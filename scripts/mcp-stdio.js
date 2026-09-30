#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- 独立 Node 脚本（MCP 客户端 stdio 桥），保持 CommonJS 零依赖 */
/**
 * MCP stdio ↔ 小鹏工具箱 HTTP 桥（T-05）
 *
 * 供外部 MCP 客户端（如 Claude Desktop / Cherry Studio / Cline）接入小鹏工具箱的工具集：
 * 在 MCP 客户端配置里添加（确保小鹏工具箱正在运行且 设置 → 桌面宠物 已开启 MCP 服务）：
 *
 *   { "mcpServers": { "xiaopeng-toolbox": {
 *       "command": "node",
 *       "args": ["C:\\路径\\scripts\\mcp-stdio.js"],
 *       "env": { "XIAOPENG_MCP_TOKEN": "<设置页显示的令牌>" } } } }
 *
 * 协议：stdin/stdout 为 MCP JSON-RPC（每行一条），转发到本机
 * http://127.0.0.1:<port>/mcp（可用 XIAOPENG_MCP_URL 环境变量覆盖）。
 * SEC-6：服务端要求携带令牌，本桥通过 Authorization: Bearer 透传。
 */
const http = require('http');

const TARGET = process.env.XIAOPENG_MCP_URL || 'http://127.0.0.1:47111/mcp';
const TOKEN = process.env.XIAOPENG_MCP_TOKEN || '';

function post(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(TARGET);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(65000, () => req.destroy(new Error('请求超时')));
    req.write(payload);
    req.end();
  });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    handleLine(line);
  }
});

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const resp = await post(JSON.stringify(msg));
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return;
    if (resp.status === 200 && resp.body) {
      process.stdout.write(resp.body.trim() + '\n');
    } else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: { code: -32000, message: '小鹏工具箱 MCP 服务无响应（HTTP ' + resp.status + '），请确认应用已运行且已开启 MCP 服务' }
        }) + '\n'
      );
    }
  } catch (e) {
    if (msg.id !== undefined && msg.id !== null) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: '连接小鹏工具箱失败：' + (e && e.message ? e.message : String(e)) }
        }) + '\n'
      );
    }
  }
}
