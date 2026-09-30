import { ipcMain } from 'electron';
import {
  installPlugin,
  listPlugins,
  loadPlugin,
  pluginAction,
  pluginUi,
  removePlugin,
  trustPlugin,
  unloadPlugin
} from '../services/pluginManager';
import { openExternalSafe } from '../utils/openExternalSafe';

export function registerPluginIpc(): void {
  ipcMain.handle('plugins:list', () => listPlugins());
  ipcMain.handle('plugins:install', () => installPlugin());
  ipcMain.handle('plugins:load', (_e, id: string) => loadPlugin(id));
  ipcMain.handle('plugins:unload', (_e, id: string) => unloadPlugin(id));
  ipcMain.handle('plugins:remove', (_e, id: string) => removePlugin(id));
  ipcMain.handle('plugins:trust', (_e, id: string) => trustPlugin(id));
  ipcMain.handle('plugins:action', async (_e, id: string, action: string, values: Record<string, string>) => {
    // P3-1 修复：出错时 reject（而非 resolve 错误字符串），渲染端才能按错误处理
    const result = (await pluginAction(id, action, values)) as Record<string, unknown> | null;
    if (result && typeof result.openUrl === 'string') {
      // SEC-5 修复：插件返回的链接同样限定安全协议
      await openExternalSafe(result.openUrl);
    }
    return result;
  });
  ipcMain.handle('plugins:ui', (_e, id: string, values: Record<string, string>, start?: boolean) =>
    pluginUi(id, values, Boolean(start))
  );
}
