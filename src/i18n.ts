/**
 * 渲染层 i18n（T-12）
 *
 * `t()` 内部读 `locale` 这个 ref —— 在 Vue 模板/计算属性里调用它会自动建立依赖，
 * 因此切换语言能立即重渲染，不需要额外的全局刷新机制。
 *
 * 初始化点放在设置 store 的 load/sync（所有页面都会经过），
 * 系统语言取 `navigator.language`（渲染层拿不到 Electron 的 app.getLocale）。
 */

import { ref } from 'vue';
import { resolveLocale, translate, type Locale, type LocaleSetting } from '../shared/i18n/index.ts';

/** 当前生效语言（响应式） */
export const locale = ref<Locale>('zh-CN');

/** 由设置 store 调用：把设置值 + 系统语言解析成生效语言 */
export function applyLocale(setting: unknown, systemLocale?: string): void {
  const sys = systemLocale ?? (typeof navigator !== 'undefined' ? navigator.language : 'zh-CN');
  locale.value = resolveLocale(setting as LocaleSetting, sys);
}

/** 取词；缺 key 时返回 key 本身（便于一眼看出漏翻译） */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(locale.value, key, params);
}
