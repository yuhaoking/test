import { BrowserWindow, clipboard, nativeImage, screen } from 'electron';
import { loadPage, preloadPath } from './common';
import { logDebug, logWarn } from '../utils/log';
import type { AnnotatePayload, CaptureRect, CaptureSurface, PinPayload } from '../../shared/types';

/**
 * 截图工作流窗口（T-04）：
 * - overlay：全屏透明遮罩（区域选择 / 屏幕取色器）；
 * - annotate：标注器（箭头/文字/矩形/马赛克/画笔 + 复制/保存/贴图）；
 * - pin：贴图置顶窗（缩放/透明度/关闭）；
 * - long：滚动长截图控制条（setFocusable(false)，滚轮/按键仍送达目标窗口）。
 */

// ---------- overlay（区域选择 / 取色器 / 取词 OCR） ----------

/** overlay 工作模式：region=区域截图，long=长截图，color=取色器，ocr=取词 OCR（T-07） */
export type OverlayMode = 'region' | 'long' | 'color' | 'ocr';

/**
 * 遮罩状态（窗口句柄 / 工作模式 / 收尾钩子）。
 *
 * 三者**必须打包在一起**：`destroy()` 触发的 'closed' 是异步投递的，
 * 而长截图流程会在极短时间内"关掉旧遮罩 → 立刻建新遮罩"。
 * 若句柄与钩子拆成各自独立的变量，迟到的旧监听器就会把**新遮罩**的句柄或钩子抹掉：
 * 新遮罩随即变成"没人管的全屏置顶窗"（推不进 surfaces → 白屏；关不掉 → 整屏点不动）。
 * 打包 + 身份校验后，旧监听器发现"当前遮罩已不是我"就整段不动作，句柄/钩子/模式一并归新窗口所有。
 */
interface OverlayState {
  win: BrowserWindow;
  mode: OverlayMode;
  onDestroyed: (() => void) | null;
}

let overlay: OverlayState | null = null;
let lastOverlayMode: OverlayMode = 'region';

