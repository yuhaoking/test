import { Notification } from 'electron';
import { dataStore } from '../store/dataStore';
import { t } from './i18n';
import { HOTKEY_DEFAULTS, RETIRED_PALETTE_HOTKEY, shouldUpgradeLegacyPaletteHotkey } from '../../shared/hotkeys.ts';
import { logWarn } from '../utils/log';
import type { AppSettings, HotkeyAction, HotkeyInfo } from '../../shared/types';

// 规则本体在 shared/hotkeys.ts（纯函数，npm test 可直接断言）；这里只做转出，保持调用方 import 路径不变
export { HOTKEY_DEFAULTS, RETIRED_PALETTE_HOTKEY, shouldUpgradeLegacyPaletteHotkey };

/**
 * 全局快捷键管理（SY-02）
 *
 * 统一登记所有全局热键（侧边栏 / 命令面板 / 工作台 / 剪贴板面板 / 截图 / 贴图）：
 * - 各窗口模块注册后回报结果（reportHotkey），此处汇总冲突检测与状态展示；
 * - 修改立即生效（由 moduleIpc 的设置副作用触发重注册）；一键可恢复默认。
 */

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  sidebar: '呼出 / 收起侧边栏',
  palette: '全局命令面板',
  deskboard: '桌面工作台（显示/隐藏）',
  clipboard: '剪贴板粘贴面板',
  capture: '区域截图',
  pin: '贴图（剪贴板图片钉到桌面）',
  translate: '划词翻译（选中文本 → 悬浮翻译条，T-07）',
  ocr: '取词 OCR（框选屏幕文字 → 悬浮文本条，T-07）'
};

const ACTIONS: HotkeyAction[] = ['sidebar', 'palette', 'deskboard', 'clipboard', 'capture', 'pin', 'translate', 'ocr'];

interface Report {
  accelerator: string;
  ok: boolean;
  error?: string;
}

const reports = new Map<HotkeyAction, Report>();

/**
 * GW-04 / OPT-04：热键注册失败必须让用户**看见**，不能只写一行日志。
 *
 * 实锤场景（缺陷分析 GW-04 + 用户日志）：09-22 → 09-27 五天里命令面板完全呼不出，
 * 而原因只是 Ctrl+Space 被别的程序占用 —— 应用侧只有一条 WARN，用户侧毫无提示：
 * 界面正常、托盘正常，唯独"按了没反应"，用户只能怀疑是应用坏了。
 *
 * 现在每个热键**首次**注册失败弹一次系统通知（同一热键再次失败不重复打扰；
 * 成功注册时清除标记，于是"换了个键成功"会得到一条确认，"又失败了"会再提示一次）。
 */
const notifiedFailures = new Set<HotkeyAction>();
const notifiedRecoveries = new Set<HotkeyAction>();

function notifyHotkeyFailure(action: HotkeyAction, accelerator: string): void {
  if (notifiedFailures.has(action)) return;
  notifiedFailures.add(action);
  notifiedRecoveries.delete(action);
  if (!Notification.isSupported()) return;
  new Notification({
    title: t('app.name'),
    body: t('notify.hotkeyConflict', { accelerator, label: HOTKEY_LABELS[action] })
  }).show();
}

function notifyHotkeyRecovered(action: HotkeyAction, accelerator: string): void {
  // 只有"此前提示过失败"的热键才回一条成功通知，避免正常启动时弹一堆无意义提示
  if (!notifiedFailures.has(action) || notifiedRecoveries.has(action)) return;
  notifiedRecoveries.add(action);
  notifiedFailures.delete(action);
  if (!Notification.isSupported()) return;
  new Notification({
    title: t('app.name'),
    body: t('notify.hotkeyRecovered', { accelerator, label: HOTKEY_LABELS[action] })
  }).show();
}

/** 各模块热键注册后回报（成功/失败/异常原因）；失败会弹一次用户可见的通知（GW-04） */
export function reportHotkey(action: HotkeyAction, accelerator: string, ok: boolean, error?: string): void {
  reports.set(action, { accelerator, ok, error });
  // 该热键被关掉/清空时重置提示状态：将来重新启用若仍失败，用户应当再收到一次提示
  if (!String(accelerator ?? '').trim()) {
    notifiedFailures.delete(action);
    notifiedRecoveries.delete(action);
    return;
  }
  try {
    if (ok) notifyHotkeyRecovered(action, accelerator);
    else notifyHotkeyFailure(action, accelerator);
  } catch (e) {
    logWarn('[hotkey] 热键状态通知失败', (e as Error).message);
  }
}

