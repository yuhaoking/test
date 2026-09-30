import { ipcMain } from 'electron';
import { generatePlugin, installGenerated, publishGenerated } from '../services/pluginForge';
import { listPlugins } from '../services/pluginManager';
import type { ForgeResult } from '../../shared/types';

/** T-06：AI 造插件 IPC（生成 → 预览 → 安装 → 发布） */
export function registerForgeIpc(): void {
  ipcMain.handle('forge:generate', (_e, prompt: string) => generatePlugin(String(prompt ?? '')));
  ipcMain.handle('forge:install', async (_e, result: ForgeResult) => {
    await installGenerated(result);
    return listPlugins();
  });
  ipcMain.handle('forge:publish', (_e, result: ForgeResult) => publishGenerated(result));
}