function virtualBounds(): Electron.Rectangle {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const d of screen.getAllDisplays()) {
    const b = d.bounds;
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function createOverlayWindow(mode: OverlayMode, onDestroyed?: () => void): BrowserWindow {
  closeOverlay();
  lastOverlayMode = mode;
  const b = virtualBounds();
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setFullScreen(false);
  /*
   * GW-03 / OPT-03：遮罩的"收尾钩子"。
   *
   * 遮罩是全屏置顶的透明窗，它一旦以任何方式消失（用户 Esc、渲染进程崩溃、
   * 主进程逃生口强杀、超时自动销毁），本次捕获会话就必须被**释放** ——
   * 否则 captureBusy 会一直被一个已经不存在的窗口占着，此后所有截图入口都静默失效。
   * 把回调挂在创建处（而不是在各销毁点手写成对调用）是刻意的：
   * 新增任何销毁路径都会自动带上释放，不会重演 GW-06 那种"控制条关了、锁还在"。
   */
  const state: OverlayState = { win, mode, onDestroyed: onDestroyed ?? null };
  overlay = state;
  win.on('closed', () => {
    // 迟到的旧监听器：当前遮罩已不是我 → 整段不动作（句柄/钩子/模式都归新窗口）
    if (overlay !== state) return;
    overlay = null;
    const hook = state.onDestroyed;
    state.onDestroyed = null;
    try {
      hook?.();
    } catch (e) {
      logWarn('[capture] 遮罩收尾钩子执行失败', e);
    }
  });
  loadPage(win, 'capture', { mode });
  return win;
}

export function overlayWindow(): BrowserWindow | null {
  const st = overlay;
  return st && !st.win.isDestroyed() ? st.win : null;
}

export function overlayModeOf(): OverlayMode {
  return overlay?.mode ?? lastOverlayMode;
}

export function pushSurfaces(surfaces: CaptureSurface[]): void {
  const win = overlayWindow();
  if (win) win.webContents.send('capture:begin', surfaces);
}

/**
 * 关闭遮罩，并**保证**释放一次捕获会话。
 *
 * 为什么要在这里主动调钩子、而不是"交给 closed 事件"：
 * `destroy()` 是否同步发出 'closed' 是实现细节（Electron 不同版本/不同销毁原因下并不一致），
 * 而授权失败**必须**是确定性的 —— 只要有哪怕一条路径没走到 closed，
 * `captureBusy` 就会被一个已经不存在的窗口永久占住，之后所有截图入口静默失效
 * （这正是 GW-06 的成因形状）。因此这里先摘状态再主动执行钩子，'closed' 到达时发现
 * `overlay !== state` 便不再重复执行 —— 两边共享同一条"身份校验 + 取走即置空"的不变式。
 */
/*
 */
export function closeOverlay(): void {
  const st = overlay;
  overlay = null; // 先摘状态：异步到达的 'closed' 会因 overlay !== state 而不重复执行
  if (st) {
    if (!st.win.isDestroyed()) {
      try {
        st.win.destroy();
      } catch (e) {
        logWarn('[capture] 关闭遮罩失败', (e as Error).message);
      }
    }
    const hook = st.onDestroyed;
    st.onDestroyed = null;
    try {
      hook?.();
    } catch (e) {
      logWarn('[capture] 遮罩收尾钩子执行失败', e);
    }
  }
}

// ---------- annotate（标注器） ----------

let annotateWin: BrowserWindow | null = null;

export function createAnnotateWindow(payload: AnnotatePayload): BrowserWindow {
  if (annotateWin && !annotateWin.isDestroyed()) annotateWin.destroy();
  annotateWin = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPage(annotateWin, 'annotate');
  annotateWin.webContents.once('did-finish-load', () => {
    if (annotateWin && !annotateWin.isDestroyed()) {
      annotateWin.webContents.send('capture:annotate-payload', payload);
      annotateWin.show();
      annotateWin.focus();
    }
  });
  annotateWin.on('closed', () => {
    annotateWin = null;
  });
  return annotateWin;
}

// ---------- pin（贴图置顶窗） ----------

interface PinState {
  dataUrl: string;
  baseW: number;
  baseH: number;
  zoom: number;
}

const pinWins = new Map<BrowserWindow, PinState>();

export function createPinWindow(dataUrl: string): BrowserWindow {
  const img = nativeImage.createFromDataURL(dataUrl);
  const size = img.getSize();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const fit = Math.min(1, (area.width * 0.7) / Math.max(1, size.width), (area.height * 0.7) / Math.max(1, size.height));
  const w = Math.max(80, Math.round(size.width * fit));
  const h = Math.max(80, Math.round(size.height * fit));
  const win = new BrowserWindow({
    x: area.x + Math.round((area.width - w) / 2),
    y: area.y + Math.round((area.height - h) / 2),
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    minWidth: 60,
    minHeight: 60,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'floating');
  loadPage(win, 'pin');
  const state: PinState = { dataUrl, baseW: size.width || w, baseH: size.height || h, zoom: 1 };
  pinWins.set(win, state);
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      const payload: PinPayload = { dataUrl };
      win.webContents.send('capture:pin-payload', payload);
      win.show();
    }
  });
  win.on('closed', () => {
    pinWins.delete(win);
  });
  logDebug('[capture] 贴图窗口已创建', `${w}x${h}`);
  return win;
}

export function createPinWindowFromFile(path: string): BrowserWindow | null {
  try {
    const img = nativeImage.createFromPath(path);
    if (img.isEmpty()) return null;
    return createPinWindow(img.toDataURL());
  } catch (e) {
    logWarn('[capture] 贴图文件读取失败', e);
    return null;
  }
}

export function pinOpFor(win: BrowserWindow, op: string, value?: number): void {
  const st = pinWins.get(win);
  if (!st) return;
  switch (op) {
    case 'close':
      win.close();
      break;
    case 'copy':
      clipboard.writeImage(nativeImage.createFromDataURL(st.dataUrl));
      break;
    case 'zoomIn':
    case 'zoomOut': {
      st.zoom = Math.min(3, Math.max(0.2, st.zoom + (op === 'zoomIn' ? 0.1 : -0.1)));
      const b = win.getBounds();
      const w = Math.max(60, Math.round(st.baseW * st.zoom));
      const h = Math.max(60, Math.round(st.baseH * st.zoom));
      win.setBounds({ x: b.x, y: b.y, width: w, height: h });
      break;
    }
    case 'reset':
      st.zoom = 1;
      win.setOpacity(1);
      win.setBounds({
        x: win.getBounds().x,
        y: win.getBounds().y,
        width: Math.round(st.baseW),
        height: Math.round(st.baseH)
      });
      break;
    case 'opacity':
      win.setOpacity(Math.min(1, Math.max(0.15, value ?? 1)));
      break;
  }
}

