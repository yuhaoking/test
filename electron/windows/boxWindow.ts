import { BrowserWindow, screen } from 'electron';
import { loadPage, preloadPath } from './common';
import { dataStore } from '../store/dataStore';
import { updateBoxBounds } from '../services/desktopBoxes';
import type { DesktopBox } from '../../shared/types';

/**
 * 收纳盒窗口管理（规格 DR-01 / DR-04 / SY-05）
 *
 * - 无边框、透明、置顶、毛玻璃（渲染层 backdrop-filter）；
 * - 位置/尺寸变化防抖回写（多显示器，重启后恢复，SY-05）；
 * - 折叠时窗口高度收缩为标题栏高度（DR-04）。
 */

/** 折叠时标题栏高度（像素） */
const COLLAPSED_H = 44;
/** T-08 胶囊模式尺寸（收起成胶囊） */
const PILL_W = 168;
const PILL_H = 40;

const windows = new Map<string, BrowserWindow>();
const saveTimers = new Map<string, NodeJS.Timeout>();
/** 胶囊悬停临时展开中的盒子（T-08） */
const previewing = new Set<string>();

/** 显示器组合指纹（拓扑 + DPI，T-08 布局记忆） */
function displayFingerprint(): string {
  return screen
    .getAllDisplays()
    .map((d) => `${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}@${d.scaleFactor}`)
    .sort()
    .join('|');
}

/** 盒子在当前显示器组合下的目标布局（无记忆时回退单一 bounds，兼容旧数据） */
function layoutOf(box: DesktopBox): { x: number; y: number; width: number; height: number } {
  return box.layouts?.[displayFingerprint()] ?? { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** 盒子的目标显示器：优先 displayId，否则按最近点定位（多显示器适配） */
function displayFor(box: DesktopBox): Electron.Display {
  if (box.displayId != null) {
    const matched = screen.getAllDisplays().find((d) => d.id === box.displayId);
    if (matched) return matched;
  }
  const l = layoutOf(box);
  return screen.getDisplayNearestPoint({ x: l.x + l.width / 2, y: l.y + l.height / 2 });
}

/** 将盒子配置应用到窗口（限屏到目标显示器工作区内，防止越界丢失） */
function applyBounds(win: BrowserWindow, box: DesktopBox): void {
  const area = displayFor(box).workArea;
  // T-08 胶囊模式：收起成胶囊（悬停临时展开时用记忆的完整尺寸）
  if (box.capsule && !previewing.has(box.id)) {
    const l = layoutOf(box);
    const x = Math.max(area.x - 8, Math.min(l.x, area.x + area.width - PILL_W));
    const y = Math.max(area.y - 8, Math.min(l.y, area.y + area.height - PILL_H));
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: PILL_W, height: PILL_H });
    return;
  }
  /*
   * P2-6 修复：expandBounds 只在**胶囊态**下才代表"展开后的完整尺寸"。
   * 非胶囊态仍用它，会让"用过胶囊模式 → 展开后拖动到新位置 → 重启"弹回旧坐标
   * （updateBoxBounds 只更新 box.x/y，而 expandBounds 停留在收起前的快照）。
   */
  const l = box.capsule ? box.expandBounds ?? layoutOf(box) : layoutOf(box);
  const w = Math.min(Math.max(160, l.width), area.width);
  const h = box.collapsed ? COLLAPSED_H : Math.min(Math.max(120, l.height), area.height - 20);
  const x = Math.max(area.x - 8, Math.min(l.x, area.x + area.width - w));
  const y = Math.max(area.y - 8, Math.min(l.y, area.y + area.height - h));
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
}

function scheduleSave(id: string, win: BrowserWindow): void {
  if (saveTimers.has(id)) return;
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      if (!win.isDestroyed()) {
        updateBoxBounds(id, win.getBounds(), displayFingerprint());
      }
    }, 600)
  );
}

/** 应用置顶层级（用户需求 1：可选择是否置顶到第一层） */
function applyTopmost(win: BrowserWindow, box: DesktopBox): void {
  if (box.onTop) win.setAlwaysOnTop(true, 'floating');
  else win.setAlwaysOnTop(false);
}

