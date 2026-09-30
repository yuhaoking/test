import { ipcMain } from 'electron';
import { chatRound, clearMemory, loadMemory } from '../services/llm';

/** T-05：AI 宠物对话 IPC */
export function registerLlmIpc(): void {
  ipcMain.handle('llm:chat', (_e, message: string) => chatRound(String(message ?? '')));
  ipcMain.handle('llm:history', () => loadMemory());
  ipcMain.handle('llm:clear', () => {
    clearMemory();
  });
}
