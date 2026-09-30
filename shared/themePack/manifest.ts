/**
 * 主题包清单（theme.json）的纯函数规则（T-06 UGC 宠物/皮肤主题包）
 *
 * 与主进程服务（electron/services/themePack.ts）共用同一份规则：
 * UGC 内容的每一条校验都必须能被 `npm test` 直接断言——规则若只存在于需要 Electron 运行时
 * 的模块里，就等于"测不到、也复审不了"，而这恰恰是第三方输入最需要被审的地方。
 */

import type { ThemeBubbleStyle, ThemeManifest, ThemeSkin } from '../types.ts';

/** 主题包标识：写进 theme.json 的 format 字段，用于给出"这不是主题包"的明确提示 */
export const THEME_FORMAT = 'xiaopeng-theme';
/** 当前支持的清单版本：更高版本一律拒绝（而不是尽力解析后行为不可预期） */
export const THEME_FORMAT_VERSION = 1;
/** 包内清单文件名（必须在压缩包根目录） */
export const THEME_ENTRY = 'theme.json';
/** 分享文件扩展名（本质是 ZIP，用专有扩展名方便双击识别与文件关联） */
export const THEME_FILE_EXT = '.xptheme';

/** 允许出现在主题包里的文件类型：只有图片与文本，任何可执行/脚本类型一律拒绝 */
export const THEME_ASSET_EXTS = ['.png', '.gif', '.webp', '.jpg', '.jpeg', '.bmp', '.apng', '.json', '.md', '.txt'];
/** 可作为形象/帧的图片类型 */
export const THEME_IMAGE_EXTS = ['.png', '.gif', '.webp', '.jpg', '.jpeg', '.bmp', '.apng'];

/** 主题包可用的动作名（与宠物动作播放入口一致） */
export const THEME_ACTIONS = ['nod', 'wave', 'blink', 'jump'] as const;

export const THEME_LIMITS = {
  maxNameLength: 40,
  maxAuthorLength: 40,
  maxDescriptionLength: 200,
  maxTags: 8,
  maxTagLength: 16,
  maxFramesPerAction: 60,
  minScale: 0.25,
  maxScale: 4,
  minFontSize: 9,
  maxFontSize: 24,
  maxRadius: 24
};

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? '.' + m[1].toLowerCase() : '';
}

/** 包内条目是否属于允许的类型（目录条目单独判断，不在此列） */
export function isAllowedThemeEntry(name: string): boolean {
  return THEME_ASSET_EXTS.includes(extOf(name));
}

export function isThemeImage(name: string): boolean {
  return THEME_IMAGE_EXTS.includes(extOf(name));
}

/** 主题包 id：小写字母/数字/短横线，至少两段（com.xiaopeng.orange-cat） */
export function isValidThemeId(id: string): boolean {
  const s = String(id ?? '');
  if (s.length < 3 || s.length > 64) return false;
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(s);
}

export function isValidThemeVersion(v: string): boolean {
  return /^\d+(\.\d+){0,3}$/.test(String(v ?? '').trim());
}

