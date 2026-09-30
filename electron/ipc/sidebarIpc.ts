import { dialog, ipcMain } from 'electron';
import { basename } from 'path';
import { closeSettingsWindow, openSettingsWindow } from '../windows/settingsWindow';
import { hideSidebar, setSidebarWidth, showSidebar, toggleSidebar } from '../windows/sidebarWindow';

export function registerSidebarIpc(): void {
  ipcMain.handle('sidebar:toggle', () => toggleSidebar());
  ipcMain.handle('sidebar:show', () => showSidebar());
  ipcMain.handle('sidebar:hide', () => hideSidebar());
  ipcMain.handle('sidebar:set-width', (_e, width: number) => setSidebarWidth(width));
  ipcMain.handle('settings:open', () => openSettingsWindow());
  ipcMain.handle('settings:close', () => closeSettingsWindow());

  ipcMain.handle('apps:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择应用',
      properties: ['openFile'],
      filters: [{ name: '应用程序', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
    });
    const path = res.filePaths[0];
    if (!path) return null;
    return { name: basename(path, path.toLowerCase().endsWith('.lnk') ? '.lnk' : ''), path, icon: undefined };
  });

  ipcMain.handle('settings:pick-image', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    });
    return res.filePaths[0];
  });

  ipcMain.handle('settings:pick-frames', async (_e, _action: string) => {
    const res = await dialog.showOpenDialog({
      title: '选择动作帧（多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    });
    return res.filePaths;
  });

  ipcMain.handle('settings:pick-folder', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择文件夹',
      properties: ['openDirectory']
    });
    return res.filePaths[0];
  });

  ipcMain.handle('settings:pick-file', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择文件',
      properties: ['openFile']
    });
    return res.filePaths[0];
  });
}
