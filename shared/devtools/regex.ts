/**
 * 正则测试（DEV-04）
 *
 * 纯函数：给出全部匹配（含分组与位置），并把非法表达式转成结构化错误；
 * 常用正则预设 ≥ 5 条随模块导出。
 */

export interface RegexMatch {
  value: string;
  index: number;
  groups: string[];
  named?: Record<string, string>;
}

export interface RegexResult {
  ok: boolean;
  matches: RegexMatch[];
  message?: string;
  /** 已执行的匹配数（超过上限时截断，防灾难性回溯） */
  truncated?: boolean;
  /** P2-11：输入文本超过长度上限被截断（截断部分未参与匹配） */
  inputTruncated?: boolean;
}

/**
 * 匹配输入长度上限。
 *
 * P2-11：JS 正则无法中断，嵌套量词（如 `(a+)+$`）会让单次 exec 呈指数级耗时
 * —— 实测 28 个字符即需 3.7 秒，界面直接冻结。纯函数侧只能限制输入规模，
 * 真正的"可中断"由调用方（开发者面板的 Web Worker + 超时终止）保证，见 src/workers/regexWorker.ts。
 */
export const REGEX_MAX_INPUT = 20_000;

/** 灾难性回溯风险静态评估（用于界面提示，不阻止用户执行） */
export function assessRegexRisk(pattern: string): { risky: boolean; reasons: string[] } {
  const p = String(pattern ?? '');
  const reasons: string[] = [];
  // 嵌套量词：量词化的分组内部又含量词，如 (a+)+ / (\w*)* / (a|aa)+
  if (/\((?:\.|[^()\\])*[*+][^()]*\)\s*(?:[*+]|\{\d+,?\d*\})/.test(p)) {
    reasons.push('嵌套量词（如 (a+)+）在长文本上会指数级回溯');
  }
  // 分组内多个可重叠分支 + 量词，如 (a|a)* / (\w|\d)*
  if (/\((?:\.|[^()\\])*\|(?:\.|[^()\\])*\)\s*(?:[*+]|\{\d+,?\d*\})/.test(p)) {
    reasons.push('可重叠的分支选择配合量词（如 (a|a)*）容易回溯爆炸');
  }
  // 超大重复次数
  const big = /\{(\d{3,})(?:,(\d*))?\}/.exec(p);
  if (big) reasons.push('重复次数过大（{' + big[1] + '}）');
  return { risky: reasons.length > 0, reasons };
}

export interface RegexPreset {
  name: string;
  pattern: string;
  flags: string;
  sample: string;
}

/** 常用正则预设（DEV-04：≥ 5 条） */
export const REGEX_PRESETS: RegexPreset[] = [
  { name: '邮箱', pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', flags: 'g', sample: '联系 admin@example.com 或 support@test.cn' },
  { name: '手机号（中国大陆）', pattern: '1[3-9]\\d{9}', flags: 'g', sample: '电话 13812345678，备用 15900001111' },
  { name: 'URL', pattern: 'https?://[^\\s<>"\']+', flags: 'g', sample: '访问 https://example.com/a?b=1 获取' },
  { name: 'IPv4', pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b', flags: 'g', sample: '本机 192.168.1.10，网关 10.0.0.1' },
  { name: '日期 YYYY-MM-DD', pattern: '\\d{4}-\\d{2}-\\d{2}', flags: 'g', sample: '2026-09-27 立项，2026-10-08 发版' },
  { name: '时间 HH:mm:ss', pattern: '\\b([01]?\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?\\b', flags: 'g', sample: '开会 09:30，结束 18:00:00' },
  { name: '中文字符', pattern: '[\\u4e00-\\u9fff]+', flags: 'g', sample: 'hello 小鹏工具箱 world' },
  { name: '十六进制颜色', pattern: '#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b', flags: 'g', sample: '主色 #5b8cff，背景 #fff' },
  { name: 'JSON 键值', pattern: '"([^"]+)"\\s*:\\s*("[^"]*"|\\d+|true|false|null)', flags: 'g', sample: '{"name":"toolbox","port":47111}' }
];

const MAX_MATCHES = 500;

/** 执行正则匹配；表达式非法时返回结构化错误 */
export function regexTest(pattern: string, flags: string, input: string): RegexResult {
  const p = String(pattern ?? '');
  if (!p) return { ok: false, matches: [], message: '请输入正则表达式' };
  const rawText = String(input ?? '');
  const inputTruncated = rawText.length > REGEX_MAX_INPUT;
  const text = inputTruncated ? rawText.slice(0, REGEX_MAX_INPUT) : rawText;
  let re: RegExp;
  try {
    // 统一带 g 便于一次性收集全部匹配
    const f = [...new Set((flags || '').replace(/[gy]/g, '').split(''))].join('') + 'g';
    re = new RegExp(p, f);
  } catch (e) {
    return { ok: false, matches: [], message: '正则语法错误：' + (e instanceof Error ? e.message : String(e)) };
  }
  const matches: RegexMatch[] = [];
  let truncated = false;
  let guard = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      value: m[0],
      index: m.index,
      groups: m.slice(1).map((g) => (g === undefined ? '' : g)),
      named: m.groups ? { ...m.groups } as Record<string, string> : undefined
    });
    if (m[0] === '') re.lastIndex++; // 零宽匹配防死循环
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    if (++guard > MAX_MATCHES * 4) {
      truncated = true;
      break;
    }
  }
  return { ok: true, matches, truncated, inputTruncated };
}

/** 是否命中（用于「测试文本是否匹配」的即时反馈） */
export function regexHit(pattern: string, flags: string, input: string): boolean {
  const r = regexTest(pattern, flags, input);
  return r.ok && r.matches.length > 0;
}

/** 把匹配区间切成 [{text, hit}] 片段，供高亮渲染（DEV-04：高亮匹配） */
export function regexHighlight(
  pattern: string,
  flags: string,
  input: string
): Array<{ text: string; hit: boolean }> {
  const rawText = String(input ?? '');
  // 与 regexTest 保持同一截断口径，避免"高亮范围"与"匹配列表"不一致
  const text = rawText.length > REGEX_MAX_INPUT ? rawText.slice(0, REGEX_MAX_INPUT) : rawText;
  const r = regexTest(pattern, flags, text);
  if (!r.ok || !r.matches.length) return text ? [{ text, hit: false }] : [];
  const out: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const m of r.matches) {
    if (m.index > cursor) out.push({ text: text.slice(cursor, m.index), hit: false });
    if (m.value) out.push({ text: m.value, hit: true });
    cursor = m.index + m.value.length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
