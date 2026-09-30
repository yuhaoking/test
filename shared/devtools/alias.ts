/**
 * 指令别名的纯函数规则（AL-01 / AL-03）
 *
 * 与主进程服务（electron/services/aliases.ts）共用：校验与冲突判定可在 npm test 直接断言，
 * 避免"规则只存在于需要 Electron 运行时的模块里"。
 */

export type AliasTargetTypeName = 'function' | 'pluginCommand' | 'website' | 'snippet';

export const ALIAS_TARGET_TYPES: AliasTargetTypeName[] = ['function', 'pluginCommand', 'website', 'snippet'];

export interface AliasLike {
  id: string;
  alias: string;
  targetId: string;
  targetLabel?: string;
}

/** 归一化：去空白 + 小写（别名匹配大小写不敏感） */
export function normalizeAlias(alias: string): string {
  return String(alias ?? '').trim().toLowerCase();
}

/** 别名文本是否合法（非空、无空格、长度 ≤ 32） */
export function isValidAlias(alias: string): boolean {
  const a = String(alias ?? '').trim();
  if (!a || a.length > 32) return false;
  return !/\s/.test(a);
}

/**
 * 校验别名输入；返回 null 表示通过，否则返回可读中文错误。
 * 冲突规则：同一别名（大小写不敏感）只允许一条（排除自身 id）。
 */
export function validateAliasInput(
  input: { id?: string; alias: string; targetId: string; targetType?: string },
  existing: AliasLike[]
): string | null {
  const alias = String(input.alias ?? '').trim();
  if (!alias) return '别名不能为空';
  if (/\s/.test(alias)) return '别名不能包含空格';
  if (alias.length > 32) return '别名过长（最多 32 个字符）';
  if (!String(input.targetId ?? '').trim()) return '请选择别名指向的目标';
  if (input.targetType && !ALIAS_TARGET_TYPES.includes(input.targetType as AliasTargetTypeName)) {
    return '别名目标类型不合法';
  }
  const dup = existing.find((a) => normalizeAlias(a.alias) === normalizeAlias(alias) && a.id !== input.id);
  if (dup) {
    return '别名「' + alias + '」已被占用（指向：' + (dup.targetLabel || dup.targetId) + '）';
  }
  return null;
}

/** 精确命中（AL-03：最高权重）：输入与别名完全一致（忽略大小写与首尾空白） */
export function matchAlias(input: string, aliases: AliasLike[]): AliasLike | null {
  const key = normalizeAlias(input);
  if (!key) return null;
  return aliases.find((a) => normalizeAlias(a.alias) === key) ?? null;
}
