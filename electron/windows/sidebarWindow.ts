import { BrowserWindow, screen } from 'electron';
import { loadPage, preloadPath } from './common';
import { dataStore } from '../store/dataStore';
import { hidePet, showPet } from './petWindow';
import { hideDeskboard } from './deskboardWindow';
import { ensureWindowPaintable } from '../services/windowWatchdog';
import { logDebug, logWarn } from '../utils/log';
import { beginCollapseSession, shouldCollapseOnBlur, stepCollapse, type CollapseState } from '../../shared/windowBehavior.ts';

let win: BrowserWindow | null = null;
/** 自动收回状态机（规则本体在 shared/windowBehavior.ts，纯函数可断言） */
let collapse: CollapseState = beginCollapseSession(0);
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
const PAD = 12;
const PAD_SIDE = 12;

/** 自动收回检查间隔（毫秒） */
const COLLAPSE_CHECK_INTERVAL = 500;

function autoCollapseEnabled(): boolean {
  return Boolean(dataStore().get().settings.sidebarAutoCollapse);
}

/** 停止自动收回检查：窗口隐藏期间不再有任何定时器唤醒，降低空闲资源占用 */
function stopCollapseWatch(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  collapse = beginCollapseSession(0);
}

/** 自调度检查：仅在侧边栏可见期间保持运行，隐藏后自动停止 */
function scheduleCollapseCheck(): void {
  if (collapseTimer) return;
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    tickCollapseCheck();
  }, COLLAPSE_CHECK_INTERVAL);
}

function tickCollapseCheck(): void {
  // 窗口不可见/已销毁：结束检查链，等待下次 showSidebar 重新调度
  if (!win || win.isDestroyed() || !win.isVisible()) {
    collapse = beginCollapseSession(0);
    return;
  }
  if (autoCollapseEnabled()) {
    const b = win.getBounds();
    const cur = screen.getCursorScreenPoint();
    const inside = cur.x >= b.x && cur.x <= b.x + b.width && cur.y >= b.y && cur.y <= b.y + b.height;
    // 宽限期 + 离开去抖都在纯函数里（含"从未入内则不收回"），此处只做采样与执行
    const result = stepCollapse(collapse, { now: Date.now(), inside });
    collapse = result.state;
    if (result.collapse) {
      logDebug('[sidebar] 光标已持续离开，自动收回');
      hideSidebar();
      return;
    }
  }
  scheduleCollapseCheck();
}

/** 鼠标离开/失焦时收回侧边栏（显示宠物形态） */
export function startAutoCollapseWatch(): void {
  const attach = (w: BrowserWindow): void => {
    // 失焦收回：但仅在"用户已经用过侧边栏"（光标进入过）之后才收回。
    // 否则从工作台/宠物刚呼出的侧边栏会因呼出瞬间的失焦被判为"离开"而闪一下就没，
    // 用户会以为功能失效（历史实测：点击工作台「侧边栏」→ 侧边栏闪现即收回）。
    w.on('blur', () => {
      if (!autoCollapseEnabled()) return;
      if (!shouldCollapseOnBlur(collapse, Date.now())) return;
      collapse = beginCollapseSession(0);
      if (isSidebarVisible()) hideSidebar();
    });
  };
  if (win && !win.isDestroyed()) attach(win);
  scheduleCollapseCheck();
}

export function createSidebarWindow(): BrowserWindow {
  win = new BrowserWindow({
    width: 384,
    height: 420,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: dataStore().get().settings.sidebarOnTop,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // GW-08 / OPT-02：常驻交互窗隐藏期间仍要跑帧与派发 IPC（详见 common.ts 的 PERMANENT_INTERACTIVE_PAGES）
      backgroundThrottling: false
    }
  });
  if (dataStore().get().settings.sidebarOnTop) win.setAlwaysOnTop(true, 'floating');
  loadPage(win, 'index');

  /*
   * 宠物可见性由侧边栏窗口的**真实显隐**派生，而不是在调用点成对手写。
   *
   * 历史缺陷：`showSidebar→hidePet`、`hideSidebar→showPet` 靠人工配对，只要有一条隐藏路径没走到
   * `hideSidebar`（窗口被销毁、被系统隐藏、将来新增的调用点），宠物就再也回不来 ——
   * 用户看到的是"侧边栏一开、宠物就没了"，而且没有别的入口能救回来。
   * 现在把"恢复"挂在窗口事件上：任何让侧边栏消失的路径都会自动把宠物还回来。
   *
   * 为什么"隐藏宠物"仍留在 showSidebar 里手写：它只有一个入口，且窗口已可见时不会再触发 'show' 事件，
   * 手写一次能保证不变量在任何调用顺序下都成立（hidePet 本身是幂等的）。
   */
  win.on('show', () => hidePet());
  win.on('hide', () => showPet());
  win.on('closed', () => {
    stopCollapseWatch();
    win = null;
    // 窗口被销毁也要把宠物还回来（旧实现在这里形成"宠物永远回不来"的死锁）
    showPet();
  });
  return win;
}

