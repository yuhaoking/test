import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { db } from '../store/db';
import { setClipboardText, suppressClipboardCapture } from './clipboardManager';
import { sendKeys } from '../utils/sendkeys';
import { logWarn } from '../utils/log';
import type { Snippet } from '../../shared/types';

/**
 * 片段库（CH-05）：预设常用文本 + 缩写。
 *
 * - 落 SQLite `fragments` 表；
 * - 浮动粘贴面板内输入缩写按 Tab 展开（expand 写入展开内容并粘贴到当前输入框）；
 * - 片段同时进入命令面板搜索源，任意场景可快速插入。
 */

let cache: Snippet[] | null = null;

function loadAll(): Snippet[] {
  if (cache) return cache;
  cache = [];
  for (const row of db().all('fragments')) {
    try {
      cache.push(JSON.parse(row.value) as Snippet);
    } catch {
      /* 跳过损坏条目 */
    }
  }
  cache.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return cache;
}

function broadcast(): void {
  const list = listSnippets();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('snippets:changed', list);
  }
}

export function listSnippets(): Snippet[] {
  return loadAll().map((s) => ({ ...s }));
}

export function saveSnippet(snippet: Snippet): Snippet[] {
  const list = loadAll();
  const now = Date.now();
  const idx = list.findIndex((s) => s.id === snippet.id);
  const next: Snippet = {
    id: snippet.id || randomUUID(),
    name: snippet.name.trim() || '未命名片段',
    abbr: snippet.abbr.trim(),
    content: snippet.content,
    createdAt: idx >= 0 ? list[idx].createdAt : now,
    updatedAt: now
  };
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  // 缩写唯一化：后保存者优先
  for (const s of list) {
    if (s.id !== next.id && next.abbr && s.abbr === next.abbr) s.abbr = '';
  }
  db().set('fragments', next.id, JSON.stringify(next));
  for (const s of list) {
    if (s.id !== next.id && !s.abbr) db().set('fragments', s.id, JSON.stringify(s));
  }
  cache = list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  broadcast();
  return listSnippets();
}

export function removeSnippet(id: string): Snippet[] {
  const list = loadAll().filter((s) => s.id !== id);
  db().delete('fragments', id);
  cache = list;
  broadcast();
  return listSnippets();
}

/** 缩写展开（CH-05）：写入展开内容并粘贴到当前输入框 */
export function expandSnippet(id: string, paste = true): void {
  const s = loadAll().find((x) => x.id === id);
  if (!s) return;
  /*
   * P2-9 修复：片段展开属于"程序内部写剪贴板"，不能被剪贴板历史当成用户复制内容记录。
   * 走 setClipboardText（同步 lastText 指纹基线）+ 抑制窗口，与划词翻译/粘贴面板同款处理。
   */
  suppressClipboardCapture(paste ? 1500 : 1200);
  setClipboardText(s.content);
  if (paste) {
    void import('../windows/clipboardWindow').then(({ hideClipboardPanel }) => hideClipboardPanel());
    sendKeys('^v', 140);
  }
}

/** 按缩写查找（浮动面板 Tab 展开） */
export function findByAbbr(abbr: string): Snippet | null {
  const q = abbr.trim().toLowerCase();
  if (!q) return null;
  return loadAll().find((s) => s.abbr && s.abbr.toLowerCase() === q) ?? null;
}

export function snippetError(e: unknown): string {
  logWarn('[snippets] 操作失败', e);
  return String(e);
}
