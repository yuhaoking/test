import { ipcMain } from 'electron';
import { dictate, speak, stopSpeak } from '../services/voice';
import { mcpStatus } from '../services/mcpServer';

/** T-05：语音输入 / 语音播报 / MCP 状态 IPC */
export function registerVoiceIpc(): void {
  ipcMain.handle('voice:speak', (_e, text: string) => {
    speak(String(text ?? ''));
  });
  ipcMain.handle('voice:stop', () => {
    stopSpeak();
  });
  ipcMain.handle('voice:dictate', (_e, seconds?: number) => dictate(Number(seconds) || 8));
  ipcMain.handle('mcp:status', () => mcpStatus());
}
