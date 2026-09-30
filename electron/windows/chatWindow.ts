import { BrowserWindow, screen } from 'electron';
import { loadPage, preloadPath } from './common';

/**
 * AI 宠物对话窗口（T-05）
 * 小型无边框面板，默认弹在当前显示器右下角（不锚定宠物，任意显示器可用）。
 */
let win: BrowserWindow | null = null;

export function createChatWindow(): BrowserWindow | null {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win = new BrowserWindow({
    width: 400,
    height: 540,
    x: area.x + area.width - 420,
    y: area.y + area.height - 560,
    frame: false,
    resizable: true,
    minWidth: 320,
    minHeight: 380,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPage(win, 'chat');
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function toggleChatWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  else createChatWindow();
}
