/**
 * 全局快捷键的纯规则（SY-02）
 *
 * 放在 `shared/` 而不是 electron 服务里的原因：`hotkeyManager.ts` 依赖 dataStore（需要 Electron 运行时），
 * `npm test` 无法直接 import 它 —— 规则若只存在于那里就等于"测不到"。
 * 这与 `shared/devtools/alias.ts` ↔ `electron/services/aliases.ts` 的分工一致。
 */

import type { HotkeyAction } from './types.ts';

/** 全部全局热键的出厂默认值 */
export const HOTKEY_DEFAULTS: Record<HotkeyAction, string> = {
  sidebar: 'Ctrl+Alt+X',
  // P3-7 修复：Alt+Space 与 Windows 系统菜单/PowerToys 常见冲突，默认改 Ctrl+Space
  palette: 'Ctrl+Space',
  deskboard: 'Ctrl+Shift+D',
  clipboard: 'Ctrl+Shift+V',
  capture: 'Ctrl+Alt+A',
  pin: 'F3',
  translate: 'Ctrl+Alt+T',
  ocr: 'Ctrl+Alt+O'
};

/**
 * P3-7 之前命令面板的默认热键。它与 Windows 系统菜单（以及 PowerToys 的"快速 accent"）冲突，
 * 注册**必然失败**。
 *
 * 为什么需要这个常量：P3-7 只改了默认值，而默认值只在**首次安装**时写入用户库 ——
 * 老用户的库里存着 Alt+Space，于是升级后命令面板热键一直注册不上，
 * 唯一信号只有控制台里一行警告（本机实测日志：`[palette] 热键注册失败…: Alt+Space`）。
 * 这是"修了默认值但没修存量配置"的典型漏网。
 */
export const RETIRED_PALETTE_HOTKEY = 'Alt+Space';

/**
 * 是否应把当前命令面板热键升级为新默认值。
 *
 * 两个条件缺一不可：
 * ① 值正是那个已废弃的旧默认值（去空白、忽略大小写）；
 * ② 用户此前没有被升级过（`paletteHotkeyMigrated`）—— 升级过一次之后，
 *    用户若又手动改回 Alt+Space（例如他已卸载 PowerToys），那是他的选择，不再干涉。
 *
 * 调用点还有一个前提：**只在该热键确实注册失败时调用**。
 * 若 Alt+Space 在某台机器上真能用，就不该动用户的设置。
 */
export function shouldUpgradeLegacyPaletteHotkey(accelerator: string, migrated: boolean): boolean {
  if (migrated) return false;
  return String(accelerator ?? '').trim().toLowerCase() === RETIRED_PALETTE_HOTKEY.toLowerCase();
}
