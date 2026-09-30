import { BrowserWindow } from 'electron';
import { loadPage, preloadPath } from './common';

let win: BrowserWindow | null = null;

export function createSettingsWindow(tab?: string): BrowserWindow {
  win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPage(win, 'settings', tab ? { tab } : undefined);
  win.on('closed', () => {
    win = null;
  });
  return win;
}

/** 打开设置窗口；tab 指定初始标签页（如 'market' 插件市场，PM-01） */
export function openSettingsWindow(tab?: string): void {
  if (win && !win.isDestroyed()) {
    if (tab) loadPage(win, 'settings', { tab });
    win.show();
    win.focus();
    return;
  }
  createSettingsWindow(tab);
}

export function closeSettingsWindow(): void {
  if (win && !win.isDestroyed()) win.close();
}

export function settingsWindow(): BrowserWindow | null {
  return win;
}
