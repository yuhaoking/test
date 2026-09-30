import { ipcMain } from 'electron';
import {
  clipboardImage,
  clipboardIntent,
  clearClipboard,
  copyClipboardEntry,
  listClipboard,
  pasteClipboardAs,
  removeClipboard,
  setClipboardText,
  updateClipboard
} from '../services/clipboardManager';
import { expandSnippet, listSnippets, removeSnippet, saveSnippet } from '../services/snippets';
import { hideClipboardPanel } from '../windows/clipboardWindow';
import type { ClipboardEntry, ClipboardQuery, PasteMode, Snippet } from '../../shared/types';

/** 剪贴板历史 + 片段库 IPC（CH-01 ~ CH-09） */
export function registerClipboardIpc(): void {
  ipcMain.handle('clipboard:list', (_e, query?: ClipboardQuery) => listClipboard(query));
  ipcMain.handle('clipboard:update', (_e, id: string, patch: Partial<ClipboardEntry>) => updateClipboard(id, patch));
  ipcMain.handle('clipboard:remove', (_e, id: string) => removeClipboard(id));
  ipcMain.handle('clipboard:clear', (_e, keepPinned?: boolean) => clearClipboard(Boolean(keepPinned)));
  ipcMain.handle('clipboard:copy', (_e, id: string, paste?: boolean) => copyClipboardEntry(id, Boolean(paste)));
  ipcMain.handle('clipboard:image', (_e, id: string, full?: boolean) => clipboardImage(id, Boolean(full)));
  ipcMain.handle('clipboard:set-text', (_e, text: string) => setClipboardText(String(text ?? '')));
  // CH-07 ~ CH-09（T-14）：格式化粘贴三件套
  ipcMain.handle('clipboard:paste-as', (_e, id: string, mode: PasteMode) =>
    pasteClipboardAs(String(id ?? ''), (mode ?? 'plain') as PasteMode)
  );
  // CP-07（T-14）：剪贴板意图识别
  ipcMain.handle('clipboard:intent', () => clipboardIntent());
  ipcMain.on('clipboard:hide', () => hideClipboardPanel());

  ipcMain.handle('snippets:list', () => listSnippets());
  ipcMain.handle('snippets:save', (_e, s: Snippet) => saveSnippet(s));
  ipcMain.handle('snippets:remove', (_e, id: string) => removeSnippet(id));
  ipcMain.handle('snippets:expand', (_e, id: string, paste?: boolean) => expandSnippet(id, Boolean(paste)));
}
