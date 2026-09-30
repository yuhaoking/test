/**
 * cron 表达式解析（DEV-10）：未来 5 次触发时间 + 中文自然语义提示
 *
 * 支持 5 段（分 时 日 月 周）与 6 段（秒 分 时 日 月 周，Quartz 风格）；
 * 支持 * , - / ? 与月份/星期英文缩写，不支持 L W #（解析时给出提示）。
 */

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEK_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface CronFieldDef {
  min: number;
  max: number;
  names?: string[];
}

export const CRON_FIELDS: CronFieldDef[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 6, names: WEEK_NAMES }
];

export interface CronParseResult {
  ok: boolean;
  /** 是否含秒字段（6 段） */
  withSeconds: boolean;
  sets: number[][];
  message?: string;
}

function normalizeToken(token: string, def: CronFieldDef): number | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (def.names) {
    const idx = def.names.indexOf(t);
    if (idx >= 0) return def.min === 0 && def.max === 6 ? idx : idx + 1;
  }
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (n < def.min || n > def.max) return null;
  return n;
}

function parseField(field: string, def: CronFieldDef): number[] | null {
  const text = field.trim();
  if (!text || text === '*' || text === '?') {
    const all: number[] = [];
    for (let i = def.min; i <= def.max; i++) all.push(i);
    return all;
  }
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const seg = part.trim();
    if (!seg) return null;
    const [rangePart, stepPart] = seg.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return null;
    let from = def.min;
    let to = def.max;
    if (rangePart !== '*' && rangePart !== '?') {
      const [a, b] = rangePart.split('-');
      const av = normalizeToken(a, def);
      if (av === null) return null;
      from = av;
      to = b === undefined ? av : normalizeToken(b, def) ?? -1;
      if (to < from) return null;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  const list = [...out].sort((a, b) => a - b);
  return list.length ? list : null;
}

export function parseCron(expr: string): CronParseResult {
  const parts = String(expr ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length !== 5 && parts.length !== 6) {
    return { ok: false, withSeconds: false, sets: [], message: '需要 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）表达式' };
  }
  if (/[LW#]/i.test(expr)) {
    return { ok: false, withSeconds: false, sets: [], message: '暂不支持 L / W / # 语法' };
  }
  const withSeconds = parts.length === 6;
  const fields = withSeconds ? parts : ['0', ...parts];
  const defs: CronFieldDef[] = [{ min: 0, max: 59 }, ...CRON_FIELDS];
  const sets: number[][] = [];
  for (let i = 0; i < fields.length; i++) {
    const parsed = parseField(fields[i], defs[i]);
    if (!parsed) return { ok: false, withSeconds, sets: [], message: '第 ' + (i + 1) + ' 段「' + fields[i] + '」无法解析' };
    sets.push(parsed);
  }
  return { ok: true, withSeconds, sets };
}

/** 扫描窗口上限：8 年（覆盖「2 月 29 日」这类最长间隔的表达式，见 P2-13） */
const MAX_SCAN_DAYS = 366 * 8;

/**
 * 未来 n 次触发时间（从 from 之后开始，含秒粒度判定）。
 *
 * P2-13 修复：旧实现按"分钟"线性扫描且窗口只有 366 天，于是 `0 0 29 2 *`（每年 2 月 29 日）
 * 在平年区间内一次都扫不到 → 命令面板把它当成"无法解析"，用户看到的是错误提示。
 * 现在改为**先按天筛选、命中日再枚举时分秒**，既把窗口扩到 8 年，又比逐分钟扫描快得多
 * （最坏 8×366 天 + 命中日的分钟枚举，而不是 420 万次循环）。
 */
export function cronNext(expr: string, n = 5, from: Date = new Date()): Date[] {
  const parsed = parseCron(expr);
  if (!parsed.ok) return [];
  const [secs, mins, hours, doms, months, dows] = parsed.sets;
  const want = Math.max(1, n);
  const out: Date[] = [];
  const domAll = doms.length === 31;
  const dowAll = dows.length === 7;

  // 从"下一个最小单位"开始（cron 语义：严格晚于当前时刻）
  const startMs = parsed.withSeconds
    ? Math.floor(from.getTime() / 1000) * 1000 + 1000
    : Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const start = new Date(startMs);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());

  for (let day = 0; day < MAX_SCAN_DAYS && out.length < want; day++) {
    const month = cursor.getMonth() + 1;
    if (months.includes(month)) {
      const domHit = doms.includes(cursor.getDate());
      const dowHit = dows.includes(cursor.getDay());
      // 日/周同为限定时按 cron 惯例取「或」；其中一个为全量时按另一个
      const dayOk = domAll && dowAll ? true : domAll ? dowHit : dowAll ? domHit : domHit || dowHit;
      if (dayOk) {
        for (const h of hours) {
          if (out.length >= want) break;
          for (const mi of mins) {
            if (out.length >= want) break;
            const secList = parsed.withSeconds ? secs : [0];
            for (const s of secList) {
              const t = new Date(
                cursor.getFullYear(),
                cursor.getMonth(),
                cursor.getDate(),
                h,
                mi,
                s
              ).getTime();
              if (t < startMs) continue;
              out.push(new Date(t));
              if (out.length >= want) break;
            }
          }
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  out.sort((a, b) => a.getTime() - b.getTime());
  return out;
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 中文自然语义提示（DEV-10） */
export function cronDescribe(expr: string): string {
  const parsed = parseCron(expr);
  if (!parsed.ok) return parsed.message ?? '表达式无法解析';
  const parts = String(expr).trim().split(/\s+/).filter(Boolean);
  const withSeconds = parsed.withSeconds;
  const f = withSeconds ? parts : ['0', ...parts];
  const [sec, min, hour, dom, mon, dow] = f;
  const bits: string[] = [];
  const everyMinute = min === '*' || min === '*/1';
  if (withSeconds && sec !== '0' && sec !== '*') bits.push('第 ' + sec + ' 秒');
  if (everyMinute && (hour === '*' || hour === '*/1')) bits.push('每分钟');
  else if (/^\*\/(\d+)$/.test(min)) bits.push('每 ' + /^\*\/(\d+)$/.exec(min)![1] + ' 分钟');
  else if (/^\d+$/.test(min) && /^\d+$/.test(hour)) bits.push(hour.padStart(2, '0') + ':' + min.padStart(2, '0'));
  else if (/^\d+$/.test(min) && hour === '*') bits.push('每小时的第 ' + min + ' 分');
  else bits.push('分:' + min + ' 时:' + hour);
  if (mon !== '*') bits.push('月份 ' + mon);
  if (dom !== '*') bits.push(dom + ' 日');
  if (dow !== '*') {
    const d = Number(dow);
    bits.push(Number.isInteger(d) && d >= 0 && d <= 6 ? WEEK_CN[d] : '周 ' + dow);
  }
  return bits.join(' · ');
}
