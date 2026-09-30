import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { app, desktopCapturer, dialog, globalShortcut, nativeImage, Notification, screen } from 'electron';
import { dataStore } from '../store/dataStore';
import { setClipboardImage } from './clipboardManager';
import { reportHotkey } from './hotkeyManager';
import { sendKeys } from '../utils/sendkeys';
import {
  closeLongWindow,
  closeOverlay,
  createAnnotateWindow,
  createLongWindow,
  createOverlayWindow,
  createPinWindow,
  createPinWindowFromFile,
  longWindow,
  overlayModeOf,
  overlayWindow,
  pushSurfaces
} from '../windows/captureWindows';
import { logDebug, logWarn } from '../utils/log';
import type { AnnotatePayload, CaptureRect, CaptureSurface } from '../../shared/types';

/**
 * 截图增强（T-04）：贴图 / 标注 / 滚动长截图 / 屏幕取色器（CH-06）
 *
 * 捕获内核走 Electron desktopCapturer（免插件、免 Python），
 * 与现有 4 个 Python 截图插件互补：插件可发 `pin.capture` 事件复用贴图能力。
 *
 * 流程（验收：截图 → 标注 → 贴图/复制 ≤ 3 步）：
 *   热键 → 遮罩拖选 → 标注器（箭头/文字/矩形/马赛克）→ 一键 贴图/复制/保存。
 */

let surfaces: CaptureSurface[] = [];
let longRect: CaptureRect | null = null;
let lastSegmentFp = '';

// ---------- 捕获会话互斥（SVC-9） ----------

let captureBusy = false;
let captureBusyTimer: NodeJS.Timeout | null = null;

/** 会话兜底超时（毫秒）：异常路径下自动释放，避免截图功能被永久锁死 */
const CAPTURE_BUSY_TIMEOUT_MS = 120_000;

let busyNotifiedAt = 0;

/**
 * 提示用户"上一次截图会话还没结束"（GW-06 / OPT-06）。
 *
 * 旧实现是静默 return + 一行 logWarn：用户按下热键、屏幕毫无反应，
 * 既不知道发生了什么，也不知道怎么救（只能等 2 分钟兜底或重启）。
 * 同一分钟内只提示一次，避免用户反复按热键时刷屏。
 */
function notifyCaptureBusy(): void {
  const now = Date.now();
  if (now - busyNotifiedAt < 60_000) return;
  busyNotifiedAt = now;
  if (!Notification.isSupported()) return;
  new Notification({
    title: '小鹏工具箱',
    body: '上一次截图还没结束，本次请求已忽略。可从托盘菜单「退出截图」强制结束。'
  }).show();
}

/** 开始一次捕获会话；已有会话进行中时返回 false（忽略本次请求并提示用户） */
function beginCapture(): boolean {
  if (captureBusy) {
    logWarn('[capture] 已有截图会话进行中，忽略本次请求（避免全局状态错乱）');
    notifyCaptureBusy();
    return false;
  }
  captureBusy = true;
  if (captureBusyTimer) clearTimeout(captureBusyTimer);
  // 兜底：异常路径下 2 分钟自动释放，避免截图功能被永久锁死
  captureBusyTimer = setTimeout(() => {
    logWarn('[capture] 捕获会话超时（120s），强制释放并关闭遮罩');
    endCapture();
    // OPT-03 ③：兜底释放的同时把遮罩关掉 —— 只解锁而不关遮罩，会留下一个"全屏但点不动"的空遮罩
    closeOverlay();
  }, CAPTURE_BUSY_TIMEOUT_MS);
  return true;
}

function endCapture(): void {
  captureBusy = false;
  if (captureBusyTimer) {
    clearTimeout(captureBusyTimer);
    captureBusyTimer = null;
  }
}

