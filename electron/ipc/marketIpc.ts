import { ipcMain } from 'electron';
import { clearSecurePackages, installFromMarket, marketState, securePackagesInfo, uninstallFromMarket, upgradeFromMarket } from '../services/marketplace';

/** 插件市场 IPC（PM-01 ~ PM-04 + T-11 安装包加密留存） */
export function registerMarketIpc(): void {
  ipcMain.handle('market:fetch', () => marketState());
  ipcMain.handle('market:install', (_e, id: string) => installFromMarket(String(id)));
  ipcMain.handle('market:upgrade', (_e, id: string) => upgradeFromMarket(String(id)));
  ipcMain.handle('market:uninstall', (_e, id: string) => uninstallFromMarket(String(id)));
  // T-11：安装包加密留存（spec 5.4）
  ipcMain.handle('market:secure-info', () => securePackagesInfo());
  ipcMain.handle('market:secure-clear', () => clearSecurePackages());
}
