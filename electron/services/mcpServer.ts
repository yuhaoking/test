import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { dataStore } from '../store/dataStore';
import { AGENT_TOOLS, execAgentTool } from './agentTools';
import { logDebug, logError, logWarn } from '../utils/log';

/**
 * MCP 对外工具服务（T-05「宠物即 Agent 入口」，MCP 兼容工具调用）
 *
 * - 本机回环 HTTP 端点（默认 http://127.0.0.1:47111/mcp），实现 MCP Streamable HTTP 的
 *   JSON-RPC 子集：initialize / notifications/initialized / tools/list / tools/call / ping；
 * - 工具集与桌宠对话共用（agentTools），外部 MCP 客户端经 `scripts/mcp-stdio.js` 桥接入；
 * - 设置 → 桌面宠物 开关（mcpEnabled / mcpPort），仅绑定 127.0.0.1，不对局域网暴露；
 * - SEC-6 加固：Host 白名单 + 随机令牌（Authorization: Bearer / X-MCP-Token），
 *   阻断恶意网页 simple-request 与 DNS rebinding 直接驱动 Agent 工具。
 */

const PROTOCOL_VERSION = '2025-03-26';

let server: Server | null = null;
let runningPort = 0;
let lastError = '';

/** 当前令牌（空表示尚未生成；开启服务时自动生成并持久化） */
function currentToken(): string {
  return String(dataStore().get().settings.mcpToken ?? '').trim();
}

export function mcpStatus(): { running: boolean; port: number; token: string; error?: string } {
  return {
    running: server !== null,
    port: runningPort || dataStore().get().settings.mcpPort,
    token: currentToken(),
    error: lastError || undefined
  };
}

/** Host 头白名单（SEC-6）：仅接受本机回环，阻断 DNS rebinding */
function hostAllowed(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '');
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

/** 提取请求携带的令牌（SEC-6）：Bearer / X-MCP-Token / ?token= */
function tokenOf(req: IncomingMessage, url: URL): string {
  const auth = String(req.headers.authorization ?? '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? '';
  const header = String(req.headers['x-mcp-token'] ?? '');
  return (bearer || header || url.searchParams.get('token') || '').trim();
}

interface JsonRpcReq {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function toolList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return AGENT_TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters
  }));
}

async function handleRpc(req: JsonRpcReq): Promise<object | null> {
  const method = String(req.method ?? '');
  const hasId = req.id !== undefined && req.id !== null;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'xiaopeng-toolbox', title: '小鹏工具箱', version: '2.0.0' }
      }
    };
  }
  if (method === 'notifications/initialized' || !hasId) {
    return null; // 通知类消息：202 空响应
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id: req.id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: req.id, result: { tools: toolList() } };
  }
  if (method === 'tools/call') {
    const params = req.params ?? {};
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    logDebug(`[mcp] tools/call ${name}`, JSON.stringify(args).slice(0, 200));
    const text = await execAgentTool(name, args);
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text }], isError: false }
    };
  }
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function startServer(port: number): void {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // SEC-6：Host 白名单 + 路由精确匹配 + 令牌校验（此前仅前缀匹配且无任何鉴权）
    if (!hostAllowed(req)) {
      res.writeHead(403).end();
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const expected = currentToken();
    if (expected && tokenOf(req, url) !== expected) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '未授权：缺少或错误的 MCP 令牌' } })
      );
      return;
    }
    if (req.method === 'GET') {
      // Streamable HTTP：不支持 SSE 流，明确拒绝
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    void readBody(req)
      .then(async (body) => {
        let parsed: JsonRpcReq | JsonRpcReq[];
        try {
          parsed = JSON.parse(body) as JsonRpcReq | JsonRpcReq[];
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        // P3 加固：批量请求条数上限，避免一次请求堆积过多工具调用
        const list = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, 50);
        const responses: object[] = [];
        for (const item of list) {
          const r = await handleRpc(item);
          if (r) responses.push(r);
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': PROTOCOL_VERSION
        });
        res.end(JSON.stringify(Array.isArray(parsed) ? responses : (responses[0] ?? {})));
      })
      .catch((e: unknown) => {
        logWarn('[mcp] 请求处理失败', e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  server.on('error', (e) => {
    lastError = e.message;
    logError('[mcp] 服务异常', e);
    server = null;
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = server?.address() as AddressInfo | null;
    runningPort = addr?.port ?? port;
    lastError = '';
    logDebug(`[mcp] MCP 工具服务已启动：http://127.0.0.1:${runningPort}/mcp`);
  });
}

export function stopMcpServer(): void {
  if (server) {
    const s = server;
    server = null;
    try {
      // keep-alive 连接不关闭会导致端口残留（EADDRINUSE）
      s.closeAllConnections?.();
      s.closeIdleConnections?.();
      s.close();
    } catch {
      /* noop */
    }
    logDebug('[mcp] MCP 工具服务已停止');
  }
  runningPort = 0;
}

/** 按设置启停 MCP 服务（设置变更即时生效） */
export function applyMcpServer(): void {
  const s = dataStore().get().settings;
  const port = Math.max(1024, Math.min(65535, Math.round(Number(s.mcpPort) || 47111)));
  if (!s.mcpEnabled) {
    stopMcpServer();
    return;
  }
  // SEC-6：首次启用自动生成随机令牌并持久化（外部客户端需携带）
  if (!currentToken()) {
    // SEC-007：令牌只由主进程生成，走专用写入（通用通道已摘除 mcpToken）
    dataStore().updateSettingsTrusted({ mcpToken: randomBytes(24).toString('hex') });
  }
  if (server && runningPort === port) return;
  stopMcpServer();
  startServer(port);
}