/** 由主题名生成兜底 id（用户不起 id 时用；中文名转不出 ASCII 则退回随机短串） */
export function themeIdFromName(name: string, seed: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const tail = String(seed ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase() || 'x';
  return slug ? `local.${slug}-${tail}` : `local.theme-${tail}`;
}

export const DEFAULT_BUBBLE_STYLE: ThemeBubbleStyle = { bg: '', color: '', fontSize: 12, radius: 8 };

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 颜色只接受 #rgb / #rrggbb / #rrggbbaa 或空串（拒绝任意 CSS 值，避免注入到 style 里） */
function color(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s.toLowerCase() : '';
}

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export type ThemeValidation = { ok: true; manifest: ThemeManifest } | { ok: false; error: string };

/**
 * 校验并归一化清单。
 *
 * @param raw   theme.json 的解析结果（可为任意 JSON 值）
 * @param files 压缩包内的**文件**条目名（已归一化），用于校验清单引用的资源真实存在——
 *              "清单说有、包里没有"是创作者最常见的打包错误，必须在导入时就给出明确提示，
 *              而不是等宠物窗加载失败变成一片空白（历史幽灵窗口问题正是这类静默失败）。
 */
export function normalizeThemeManifest(raw: unknown, files: string[]): ThemeValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'theme.json 不是有效的对象' };
  const o = raw as Record<string, unknown>;

  if (o.format !== THEME_FORMAT) {
    return { ok: false, error: `这不是小鹏工具箱主题包（format 应为 ${THEME_FORMAT}，实际为 ${String(o.format ?? '空')}）` };
  }
  const formatVersion = Number(o.formatVersion ?? 0);
  if (!Number.isFinite(formatVersion) || formatVersion < 1) return { ok: false, error: 'formatVersion 缺失或不合法' };
  if (formatVersion > THEME_FORMAT_VERSION) {
    return { ok: false, error: `主题包版本过新（formatVersion=${formatVersion}），请升级小鹏工具箱后再导入` };
  }

  const id = str(o.id, 64);
  if (!isValidThemeId(id)) {
    return { ok: false, error: `id 不合法（应为小写反向域名式，如 com.you.orange-cat）：${id || '空'}` };
  }
  const name = str(o.name, THEME_LIMITS.maxNameLength);
  if (!name) return { ok: false, error: 'name 不能为空' };
  const version = str(o.version, 20) || '1.0.0';
  if (!isValidThemeVersion(version)) return { ok: false, error: `version 不合法：${version}` };

  const homepage = str(o.homepage, 200);
  if (homepage && !/^https?:\/\//i.test(homepage)) return { ok: false, error: 'homepage 只支持 http/https 链接' };

  const fileSet = new Set(files);
  const missing: string[] = [];

  const image = str(o.image, 200);
  if (!image) return { ok: false, error: 'image 不能为空（主题包必须包含主形象）' };
  if (!isThemeImage(image)) return { ok: false, error: `image 必须是图片文件：${image}` };
  if (!fileSet.has(image)) missing.push(image);

  const actions: Record<string, string[]> = {};
  const rawActions = o.actions;
  if (rawActions !== undefined) {
    if (!rawActions || typeof rawActions !== 'object' || Array.isArray(rawActions)) {
      return { ok: false, error: 'actions 必须是「动作名 → 文件名数组」的对象' };
    }
    for (const [key, value] of Object.entries(rawActions as Record<string, unknown>)) {
      if (!(THEME_ACTIONS as readonly string[]).includes(key)) continue; // 未知动作忽略（向前兼容）
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) return { ok: false, error: `actions.${key} 必须是文件名数组` };
      if (value.length > THEME_LIMITS.maxFramesPerAction) {
        return { ok: false, error: `actions.${key} 帧数过多（${value.length} > ${THEME_LIMITS.maxFramesPerAction}）` };
      }
      const frames: string[] = [];
      for (const f of value) {
        const p = str(f, 200);
        if (!p) continue;
        if (!isThemeImage(p)) return { ok: false, error: `actions.${key} 含非图片文件：${p}` };
        if (!fileSet.has(p)) missing.push(p);
        frames.push(p);
      }
      if (frames.length) actions[key] = frames;
    }
  }
  for (const a of THEME_ACTIONS) if (!actions[a]) actions[a] = [];

  if (missing.length) {
    const uniq = [...new Set(missing)].slice(0, 5);
    return { ok: false, error: `主题包内缺少清单引用的文件：${uniq.join('、')}${missing.length > 5 ? ' 等' : ''}` };
  }

  const rawBubble = (o.bubble && typeof o.bubble === 'object' && !Array.isArray(o.bubble) ? o.bubble : {}) as Record<string, unknown>;
  const bubble: ThemeBubbleStyle = {
    bg: color(rawBubble.bg),
    color: color(rawBubble.color),
    fontSize: intIn(rawBubble.fontSize, THEME_LIMITS.minFontSize, THEME_LIMITS.maxFontSize, DEFAULT_BUBBLE_STYLE.fontSize),
    radius: intIn(rawBubble.radius, 0, THEME_LIMITS.maxRadius, DEFAULT_BUBBLE_STYLE.radius)
  };

  let skin: ThemeSkin | null = null;
  if (o.skin && typeof o.skin === 'object' && !Array.isArray(o.skin)) {
    const s = o.skin as Record<string, unknown>;
    const theme = s.theme === 'dark' || s.theme === 'light' ? s.theme : '';
    const accent = color(s.accent);
    if (theme || accent) skin = { theme, accent };
  }

  const tags = Array.isArray(o.tags)
    ? o.tags
        .map((t) => str(t, THEME_LIMITS.maxTagLength))
        .filter(Boolean)
        .slice(0, THEME_LIMITS.maxTags)
    : [];

  // 白名单重建：未知字段不进入运行时，避免 UGC 携带任意 JSON 被长期存库
  return {
    ok: true,
    manifest: {
      format: THEME_FORMAT,
      formatVersion: THEME_FORMAT_VERSION,
      id,
      name,
      version,
      author: str(o.author, THEME_LIMITS.maxAuthorLength),
      description: str(o.description, THEME_LIMITS.maxDescriptionLength),
      license: str(o.license, 40),
      homepage,
      tags,
      image,
      actions,
      scale: (() => {
        const n = Number(o.scale);
        if (!Number.isFinite(n) || n <= 0) return 1;
        return Math.min(THEME_LIMITS.maxScale, Math.max(THEME_LIMITS.minScale, Number(n.toFixed(2))));
      })(),
      bubble,
      skin,
      createdAt: str(o.createdAt, 40) || new Date().toISOString()
    }
  };
}

/** 生成可直接发到社区的分享文案（对齐 VPet 创意工坊的"投稿帖"习惯） */
export function themeShareText(
  manifest: ThemeManifest,
  opts: { sha256: string; bytes: number; frames: number }
): string {
  // 逐行 push（而不是先塞空串再过滤）——否则可选项缺失时会连带删掉正文里的空行分隔
  const lines: string[] = [
    `【小鹏工具箱 · 主题包】${manifest.name} v${manifest.version}`,
    '',
    manifest.description || '（暂无简介）',
    '',
    `- 作者：${manifest.author || '匿名'}`,
    `- 主题 id：${manifest.id}`,
    `- 动作帧：${opts.frames} 帧`,
    `- 文件大小：${(opts.bytes / 1024).toFixed(1)} KB`,
    `- SHA256：${opts.sha256}`
  ];
  if (manifest.license) lines.push(`- 授权：${manifest.license}`);
  if (manifest.homepage) lines.push(`- 主页：${manifest.homepage}`);
  if (manifest.tags.length) lines.push(`- 标签：${manifest.tags.join(' / ')}`);
  lines.push('', `安装方式：小鹏工具箱 → 设置 → 桌面宠物 → 主题包 → 导入，选择 ${manifest.id}.xptheme 文件。`);
  return lines.join('\n');
}
