import { BrowserWindow, globalShortcut, screen } from 'electron';
import { loadPage, preloadPath } from './common';
import { dataStore } from '../store/dataStore';
import { HOTKEY_DEFAULTS, reportHotkey, shouldUpgradeLegacyPaletteHotkey } from '../services/hotkeyManager';
import { logWarn } from '../utils/log';

/**
 * 全局命令面板窗口（规格 CP-01）
 *
 * - 无边框、毛玻璃、居中/顶部，浮于最上层；
 * - 失焦自动隐藏（launcher 惯例）；
 * - 热键（默认 Ctrl+Space，见 HOTKEY_DEFAULTS）注册在 applyPaletteHotkey，可自定义。
 */

const PANEL_W = 640;
const PANEL_H = 480;

let win: BrowserWindow | null = null;
let registeredKey = '';

/** 创建命令面板窗口（懒创建：首次呼出时才建立，空闲不占渲染进程） */
export function createPaletteWindow(): BrowserWindow {
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
      nodeIntegration: false,
      // GW-08 / OPT-02：常驻交互窗隐藏期间仍要跑帧与派发 IPC（详见 common.ts 的 PERMANENT_INTERACTIVE_PAGES）
      backgroundThrottling: false
    }
  });
  // screen-saver 层级：可浮于其他置顶窗口（桌面收纳盒）之上
  win.setAlwaysOnTop(true, 'screen-saver');
  loadPage(win, 'palette');
  win.on('blur', () => {
    // 禁用对焦状态下的误隐藏：面板自身聚焦期间不触发
    hidePalette();
  });
  win.on('closed', () => {
    win = null;
  });
  return win;
}

/** 显示面板：定位到光标所在显示器（多显示器适配），居中偏上 */
export function showPalette(): void {
  const w = createPaletteWindow();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  w.setBounds({
    x: area.x + Math.round((area.width - PANEL_W) / 2),
    y: area.y + Math.round(area.height * 0.16),
    width: PANEL_W,
    height: PANEL_H
  });
  w.show();
  w.focus();
  /*
   * P2-2 修复：首次呼出时窗口还在加载，palette:shown 会在渲染层注册监听之前发出并被丢弃，
   * 于是"面板打开是空的、输入框没有焦点，必须点一下才能打字"。
   * 现在：已加载则立即通知；仍在加载则等 did-finish-load 后再通知，并再次聚焦窗口与 webContents。
   */
  const notifyShown = (): void => {
    if (w.isDestroyed() || !w.isVisible()) return;
    w.webContents.send('palette:shown');
    w.focus();
    w.webContents.focus();
  };
  if (w.webContents.isLoadingMainFrame()) {
    w.webContents.once('did-finish-load', notifyShown);
  } else {
    notifyShown();
  }
}

export function hidePalette(): void {
  if (win && !win.isDestroyed()) win.hide();
}

export function togglePalette(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hidePalette();
  else showPalette();
}

/** 应用命令面板热键（设置变更 / 启停开关时调用；失败记录警告不崩溃） */
export function applyPaletteHotkey(): void {
  if (registeredKey) {
    try {
      globalShortcut.unregister(registeredKey);
    } catch {
      /* noop */
    }
    registeredKey = '';
  }
  const settings = dataStore().get().settings;
  if (!settings.paletteEnabled || !settings.paletteHotkey) return;
  const attempt = (accelerator: string): boolean => {
    try {
      if (!globalShortcut.register(accelerator, () => togglePalette())) return false;
      registeredKey = accelerator;
      reportHotkey('palette', accelerator, true);
      return true;
    } catch (e) {
      reportHotkey('palette', accelerator, false, (e as Error).message);
      return false;
    }
  };

  if (attempt(settings.paletteHotkey)) return;

  /*
   * 注册失败且存的是那个"已被判定为必然冲突"的旧默认值（P3-7 之前是 Alt+Space）：
   * 一次性升级为新默认值并重试。仅对"确实注册不上"的用户生效 —— 若该键在这台机器上可用，
   * 上面就已经注册成功、根本走不到这里，用户自己选的值不会被改掉。
   */
  if (shouldUpgradeLegacyPaletteHotkey(settings.paletteHotkey, settings.paletteHotkeyMigrated)) {
    dataStore().updateSettings({
      paletteHotkey: HOTKEY_DEFAULTS.palette,
      paletteHotkeyMigrated: true
    });
    logWarn(
      `[palette] 热键 ${settings.paletteHotkey} 与 Windows 系统菜单冲突且注册失败，已自动升级为 ${HOTKEY_DEFAULTS.palette}（可在 设置 → 快捷键 更改）`
    );
    if (attempt(HOTKEY_DEFAULTS.palette)) return;
  } else {
    logWarn(
      `[palette] 热键注册失败（可能被其他程序占用）：${settings.paletteHotkey} —— 可在 设置 → 快捷键 更换`
    );
  }
}

export function paletteWindow(): BrowserWindow | null {
  return win;
}
