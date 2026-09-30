import { BrowserWindow, globalShortcut, screen } from 'electron';
import { loadPage, preloadPath } from './common';
import { dataStore } from '../store/dataStore';
import { captureContext } from '../services/contextCapture';
import { listContextActions } from '../services/contextActions';
import { reportHotkey } from '../services/hotkeyManager';
import { notifyMinimizedToTray, shouldMinimizeToTray } from '../services/trayManager';
import { isQuitting } from '../utils/quitState';
import { logDebug, logWarn } from '../utils/log';
import { ensureWindowPaintable } from '../services/windowWatchdog';
import type { ContextAction, ContextPayload } from '../../shared/types';

/**
 * 桌面工作台（DeskBox 式主面板）：
 * 大毛玻璃窗口——左功能列 + 中央搜索/全部应用网格 + 右侧可折叠功能卡列。
 * 启动即显示（设置可关），全局热键默认 Ctrl+Shift+D 显示/隐藏。
 */

const PANEL_W = 1180;
const PANEL_H = 680;

let win: BrowserWindow | null = null;
let registeredKey = '';

/** 工作台最小尺寸（与 BrowserWindow 的 minWidth/minHeight 保持一致，夹取时不能违反） */
const MIN_W = 900;
const MIN_H = 560;

/**
 * 把窗口夹取到"它当前所在的显示器"的工作区内（GW-05 / OPT-05）。
 *
 * 历史缺陷：初始坐标只在 createDeskboardWindow() 里按**主显示器**算一次，
 * 之后无论显示器怎么变都不再重算。于是"外接屏拔掉 / 休眠唤醒后分辨率变化 / DPI 变化"
 * 之后，show() 会成功（窗口确实"显示了"），但位置仍停在早已不存在的坐标上 ——
 * 用户看到的是"呼出了但看不见窗口"（幽灵窗口症状②）。
 *
 * 判定用 getDisplayMatching(bounds) 而不是"光标所在显示器"：夹取的对象是**窗口自己**，
 * 按窗口当前位置找显示器才不会在用户没动鼠标时把窗口整块搬到另一块屏上
 * （paletteWindow.ts 用光标是因为命令面板本就该"跟着人走"，语义不同）。
 */
function clampToVisibleArea(w: BrowserWindow): void {
  try {
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(Math.max(b.width, MIN_W), area.width);
    const height = Math.min(Math.max(b.height, MIN_H), area.height);
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
    if (x !== b.x || y !== b.y || width !== b.width || height !== b.height) {
      logDebug('[deskboard] 显示前夹取到当前显示器工作区', JSON.stringify({ from: b, to: { x, y, width, height } }));
      w.setBounds({ x, y, width, height });
    }
  } catch (e) {
    logWarn('[deskboard] 夹取窗口位置失败（按原坐标显示）', (e as Error).message);
  }
}

/** 最近一次上下文抓取结果（渲染层挂载/重载时补齐，避免推送早于监听注册的竞态） */
let lastContext: { payload: ContextPayload; actions: ContextAction[] } | null = null;

export function lastContextEvent(): { payload: ContextPayload; actions: ContextAction[] } {
  if (lastContext) return lastContext;
  const payload: ContextPayload = { type: 'none', detail: '尚未抓取上下文' };
  return { payload, actions: listContextActions(payload) };
}

