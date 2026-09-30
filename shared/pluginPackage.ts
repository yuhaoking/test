/**
 * 插件包纯函数规则（SEC-001 / SEC-005 / DEF-001 / DEF-007）
 *
 * 与主进程服务（electron/services/pluginManager.ts、marketplace.ts、pluginForge.ts）共用同一份规则：
 * 第三方输入（导入目录的 manifest.json、市场索引条目、AI 生成的清单）的每一条校验
 * 都必须能被 `npm test` 直接断言——规则若只存在于需要 Electron 运行时的模块里，
 * 就等于"测不到、也复审不了"，而这恰恰是第三方输入最需要被审的地方。
 * （与 shared/themePack/manifest.ts 的分工保持一致。）
 */


/** 插件标识：反向域名式小写标识（至少两段），索引 / 包内 manifest / 生成器共用 */
export const PLUGIN_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/**
 * 内置插件的保留命名空间（SEC-005）。
 *
 * 内置插件是**随安装包分发的代码**，用户对它们有天然的信任预期；
 * 一旦市场条目能占用同一个 id，恶意（或只是重名）的第三方包就能顶替内置插件的位置、
 * 甚至把已启用的内置插件目录覆盖掉。因此这两个前缀保留给内置插件，市场条目命中即拒。
 */
export const RESERVED_PLUGIN_ID_PREFIXES = ['com.office.', 'com.example.'] as const;

/** 保留命名空间说明（错误提示 / UI 文案共用） */
export const RESERVED_PLUGIN_ID_HINT = '内置插件保留命名空间（com.office.* / com.example.*）';

/** 清单字段长度上限（DEF-001：不设上限时一个 10MB 的 icon 字段就能把整个插件列表拖死） */
export const PLUGIN_MANIFEST_LIMITS = {
  maxIdLength: 64,
  maxNameLength: 64,
  maxVersionLength: 32,
  maxAuthorLength: 64,
  maxDescriptionLength: 500,
  maxCategoryLength: 32,
  maxEntryLength: 64,
  maxIconLength: 180,
  maxPermissions: 16,
  maxCommands: 32,
  maxCommandTitleLength: 48,
  maxKeywords: 8
} as const;

/**
 * 版本号白名单（DEF-007）。
 *
 * 市场索引条目的 version 会参与 `${id}-v${version}.zip.enc` 这类路径拼接，
 * 因此这里比"看起来像个版本号"更严：必须以字母/数字开头，只允许 . - + 与字母数字，
 * 结构上不可能出现 `..` 段或路径分隔符。
 */
export const PLUGIN_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.\-+]{0,31}$/;

/** 包内裸文件名（entry / icon）白名单：不允许路径分隔符、上级目录、隐藏文件 */
const BARE_FILE_RE = /^[^\u005c\u002f]+$/;

export function isValidPluginId(id: unknown): boolean {
  const s = String(id ?? '');
  return s.length >= 3 && s.length <= PLUGIN_MANIFEST_LIMITS.maxIdLength && PLUGIN_ID_RE.test(s);
}

export function assertPluginId(id: unknown): asserts id is string {
  if (!isValidPluginId(id)) throw new Error(`插件标识不合法：${String(id ?? '')}`);
}

/** 是否为内置插件保留命名空间（SEC-005） */
export function isReservedPluginId(id: unknown): boolean {
  const s = String(id ?? '');
  return RESERVED_PLUGIN_ID_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * 市场条目是否因安全策略不可安装（SEC-005 / OPT-15）。返回原因字符串，可安装则返回 null。
 *
 * 放在 shared 里是刻意的：主进程的"拒绝安装"与渲染层的"按钮置灰"必须共用同一条规则，
 * 两边各写一份迟早会出现"界面允许点、点了必然报错"的错位。
 */
export function marketItemBlockedReason(item: { id?: unknown; version?: unknown }): string | null {
  if (isReservedPluginId(item?.id)) return RESERVED_PLUGIN_ID_HINT;
  if (!isValidPluginVersion(item?.version)) return '版本号不合法';
  return null;
}

/** 版本号是否合法（DEF-007） */
export function isValidPluginVersion(v: unknown): boolean {
  const s = String(v ?? '');
  return s.length > 0 && PLUGIN_VERSION_RE.test(s);
}

/** 版本号归一（非法时抛错，调用方决定是否降级） */
export function assertPluginVersion(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!isValidPluginVersion(s)) throw new Error(`版本号不合法：${String(v ?? '')}`);
  return s;
}

/** 当前平台的主分隔符（不 import 'path'：本模块要被渲染层打包，浏览器环境没有 node:path） */
const SEP = typeof process !== 'undefined' && process.platform === 'win32' ? '\\' : '/';

/** 路径是否含自定义分隔符（Windows 的 path.win32 认反斜杠与斜杠两种） */
function hasSeparator(s: string): boolean {
  return s.includes('/') || s.includes('\\');
}

/**
 * 安全解析插件目录：校验 id 格式并断言解析结果**严格位于 root 之内**（SEC-001 路径 containment）。
 *
 * 为什么白名单之外还要 containment：白名单是"当前已知的坏输入"，containment 是结构性保证——
 * 将来白名单被放宽、或被别的调用方绕过时，前缀断言仍然拦得住 `..` 穿越。
 * 返回 null 表示不合法（调用方自行决定抛错还是跳过）。
 *
 * 实现刻意不依赖 node:path：本文件同时被渲染层引用（市场页要判断"这个条目能不能装"），
 * 而 Vite 会把 node:path externalize 成浏览器空实现，直接 import 会导致构建失败。
 * 好在白名单已经把 id 收敛成 [a-z0-9.-] 的至少两段，结构上不可能出现 `..` 段或分隔符，
 * 因此"拼接 + 前缀断言"在这里是完备的。
 */