/**
 * 遮罩收尾（注入给 captureWindows，任何销毁路径都会调用）：释放互斥锁 + 清掉长截图选中区。
 *
 * 这里是 GW-03 的根治点：遮罩的消失与"会话是否还被占用"必须绑在一起。
 *
 * **注意 longRect 的清空必须带条件**：长截图流程本身就是"遮罩选完区域 → 关遮罩 → 开控制条"，
 * 关闭遮罩是**正常步骤**而不是会话结束。若无条件清空 longRect，
 * `longStep()` 的 `if (!longRect || !longWindow()) return null` 会立刻返回 null，
 * 长截图从第一步起就"到底了"（渲染层表现为拉伸不出任何内容）。
 * 因此只在"没有控制条接管这次会话"时才清空它。
 */
function onOverlayTornDown(): void {
  if (!longWindow()) {
    longRect = null;
    lastSegmentFp = '';
  }
  endCapture();
}

/**
 * 用户逃生口（GW-03 / OPT-03）：强制结束当前截图会话。
 *
 * 场景：遮罩渲染进程卡死 —— 屏幕被一层全屏置顶透明窗盖住，**整屏都点不动**，
 * 而托盘里的"修复卡住的窗口"刻意跳过了遮罩（windowWatchdog.ts 的 RELOADABLE 白名单），
 * 用户此时没有任何自救手段（只能杀进程）。
 *
 * 因此提供一条与渲染层 `capture:cancel` 完全等价的**主进程路径**：
 * 关闭遮罩 + 关闭长截图控制条 + 释放互斥锁。不 reload 遮罩（reload 只会留下一块没有 surfaces 的空遮罩）。
 */
export function abortCapture(): { ok: boolean; detail: string } {
  const hadOverlay = Boolean(overlayWindow());
  const hadLong = Boolean(longWindow());
  closeOverlay();
  closeLongWindow();
  longRect = null;
  lastSegmentFp = '';
  endCapture();
  const detail = hadOverlay || hadLong ? '已结束截图会话' : '当前没有进行中的截图会话';
  logWarn('[capture] 逃生口：强制结束截图会话', detail);
  return { ok: hadOverlay || hadLong, detail };
}

/** 是否存在进行中的捕获会话（托盘菜单/诊断用） */
export function captureSessionActive(): boolean {
  return captureBusy;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- 捕获内核 ----------

export async function grabSurfaces(): Promise<CaptureSurface[]> {
  const displays = screen.getAllDisplays();
  let maxW = 0;
  let maxH = 0;
  for (const d of displays) {
    maxW = Math.max(maxW, Math.round(d.bounds.width * d.scaleFactor));
    maxH = Math.max(maxH, Math.round(d.bounds.height * d.scaleFactor));
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW || 1920, height: maxH || 1080 }
  });
  const out: CaptureSurface[] = [];
  displays.forEach((d, i) => {
    const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[i] ?? sources[0];
    if (!src || src.thumbnail.isEmpty()) return;
    out.push({
      displayId: d.id,
      bounds: { ...d.bounds },
      scaleFactor: d.scaleFactor || 1,
      dataUrl: src.thumbnail.toDataURL()
    });
  });
  surfaces = out;
  return out;
}

/** 按虚拟桌面 DIP 选区裁剪出 PNG dataURL */
export function cropToDataUrl(rect: CaptureRect): string {
  const surface = surfaces.find((s) => s.displayId === rect.displayId) ?? surfaces[0];
  if (!surface) throw new Error('没有可用的屏幕捕获面');
  const img = nativeImage.createFromDataURL(surface.dataUrl);
  const size = img.getSize();
  const sx = size.width / surface.bounds.width;
  const sy = size.height / surface.bounds.height;
  const x = Math.max(0, Math.round((rect.x - surface.bounds.x) * sx));
  const y = Math.max(0, Math.round((rect.y - surface.bounds.y) * sy));
  const w = Math.min(size.width - x, Math.max(1, Math.round(rect.width * sx)));
  const h = Math.min(size.height - y, Math.max(1, Math.round(rect.height * sy)));
  return img.crop({ x, y, width: w, height: h }).toDataURL();
}

// ---------- 入口（热键 / 命令面板 / 设置页） ----------

