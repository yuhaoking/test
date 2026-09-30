import { BrowserWindow, screen } from 'electron';
import { loadPage, preloadPath } from './common';

/**
 * 划词翻译 / 取词 OCR 悬浮条（T-07，pot 模式）
 * 无边框小面板，弹在光标附近；失焦自动隐藏。
 */

const BAR_W = 460;
// WK-07：新增可配置动作条后加高，避免动作多行时内容被裁掉
const BAR_H = 312;

let win: BrowserWindow | null = null;

export function createTranslateBar(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    frame: false,
    transparent: true,
    resizable: false,
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
  win.setAlwaysOnTop(true, 'screen-saver');
  loadPage(win, 'translatebar');
  win.on('blur', () => hideTranslateBar());
  win.on('closed', () => {
    win = null;
  });
  return win;
}

/** 在光标附近显示悬浮条（自动夹取到当前显示器工作区） */
export function showTranslateBar(): void {
  const w = createTranslateBar();
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const x = Math.max(area.x, Math.min(cursor.x - 40, area.x + area.width - BAR_W - 8));
  const y = Math.max(area.y, Math.min(cursor.y + 24, area.y + area.height - BAR_H - 8));
  w.setBounds({ x, y, width: BAR_W, height: BAR_H });
  w.show();
  w.focus();
}

export function hideTranslateBar(): void {
  if (win && !win.isDestroyed()) win.hide();
}

export function translateBarWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}
