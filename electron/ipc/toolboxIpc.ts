import { ipcMain } from 'electron';
import { exportAliases, importAliases, listAliases, removeAlias, saveAlias } from '../services/aliases';
import { checkForUpdates, openReleasePage, updateState } from '../services/updateChecker';
import { closeDevtoolsWindow, openDevtoolsWindow } from '../windows/devtoolsWindow';
import type { Alias } from '../../shared/types';

/** T-14：开发者工具面板 / 指令别名 / 检查更新 IPC */
export function registerToolboxIpc(): void {
  // DEV-d：独立小面板
  ipcMain.handle('devtools:open', (_e, tab?: string) => openDevtoolsWindow(tab ? String(tab) : undefined));
  ipcMain.on('devtools:close', () => closeDevtoolsWindow());

  // AL-01 ~ AL-03：指令别名
  ipcMain.handle('aliases:list', () => listAliases());
  ipcMain.handle('aliases:save', (_e, a: Alias) => saveAlias(a));
  ipcMain.handle('aliases:remove', (_e, id: string) => removeAlias(String(id ?? '')));
  ipcMain.handle('aliases:export', () => exportAliases());
  ipcMain.handle('aliases:import', (_e, text: string) => {
    const r = importAliases(String(text ?? ''));
    return { ok: r.ok, message: r.message, list: listAliases() };
  });

  // UPD-01：检查更新（失败静默）
  ipcMain.handle('update:state', () => updateState());
  ipcMain.handle('update:check', (_e, force?: boolean) => checkForUpdates(Boolean(force)));
  ipcMain.handle('update:open', () => openReleasePage());
}