function acceleratorOf(action: HotkeyAction, s: AppSettings): string {
  switch (action) {
    case 'sidebar':
      return s.hotkey;
    case 'palette':
      return s.paletteHotkey;
    case 'deskboard':
      return s.deskboardHotkey;
    case 'clipboard':
      return s.clipboardHotkey;
    case 'capture':
      return s.captureHotkey;
    case 'pin':
      return s.pinHotkey;
    case 'translate':
      return s.translateHotkey;
    case 'ocr':
      return s.ocrHotkey;
  }
}

function enabledOf(action: HotkeyAction, s: AppSettings): boolean {
  switch (action) {
    case 'palette':
      return s.paletteEnabled;
    case 'deskboard':
      return s.deskboardEnabled;
    case 'clipboard':
      return s.clipboardEnabled;
    default:
      return true;
  }
}

/** 当前热键状态（含冲突检测与注册结果，SY-02 验收点） */
export function hotkeyList(): HotkeyInfo[] {
  const s = dataStore().get().settings;
  const seen = new Map<string, HotkeyAction>();
  const info: HotkeyInfo[] = [];
  for (const action of ACTIONS) {
    const acc = acceleratorOf(action, s);
    const norm = acc.trim().toLowerCase();
    let conflictWith: HotkeyAction | undefined;
    if (norm) {
      const prev = seen.get(norm);
      if (prev) conflictWith = prev;
      else seen.set(norm, action);
    }
    const rep = reports.get(action);
    info.push({
      action,
      label: HOTKEY_LABELS[action],
      accelerator: acc,
      defaultAccelerator: HOTKEY_DEFAULTS[action],
      enabled: enabledOf(action, s),
      registered: rep?.ok && rep.accelerator === acc ? true : false,
      conflictWith,
      error: rep && rep.accelerator === acc && !rep.ok ? (rep.error ?? '注册失败（可能被其他程序占用）') : undefined
    });
  }
  // 冲突双向标注
  for (const a of info) {
    if (!a.conflictWith) {
      const other = info.find((x) => x.conflictWith === a.action);
      if (other && other.accelerator.toLowerCase() === a.accelerator.toLowerCase()) a.conflictWith = other.action;
    }
  }
  return info;
}

function settingsPatchOf(action: HotkeyAction, accelerator: string): Partial<AppSettings> {
  switch (action) {
    case 'sidebar':
      return { hotkey: accelerator };
    case 'palette':
      return { paletteHotkey: accelerator };
    case 'deskboard':
      return { deskboardHotkey: accelerator };
    case 'clipboard':
      return { clipboardHotkey: accelerator };
    case 'capture':
      return { captureHotkey: accelerator };
    case 'pin':
      return { pinHotkey: accelerator };
    case 'translate':
      return { translateHotkey: accelerator };
    case 'ocr':
      return { ocrHotkey: accelerator };
  }
}

/** 修改热键并立即生效（副作用由 applySettingsSideEffects 统一处理） */
export function setHotkey(action: HotkeyAction, accelerator: string): HotkeyInfo[] {
  const acc = accelerator.trim();
  if (!acc) throw new Error('快捷键不能为空');
  dataStore().updateSettings(settingsPatchOf(action, acc));
  reports.delete(action);
  return hotkeyList();
}

/** 一键恢复默认（SY-02） */
export function resetHotkeys(): HotkeyInfo[] {
  dataStore().updateSettings({
    hotkey: HOTKEY_DEFAULTS.sidebar,
    paletteHotkey: HOTKEY_DEFAULTS.palette,
    deskboardHotkey: HOTKEY_DEFAULTS.deskboard,
    clipboardHotkey: HOTKEY_DEFAULTS.clipboard,
    captureHotkey: HOTKEY_DEFAULTS.capture,
    pinHotkey: HOTKEY_DEFAULTS.pin,
    translateHotkey: HOTKEY_DEFAULTS.translate,
    ocrHotkey: HOTKEY_DEFAULTS.ocr
  });
  reports.clear();
  return hotkeyList();
}
