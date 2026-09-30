import { BrowserWindow, screen } from 'electron';
import { loadPage, preloadPath } from './common';

/**
 * 内置文件预览窗口（T-08：QuickLook 未检测到时的兜底）
 * 小型无边框置顶窗，居中于当前显示器；Esc / 空格 / 关闭按钮关闭。
 */

let win: BrowserWindow | null = null;

export function openPreviewWindow(path: string): void {
  if (win && !win.isDestroyed()) {
    win.destroy();
    win = null;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win = new BrowserWindow({
    width: Math.min(720, Math.round(area.width * 0.6)),
    height: Math.min(560, Math.round(area.height * 0.7)),
    x: area.x + Math.round((area.width - Math.min(720, Math.round(area.width * 0.6))) / 2),
    y: area.y + Math.round((area.height - Math.min(560, Math.round(area.height * 0.7))) / 2),
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 360,
    minHeight: 280,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'floating');
  loadPage(win, 'preview', { path });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
}

export function closePreviewWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

export function previewWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}
