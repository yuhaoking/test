import { app, globalShortcut, ipcMain } from 'electron';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { dataStore } from '../store/dataStore';
import { setPetOnTop } from '../windows/petWindow';
import { setSidebarOnTop, toggleSidebar } from '../windows/sidebarWindow';
import { applyPaletteHotkey } from '../windows/paletteWindow';
import { applyClipboardHotkey } from '../windows/clipboardWindow';
import { applyDeskboardHotkey, applyDeskboardVisibility } from '../windows/deskboardWindow';
import { applyBoxesEnabled } from '../services/desktopBoxes';
import { applyClipboardMonitor } from '../services/clipboardManager';
import { applyCaptureHotkeys } from '../services/captureManager';
import { applyTranslateHotkeys } from '../services/translateBar';
import { applyTray } from '../services/trayManager';
import { applyMcpServer } from '../services/mcpServer';
import { applyPerfMode } from '../services/perf';
import { startUpdateCheck } from '../services/updateChecker';
import { reportHotkey } from '../services/hotkeyManager';
import { unloadPlugin } from '../services/pluginManager';
import { logWarn } from '../utils/log';
import type { AppSettings, Module } from '../../shared/types';

/** 当前注册的侧边栏热键（仅注销自身，避免误杀命令面板等其它快捷键） */
let sidebarRegistered = '';

export function applyGlobalHotkey(): void {
  if (sidebarRegistered) {
    try {
      globalShortcut.unregister(sidebarRegistered);
    } catch {
      /* noop */
    }
    sidebarRegistered = '';
  }
  const hotkey = dataStore().get().settings.hotkey;
  if (!hotkey) return;
  try {
    if (globalShortcut.register(hotkey, () => toggleSidebar())) {
      sidebarRegistered = hotkey;
      reportHotkey('sidebar', hotkey, true);
    } else {
      reportHotkey('sidebar', hotkey, false, '注册失败（可能被其他程序占用）');
      logWarn('[hotkey] 注册失败（可能被占用）:', hotkey);
    }
  } catch (e) {
    reportHotkey('sidebar', hotkey, false, (e as Error).message);
    logWarn('[hotkey] 注册失败', e);
  }
}

export function applyAutostart(): void {
  app.setLoginItemSettings({ openAtLogin: dataStore().get().settings.autostart });
}

/**
 * “隐藏桌面原生图标”开关（DR-04，可选）：
 * 用 reg.exe 写入 HideIcons 注册表 + ie4uinit 刷新桌面（部分系统需重启资源管理器生效）。
 * 不使用内嵌 PowerShell 脚本，避免引号转义问题。
 */
export function applyHideDesktopIcons(): void {
  const hide = dataStore().get().settings.hideDesktopIcons ? 1 : 0;
  execFile(
    'reg.exe',
    [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
      '/v',
      'HideIcons',
      '/t',
      'REG_DWORD',
      '/d',
      String(hide),
      '/f'
    ],
    { windowsHide: true, timeout: 15000 },
    (err) => {
      if (err) logWarn('[settings] 桌面图标显示切换失败', err.message);
      // 刷新桌面图标（ie4uinit 在 Win10/11 自带；失败忽略）
      execFile('ie4uinit.exe', ['-show'], { windowsHide: true, timeout: 15000 }, () => undefined);
    }
  );
}