async function openOverlay(mode: 'region' | 'long' | 'color' | 'ocr'): Promise<void> {
  // SVC-9 修复：同一时刻只允许一个捕获会话（此前热键与 MCP screenshot 并发时全局 surfaces/mode 互相覆盖 → 裁剪错屏/错模式）
  if (!beginCapture()) return;
  try {
    await grabSurfaces();
  } catch (e) {
    endCapture();
    throw e;
  }
  /*
   * OPT-03 ①：遮罩的渲染进程崩溃 / 无响应 → 主进程直接关掉遮罩（**不 reload**）。
   * reload 只会得到"没有 surfaces 的空遮罩"（全屏、置顶、点不动），比没有遮罩更糟。
   * 关闭走 closeOverlay → closed 钩子 → 释放互斥锁，用户 ≤5s 内恢复整屏点击。
   */
  const win = createOverlayWindow(mode, onOverlayTornDown);
  win.webContents.on('render-process-gone', (_e, details) => {
    logWarn(`[capture] 遮罩渲染进程异常退出（reason=${details.reason}），已直接关闭遮罩`);
    closeOverlay();
  });
  win.webContents.on('unresponsive', () => {
    logWarn('[capture] 遮罩无响应，已直接关闭遮罩（避免全屏点不动）');
    closeOverlay();
  });
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return; // 加载期间可能已被超时兜底/逃生口关掉
    pushSurfaces(surfaces);
    win.show();
    win.focus();
  });
}

export async function startRegionCapture(): Promise<void> {
  await openOverlay('region');
}

export async function startLongCapture(): Promise<void> {
  await openOverlay('long');
}

export async function startColorPicker(): Promise<void> {
  await openOverlay('color');
}

/** T-07 取词 OCR：框选屏幕区域 → Tesseract 识别 → 悬浮文本条 */
export async function startOcrCapture(): Promise<void> {
  await openOverlay('ocr');
}

export async function startFullCapture(): Promise<void> {
  if (!beginCapture()) return;
  try {
    await grabSurfaces();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    openAnnotate({ mode: 'edit', dataUrl: cropToDataUrl({ displayId: display.id, ...display.bounds }) });
  } finally {
    endCapture();
  }
}

// ---------- 遮罩回调 ----------

export async function handlePickRegion(rect: CaptureRect): Promise<void> {
  const mode = overlayModeOf();
  closeOverlay();
  if (mode === 'long') {
    // 长截图继续沿用本次会话的 surfaces，直到 finish/stop 才释放互斥
    longRect = rect;
    lastSegmentFp = '';
    // OPT-06：控制条被关掉（任何路径）→ longStop + 关闭遮罩 + 释放互斥锁
    createLongWindow(rect, () => {
      longRect = null;
      lastSegmentFp = '';
      closeOverlay();
      endCapture();
      logDebug('[capture] 长截图控制条已关闭，捕获会话已释放');
    });
    return;
  }
  endCapture();
  if (mode === 'ocr') {
    // T-07 取词 OCR：裁剪 → 临时图 → Tesseract 识别 → 悬浮文本条
    try {
      const img = nativeImage.createFromDataURL(cropToDataUrl(rect));
      const file = join(app.getPath('temp'), `xpos-ocr-${Date.now()}.png`);
      writeFileSync(file, img.toPNG());
      void import('./translateBar').then((m) => m.showOcr(file));
    } catch (e) {
      logWarn('[capture] 取词 OCR 裁剪失败', e);
    }
    return;
  }
  try {
    openAnnotate({ mode: 'edit', dataUrl: cropToDataUrl(rect) });
  } catch (e) {
    logWarn('[capture] 区域裁剪失败', e);
  }
}

export function handleCancel(): void {
  closeOverlay();
  endCapture();
}

export function cursorPos(): { x: number; y: number } {
  return screen.getCursorScreenPoint();
}

// ---------- 标注器 ----------

function openAnnotate(payload: AnnotatePayload): void {
  createAnnotateWindow(payload);
  logDebug('[capture] 标注器已打开');
}

export function copyImage(dataUrl: string): void {
  setClipboardImage(nativeImage.createFromDataURL(dataUrl));
  new Notification({ title: '小鹏工具箱', body: '截图已复制到剪贴板' }).show();
}