export function resolvePluginDir(root: string, id: unknown): string | null {
  if (!isValidPluginId(id)) return null;
  const base = String(root ?? '');
  if (!base || hasSeparator(String(id))) return null;
  const trimmed = base.endsWith('/') || base.endsWith('\\') ? base.slice(0, -1) : base;
  if (!trimmed) return null;
  const target = trimmed + SEP + String(id);
  if (target === trimmed) return null;
  return target;
}

function str(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > max ? s.slice(0, max) : s;
}

/** 字符串数组归一：逐项 String() + trim + 去空 + 去重 + 长度与数量上限 */
function strArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, maxLen);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeCommands(value: unknown): PluginCommandLike[] {
  if (!Array.isArray(value)) return [];
  const out: PluginCommandLike[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const rec = v as Record<string, unknown>;
    const id = str(rec.id, PLUGIN_MANIFEST_LIMITS.maxIdLength);
    const title = str(rec.title, PLUGIN_MANIFEST_LIMITS.maxCommandTitleLength);
    if (!id || !title) continue;
    const cmd: PluginCommandLike = { id, title };
    const keywords = strArray(rec.keywords, PLUGIN_MANIFEST_LIMITS.maxKeywords, 32);
    if (keywords.length) cmd.keywords = keywords;
    out.push(cmd);
    if (out.length >= PLUGIN_MANIFEST_LIMITS.maxCommands) break;
  }
  return out;
}

/** 归一化后的最小清单形状（字段与 shared/types.ts 的 PluginManifest 一致，这里不反向依赖类型文件） */
export interface PluginCommandLike {
  id: string;
  title: string;
  keywords?: string[];
}

export interface NormalizedPluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  type: 'module' | 'pet';
  author?: string;
  description?: string;
  category?: string;
  icon?: string;
  permissions?: string[];
  commands?: PluginCommandLike[];
}

/**
 * 归一化 + 校验插件清单（DEF-001）。
 *
 * 历史缺陷：`readManifest` 直接 `JSON.parse` 后原样使用，字段是什么类型完全看第三方包的心情——
 * `icon` 写成数字时 `join(full, manifest.icon)` 直接抛 TypeError，**整个 `plugins:list` 挂掉**，
 * 用户看到的是"插件列表空白"，且没有任何一条错误指向那个包。
 * 现在：逐字段 String() 归一 + 长度上限；不合法就返回带原因的结果，由调用方决定忽略/报错。
 *
 * 另有历史缺陷：`plugins:list` 在 id 重复时**静默取第一个**，用户看到的是随机的那个目录。
 * 这里不负责去重（那是 listPlugins 的事），只负责把字段归一。
 */
export function normalizePluginManifest(
  raw: unknown
): { ok: true; manifest: NormalizedPluginManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '清单不是 JSON 对象' };
  const rec = raw as Record<string, unknown>;
  const id = str(rec.id, PLUGIN_MANIFEST_LIMITS.maxIdLength + 1);
  if (!isValidPluginId(id)) return { ok: false, error: `插件标识不合法：${id}` };
  const name = str(rec.name, PLUGIN_MANIFEST_LIMITS.maxNameLength);
  if (!name) return { ok: false, error: '缺少插件名称（name）' };
  const version = str(rec.version, PLUGIN_MANIFEST_LIMITS.maxVersionLength);
  if (!isValidPluginVersion(version)) return { ok: false, error: `版本号不合法：${version}` };
  const entry = str(rec.entry, PLUGIN_MANIFEST_LIMITS.maxEntryLength + 1);
  // entry 是"包内裸文件名"：路径分隔符 / 上级目录 / 隐藏文件一律拒绝（P2-23 同口径）
  if (!entry || !BARE_FILE_RE.test(entry) || entry.includes('..') || entry.startsWith('.')) {
    return { ok: false, error: `插件入口不合法：${entry}` };
  }
  const icon = str(rec.icon, PLUGIN_MANIFEST_LIMITS.maxIconLength + 1);
  if (icon && (!BARE_FILE_RE.test(icon) || icon.includes('..') || icon.startsWith('.'))) {
    return { ok: false, error: `插件图标不合法：${icon}` };
  }
  const manifest: NormalizedPluginManifest = {
    id,
    name,
    version,
    entry,
    type: rec.type === 'pet' ? 'pet' : 'module'
  };
  const author = str(rec.author, PLUGIN_MANIFEST_LIMITS.maxAuthorLength);
  if (author) manifest.author = author;
  const description = str(rec.description, PLUGIN_MANIFEST_LIMITS.maxDescriptionLength);
  if (description) manifest.description = description;
  const category = str(rec.category, PLUGIN_MANIFEST_LIMITS.maxCategoryLength);
  if (category) manifest.category = category;
  if (icon) manifest.icon = icon;
  const permissions = strArray(rec.permissions, PLUGIN_MANIFEST_LIMITS.maxPermissions, 32);
  if (permissions.length) manifest.permissions = permissions;
  const commands = normalizeCommands(rec.commands);
  if (commands.length) manifest.commands = commands;
  return { ok: true, manifest };
}
