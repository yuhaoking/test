import { randomUUID } from 'crypto';
import { db } from '../store/db';
import { normalizeAlias, validateAliasInput } from '../../shared/devtools/alias.ts';
import { logDebug } from '../utils/log';
import type { Alias, AliasTargetType } from '../../shared/types';

/**
 * 指令别名（AL-01 ~ AL-03）
 *
 * - 存储：专表 aliases（key=id, value=JSON），与基线规格 (key,value) 结构一致；
 * - 命中：精确匹配（大小写不敏感）优先于一切模糊匹配（AL-03）；
 * - 冲突：同一别名（大小写不敏感）只允许一条，保存时拒绝并给出可读提示（AL-01）。
 */

const TARGET_TYPES: AliasTargetType[] = ['function', 'pluginCommand', 'website', 'snippet'];

function parse(row: { key: string; value: string }): Alias | null {
  try {
    const a = JSON.parse(row.value) as Alias;
    if (!a || !a.id || !a.alias || !a.targetId) return null;
    if (!TARGET_TYPES.includes(a.targetType)) a.targetType = 'function';
    return a;
  } catch {
    return null;
  }
}

export function listAliases(): Alias[] {
  const out: Alias[] = [];
  for (const row of db().all('aliases')) {
    const a = parse(row);
    if (a) out.push(a);
  }
  out.sort((a, b) => a.alias.localeCompare(b.alias, 'zh-CN'));
  return out;
}

/** 别名 → 目标（精确匹配，AL-03 最高优先级） */
export function findAlias(alias: string): Alias | null {
  const key = normalizeAlias(alias);
  if (!key) return null;
  return listAliases().find((a) => normalizeAlias(a.alias) === key) ?? null;
}

/** 校验并保存（冲突 / 非法输入抛出可读中文错误，规则见 shared/devtools/alias.ts） */
export function saveAlias(input: Alias): Alias[] {
  const current = listAliases();
  const problem = validateAliasInput(
    {
      id: input.id || undefined,
      alias: input.alias,
      targetId: input.targetId,
      targetType: input.targetType
    },
    current
  );
  if (problem) throw new Error(problem);
  const alias = String(input.alias ?? '').trim();
  const item: Alias = {
    id: input.id || 'alias-' + randomUUID(),
    alias,
    targetId: String(input.targetId),
    targetType: input.targetType,
    targetLabel: input.targetLabel ? String(input.targetLabel) : undefined,
    note: input.note ? String(input.note) : undefined,
    createdAt: input.createdAt || Date.now()
  };
  db().set('aliases', item.id, JSON.stringify(item));
  logDebug('[aliases] 已保存别名', alias, '→', item.targetId);
  return listAliases();
}

export function removeAlias(id: string): Alias[] {
  db().delete('aliases', String(id ?? ''));
  return listAliases();
}

/** 导出为 JSON 文本（AL-02：批量导出） */
export function exportAliases(): string {
  return JSON.stringify({ version: 1, aliases: listAliases() }, null, 2);
}

/**
 * 批量导入（AL-02）：同别名 **覆盖更新**，其余非法项跳过并汇总。
 *
 * P2-7 修复：旧实现一律以 `id: ''` 新建，于是"导出 → 原样导入"必然撞上自己的别名
 * 唯一性规则（100% 失败，只有先手工删光旧别名才能导入）。现在按别名**就地更新**，
 * 使导出/导入成为幂等操作——这才是备份恢复应有的语义。
 */
export function importAliases(text: string): { ok: boolean; message?: string; count: number } {
  let parsed: unknown;
  try {
    // P2-8 配套：剥离 UTF-8 BOM（与备份导入一致）
    parsed = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, message: 'JSON 解析失败：' + (e as Error).message, count: 0 };
  }
  const raw = Array.isArray(parsed) ? parsed : ((parsed as { aliases?: unknown[] })?.aliases ?? []);
  if (!Array.isArray(raw) || !raw.length) return { ok: false, message: '没有可导入的别名', count: 0 };
  let count = 0;
  let updated = 0;
  const skipped: string[] = [];
  for (const item of raw as Array<Partial<Alias>>) {
    const alias = String(item.alias ?? '').trim();
    try {
      const existing = findAlias(alias);
      if (existing) updated++;
      saveAlias({
        // 命中同名别名时复用其 id → 走更新路径，不再被判为冲突
        id: existing?.id ?? '',
        alias,
        targetId: String(item.targetId ?? ''),
        targetType: (item.targetType ?? 'function') as AliasTargetType,
        targetLabel: item.targetLabel,
        note: item.note,
        createdAt: existing?.createdAt ?? 0
      });
      count++;
    } catch (e) {
      skipped.push(alias || '?' + '（' + (e as Error).message + '）');
    }
  }
  if (!count) return { ok: false, message: '全部导入失败：' + skipped.slice(0, 3).join('；'), count: 0 };
  const parts = ['已导入 ' + count + ' 条'];
  if (updated) parts.push('其中覆盖更新 ' + updated + ' 条');
  if (skipped.length) parts.push('跳过 ' + skipped.length + ' 条：' + skipped.slice(0, 3).join('；'));
  return { ok: true, count, message: parts.join('，') };
}