export function saveImage(dataUrl: string): string | null {
  const settings = dataStore().get().settings;
  const name = `截图_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.png`;
  const dir = settings.saveDir || app.getPath('pictures');
  const res = dialog.showSaveDialogSync({ title: '保存截图', defaultPath: join(dir, name), filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (!res) return null;
  try {
    writeFileSync(res, nativeImage.createFromDataURL(dataUrl).toPNG());
    return res;
  } catch (e) {
    logWarn('[capture] 截图保存失败', e);
    return null;
  }
}

export function pinImage(dataUrl: string): void {
  createPinWindow(dataUrl);
}

export function pinClipboardImage(): void {
  // 动态引入避免与 clipboardManager 的窗口依赖形成静态环
  void import('electron').then(({ clipboard }) => {
    const img = clipboard.readImage();
    if (img.isEmpty()) {
      new Notification({ title: '小鹏工具箱', body: '剪贴板中没有图片，无法贴图' }).show();
      return;
    }
    createPinWindow(img.toDataURL());
  });
}

export { createPinWindowFromFile };

// ---------- 滚动长截图（T-04） ----------

/** 捕获长截图像素段；autoScroll 时先向目标窗口发送 PgDn。到底（画面不再变化）返回 null */
export async function longStep(autoScroll: boolean): Promise<string | null> {
  if (!longRect || !longWindow()) return null;
  if (autoScroll) {
    sendKeys('{PGDN}', 0);
    await sleep(700);
  }
  let dataUrl: string;
  try {
    dataUrl = cropToDataUrl(longRect);
  } catch (e) {
    logWarn('[capture] 长截图分段捕获失败', e);
    return null;
  }
  const fp = createHash('sha1').update(dataUrl).digest('hex');
  if (autoScroll && fp === lastSegmentFp) {
    lastSegmentFp = '';
    return null;
  }
  lastSegmentFp = fp;
  return dataUrl;
}

export function longStop(): void {
  lastSegmentFp = '';
  endCapture();
}

export function longFinish(segments: string[]): void {
  closeLongWindow();
  longRect = null;
  endCapture();
  // P3 加固：分段数量上限，避免超长拼接把主进程内存打满
  const list = (Array.isArray(segments) ? segments : []).slice(0, 100);
  if (!list.length) return;
  openAnnotate({ mode: 'stitch', segments: list });
}

// ---------- 全局热键（SY-02 登记） ----------

let captureRegistered = '';
let pinRegistered = '';

export function applyCaptureHotkeys(): void {
  const s = dataStore().get().settings;
  for (const [key, action] of [
    [captureRegistered, 'capture'],
    [pinRegistered, 'pin']
  ] as Array<[string, 'capture' | 'pin']>) {
    if (key) {
      try {
        globalShortcut.unregister(key);
      } catch {
        /* noop */
      }
      if (action === 'capture') captureRegistered = '';
      else pinRegistered = '';
    }
  }
  if (s.captureHotkey) {
    try {
      if (globalShortcut.register(s.captureHotkey, () => void startRegionCapture())) {
        captureRegistered = s.captureHotkey;
        reportHotkey('capture', s.captureHotkey, true);
      } else {
        reportHotkey('capture', s.captureHotkey, false, '注册失败（可能被其他程序占用）');
        logWarn('[capture] 截图热键注册失败:', s.captureHotkey);
      }
    } catch (e) {
      reportHotkey('capture', s.captureHotkey, false, (e as Error).message);
      logWarn('[capture] 截图热键注册异常', e);
    }
  }
  if (s.pinHotkey) {
    try {
      if (globalShortcut.register(s.pinHotkey, () => pinClipboardImage())) {
        pinRegistered = s.pinHotkey;
        reportHotkey('pin', s.pinHotkey, true);
      } else {
        reportHotkey('pin', s.pinHotkey, false, '注册失败（可能被其他程序占用）');
        logWarn('[capture] 贴图热键注册失败:', s.pinHotkey);
      }
    } catch (e) {
      reportHotkey('pin', s.pinHotkey, false, (e as Error).message);
      logWarn('[capture] 贴图热键注册异常', e);
    }
  }
}
