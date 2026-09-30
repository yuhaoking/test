/**
 * T-11 数据备份 / 诊断包 IPC
 *
 * - backup:export-settings → 导出设置备份（JSON），返回保存路径
 * - backup:import-settings → 导入设置备份并重放副作用，返回合并后的 settings
 * - backup:diag → 导出脱敏诊断包（txt），返回保存路径
 */

import { ipcMain } from 'electron';
import { exportDiagBundle, importSettingsBackup, exportSettingsBackup } from '../services/backup';
import { applySettingsSideEffects } from './moduleIpc';
import { dataStore } from '../store/dataStore';
import { logError } from '../utils/log';

export function registerBackupIpc(): void {
  ipcMain.handle('backup:export-settings', () => exportSettingsBackup());

  ipcMain.handle('backup:import-settings', async () => {
    const imported = await importSettingsBackup();
    if (imported) {
      // 重放系统副作用：热键 / 托盘 / 自启 / 监听器等立即按备份内容生效
      try {
        applySettingsSideEffects(imported);
      } catch (e) {
        logError('[backup] 设置副作用重放失败', e);
      }
    }
    return imported ?? dataStore().get().settings;
  });

  ipcMain.handle('backup:diag', () => exportDiagBundle());
}
