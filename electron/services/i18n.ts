/**
 * 主进程 i18n（T-12）
 *
 * 语言设置存在 dataStore 里，主进程各处（托盘、右键菜单、系统通知）按需取当前语言。
 * 不做缓存：设置读取是内存操作，而缓存会因为"改了语言但托盘没变"这类问题变得难以排查。
 * 系统语言取 Electron 的 app.getLocale()（如 zh-CN / zh-Hant-TW / ja-JP）。
 */

import { app } from 'electron';
import { resolveLocale, translate, type Locale } from '../../shared/i18n/index.ts';
import { dataStore } from '../store/dataStore';

export function currentLocale(): Locale {
  const s = dataStore().get().settings;
  return resolveLocale(s.locale, app.getLocale());
}

/** 取词（主进程侧） */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(currentLocale(), key, params);
}

/** 语言显示名（用于"已切换为 xx"提示） */
export function localeLabel(locale: Locale): string {
  const found = ['zh-CN', 'zh-TW', 'en', 'ja'].includes(locale) ? locale : 'zh-CN';
  const labels: Record<string, string> = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語' };
  return labels[found] ?? found;
}