/** 设置变更的即时副作用（store:update-settings 与 hotkeys:set/reset 共用） */
export function applySettingsSideEffects(patch: Partial<AppSettings>): void {
  if (patch.petOnTop !== undefined) setPetOnTop(Boolean(patch.petOnTop));
  if (patch.sidebarOnTop !== undefined) setSidebarOnTop(Boolean(patch.sidebarOnTop));
  if (patch.autostart !== undefined) applyAutostart();
  if (patch.hotkey !== undefined) applyGlobalHotkey();
  // v2.0：命令面板热键/开关、桌面收纳开关、桌面图标隐藏
  if (patch.paletteHotkey !== undefined || patch.paletteEnabled !== undefined) applyPaletteHotkey();
  if (patch.desktopBoxesEnabled !== undefined) applyBoxesEnabled();
  // 智能分类开关变化：重启文件监听（监听器在 applyBoxesEnabled 内同步启停）
  if (patch.boxAutoMode !== undefined) applyBoxesEnabled();
  if (patch.hideDesktopIcons !== undefined) applyHideDesktopIcons();
  // 桌面工作台：开关/热键/启动显示变更即时生效
  if (
    patch.deskboardHotkey !== undefined ||
    patch.deskboardEnabled !== undefined ||
    patch.deskboardShowOnStartup !== undefined
  ) {
    applyDeskboardHotkey();
    applyDeskboardVisibility();
  }
  // ---- P0（T-01 / T-03 / T-04）：剪贴板、托盘、截图热键即时生效（SY-02） ----
  if (patch.clipboardEnabled !== undefined) {
    applyClipboardMonitor();
    applyClipboardHotkey();
  }
  if (patch.clipboardHotkey !== undefined) applyClipboardHotkey();
  if (patch.captureHotkey !== undefined || patch.pinHotkey !== undefined) applyCaptureHotkeys();
  // T-07：划词翻译 / 取词 OCR 热键即时生效
  if (patch.translateHotkey !== undefined || patch.ocrHotkey !== undefined) applyTranslateHotkeys();
  if (patch.trayEnabled !== undefined || patch.closeToTray !== undefined) applyTray();
  // T-05：MCP 对外工具服务开关/端口即时生效
  if (patch.mcpEnabled !== undefined || patch.mcpPort !== undefined) applyMcpServer();
  // T-10：性能模式 / 动画 / 闲置释放即时生效
  if (patch.perfMode !== undefined || patch.perfAnimations !== undefined || patch.perfIdleRelease !== undefined) {
    applyPerfMode();
  }
  // T-14（UPD-01）：开启检查更新后重新排程（延迟 30s 执行，受 1 次/天频率限制）
  if (patch.updateCheckEnabled !== undefined) startUpdateCheck();
  /*
   * P2-24 修复：托盘菜单是"构建时快照"，设置页改动后不刷新就会一直显示旧勾选状态。
   * 这里在影响托盘菜单语义的设置变更时统一刷新（动态 import 避免与 trayManager 形成静态环）。
   */
  if (
    patch.autostart !== undefined ||
    patch.clipboardEnabled !== undefined ||
    patch.desktopBoxesEnabled !== undefined ||
    // T-12：语言变了，托盘菜单的文字也要跟着变（托盘菜单是"构建时快照"）
    patch.locale !== undefined
  ) {
    void import('../services/trayManager').then((m) => m.refreshTray());
  }
}

export function registerModuleIpc(): void {
  ipcMain.handle('store:get', () => dataStore().get());

  ipcMain.handle('store:update-settings', (_e, patch: Partial<AppSettings>) => {
    dataStore().updateSettings(patch);
    applySettingsSideEffects(patch);
    // 命令面板候选集有短 TTL 缓存：设置变更后立即失效，避免"改了设置但搜索仍是旧结果"
    void import('../services/paletteSearch').then((m) => m.invalidatePaletteCache());
    return dataStore().get();
  });

  ipcMain.handle('module:add', (_e, module: Module) => {
    const data = dataStore().get();
    const m: Module = {
      ...module,
      id: module.id ?? `mod-${randomUUID()}`,
      order: data.modules.reduce((max, x) => Math.max(max, x.order), -1) + 1
    };
    dataStore().update((d) => {
      d.modules.push(m);
    });
    return dataStore().get().modules;
  });

  ipcMain.handle('module:update', (_e, id: string, patch: Partial<Module>) => {
    dataStore().update((d) => {
      const idx = d.modules.findIndex((m) => m.id === id);
      if (idx >= 0)
        d.modules[idx] = { ...d.modules[idx], ...patch, config: { ...d.modules[idx].config, ...patch.config } };
    });
    return dataStore().get().modules;
  });

  ipcMain.handle('module:delete', async (_e, id: string) => {
    const target = dataStore()
      .get()
      .modules.find((m) => m.id === id);
    // 插件聚合卡：删除聚合卡不应卸载所有插件，仅移除卡片本身
    if (target?.type === 'plugin' && target.config.pluginId && !(target.config.pluginAggregate === true)) {
      await unloadPlugin(String(target.config.pluginId));
    }
    dataStore().update((d) => {
      d.modules = d.modules.filter((m) => m.id !== id);
    });
    return dataStore().get().modules;
  });

  ipcMain.handle('module:reorder', (_e, modules: Module[]) => {
    dataStore().update((d) => {
      d.modules = modules.map((m, i) => ({ ...m, order: i }));
    });
    return dataStore().get().modules;
  });
}
