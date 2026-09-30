/**
 * i18n 核心（T-12 国际化）
 *
 * 纯函数、零依赖、无 IO：主进程与渲染层共用同一份实现，`npm test` 可直接断言。
 * 语言解析 / 回退 / 插值 / 覆盖率 全部在这里，界面代码只调用 `t(key, params)`。
 */

import { toTraditional } from './hant.ts';
import { DICTS, ZH_CN, ZH_TW_OVERRIDES } from './messages.ts';

export type Locale = 'zh-CN' | 'zh-TW' | 'en' | 'ja';
/** 设置里可选的值：'auto' = 跟随系统 */
export type LocaleSetting = Locale | 'auto';

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' }
];

/** 权威源语言：字典缺失时的最终回退，也是"新增 key 必须先加这里"的那一份 */
export const SOURCE_LOCALE: Locale = 'zh-CN';

export function isLocale(v: unknown): v is Locale {
  return v === 'zh-CN' || v === 'zh-TW' || v === 'en' || v === 'ja';
}

/** 把任意系统语言标记（zh-Hant-TW / ja-JP / en-US…）归一到支持的四种 */
export function normalizeSystemLocale(tag: string): Locale {
  const t = String(tag ?? '').trim().toLowerCase();
  if (!t) return SOURCE_LOCALE;
  if (t.startsWith('ja')) return 'ja';
  if (t.startsWith('en')) return 'en';
  if (t.startsWith('zh')) {
    // 繁体地区：台湾 / 香港 / 澳门，或显式 Hant
    if (/hant|tw|hk|mo/.test(t)) return 'zh-TW';
    return 'zh-CN';
  }
  return SOURCE_LOCALE;
}

/**
 * 解析最终生效语言。
 * 设置项非法（历史脏值/手工改库）一律回退到跟随系统，而不是抛错——设置永远不该让界面打不开。
 */
export function resolveLocale(setting: unknown, systemLocale: string): Locale {
  const s = String(setting ?? 'auto');
  if (isLocale(s)) return s;
  return normalizeSystemLocale(systemLocale);
}

/** 取某语言的字典（zh-TW = zh-CN 逐字/词转换 + 覆写） */
export function dictionaryFor(locale: Locale): Record<string, string> {
  if (locale === 'zh-TW') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(ZH_CN)) out[k] = toTraditional(v);
    return { ...out, ...ZH_TW_OVERRIDES };
  }
  return DICTS[locale as 'zh-CN' | 'en' | 'ja'] ?? ZH_CN;
}

/** 插值：把 {name} 换成参数值；缺失参数保留占位符（便于一眼看出漏传，而不是显示 undefined） */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? String(params[key]) : m));
}

/**
 * 翻译。
 * 回退链：目标语言 → 源语言(zh-CN) → key 本身。
 * 返回 key 本身是刻意的：开发/测试阶段一眼就能看出"这个词没翻译"，而不是静默显示空白。
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = dictionaryFor(locale);
  const text = dict[key] ?? ZH_CN[key] ?? key;
  return interpolate(text, params);
}

/** 生成绑定语言的翻译函数（主进程按当前设置用；渲染层用 src/i18n.ts 的响应式版本） */
export function translator(locale: Locale): (key: string, params?: Record<string, string | number>) => string {
  const dict = dictionaryFor(locale);
  return (key, params) => interpolate(dict[key] ?? ZH_CN[key] ?? key, params);
}

/**
 * 字典完整性检查：en / ja 必须覆盖 zh-CN 的每一个 key。
 * 这是 `npm test` 的强制项——否则界面会在切换语言后突然冒出一串 key 名。
 */
export function dictionaryGaps(): { locale: Locale; missing: string[] }[] {
  const keys = Object.keys(ZH_CN);
  const out: { locale: Locale; missing: string[] }[] = [];
  for (const locale of ['en', 'ja'] as Locale[]) {
    const dict = DICTS[locale as 'en' | 'ja'];
    const missing = keys.filter((k) => !(k in dict));
    if (missing.length) out.push({ locale, missing });
  }
  // zh-TW 由转换生成，理论上不会缺；仍显式校验一次（防止覆写表写错 key）
  const tw = dictionaryFor('zh-TW');
  const twMissing = keys.filter((k) => !(k in tw));
  if (twMissing.length) out.push({ locale: 'zh-TW', missing: twMissing });
  return out;
}