export function pinWindowOf(win: BrowserWindow): PinState | null {
  return pinWins.get(win) ?? null;
}

// ---------- long（长截图控制条） ----------

/** 长截图控制条状态（句柄 + 收尾钩子打包，理由同 OverlayState 的说明） */
interface LongState {
  win: BrowserWindow;
  onClosed: (() => void) | null;
}

let long: LongState | null = null;

export function createLongWindow(rect: CaptureRect, onClosed?: () => void): BrowserWindow {
  closeLongWindow();
  const display = screen.getDisplayNearestPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const area = display.workArea;
  const w = 300;
  const h = 380;
  // 控制条避开捕获区域，防止进入长截图画面
  let x = rect.x + rect.width + 16;
  let y = rect.y;
  if (x + w > area.x + area.width) x = Math.max(area.x + 8, rect.x - w - 16);
  if (x + w > area.x + area.width || (x < rect.x + rect.width && y < rect.y + rect.height)) {
    x = Math.max(area.x + 8, Math.min(rect.x, area.x + area.width - w - 8));
    y = Math.min(area.y + area.height - h - 8, rect.y + rect.height + 16);
  }
  const win = new BrowserWindow({
    x,
    y,
    width: w,
    height: h,
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
  const state: LongState = { win, onClosed: onClosed ?? null };
  long = state;
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('capture:long-payload', { rect });
      win.show();
      // 不抢焦点：滚动按键需要继续送达目标窗口（T-04 滚动捕获）
      win.setFocusable(false);
    }
  });
  /*
   * GW-06 / OPT-06：控制条被关掉时必须走 longStop() + 释放互斥锁。
   *
   * 旧实现只把句柄置空：捕获会话（captureBusy）仍被这次的 long 流程占着，
   * 直到 beginCapture 的 120s 兜底超时才释放 —— 用户实测"关掉控制条后 2 分钟内所有截图入口静默失效"。
   * 与遮罩同理，收尾挂在 closed 事件上，任何关闭路径（用户点 X / Esc / 主进程强杀）都不会漏。
   */
  // 与遮罩同理：'closed' 是异步投递的，迟到的旧监听器不得抹掉更新后的句柄/钩子
  win.on('closed', () => {
    if (long !== state) return;
    long = null;
    const hook = state.onClosed;
    state.onClosed = null;
    try {
      hook?.();
    } catch (e) {
      logWarn('[capture] 长截图收尾钩子执行失败', e);
    }
  });
  loadPage(win, 'long');
  return win;
}

export function longWindow(): BrowserWindow | null {
  const st = long;
  return st && !st.win.isDestroyed() ? st.win : null;
}

/** 关闭长截图控制条，并保证释放一次捕获会话（理由同 closeOverlay：授权必须是确定性的） */
export function closeLongWindow(): void {
  const st = long;
  long = null;
  if (!st) return;
  if (!st.win.isDestroyed()) {
    try {
      st.win.destroy();
    } catch (e) {
      logWarn('[capture] 关闭长截图控制条失败', (e as Error).message);
    }
  }
  const hook = st.onClosed;
  st.onClosed = null;
  try {
    hook?.();
  } catch (e) {
    logWarn('[capture] 长截图收尾钩子执行失败', e);
  }
}

/** 主进程退出前销毁截图工作流窗口 */
export function destroyCaptureWindows(): void {
  closeOverlay();
  closeLongWindow();
  if (annotateWin && !annotateWin.isDestroyed()) annotateWin.destroy();
  annotateWin = null;
  for (const win of [...pinWins.keys()]) {
    if (!win.isDestroyed()) win.destroy();
  }
  pinWins.clear();
}
