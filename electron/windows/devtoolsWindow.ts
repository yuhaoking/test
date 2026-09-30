import { BrowserWindow } from 'electron';
import { loadPage, preloadPath } from './common';

/**
 * 开发者工具百宝箱小面板（DEV-d）
 *
 * 正则测试 / 文本 diff / 二维码 / JSON·时间戳·编解码·哈希·进制·单位·cron 一站式；
 * 入口：命令面板输入 `devtools` 或工作台固定动作。
 */

let win: BrowserWindow | null = null;

const TABS = ['regex', 'diff', 'qrcode', 'tools'];

export function openDevtoolsWindow(tab?: string): void {
  const initial = tab && TABS.includes(tab) ? tab : 'regex';
  if (win && !win.isDestroyed()) {
    loadPage(win, 'devtools', { tab: initial });
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPage(win, 'devtools', { tab: initial });
  win.on('closed', () => {
    win = null;
  });
}

export function closeDevtoolsWindow(): void {
  if (win && !win.isDestroyed()) win.close();
}

export function devtoolsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}