export function createDeskboardWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    x: workArea.x + Math.round((workArea.width - PANEL_W) / 2),
    y: workArea.y + Math.round((workArea.height - PANEL_H) / 2),
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 900,
    minHeight: 560,
    alwaysOnTop: true,
    skipTaskbar: false,
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
  win.setAlwaysOnTop(true, 'floating');
  loadPage(win, 'deskboard');
  // 修复（幽灵窗口）：隐藏时撤掉置顶，显示时重新置顶——
  // 防止“看不见却仍在最上层接收点击”的透明置顶窗口残留
  win.on('hide', () => {
    if (!win?.isDestroyed()) win?.setAlwaysOnTop(false);
    // 诊断（幽灵窗口排查）：记录是谁隐藏了工作台，便于定位“页面消失”类问题
    logDebug('[deskboard] 窗口被隐藏，调用栈：', new Error('hide-caller').stack?.split('\n').slice(1, 5).join(' | '));
  });
  win.on('show', () => {
    if (!win?.isDestroyed()) win?.setAlwaysOnTop(true, 'floating');
  });
  // 非常驻模式（默认）：工作台失去焦点即自动收起。
  // 覆盖"点功能按钮 → 目标窗口/应用接管"与"用户切换到别的窗口"两类场景。
  // 加 wasFocused 守卫，避免启动阶段尚未获得焦点就被误收起。
  let wasFocused = false;
  win.on('focus', () => {
    wasFocused = true;
  });
  win.on('blur', () => {
    if (wasFocused) hideDeskboardAfterAction();
  });
  // SY-03 托盘常驻：主窗口关闭最小化到托盘（从托盘“退出”时放行关闭）
  win.on('close', (e) => {
    if (!isQuitting() && shouldMinimizeToTray()) {
      e.preventDefault();
      win?.hide();
      notifyMinimizedToTray();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  return win;
}

/**
 * 显示工作台（WK-01：呼出时自动抓取上下文）
 *
 * 顺序很关键：**先**抓取上下文（此刻前台仍是用户原来的应用，模拟 Ctrl+C 才取得到选中内容），
 * 窗口用 showInactive 先行显示（不抢焦点），抓取完成后再 focus。
 * 这样"呼出 → 界面出现"几乎无延迟，"上下文动作出现"≈ 抓取耗时。
 */
export function showDeskboard(): void {
  const w = createDeskboardWindow();
  // 幽灵窗口防线：渲染进程崩溃时先恢复，避免显示出一块空白却吃点击的挡板
  ensureWindowPaintable(w);
  // GW-05 / OPT-05：显示器拔插 / 休眠唤醒 / DPI 变化后，旧坐标可能已在屏外 ——
  // 每次显示前按"窗口当前所在显示器"重算（在 show 之前执行，用户看不到跳变）
  clampToVisibleArea(w);
  const enabled = dataStore().get().settings.deskboardContextCapture !== false;
  if (!enabled) {
    w.show();
    w.focus();
    const payload: ContextPayload = { type: 'none', detail: '上下文抓取已关闭（设置 → 桌面工作台）' };
    // 即使关闭抓取，固定动作（WK-03 常驻区）仍应展示
    lastContext = { payload, actions: listContextActions(payload) };
    w.webContents.send('deskboard:context', lastContext);
    return;
  }
  // 不抢焦点地先显示（避免 Ctrl+C 落回工作台自身）
  w.showInactive();
  void captureContext({ copyKey: true })
    .then((payload) => {
      lastContext = { payload, actions: listContextActions(payload) };
      if (w.isDestroyed()) return;
      w.webContents.send('deskboard:context', lastContext);
    })
    .catch((e: unknown) => logWarn('[deskboard] 上下文抓取失败（按 none 渲染）', e))
    .finally(() => {
      /*
       * GW-07 / OPT-07：收尾聚焦必须带 isVisible 守卫。
       *
       * 时序是"showInactive → 抓取上下文（模拟 Ctrl+C，可能几百毫秒）→ focus"，
       * 而用户完全可能在这段窗口里点别处 / 按 Esc 把工作台收起。
       * 旧实现只判 isDestroyed，于是对**已隐藏**的窗口调 focus()：
       * 窗口看不见，却把输入焦点抢回自己身上 —— 表现就是"点了别的窗口，键盘却没反应"，
       * 用户只能再点一下才能继续（幽灵窗口症状③「隐藏仍响应」）。
       * 隐藏的窗口不该持有焦点，这一条在 OS 层也是共识。
       */
      if (!w.isDestroyed() && w.isVisible()) w.focus();
    });
}

export function hideDeskboard(): void {
  const w = win;
  if (!w || w.isDestroyed()) return;
  // 隐藏 = 彻底不可交互（BrowserWindow.hide 后不再接收任何输入）
  w.hide();

  /*
   * 节省资源模式（T-10）：工作台是"呼之即来"的面板，隐藏后没必要把渲染进程（实测 117MB）
   * 与它撑起的 GPU 进程（实测 +110MB）一直挂着 —— 整机空闲内存因此能省下约 230MB。
   *
   * 为什么要延迟销毁而不是立刻：
   *  · 渲染端可能刚发出 IPC（如 api.sidebar.toggle()），立刻销毁会截断尚未返回的调用；
   *  · 1.5 秒足够所有在途 IPC 收尾，此时窗口已隐藏、用户看不到任何变化。
   * 下次呼出由 showDeskboard() 按需重建（冷启动该页约 150ms，仍在 WK-01 预算内）。
   */
  if (saverReclaimEnabled()) {
    setTimeout(() => {
      if (win === w && !w.isDestroyed() && !w.isVisible()) {
        logDebug('[deskboard] 节省资源模式：回收工作台渲染进程');
        w.destroy();
      }
    }, 1500);
  }
}

/** 是否启用"隐藏后回收工作台渲染进程"（仅节省资源模式，默认自定义模式下也可单独开启） */
function saverReclaimEnabled(): boolean {
  const s = dataStore().get().settings;
  if (s.perfIdleRelease === false) return false;
  return s.perfMode === 'saver';
}

/**
 * 执行完工作台功能后按设置自动收起（主进程侧执行）。
 *
 * 为什么不只在渲染端收起：窗口一旦 `hide()`，其渲染进程立刻被后台节流/冻结，
 * 渲染端后续的 IPC（如 `api.sidebar.toggle()`）会发不出去（实测日志只见 hideDeskboard、不见 toggle）。
 * 因此"用完即走"的主路径放在主进程：工作台失焦/其它窗口获得焦点即自动收起。
 */
export function hideDeskboardAfterAction(): void {
  if (dataStore().get().settings.deskboardHideAfterAction === false) return;
  hideDeskboard();
}

export function toggleDeskboard(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideDeskboard();
  else showDeskboard();
}

/** 应用工作台全局热键（默认 Ctrl+Shift+D，设置变更时调用） */
export function applyDeskboardHotkey(): void {
  if (registeredKey) {
    try {
      globalShortcut.unregister(registeredKey);
    } catch {
      /* noop */
    }
    registeredKey = '';
  }
  const settings = dataStore().get().settings;
  if (!settings.deskboardEnabled || !settings.deskboardHotkey) return;
  try {
    if (globalShortcut.register(settings.deskboardHotkey, () => toggleDeskboard())) {
      registeredKey = settings.deskboardHotkey;
      reportHotkey('deskboard', settings.deskboardHotkey, true);
    } else {
      reportHotkey('deskboard', settings.deskboardHotkey, false, '注册失败（可能被其他程序占用）');
      logWarn('[deskboard] 热键注册失败（可能被占用）:', settings.deskboardHotkey);
    }
  } catch (e) {
    reportHotkey('deskboard', settings.deskboardHotkey, false, (e as Error).message);
    logWarn('[deskboard] 热键注册异常', e);
  }
}

/**
 * 启动时是否显示工作台（"非常驻"模式）。
 *
 * 现在默认**不随启动显示**：工作台按"呼之即来、用完即走"使用——
 * Ctrl+Shift+D / 托盘「显示主窗口（工作台）」随时呼出，执行完功能后由渲染端自动收起
 * （`settings.deskboardHideAfterAction`）。想恢复"常驻启动即显示"可打开 `deskboardShowOnStartup`。
 */
export function applyDeskboardVisibility(): void {
  const s = dataStore().get().settings;
  if (s.deskboardEnabled && s.deskboardShowOnStartup) showDeskboard();
  else hideDeskboard();
}
