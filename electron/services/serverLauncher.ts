import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { BrowserWindow } from 'electron';
import type { ServerItem } from '../../shared/types';

interface RunningServer {
  item: ServerItem;
  child: ReturnType<typeof spawn> | null;
  logs: string;
}

const running = new Map<string, RunningServer>();

const utf8Decoder = new TextDecoder('utf-8');
const gbkDecoder = new TextDecoder('gbk');

function decodeChunk(buf: Buffer): string {
  const utf8 = utf8Decoder.decode(buf);
  const badUtf8 = (utf8.match(/\uFFFD/g) ?? []).length;
  if (badUtf8 > 0) {
    const gbk = gbkDecoder.decode(buf);
    const badGbk = (gbk.match(/\uFFFD/g) ?? []).length;
    if (badGbk < badUtf8) return gbk;
  }
  return utf8;
}

function sendLog(itemId: string, stream: 'stdout' | 'stderr' | 'system', data: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('server:log', { itemId, stream, data });
  }
}

export function isServerRunning(itemId: string): boolean {
  const s = running.get(itemId);
  return Boolean(s && s.child);
}

/**
 * 拆分命令行（SEC-4）：支持双引号包裹的参数，不做任何 shell 解释。
 * 此前 `spawn(cmd, [], { shell: true })` 允许 `calc & del /q C:\重要` 之类注入，
 * 现在一律以 argv 数组 + shell:false 启动。
 */
function splitCommandLine(line: string): { cmd: string; args: string[] } {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of String(line ?? '')) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return { cmd: out[0] ?? '', args: out.slice(1) };
}

export function launchServer(item: ServerItem): boolean {
  const existing = running.get(item.id);
  if (existing && existing.child) return false;
  let child: ReturnType<typeof spawn>;
  const cwd = item.cwd !== undefined && item.cwd.trim() && existsSync(item.cwd) ? item.cwd : homedir();
  try {
    switch (item.type) {
      case 'python':
        child = spawn('python', [item.command], { cwd, windowsHide: true, shell: false });
        break;
      case 'exe':
        child = spawn(item.command, [], { cwd, windowsHide: true, shell: false });
        break;
      default: {
        // SEC-4 修复：命令行拆为 argv，禁用 shell 解释（不再有命令注入面）
        const { cmd, args } = splitCommandLine(item.command);
        if (!cmd) throw new Error('命令为空');
        child = spawn(cmd, args, { cwd, windowsHide: true, shell: false });
      }
    }
  } catch (e) {
    sendLog(item.id, 'system', `启动失败: ${(e as Error).message}\n`);
    return false;
  }
  const server: RunningServer = { item, child, logs: '' };
  running.set(item.id, server);
  sendLog(item.id, 'system', `[已启动] ${item.name} → ${item.command}\n`);
  child.stdout?.on('data', (chunk: Buffer) => {
    const d = decodeChunk(chunk);
    server.logs = (server.logs + d).slice(-20000);
    sendLog(item.id, 'stdout', d);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const d = decodeChunk(chunk);
    server.logs = (server.logs + d).slice(-20000);
    sendLog(item.id, 'stderr', d);
  });
  child.on('error', (err) => {
    server.child = null;
    sendLog(item.id, 'system', `错误: ${err.message}\n`);
  });
  child.on('close', (code) => {
    server.child = null;
    sendLog(item.id, 'system', `[已退出] code=${code ?? '?'}\n`);
  });
  return true;
}

export function stopServer(itemId: string): void {
  const server = running.get(itemId);
  if (!server?.child?.pid) return;
  spawn('taskkill', ['/pid', String(server.child.pid), '/T', '/F'], { windowsHide: true, shell: false });
  sendLog(itemId, 'system', '[已停止]\n');
}
