/**
 * 统一日志工具（主进程）
 *
 * 规格约束（小鹏工具箱 v2.0 轮格说明书 5.2 / 6）：
 * - 移除所有 console.log 调试输出，仅保留 debug 级别日志；
 * - 错误与警告使用独立的级别输出，便于按级别过滤。
 *
 * v2.1 扩展（T-11 一键诊断包）：日志同时落盘 userData/logs/app.log（1MB 轮转），
 * 供"导出诊断包"隐私过滤后导出；原有 console 行为保持不变。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, userInfo } from 'os';
import { app } from 'electron';

const MAX_LOG_BYTES = 1024 * 1024;

function logDir(): string {
  return join(app.getPath('userData'), 'logs');
}

/** 日志文件路径（T-11 诊断包导出源） */
export function logFilePath(): string {
  return join(logDir(), 'app.log');
}

function write(level: string, args: unknown[]): void {
  try {
    const dir = logDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = logFilePath();
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      renameSync(file, join(dir, 'app.old.log'));
    }
    const text = args
      .map((a) => {
        if (a instanceof Error) return a.stack ?? a.message;
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${text}\n`, 'utf-8');
  } catch {
    /* 日志落盘失败不影响主流程 */
  }
}

/** 调试日志：仅供开发排障，正常运行不参与任何逻辑 */
export function logDebug(...args: unknown[]): void {
  console.debug('[toolbox]', ...args);
  write('DEBUG', args);
}

/** 警告日志：可恢复的异常情况（如热键注册失败） */
export function logWarn(...args: unknown[]): void {
  console.warn('[toolbox]', ...args);
  write('WARN', args);
}

/** 错误日志：实际失败，配合 try-catch 使用 */
export function logError(...args: unknown[]): void {
  console.error('[toolbox]', ...args);
  write('ERROR', args);
}

/**
 * 读取脱敏后的日志内容（T-11 一键诊断包）。
 * 过滤：API Key（sk-… / Bearer / xxx_token=…）、邮箱、用户主目录路径、身份证号样式长数字。
 */
export function readRedactedLog(): string {
  const parts: string[] = [];
  for (const name of ['app.log', 'app.old.log']) {
    const file = join(logDir(), name);
    if (!existsSync(file)) continue;
    parts.push(`----- ${name} -----`);
    parts.push(redact(readFileSync(file, 'utf-8')));
  }
  return parts.join('\n') || '（暂无日志文件）';
}

/** 隐私过滤（spec 5.4）：密钥 / 邮箱 / 主目录 / 长数字证照号一律脱敏 */
export function redact(text: string): string {
  let out = text;
  try {
    const home = homedir();
    if (home) out = out.split(home).join('%USERPROFILE%');
  } catch {
    /* ignore */
  }
  try {
    out = out.split(userInfo().username).join('%USER%');
  } catch {
    /* ignore */
  }
  out = out.replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***');
  // P3-8 修复：除 sk- 前缀外，其他常见密钥形态也一律脱敏
  out = out.replace(/\b(?:ghp|gho|ghu|ghs|ghr|xox[baprs]|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '***');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
  out = out.replace(
    /("?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|credential|authorization)"?\s*[:=]\s*"?)([^"'\s,}]{6,})/gi,
    '$1***'
  );
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
  out = out.replace(/\b\d{15}(?:\d{2}[\dXx])?\b/g, '***证照号***');
  return out;
}

/** 构建诊断包文本（T-11）：环境信息 + 脱敏日志 */
export function buildDiagReport(extra: Record<string, string | number | boolean>): string {
  const lines = [
    '# 小鹏工具箱 一键诊断包（已脱敏）',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `应用版本：${app.getVersion()} · Electron ${process.versions.electron ?? '-'} · Node ${process.versions.node}`,
    `系统：${process.platform} ${process.arch} ${process.getSystemVersion?.() ?? ''}`
  ];
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}：${v}`);
  lines.push('', readRedactedLog());
  return lines.join('\n');
}

/** 供测试/兜底清空日志 */
export function truncateLog(): void {
  try {
    writeFileSync(logFilePath(), '', 'utf-8');
  } catch {
    /* ignore */
  }
}
