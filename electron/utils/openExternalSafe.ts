import { shell } from 'electron';

/**
 * 安全打开外部链接（SEC-5）
 *
 * 仅允许 http / https / mailto 三种协议：此前 `shell.openExternal(任意字符串)`
 * 可被 `file:///C:/evil.exe`、`search-ms:` 等危险协议利用（配合渲染层 XSS 即为执行链）。
 */
export function openExternalSafe(url: string): Promise<void> {
  const u = String(url ?? '').trim();
  if (!/^(https?:\/\/|mailto:)/i.test(u)) {
    return Promise.reject(new Error('仅支持 http / https / mailto 链接'));
  }
  return shell.openExternal(u);
}
