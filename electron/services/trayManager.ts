import { app, Menu, Notification, Tray, nativeImage } from 'electron';
import { join } from 'path';
import { dataStore, resourcesRoot } from '../store/dataStore';
import { showDeskboard } from '../windows/deskboardWindow';
import { openSettingsWindow } from '../windows/settingsWindow';
import { applyBoxesEnabled } from './desktopBoxes';
import { applyClipboardMonitor } from './clipboardManager';
import { applyClipboardHotkey } from '../windows/clipboardWindow';
import { abortCapture, captureSessionActive } from './captureManager';
import { setQuitting } from '../utils/quitState';
import { logDebug, logWarn } from '../utils/log';
import { repairStuckWindows } from './windowWatchdog';
import { openReleasePage, updateState } from './updateChecker';
import { t } from './i18n';

/**
 * 托盘常驻（SY-03 / SY-04）
 *
 * - 主窗口关闭最小化到托盘（deskboardWindow 的 close 拦截逻辑配合 quitState）；
 * - 托盘菜单：显示主窗口 / 显示设置 / 启用禁用收纳盒 / 剪贴板记录开关 / 开机自启 / 退出；
 * - 退出走 before-quit 置位 quitState，窗口 close 拦截据此放行。
 */

let tray: Tray | null = null;
let closeToTrayNotified = false;

function buildMenu(): Menu {
  const s = dataStore().get().settings;
  const update = updateState();
  const updateItems: Electron.MenuItemConstructorOptions[] = update.hasUpdate
    ? [
        {
          label: t('tray.newVersion', { version: update.latestVersion ?? '' }),
          click: () => void openReleasePage()
        },
        { type: 'separator' }
      ]
    : [];
  return Menu.buildFromTemplate([
    ...updateItems,
    { label: t('tray.showMain'), click: () => showDeskboard() },
    { label: t('tray.showSettings'), click: () => openSettingsWindow() },
    {
      // 幽灵窗口逃生口：透明置顶窗若因渲染异常变成“看不见却挡住点击”，一键重载常驻 UI
      label: t('tray.repairWindows'),
      click: () => {
        const list = repairStuckWindows();
        logDebug('[tray] 已修复窗口', list.join('、') || '无');
        if (Notification.isSupported()) {
          new Notification({
            title: t('app.name'),
            body: list.length ? t('tray.repaired', { n: list.length, list: list.join('、') }) : t('tray.nothingToRepair')
          }).show();
        }
      }
    },
    {
      /*
       * GW-03 / OPT-03：截图逃生口。
       *
       * 截图遮罩是**全屏置顶透明窗**：它一旦卡住（渲染进程冻结/崩溃），屏幕就整块点不动，
       * 而上面的「修复卡住的窗口」刻意跳过遮罩（它是瞬态窗口，reload 会留下一块没有 surfaces 的空遮罩）。
       * 于是用户在遮罩卡死时没有任何自救手段，只能杀进程。
       * 这一项走主进程侧的 abortCapture：关闭遮罩 + 关闭长截图控制条 + 释放互斥锁，
       * 与渲染层 `capture:cancel` 完全等价，且**任何状态下都可用**（没有会话时也能安全点击）。
       */
      label: t('tray.abortCapture'),
      click: () => {
        const had = captureSessionActive();
        const res = abortCapture();
        if (Notification.isSupported()) {
          new Notification({
            title: t('app.name'),
            body: had || res.ok ? t('tray.captureAborted') : t('tray.noCapture')
          }).show();
        }
      }
    },
    { type: 'separator' },
    {
      label: t('tray.toggleBoxes'),
      type: 'checkbox',
      checked: s.desktopBoxesEnabled,
      click: () => {
        dataStore().updateSettings({ desktopBoxesEnabled: !s.desktopBoxesEnabled });
        applyBoxesEnabled();
        refreshTray();
      }
    },
    {
      label: t('tray.toggleClipboard'),
      type: 'checkbox',
      checked: s.clipboardEnabled,
      click: () => {
        dataStore().updateSettings({ clipboardEnabled: !s.clipboardEnabled });
        applyClipboardMonitor();
        /*
         * P2-24 修复：剪贴板面板热键的注册条件是 clipboardEnabled（见 clipboardWindow.applyClipboardHotkey），
         * 而这里以前只重启监听、没重放热键副作用 —— 于是"托盘里关掉再打开剪贴板记录"之后
         * Ctrl+Shift+V 唤不出面板，必须回设置页再切一次。这里补上重放。
         */
        applyClipboardHotkey();
        refreshTray();
      }
    },
    {
      label: t('tray.autostart'),
      type: 'checkbox',
      checked: s.autostart,
      click: () => {
        dataStore().updateSettings({ autostart: !s.autostart });
        app.setLoginItemSettings({ openAtLogin: !s.autostart });
        refreshTray();
      }
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: () => {
        setQuitting();
        app.quit();
      }
    }
  ]);
}

/** 刷新托盘菜单勾选状态（设置变化 / 托盘内切换后调用） */
export function refreshTray(): void {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

export function createTray(): void {
  if (tray && !tray.isDestroyed()) return;
  try {
    const icon = nativeImage.createFromPath(join(resourcesRoot(), 'default-pet.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
    tray.setToolTip(t('tray.tooltip'));
    tray.setContextMenu(buildMenu());
    tray.on('double-click', () => showDeskboard());
    logDebug('[tray] 托盘已创建');
  } catch (e) {
    logWarn('[tray] 托盘创建失败', e);
    tray = null;
  }
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

/** 随设置启停托盘（SY-03） */
export function applyTray(): void {
  if (dataStore().get().settings.trayEnabled) createTray();
  else destroyTray();
  refreshTray();
}

/** 主窗口关闭是否最小化到托盘（deskboardWindow close 事件调用） */
export function shouldMinimizeToTray(): boolean {
  const s = dataStore().get().settings;
  return s.trayEnabled && s.closeToTray;
}

/** 关闭拦截提示（仅提示一次） */
export function notifyMinimizedToTray(): void {
  if (closeToTrayNotified) return;
  closeToTrayNotified = true;
  new Notification({ title: t('app.name'), body: t('tray.minimizedToTray') }).show();
}
