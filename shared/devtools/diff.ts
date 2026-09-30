/**
 * 文本行级对比（DEV-11）
 *
 * 经典 LCS 动态规划（Int32Array 单行滚动 + 回溯），行级 same/add/del 结果供界面高亮。
 * 超大输入自动截断（避免 O(n·m) 内存爆掉）。
 */

export type DiffType = 'same' | 'add' | 'del';

export interface DiffLine {
  type: DiffType;
  text: string;
  /** 左侧（原文）行号，1 起；add 行为 0 */
  aLine: number;
  /** 右侧（新文）行号，1 起；del 行为 0 */
  bLine: number;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
  /**
   * P3-4：两侧"文件末尾是否有换行"不一致。
   * 旧实现把 "a" 与 "a\n" 判为完全相同 —— 对程序员来说这是有意义的差异
   * （等价于 git 的 "\ No newline at end of file"），因此单独标出来由界面提示。
   */
  trailingNewlineDiffers: boolean;
}

const MAX_LINES = 2000;

/**
 * 切分文本行。
 *
 * P3-4（加强）：**保留**结尾换行产生的最后一个空行（"a\n" → ["a", ""]）。
 * 旧实现把它 pop 掉，导致 "a" 与 "a\n" 被判定为完全相同；仅加标记还不够——
 * 行级 diff 的输出必须能无损还原两侧原文（审计脚本用随机文本做了 400 组重建校验）。
 */
function splitLines(text: string): string[] {
  const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (t === '') return [];
  return t.split('\n');
}

/** 行级 diff（DEV-11：独立小面板，行级高亮） */
export function diffLines(a: string, b: string): DiffResult {
  let left = splitLines(a);
  let right = splitLines(b);
  let truncated = false;
  if (left.length > MAX_LINES || right.length > MAX_LINES) {
    left = left.slice(0, MAX_LINES);
    right = right.slice(0, MAX_LINES);
    truncated = true;
  }
  const n = left.length;
  const m = right.length;
  // dp[i][j] = LCS 长度；用 (n+1) x (m+1) 的 Int32Array 扁平存储
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        left[i] === right[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      lines.push({ type: 'same', text: left[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      lines.push({ type: 'del', text: left[i], aLine: i + 1, bLine: 0 });
      removed++;
      i++;
    } else {
      lines.push({ type: 'add', text: right[j], aLine: 0, bLine: j + 1 });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: left[i], aLine: i + 1, bLine: 0 });
    removed++;
    i++;
  }
  while (j < m) {
    lines.push({ type: 'add', text: right[j], aLine: 0, bLine: j + 1 });
    added++;
    j++;
  }
  const endsWithNewline = (s: string): boolean => /\n$/.test(String(s ?? ''));
  return {
    lines,
    added,
    removed,
    truncated,
    trailingNewlineDiffers: endsWithNewline(a) !== endsWithNewline(b)
  };
}

/** 相似度（0~1，按最长公共子序列占比估算），用于摘要行 */
export function diffSimilarity(result: DiffResult): number {
  const total = result.lines.length;
  if (!total) return 1;
  const same = result.lines.filter((l) => l.type === 'same').length;
  return same / total;
}
