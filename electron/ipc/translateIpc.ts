import { ipcMain } from 'electron';
import { currentBarActions, currentBarData, hideBar, runBarAction } from '../services/translateBar';
import { setClipboardText } from '../services/clipboardManager';

/** T-07 / WK-07：划词翻译 / 取词 OCR 悬浮条 + 可配置动作条 IPC */
export function registerTranslateIpc(): void {
  ipcMain.handle('translatebar:state', () => currentBarData());
  ipcMain.handle('translatebar:copy', (_e, text: string) => setClipboardText(String(text ?? '')));
  ipcMain.handle('translatebar:actions', () => currentBarActions());
  ipcMain.handle('translatebar:run', (_e, id: string, text: string) => runBarAction(String(id ?? ''), String(text ?? '')));
  ipcMain.on('translatebar:hide', () => hideBar());
}
