/**
 * 剪贴板意图识别（CP-07 粘贴智能匹配 / WK-02 上下文类型判定）
 *
 * 纯函数（无 IO）：不访问文件系统，路径仅做形态判定，由调用方按需校验存在性。
 */

import { looksLikeJson } from './json.ts';

export type IntentKind = 'path' | 'url' | 'json' | 'timestamp' | 'color' | 'unknown';

export interface ClipboardIntent {
  kind: IntentKind;
  /** 原始文本（超长时截断到 2000 字，避免把大段日志带进动作面板） */
  text: string;
  /** kind=path 时解析出的路径列表（资源管理器多选为多行） */
  paths: string[];
  /** 人类可读说明（动作副标题用） */
  detail: string;
}

/** Windows 绝对路径（C:\…）或 UNC 路径（\\server\share\…） */
const WIN_PATH = /^[A-Za-z]:[\\/][^<>:"|?*]*$/;
const UNC_PATH = /^\\{2}[^\\/]+[\\/][^<>:"|?*]*$/;
/** 常见 POSIX 绝对路径（兼容开发环境） */
const NIX_PATH = /^\/(?:[^\0<>|?*]+\/)*[^\0<>|?*]*$/;

export function isPathLike(line: string): boolean {
  const t = line.trim().replace(/^"|"$/g, '');
  if (!t) return false;
  if (WIN_PATH.test(t)) return true;
  if (UNC_PATH.test(t)) return true;
  // 仅当包含多级目录时才把 POSIX 形态当路径，避免把 "/" 之类误判
  if (NIX_PATH.test(t) && t.split('/').length >= 3) return true;
  return false;
}

function isUrl(text: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

function isTimestamp(text: string): boolean {
  return /^\d{10}$/.test(text) || /^\d{13}$/.test(text) || /^\d{16}$/.test(text);
}

function isColor(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(t) || /^rgba?\([\d.,\s%]+\)$/.test(t);
}

const KIND_LABEL: Record<IntentKind, string> = {
  path: '文件路径',
  url: '网页链接',
  json: 'JSON 文本',
  timestamp: '时间戳',
  color: '颜色值',
  unknown: '普通文本'
};

export function intentKindLabel(kind: IntentKind): string {
  return KIND_LABEL[kind] ?? '文本';
}

/** 识别剪贴板文本意图（CP-07 / WK-02，识别正确率目标 ≥ 95%） */
export function inferClipboardIntent(input: string): ClipboardIntent {
  const raw = String(input ?? '');
  const text = raw.length > 2000 ? raw.slice(0, 2000) : raw;
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'unknown', text, paths: [], detail: '剪贴板为空' };

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (isUrl(trimmed)) {
    return { kind: 'url', text, paths: [], detail: '检测到网页链接' };
  }
  if (lines.length > 0 && lines.length <= 50 && lines.every((l) => isPathLike(l))) {
    const paths = lines.map((l) => l.replace(/^"|"$/g, ''));
    return {
      kind: 'path',
      text,
      paths,
      detail: paths.length > 1 ? '检测到 ' + paths.length + ' 个文件路径' : '检测到文件路径'
    };
  }
  if (isTimestamp(trimmed)) {
    return { kind: 'timestamp', text, paths: [], detail: '检测到时间戳' };
  }
  if (isColor(trimmed)) {
    return { kind: 'color', text, paths: [], detail: '检测到颜色值' };
  }
  if (looksLikeJson(trimmed)) {
    try {
      JSON.parse(trimmed);
      return { kind: 'json', text, paths: [], detail: '检测到合法 JSON' };
    } catch {
      /* 形似 JSON 但语法错误 → 仍归为 json，便于「格式化」动作提示错误位置 */
      return { kind: 'json', text, paths: [], detail: '检测到 JSON 文本（语法可能有误）' };
    }
  }
  return { kind: 'unknown', text, paths: [], detail: KIND_LABEL.unknown };
}

/** 判定结果 → 工作台上下文类型（WK-02 复用同一套识别） */
export function intentToContextType(kind: IntentKind): 'text' | 'file' | 'url' | 'none' {
  switch (kind) {
    case 'path':
      return 'file';
    case 'url':
      return 'url';
    case 'unknown':
      return 'text';
    default:
      return 'text';
  }
}
