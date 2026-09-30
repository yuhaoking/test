import { BrowserWindow, globalShortcut, screen } from 'electron';
import { loadPage, preloadPath } from './common';
import { dataStore } from '../store/dataStore';
import { reportHotkey } from '../services/hotkeyManager';
import { logWarn } from '../utils/log';

/**
 * 浮动粘贴面板（CH-04）：全局热键（默认 Ctrl+Shift+V）呼出，
 * 上下选择历史/片段粘贴；输入缩写按 Tab 展开片段；失焦自动隐藏。
 */

const PANEL_W = 560;
const PANEL_H = 560;

let win: BrowserWindow | null = null;
let registeredKey = '';

export function createClipboardPanel(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
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
  loadPage(win, 'clipboard');
  win.on('blur', () => hideClipboardPanel());
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function showClipboardPanel(): void {
  const w = createClipboardPanel();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  w.setBounds({
    x: area.x + Math.round((area.width - PANEL_W) / 2),
    y: area.y + Math.round(area.height * 0.14),
    width: PANEL_W,
    height: PANEL_H
  });
  w.show();
  w.focus();
  w.webContents.send('clipboard:shown');
}

export function hideClipboardPanel(): void {
  if (win && !win.isDestroyed()) win.hide();
}

export function toggleClipboardPanel(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideClipboardPanel();
  else showClipboardPanel();
}

/** 应用剪贴板面板热键（CH-04；结果回报到 SY-02 热键管理页） */
export function applyClipboardHotkey(): void {
  if (registeredKey) {
    try {
      globalShortcut.unregister(registeredKey);
    } catch {
      /* noop */
    }
    registeredKey = '';
  }
  const settings = dataStore().get().settings;
  if (!settings.clipboardEnabled || !settings.clipboardHotkey) return;
  try {
    if (globalShortcut.register(settings.clipboardHotkey, () => toggleClipboardPanel())) {
      registeredKey = settings.clipboardHotkey;
      reportHotkey('clipboard', settings.clipboardHotkey, true);
    } else {
      reportHotkey('clipboard', settings.clipboardHotkey, false, '注册失败（可能被其他程序占用）');
      logWarn('[clipboard-panel] 热键注册失败:', settings.clipboardHotkey);
    }
  } catch (e) {
    reportHotkey('clipboard', settings.clipboardHotkey, false, (e as Error).message);
    logWarn('[clipboard-panel] 热键注册异常', e);
  }
}

export function clipboardPanelWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}
