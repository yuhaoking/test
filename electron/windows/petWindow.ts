import { BrowserWindow, screen } from 'electron';
import { loadPage, preloadPath } from './common';
import { dataStore } from '../store/dataStore';
import { ensureWindowPaintable } from '../services/windowWatchdog';
import { logDebug } from '../utils/log';

/**
 * 调用来源（栈里第 3 帧 = 真正调用 hidePet/showPet 的地方）。
 *
 * 为什么要记这个：用户反馈"侧边栏一开宠物就没了 / 鼠标移出后宠物没回来"，
 * 而宠物只有这两个显隐入口 —— 不记录来源就只能靠猜是谁隐藏了它（本轮已经猜错一次）。
 */
function callerFrame(): string {
  const line = (new Error('caller').stack ?? '').split('\n')[3] ?? '';
  return line.trim().replace(/^at\s+/, '').slice(0, 90);
}

let win: BrowserWindow | null = null;

export function createPetWindow(): BrowserWindow {
  // P3 修复：重复调用返回既有窗口，避免产生孤儿宠物窗口
  if (win && !win.isDestroyed()) return win;
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: 128,
    height: 128,
    x: workArea.x + workArea.width - 180,
    y: workArea.y + workArea.height - 200,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: dataStore().get().settings.petOnTop,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(dataStore().get().settings.petOnTop);
  loadPage(win, 'pet');
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function petWindow(): BrowserWindow | null {
  return win;
}

export function setPetOnTop(onTop: boolean): void {
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(Boolean(onTop));
  }
}

export function setPetSize(width: number, height: number): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const cx = b.x + Math.round(b.width / 2);
  const cy = b.y + Math.round(b.height / 2);
  win.setBounds({ x: cx - Math.round(width / 2), y: cy - Math.round(height / 2), width, height });
}

export function hidePet(): void {
  if (!win || win.isDestroyed()) return;
  win.hide();
  logDebug(`[pet] 已隐藏（isVisible=${win.isVisible()}）← ${callerFrame()}`);
}

export function showPet(): void {
  if (!win || win.isDestroyed()) return;
  // 幽灵窗口防线：崩溃的宠物窗显示出来会是隐形挡板，先恢复
  ensureWindowPaintable(win);
  win.showInactive();
  /*
   * 只 show 不保证回到最上层：宠物窗可能被其它置顶窗（工作台/侧边栏）压在下面，
   * 用户看到的就是"宠物被隐藏了"。这里重新断言一次置顶并 moveTop（不抢焦点）。
   */
  if (dataStore().get().settings.petOnTop) {
    win.setAlwaysOnTop(true);
    win.moveTop();
  }
  logDebug(`[pet] 已显示（isVisible=${win.isVisible()} onTop=${dataStore().get().settings.petOnTop}）← ${callerFrame()}`);
}

export function playPetAction(frames: string[]): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:action', frames);
  }
}

export function notifyPet(text: string): void {
  // T-05 语音播报：开启后桌宠气泡消息同步 TTS 朗读（聊天回复/待办提醒/用量管家播报共用）
  if (dataStore().get().settings.petVoiceEnabled) {
    void import('../services/voice').then((m) => m.speak(text));
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:notify', text);
  }
}