export function applySidebarBounds(width: number): void {
  if (!win || win.isDestroyed()) return;
  // P2-4 修复：按“光标所在显示器”的工作区计算（多显示器下不再永远锚定主屏）
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = Math.min(Math.max(width, 260), 600) + PAD_SIDE * 2;
  win.setBounds({
    x: workArea.x + workArea.width - w,
    y: workArea.y + PAD,
    width: w,
    height: Math.max(300, workArea.height - PAD * 2)
  });
}

export function isSidebarVisible(): boolean {
  return Boolean(win && !win.isDestroyed() && win.isVisible());
}

export function setSidebarOnTop(onTop: boolean): void {
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(Boolean(onTop), 'floating');
  }
}

export function showSidebar(): void {
  /*
   * P2-3 修复：窗口被真正关闭（销毁）后必须能重建。
   * 旧实现在这里直接 return 并只打一行日志，而 createSidebarWindow 全仓仅 main.ts 启动时调用一次 ——
   * 于是"一旦侧边栏窗口被关掉，本次运行内热键/托盘/双击宠物全部失效，宠物也回不来"（showSidebar 已 hidePet，
   * 而 showPet 只在 hideSidebar 里调用，形成死锁）。现在按需重建并重挂自动收回监听。
   */
  if (!win || win.isDestroyed()) {
    logWarn('[sidebar] 窗口不存在或已销毁，按需重建');
    createSidebarWindow();
    startAutoCollapseWatch();
  }
  if (!win || win.isDestroyed()) {
    logWarn('[sidebar] 窗口重建失败，无法显示');
    return;
  }
  logDebug(`[sidebar] showSidebar：bounds 前 = ${JSON.stringify(win.getBounds())}`);

  /*
   * 先收起工作台再显示侧边栏。
   * 工作台是居中的置顶窗（最小 900 宽），侧边栏贴在屏幕右缘 —— 两者在 1536 宽的屏上就重叠约 190px，
   * 而工作台失焦后才收起。这个"重叠窗口期"里点侧边栏会落到工作台上，用户感受就是
   * "从工作台打开侧边栏后偶尔点不动"。显式先收起，把这个竞态窗口彻底去掉。
   */
  hideDeskboard();

  // 幽灵窗口防线：渲染进程若已崩溃，`show()` 出来的是空白但吃点击的窗口——先恢复再显示
  ensureWindowPaintable(win);
  applySidebarBounds(dataStore().get().settings.sidebarWidth);
  setSidebarOnTop(dataStore().get().settings.sidebarOnTop);
  hidePet();
  // 每次显示都重置收回状态机：把上一次的"入内过"带过来会让新一轮的第一次外部采样就直接收回
  collapse = beginCollapseSession(Date.now());
  win.show();
  win.focus();
  // 重新激活自动收回检查链
  scheduleCollapseCheck();
}

export function hideSidebar(): void {
  // 即使窗口已不存在也要继续：宠物的恢复挂在窗口事件上，而这里还要清掉定时器
  stopCollapseWatch();
  if (!win || win.isDestroyed()) return;
  win.hide(); // 'hide' 事件里会 showPet()，不在这里成对调用
  logDebug('[sidebar] hideSidebar：已收回并显示宠物');
}

export function toggleSidebar(): void {
  const exists = Boolean(win && !win.isDestroyed());
  const visible = isSidebarVisible();
  logDebug(`[sidebar] toggle：窗口存在=${exists} 当前可见=${visible}`);
  if (visible) hideSidebar();
  else showSidebar();
}

export function setSidebarWidth(width: number): void {
  const clamped = Math.min(Math.max(Math.round(width), 260), 600);
  dataStore().updateSettings({ sidebarWidth: clamped });
  applySidebarBounds(clamped);
}

export function sidebarWindow(): BrowserWindow | null {
  return win;
}
