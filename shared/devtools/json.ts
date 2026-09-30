/**
 * JSON 格式化 / 压缩（DEV-01 / DEV-12）
 *
 * 纯函数：零依赖、无 IO、无全局状态；主进程 / 渲染层 / npm test 共用。
 * 非法 JSON 返回结构化错误（含字符位置与行列），便于命令面板即时提示。
 */

export type JsonError = { ok: false; message: string; pos: number; line: number; column: number };
export type JsonResult = { ok: true; out: string } | JsonError;

/** 从 V8 的错误文案里抽出字符位置：兼容 "at position 12" 与 "at line 1 column 3" 两种形态 */
function errorPos(err: unknown, text: string): { pos: number; line: number; column: number } {
  const msg = err instanceof Error ? err.message : String(err);
  let pos = -1;
  const byPos = /position (\d+)/.exec(msg);
  if (byPos) pos = Number(byPos[1]);
  if (pos < 0) {
    const byLine = /line (\d+) column (\d+)/.exec(msg);
    if (byLine) {
      const line = Number(byLine[1]);
      const column = Number(byLine[2]);
      const lines = text.split('\n');
      let acc = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) acc += lines[i].length + 1;
      pos = acc + column - 1;
    }
  }
  if (pos < 0) pos = 0;
  if (pos > text.length) pos = text.length;
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else column++;
  }
  return { pos, line, column };
}

function parse(input: string): { ok: true; value: unknown } | JsonError {
  const text = String(input ?? '');
  if (!text.trim()) return { ok: false, message: '内容为空', pos: 0, line: 1, column: 1 };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const at = errorPos(e, text);
    const raw = e instanceof Error ? e.message : String(e);
    return { ok: false, message: raw.replace(/^JSON\.parse:\s*/, ''), ...at };
  }
}

/** 格式化：缩进可配（默认 2 空格）；非法输入返回错误位置 */
export function jsonFormat(input: string, indent = 2): JsonResult {
  const r = parse(input);
  if (!r.ok) return r;
  const width = Math.max(0, Math.min(8, Math.round(Number(indent) || 0)));
  try {
    return { ok: true, out: JSON.stringify(r.value, null, width) };
  } catch {
    return { ok: false, message: '无法序列化（可能包含循环引用）', pos: 0, line: 1, column: 1 };
  }
}

/** 压缩为单行（去掉所有可省略空白） */
export function jsonMinify(input: string): JsonResult {
  const r = parse(input);
  if (!r.ok) return r;
  try {
    return { ok: true, out: JSON.stringify(r.value) };
  } catch {
    return { ok: false, message: '无法序列化（可能包含循环引用）', pos: 0, line: 1, column: 1 };
  }
}

/** 是否形如 JSON（以 { 或 [ 开头且配对结尾）——用于 DEV-12 输入形态识别 */
export function looksLikeJson(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.startsWith('{') && t.endsWith('}')) return true;
  if (t.startsWith('[') && t.endsWith(']')) return true;
  return false;
}

/** 结构化摘要（类型 / 条目数），用于即时结果副标题 */
export function jsonSummary(value: unknown): string {
  if (Array.isArray(value)) return '数组 · ' + value.length + ' 项';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'object') return '对象 · ' + Object.keys(value as Record<string, unknown>).length + ' 个键';
  return t;
}
