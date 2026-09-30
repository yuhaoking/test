/**
 * 时间戳 / 日期转换（DEV-02 / DEV-12）
 *
 * 自动识别 10 位（秒）/ 13 位（毫秒）/ 16 位（微秒）时间戳与常见日期字符串。
 */

export type TimeKind = 'seconds' | 'milliseconds' | 'microseconds' | 'date';
export interface TimeParseResult {
  ok: boolean;
  kind: TimeKind;
  epochMs: number;
  /** 本地时间（YYYY-MM-DD HH:mm:ss） */
  local: string;
  /** ISO 8601（UTC，带 Z） */
  iso: string;
  /** 本地时区偏移（如 +08:00） */
  zone: string;
  /** 相对当前时间（如 "3 天前"） */
  relative: string;
  message?: string;
}

const DATE_LIKE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})([ T](\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?$/;

function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, '0');
}

/** 本地时间文本（不走 toLocaleString，避免不同运行时输出不一致） */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

/** 本地时区偏移文本（如 +08:00） */
export function zoneOffset(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const min = -d.getTimezoneOffset();
  const sign = min >= 0 ? '+' : '-';
  return sign + pad(Math.floor(Math.abs(min) / 60)) + ':' + pad(Math.abs(min) % 60);
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月后 … */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms)) return '';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '后' : '前';
  if (abs < 5_000) return '刚刚';
  if (abs < 60_000) return Math.round(abs / 1000) + ' 秒' + suffix;
  if (abs < 3600_000) return Math.round(abs / 60_000) + ' 分钟' + suffix;
  if (abs < 86400_000) return Math.round(abs / 3600_000) + ' 小时' + suffix;
  if (abs < 30 * 86400_000) return Math.round(abs / 86400_000) + ' 天' + suffix;
  if (abs < 365 * 86400_000) return Math.round(abs / (30 * 86400_000)) + ' 个月' + suffix;
  return Math.round(abs / (365 * 86400_000)) + ' 年' + suffix;
}

function isValidMs(ms: number): boolean {
  // 允许 1970-01-01 ~ 2100 年区间，避免把随机长数字当成时间戳
  return Number.isFinite(ms) && ms >= 0 && ms <= 4102444800000;
}

/** 解析时间戳或日期字符串；无法识别返回 null */
export function parseTimeInput(input: string, now = Date.now()): TimeParseResult | null {
  const t = String(input ?? '').trim();
  if (!t) return null;
  let epochMs = NaN;
  let kind: TimeKind = 'date';

  if (/^\d{10}$/.test(t)) {
    epochMs = Number(t) * 1000;
    kind = 'seconds';
  } else if (/^\d{13}$/.test(t)) {
    epochMs = Number(t);
    kind = 'milliseconds';
  } else if (/^\d{16}$/.test(t)) {
    epochMs = Math.round(Number(t) / 1000);
    kind = 'microseconds';
  } else {
    const m = DATE_LIKE.exec(t);
    if (m) {
      const p = (s: string | undefined, d = 0): number => (s == null ? d : Number(s));
      const y = p(m[1]);
      const mo = p(m[2]);
      const d = p(m[3]);
      const hh = p(m[5]);
      const mi = p(m[6]);
      const ss = p(m[8]);
      const dt = new Date(y, mo - 1, d, hh, mi, ss);
      /*
       * P2-12 修复：new Date(y, m, d, …) 会把越界值"顺延"而不是判非法 ——
       * 2026-02-30 静默变成 2026-03-02，2026-13-01 变成 2027-01-01，25:99 变成次日 02:39。
       * 对时间戳转换工具来说这是"给出一个看起来正确、实际错误的答案"，必须逐字段回验。
       */
      const sameParts =
        dt.getFullYear() === y &&
        dt.getMonth() === mo - 1 &&
        dt.getDate() === d &&
        dt.getHours() === hh &&
        dt.getMinutes() === mi &&
        dt.getSeconds() === ss;
      // 越界即视为"无法识别为时间"（返回 null，与其它非法输入一致）；
      // 可读原因由 explainTimeInput 单独提供，避免调用方拿到一个"看似有效"的空结果。
      if (!sameParts) return null;
      if (Number.isFinite(dt.getTime())) {
        epochMs = dt.getTime();
        kind = 'date';
      }
    }
  }
  if (!isValidMs(epochMs)) return null;
  return {
    ok: true,
    kind,
    epochMs,
    local: formatLocal(epochMs),
    iso: new Date(epochMs).toISOString(),
    zone: zoneOffset(epochMs),
    relative: relativeTime(epochMs, now)
  };
}

/**
 * 当 parseTimeInput 返回 null 时，给出可读原因（用于界面提示）。
 *
 * 为什么拆成两个函数：parseTimeInput 的契约是"识别不了就返回 null"（调用方据此走
 * "无法识别"分支），如果把"2026-02-30 越界"也塞回一个非 null 的结果对象，
 * 调用方稍不注意就会拿到一串空字段——那才是真正危险的（给出看似正确的空答案）。
 */
export function explainTimeInput(input: string): string | null {
  const t = String(input ?? '').trim();
  const m = DATE_LIKE.exec(t);
  if (!m) return null;
  const p = (s: string | undefined, d = 0): number => (s == null ? d : Number(s));
  const y = p(m[1]);
  const mo = p(m[2]);
  const d = p(m[3]);
  const hh = p(m[5]);
  const mi = p(m[6]);
  const ss = p(m[8]);
  const dt = new Date(y, mo - 1, d, hh, mi, ss);
  const same =
    dt.getFullYear() === y &&
    dt.getMonth() === mo - 1 &&
    dt.getDate() === d &&
    dt.getHours() === hh &&
    dt.getMinutes() === mi &&
    dt.getSeconds() === ss;
  if (same) return null;
  if (mo < 1 || mo > 12) return `月份 ${mo} 超出范围（1~12）`;
  if (d < 1 || d > 31) return `日期 ${d} 超出范围`;
  if (hh > 23) return `小时 ${hh} 超出范围（0~23）`;
  if (mi > 59) return `分钟 ${mi} 超出范围（0~59）`;
  if (ss > 59) return `秒 ${ss} 超出范围（0~59）`;
  return `${t} 不是有效日期（该月没有这一天）`;
}

const KIND_LABEL: Record<TimeKind, string> = {
  seconds: '10 位秒级时间戳',
  milliseconds: '13 位毫秒时间戳',
  microseconds: '16 位微秒时间戳',
  date: '日期字符串'
};

export function timeKindLabel(kind: TimeKind): string {
  return KIND_LABEL[kind] ?? '时间';
}

/** 当前时间戳（供 "now"/"ts" 无参输入使用） */
export function nowStamps(now = Date.now()): { seconds: number; milliseconds: number } {
  return { seconds: Math.floor(now / 1000), milliseconds: now };
}