/** 创建（或同步已存在）的盒子窗口；未启用桌面收纳时返回 null */
export function ensureBoxWindow(box: DesktopBox): BrowserWindow | null {
  if (!dataStore().get().settings.desktopBoxesEnabled) return null;
  const existing = windows.get(box.id);
  if (existing && !existing.isDestroyed()) {
    applyBounds(existing, box);
    applyTopmost(existing, box);
    if (box.visible && !existing.isVisible()) existing.showInactive();
    if (!box.visible && existing.isVisible()) existing.hide();
    return existing;
  }
  const win = new BrowserWindow({
    x: box.x,
    y: box.y,
    width: Math.max(160, box.width),
    height: box.collapsed ? COLLAPSED_H : Math.max(120, box.height),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: box.onTop,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    minWidth: 160,
    minHeight: COLLAPSED_H,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyTopmost(win, box);
  applyBounds(win, box);
  loadPage(win, 'box', { box: box.id });
  windows.set(box.id, win);
  const onMovedOrResized = (): void => {
    if (!win.isDestroyed()) scheduleSave(box.id, win);
  };
  win.on('moved', onMovedOrResized);
  win.on('resized', onMovedOrResized);
  win.on('closed', () => {
    windows.delete(box.id);
    const t = saveTimers.get(box.id);
    if (t) {
      clearTimeout(t);
      saveTimers.delete(box.id);
    }
  });
  if (box.visible) win.showInactive();
  return win;
}

export function destroyBoxWindow(id: string): void {
  const win = windows.get(id);
  if (win && !win.isDestroyed()) win.destroy();
  windows.delete(id);
}

/** 按总开关同步全部盒子窗口（启用/关闭桌面收纳） */
export function syncBoxWindows(boxes: DesktopBox[], enabled: boolean): void {
  if (!enabled) {
    for (const id of [...windows.keys()]) destroyBoxWindow(id);
    return;
  }
  const ids = new Set(boxes.map((b) => b.id));
  for (const id of [...windows.keys()]) {
    if (!ids.has(id)) destroyBoxWindow(id);
  }
  for (const box of boxes) ensureBoxWindow(box);
}

/** 由 sender 窗口反查盒子 id（用于拖放归属） */
export function windowBoxId(win: BrowserWindow): string | null {
  for (const [id, w] of windows) {
    if (w === win) return id;
  }
  return null;
}

export function boxWindowByBoxId(boxId: string): BrowserWindow | null {
  const win = windows.get(boxId);
  return win && !win.isDestroyed() ? win : null;
}

// ---------- T-08 胶囊模式 / 盒子组 ----------

/** 胶囊悬停临时展开 / 收回（渲染层 mouseenter/mouseleave 触发） */
export function setCapsulePreview(id: string, on: boolean): void {
  if (on) previewing.add(id);
  else previewing.delete(id);
  const win = windows.get(id);
  if (!win || win.isDestroyed()) return;
  const box = currentBoxOf(id);
  if (box) applyBounds(win, box);
}

/**
 * 盒子组：同组（group 同名）的胶囊并排停靠成胶囊栏，
 * 以组内 order 最小者为锚点横向排列。
 */
export function arrangeCapsuleGroups(boxes: DesktopBox[]): void {
  const groups = new Map<string, DesktopBox[]>();
  for (const b of boxes) {
    if (!b.capsule || !b.group || !b.visible) continue;
    const list = groups.get(b.group) ?? [];
    list.push(b);
    groups.set(b.group, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.order - b.order);
    const leader = list[0];
    const anchor = layoutOf(leader);
    list.forEach((box, i) => {
      const win = windows.get(box.id);
      if (!win || win.isDestroyed()) return;
      const x = Math.round(anchor.x + i * (PILL_W + 8));
      const y = Math.round(anchor.y);
      win.setBounds({ x, y, width: PILL_W, height: PILL_H });
    });
  }
}

/** 由窗口侧读取当前盒子配置（防循环依赖，desktopBoxes 在窗口创建后回填） */
let boxLookup: ((id: string) => DesktopBox | null) | null = null;

export function registerBoxLookup(fn: (id: string) => DesktopBox | null): void {
  boxLookup = fn;
}

function currentBoxOf(id: string): DesktopBox | null {
  return boxLookup ? boxLookup(id) : null;
}

/** 主进程退出前销毁所有盒子窗口 */
export function destroyAllBoxWindows(): void {
  for (const id of [...windows.keys()]) destroyBoxWindow(id);
}
