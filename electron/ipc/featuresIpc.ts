import { app, ipcMain } from 'electron';
import { extractAppIcon, scanInstalledApps } from '../services/appScanner';
import { addFavorite, clearRecents, getDrives, openPath, removeFavorite, searchFiles } from '../services/fileSearch';
import { getFileIcons } from '../services/fileIcons';
import { getSystemInfo } from '../services/systemInfo';
import { controlMusic, getLyrics, getMusicState, openPlayer } from '../services/musicControl';
import { launchServer, stopServer } from '../services/serverLauncher';
import { runtimeInfo } from '../services/pluginManager';
import { perfUsage } from '../services/perf';
import { everythingAvailable } from '../services/paletteSearch';
import { windowsIndexAvailable } from '../services/windowsSearch';
import { openExternalSafe } from '../utils/openExternalSafe';
import { dataStore, userDataDir } from '../store/dataStore';
import type { ServerItem } from '../../shared/types';

export function registerFeaturesIpc(): void {
  ipcMain.handle('apps:scan', (_e, force?: boolean) => scanInstalledApps(Boolean(force)));
  ipcMain.handle('apps:get-icon', (_e, path: string) => extractAppIcon(path));

  ipcMain.handle('files:search', (_e, query: string, fullDisk: boolean, selectedDrives: string[]) =>
    searchFiles(query, fullDisk, selectedDrives)
  );
  ipcMain.handle('files:get-drives', () => getDrives());
  ipcMain.handle('files:open', (_e, path: string) => openPath(path));
  ipcMain.handle('files:add-favorite', (_e, path: string) => addFavorite(path));
  ipcMain.handle('files:remove-favorite', (_e, path: string) => removeFavorite(path));
  ipcMain.handle('files:clear-recents', () => clearRecents());
  ipcMain.handle('files:get-icons', (_e, paths: string[]) => getFileIcons(Array.isArray(paths) ? paths : []));
  // SEC-5 修复：外部链接限定 http/https/mailto 协议
  ipcMain.handle('websites:open', (_e, url: string) => openExternalSafe(url));

  ipcMain.handle('servers:launch', (_e, item: ServerItem) => launchServer(item));
  ipcMain.handle('servers:stop', (_e, itemId: string) => stopServer(itemId));

  ipcMain.handle('system:info:get', () => getSystemInfo());

  // 运行环境诊断（设置页展示，便于确认运行版本与引擎状态）
  ipcMain.handle('app:info', () => {
    const t = runtimeInfo();
    return { version: app.getVersion(), python: t.python, tkinterOk: t.tkinterOk, dataDir: userDataDir() };
  });

  ipcMain.handle('music:state', () => getMusicState());
  ipcMain.handle('music:control', (_e, action: string, value: number) => controlMusic(action, value));
  ipcMain.handle('music:open-player', () => openPlayer(dataStore().get().settings.musicPlatform));
  ipcMain.handle('music:lyrics', (_e, title: string, artist: string) => getLyrics(title, artist));

  // T-10：资源占用可视化（设置页展示）
  ipcMain.handle('perf:usage', () => perfUsage());

  // T-07：搜索后端诊断（Everything / Windows 搜索索引），设置页展示当前可用能力
  ipcMain.handle('search:backend', async () => ({
    everything: everythingAvailable(),
    windowsIndex: await windowsIndexAvailable()
  }));
}
