/**
 * UGC 宠物/皮肤主题包（T-06，对标 VPet 创意工坊）
 *
 * 一条闭环：**制作 → 导入 → 分享**。
 * - 制作：把用户当前的宠物形象 + 动作帧 + 气泡样式打成 `.xptheme`（本质是 ZIP：theme.json + 图片）；
 * - 导入：先审后解——路径/大小/压缩比/文件类型全部校验通过后才落盘，绝不解压可执行内容；
 * - 分享：导出包 + SHA256 + 一段可直接发社区的文案（小红书/B站 UGC 传播场景）。
 *
 * 设计取舍：
 * 1) **不做主题包索引文件**。列表由"扫描目录 + 读清单"得出，天然自愈——
 *    索引文件一旦与磁盘不一致（用户手动删了目录、断电写坏），就会出现"列表里有、点开没有"的鬼影。
 * 2) **主题包不提供任何可执行能力**。允许的文件类型只有图片与文本，主题只描述"长什么样"。
 *    插件才是代码载体，两者边界必须清楚——这是 UGC 分发的安全底线。
 * 3) 应用主题 = 写用户设置项（petImage / petActions / 气泡样式 / petThemeId），
 *    复用既有的"脏配置自愈"链路，不引入第二套形象解析逻辑。
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { dialog } from 'electron';
import { dataStore, defaultPetImage, userDataDir } from '../store/dataStore';
import {
  DEFAULT_ZIP_LIMITS,
  buildZip,
  listZipEntries,
  readZipEntry,
  type ZipEntry
} from '../../shared/themePack/zip.ts';
import {
  DEFAULT_BUBBLE_STYLE,
  THEME_ACTIONS,
  THEME_ENTRY,
  THEME_FILE_EXT,
  THEME_FORMAT,
  THEME_FORMAT_VERSION,
  isAllowedThemeEntry,
  isThemeImage,
  isValidThemeId,
  normalizeThemeManifest,
  themeIdFromName,
  themeShareText
} from '../../shared/themePack/manifest.ts';
import { logWarn } from '../utils/log';
import type {
  AppSettings,
  ThemeBubbleStyle,
  ThemeExportResult,
  ThemeImportResult,
  ThemeManifest,
  ThemePackInfo,
  ThemeSkin
} from '../../shared/types';

/** 内置默认形象的主题 id：虚拟条目（没有实体目录），用于让"默认形象"也能在列表里被选中 */
export const BUILTIN_THEME_ID = 'builtin.default';

/** 主题包安装目录 */
export function themesRoot(): string {
  return join(userDataDir(), 'themes');
}

/**
 * 主题包目录（路径拼接的唯一入口，带 id 合法性校验）。
 *
 * 为什么这里必须校验：id 会参与路径拼接，而 `removeTheme` 会 `rmSync(recursive)` 整个目录。
 * 若直接用外部传来的 id，`../../Documents` 这类值就能让"删除主题包"变成**任意目录删除**。
 * 合法 id 的每一段都必须以 [a-z0-9] 开头，因此结构上不可能出现 `..` 段。
 */
function themeDir(id: string): string {
  if (!isValidThemeId(id)) throw new Error(`主题包 id 不合法：${id}`);
  return join(themesRoot(), id);
}

/** 目录体积（用于列表展示与分享文案） */
function dirBytes(dir: string): number {
  let sum = 0;
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else sum += st.size;
      } catch {
        /* 单个文件读不到不影响整体 */
      }
    }
  };
  walk(dir);
  return sum;
}

/**
 * 读取已安装主题的清单；损坏/缺失返回 null（列表里直接不显示，而不是显示一个点不开的条目）。
 *
 * DEF-002 / OPT-20：入口先做 id 白名单。
 * `themeDir(id)` 对非法 id 是**抛错**（这是刻意的：它同时守着 rmSync 的删除路径），
 * 但扫描 themes/ 目录时 id 来自**磁盘上的目录名**——用户手工建一个"旧主题"目录、
 * 或者从别处拷来一个带空格/中文的目录，`theme:list` 就会整体抛错，
 * 表现为"主题页一片空白，连原本能用的主题也看不见了"。
 * 这里把"非法目录名"降级为"这一个目录不显示"，其余主题照常。
 */
function readInstalledManifest(id: string): ThemeManifest | null {
  if (!isValidThemeId(id)) {
    logWarn(`[theme] 目录名不是合法主题 id，已跳过：${id}`);
    return null;
  }
  const file = join(themeDir(id), THEME_ENTRY);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')) as unknown;
    const files = collectFiles(themeDir(id));
    const result = normalizeThemeManifest(raw, files);
    if (!result.ok) {
      logWarn(`[theme] 主题包 ${id} 清单不合法，已忽略：${result.error}`);
      return null;
    }
    return result.manifest;
  } catch (e) {
    logWarn(`[theme] 主题包 ${id} 读取失败`, e);
    return null;
  }
}

/** 收集目录内全部文件（相对路径，`/` 分隔），用于清单引用校验与重新打包 */
function collectFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    const rel = prefix ? `${prefix}/${n}` : n;
    if (st.isDirectory()) out.push(...collectFiles(p, rel));
    else out.push(rel);
  }
  return out;
}

/** 内置默认主题（虚拟条目）：应用它等于清空 petThemeId，回退内置形象 */
function builtinInfo(active: boolean): ThemePackInfo {
  return {
    manifest: {
      format: THEME_FORMAT,
      formatVersion: THEME_FORMAT_VERSION,
      id: BUILTIN_THEME_ID,
      name: '默认形象',
      version: '1.0.0',
      author: '小鹏工具箱',
      description: '内置默认宠物形象。选择它即清除自定义形象与动作帧。',
      license: '',
      homepage: '',
      tags: ['内置'],
      image: '',
      actions: { nod: [], wave: [], blink: [], jump: [] },
      scale: 1,
      bubble: { ...DEFAULT_BUBBLE_STYLE },
      skin: null,
      createdAt: ''
    },
    dir: '',
    bytes: 0,
    builtin: true,
    active,
    installedAt: 0
  };
}

/**
 * 列表缓存：宠物窗每次加载都会问"当前主题的缩放/气泡样式"，若每次都全量扫描目录，
 * 主题包一多（每个几十帧就是几十次 stat）就会变成启动路径上的固定开销。
 * TTL 很短 + 所有变更点显式失效 —— 只挡住"同一瞬间被反复问"，不会让列表变陈旧。
 */
let listCache: { at: number; data: ThemePackInfo[] } | null = null;
const LIST_TTL_MS = 1500;

/** 主题包发生变化（导入/删除/应用）后必须调用，否则列表最多陈旧 1.5s */
function invalidateThemeCache(): void {
  listCache = null;
}

/**
 * 已安装主题包列表（内置默认排在最前）。
 * 只扫描一层目录：主题包必须是 `themes/<id>/` —— 嵌套会让"删除"变成递归猜谜。
 */
export function listThemes(): ThemePackInfo[] {
  const now = Date.now();
  if (listCache && now - listCache.at < LIST_TTL_MS) return listCache.data;
  const data = scanThemes();
  listCache = { at: now, data };
  return data;
}

function scanThemes(): ThemePackInfo[] {
  const root = themesRoot();
  const themeId = String(dataStore().get().settings.petThemeId ?? '');
  const installed: ThemePackInfo[] = [];
  let names: string[] = [];
  try {
    if (existsSync(root)) names = readdirSync(root);
  } catch (e) {
    logWarn('[theme] 主题目录读取失败', e);
  }
  for (const n of names) {
    if (n.startsWith('.')) continue; // 暂存/回收目录
    const dir = join(root, n);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // DEF-002 / OPT-20：单目录处理包 try/catch —— 一个坏目录不该让整个主题列表消失
    let manifest: ThemeManifest | null = null;
    try {
      manifest = readInstalledManifest(n);
    } catch (e) {
      logWarn(`[theme] 主题目录处理失败，已跳过：${n}`, e);
      continue;
    }
    if (!manifest) continue;
    installed.push({
      manifest,
      dir,
      bytes: dirBytes(dir),
      builtin: false,
      active: themeId === manifest.id,
      installedAt: (() => {
        try {
          return Math.round(statSync(dir).mtimeMs);
        } catch {
          return 0;
        }
      })()
    });
  }
  installed.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'zh-Hans-CN'));
  return [builtinInfo(!installed.some((t) => t.active)), ...installed];
}

/** 缓存失效点（全部变更入口都在这里，漏一个就会出现"导入后列表不更新"） */
function afterMutation(): void {
  invalidateThemeCache();
}

export function getThemeInfo(id: string): ThemePackInfo | null {
  return listThemes().find((t) => t.manifest.id === id) ?? null;
}

/** 当前生效主题的气泡样式（无主题包时给默认值） */
export function activeBubbleStyle(): ThemeBubbleStyle {
  const s = dataStore().get().settings;
  return {
    bg: String(s.petBubbleBg ?? '') || DEFAULT_BUBBLE_STYLE.bg,
    color: String(s.petBubbleColor ?? '') || DEFAULT_BUBBLE_STYLE.color,
    fontSize: Number.isFinite(s.petBubbleFontSize) ? s.petBubbleFontSize : DEFAULT_BUBBLE_STYLE.fontSize,
    radius: Number.isFinite(s.petBubbleRadius) ? s.petBubbleRadius : DEFAULT_BUBBLE_STYLE.radius
  };
}

/** 当前生效主题的显示缩放（非主题包时 1） */
export function activeThemeScale(): number {
  const id = String(dataStore().get().settings.petThemeId ?? '');
  if (!id) return 1;
  const info = getThemeInfo(id);
  const scale = Number(info?.manifest.scale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// ---------------- 导入 ----------------

/** 压缩包内允许出现的内容：图片/文本清单之外一律拒绝（UGC 包里不允许存在可执行内容） */
function assertThemeEntries(entries: ZipEntry[]): void {
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!isAllowedThemeEntry(e.name)) {
      throw new Error(`主题包内含不允许的文件类型（只允许图片与文本）：${e.name}`);
    }
  }
  if (!entries.some((e) => !e.isDirectory && e.name === THEME_ENTRY)) {
    throw new Error(`主题包缺少清单文件 ${THEME_ENTRY}（应位于压缩包根目录）`);
  }
}

/**
 * 从文件导入主题包。
 * @param overwrite 已存在同 id 主题时是否覆盖；false 且已存在时返回 `exists: true` 交由 UI 二次确认
 */
export function importThemeFromFile(file: string, overwrite = false): ThemeImportResult {
  if (!existsSync(file)) return { ok: false, error: '文件不存在' };
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(readFileSync(file));
  } catch (e) {
    return { ok: false, error: `读取失败：${(e as Error).message}` };
  }
  if (buf.length > 128 * 1024 * 1024) return { ok: false, error: '主题包过大（>128MB）' };

  let entries: ZipEntry[];
  try {
    entries = listZipEntries(buf, DEFAULT_ZIP_LIMITS);
    assertThemeEntries(entries);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // 先解出清单并校验（此时尚未向磁盘写入任何内容）
  let manifest: ThemeManifest;
  try {
    const entry = entries.find((e) => !e.isDirectory && e.name === THEME_ENTRY) as ZipEntry;
    const json = JSON.parse(new TextDecoder().decode(readZipEntry(buf, entry)).replace(/^\uFEFF/, '')) as unknown;
    const files = entries.filter((e) => !e.isDirectory).map((e) => e.name);
    const result = normalizeThemeManifest(json, files);
    if (!result.ok) return { ok: false, error: result.error };
    manifest = result.manifest;
  } catch (e) {
    return { ok: false, error: `主题包清单解析失败：${(e as Error).message}` };
  }

  const target = themeDir(manifest.id);
  if (existsSync(target) && !overwrite) return { ok: false, error: '已安装同 id 主题包', exists: true };

  // 解压到暂存目录：任何一步失败都不会污染已安装主题
  const staging = join(themesRoot(), `.staging-${Date.now().toString(36)}`);
  try {
    mkdirSync(staging, { recursive: true });
    let written = 0;
    for (const e of entries) {
      if (e.isDirectory) continue;
      const data = readZipEntry(buf, e);
      written += data.length;
      // 二次总量护栏：中央目录声明值已被校验过，这里是"按实际写出的字节数"再兜一层
      if (written > DEFAULT_ZIP_LIMITS.maxTotalUncompressed) throw new Error('主题包解压后总大小超限');
      const dest = join(staging, e.name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
    // 清单由服务端重新序列化写入：保持字段顺序稳定，也确保存盘内容与校验过的对象完全一致
    writeFileSync(join(staging, THEME_ENTRY), JSON.stringify(manifest, null, 2), 'utf-8');

    mkdirSync(themesRoot(), { recursive: true });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `导入失败：${(e as Error).message}` };
  }

  afterMutation();
  const info = getThemeInfo(manifest.id);
  return info ? { ok: true, info } : { ok: false, error: '导入后读取主题包失败' };
}

/**
 * 弹出文件选择器挑一个主题包（用户取消返回 null）。
 * 刻意不在这里直接导入：覆盖确认需要"再导入一次"，而**回传路径必须由主进程自己记住**——
 * 若接受渲染层传来的路径，任何页面脚本都能借导入接口去读本机任意文件（UGC 接口不能开这个口子）。
 */
export async function pickThemeFile(): Promise<string | null> {
  const picked = await dialog.showOpenDialog({
    title: '导入主题包',
    properties: ['openFile'],
    filters: [
      { name: '小鹏主题包', extensions: ['xptheme'] },
      { name: '压缩包', extensions: ['zip'] }
    ]
  });
  const file = picked.filePaths?.[0];
  return picked.canceled || !file ? null : file;
}

export function removeTheme(id: string): { ok: boolean; error?: string } {
  if (id === BUILTIN_THEME_ID) return { ok: false, error: '内置主题不可删除' };
  // 删除目标的路径**取自目录扫描结果**，而不是用调用方传来的 id 现拼——
  // 这样即使 id 是 `..\..\x`，也只是"查不到这个主题"，不会删到目录外的任何东西。
  const info = getThemeInfo(id);
  if (!info) return { ok: false, error: '主题包不存在' };
  if (info.builtin) return { ok: false, error: '内置主题不可删除' };
  const dir = info.dir;
  // 兜底断言：删除目标必须确实位于主题目录之内
  const root = themesRoot();
  if (dir !== join(root, basename(dir)) || !existsSync(dir)) return { ok: false, error: '主题包路径非法' };
  if (dataStore().get().settings.petThemeId === id) applyTheme(BUILTIN_THEME_ID);
  try {
    rmSync(dir, { recursive: true, force: true });
    afterMutation();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------- 应用 ----------------

/**
 * 应用主题包。
 * @param applySkin 是否同时应用界面皮肤（明暗/强调色）——默认不勾选：
 *        换一只宠物不应该顺手改掉用户精心调过的主题色。
 */
export function applyTheme(id: string, applySkin = false): { ok: boolean; error?: string } {
  if (id === BUILTIN_THEME_ID || !id) {
    dataStore().updateSettings({
      petImage: '',
      petActions: { nod: [], wave: [], blink: [], jump: [] },
      petThemeId: '',
      petBubbleBg: '',
      petBubbleColor: '',
      petBubbleFontSize: DEFAULT_BUBBLE_STYLE.fontSize,
      petBubbleRadius: DEFAULT_BUBBLE_STYLE.radius
    });
    afterMutation();
    return { ok: true };
  }
  const info = getThemeInfo(id);
  if (!info) return { ok: false, error: '主题包不存在' };
  const m = info.manifest;
  // 生效主题变了 → 列表里的 active 标记与宠物窗取用的样式都要立刻跟上（不能等 TTL）
  const toAbs = (rel: string): string => join(info.dir, rel);
  const actions: Record<string, string[]> = {};
  for (const a of THEME_ACTIONS) actions[a] = (m.actions[a] ?? []).map(toAbs);

  const patch: Partial<AppSettings> = {
    petImage: toAbs(m.image),
    petActions: actions,
    petThemeId: m.id,
    petBubbleBg: m.bubble.bg,
    petBubbleColor: m.bubble.color,
    petBubbleFontSize: m.bubble.fontSize,
    petBubbleRadius: m.bubble.radius
  };
  if (applySkin && m.skin) {
    if (m.skin.theme) patch.theme = m.skin.theme;
    if (m.skin.accent) patch.accent = m.skin.accent;
  }
  dataStore().updateSettings(patch);
  afterMutation();
  return { ok: true };
}

// ---------------- 导出 / 分享 ----------------

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 把已安装主题重新打包为 `.xptheme` 字节流（导出与分享共用） */
function packInstalled(id: string): { bytes: Uint8Array; info: ThemePackInfo; frames: number } | null {
  const info = getThemeInfo(id);
  if (!info || info.builtin) return null;
  const files = collectFiles(info.dir).filter((f) => f !== THEME_ENTRY && isAllowedThemeEntry(f));
  const entries = [
    { name: THEME_ENTRY, data: new TextEncoder().encode(JSON.stringify(info.manifest, null, 2)) },
    ...files.map((f) => ({ name: f, data: new Uint8Array(readFileSync(join(info.dir, f))) }))
  ];
  const frames = Object.values(info.manifest.actions).reduce((n, list) => n + list.length, 0);
  return { bytes: buildZip(entries), info, frames };
}

/** 导出主题包到指定路径；不传路径则弹保存对话框（用户取消返回 path: null） */
export async function exportTheme(id: string, targetPath?: string): Promise<ThemeExportResult> {
  const packed = packInstalled(id);
  if (!packed) throw new Error('该主题包不可导出');
  const { bytes, info, frames } = packed;
  let out = targetPath ?? '';
  if (!out) {
    const picked = await dialog.showSaveDialog({
      title: '导出主题包',
      defaultPath: `${info.manifest.id}.xptheme`,
      filters: [{ name: '小鹏主题包', extensions: ['xptheme'] }]
    });
    if (picked.canceled || !picked.filePath) return { path: null, sha256: '', bytes: 0, shareText: '' };
    out = picked.filePath;
  }
  writeFileSync(out, bytes);
  const hash = sha256(bytes);
  return { path: out, sha256: hash, bytes: bytes.length, shareText: themeShareText(info.manifest, { sha256: hash, bytes: bytes.length, frames }) };
}

/** 只取分享文案（不落盘），用于"复制分享文案"按钮 */
export function themeShareTextOf(id: string): string {
  const packed = packInstalled(id);
  if (!packed) return '';
  const hash = sha256(packed.bytes);
  return themeShareText(packed.info.manifest, { sha256: hash, bytes: packed.bytes.length, frames: packed.frames });
}

// ---------------- 制作 ----------------

export interface ThemeDraft {
  name: string;
  id?: string;
  author?: string;
  description?: string;
  version?: string;
  license?: string;
  homepage?: string;
  tags?: string[];
  /** 主形象绝对路径（默认取当前宠物形象） */
  image?: string;
  /** 动作帧绝对路径（默认取当前动作帧） */
  actions?: Record<string, string[]>;
  bubble?: Partial<ThemeBubbleStyle>;
  skin?: Partial<ThemeSkin>;
}

function extOfSafe(p: string): string {
  const e = extname(p).toLowerCase();
  return isThemeImage('x' + e) ? e : '.png';
}

/**
 * 制作主题包：把当前（或指定）的形象与动作帧打成 `.xptheme`。
 *
 * 为什么要"从当前配置反向打包"：用户通常是先在设置里把形象和动作帧调满意，
 * 才产生"这个想分享出去"的念头。让创作者重新按包结构整理一遍文件，是最没必要的门槛。
 */
export async function createThemePack(draft: ThemeDraft, targetPath?: string): Promise<ThemeExportResult> {
  const settings = dataStore().get().settings;
  const name = String(draft.name ?? '').trim() || '未命名主题';
  const id = draft.id && /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(draft.id)
    ? draft.id
    : themeIdFromName(name, createHash('sha1').update(`${name}${Date.now()}`).digest('hex'));

  const imageAbs = draft.image && existsSync(draft.image) ? draft.image : String(settings.petImage || defaultPetImage());
  if (!existsSync(imageAbs)) throw new Error('找不到宠物形象文件，请先在设置里选择一张图片');

  const actionsAbs: Record<string, string[]> = {};
  for (const a of THEME_ACTIONS) {
    const src = draft.actions?.[a] ?? settings.petActions[a] ?? [];
    actionsAbs[a] = (Array.isArray(src) ? src : []).filter((p) => typeof p === 'string' && existsSync(p));
  }

  const enc = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [];
  const imageName = `pet${extOfSafe(imageAbs)}`;
  entries.push({ name: imageName, data: new Uint8Array(readFileSync(imageAbs)) });

  const actions: Record<string, string[]> = {};
  const seen = new Set<string>();
  let frames = 0;
  for (const a of THEME_ACTIONS) {
    const list: string[] = [];
    for (const [i, p] of actionsAbs[a].entries()) {
      // 同一张图被多个动作引用时只打包一次：包体积是分享意愿的直接阻力
      const key = p.toLowerCase();
      const fileName = `frames/${a}/${String(i + 1).padStart(2, '0')}${extOfSafe(p)}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ name: fileName, data: new Uint8Array(readFileSync(p)) });
      }
      list.push(fileName);
      frames++;
    }
    actions[a] = list;
  }

  const fallback = normalizeThemeManifest(
    {
      format: THEME_FORMAT,
      formatVersion: THEME_FORMAT_VERSION,
      id,
      name,
      version: draft.version || '1.0.0',
      author: draft.author || '',
      description: draft.description || '',
      license: draft.license || '',
      homepage: draft.homepage || '',
      tags: draft.tags || [],
      image: imageName,
      actions,
      bubble: { ...DEFAULT_BUBBLE_STYLE, ...(draft.bubble ?? {}) },
      skin: draft.skin && (draft.skin.theme || draft.skin.accent) ? { theme: draft.skin.theme ?? '', accent: draft.skin.accent ?? '' } : null,
      createdAt: new Date().toISOString()
    },
    entries.map((e) => e.name)
  );
  if (!fallback.ok) throw new Error(fallback.error);

  const bytes = buildZip([{ name: THEME_ENTRY, data: enc.encode(JSON.stringify(fallback.manifest, null, 2)) }, ...entries]);

  let out = targetPath ?? '';
  if (!out) {
    const picked = await dialog.showSaveDialog({
      title: '保存主题包',
      defaultPath: `${fallback.manifest.id}.xptheme`,
      filters: [{ name: '小鹏主题包', extensions: ['xptheme'] }]
    });
    if (picked.canceled || !picked.filePath) return { path: null, sha256: '', bytes: 0, shareText: '' };
    out = picked.filePath;
  }
  writeFileSync(out, bytes);
  const hash = sha256(bytes);
  return {
    path: out,
    sha256: hash,
    bytes: bytes.length,
    shareText: themeShareText(fallback.manifest, { sha256: hash, bytes: bytes.length, frames })
  };
}

/** 导出"制作模板"：一份可直接改的骨架包（清单 + 默认形象 + 制作说明） */
export async function exportThemeTemplate(targetPath?: string): Promise<string | null> {
  const readme = `# 主题包制作说明

一个主题包就是一个 ZIP 压缩包，把扩展名改成 .xptheme 即可分享。结构：

    theme.json          清单（必须，放在压缩包根目录）
    pet.png             主形象（清单里 image 指向它）
    frames/nod/01.png   动作帧（可选，nod/wave/blink/jump 四个动作）
    preview.png         预览图（可选）

## 步骤

1. 解压本模板，用同名文件替换 pet.png（建议 PNG 透明背景，尺寸 96~256px）；
2. 需要动画就放进 frames/<动作名>/ 目录，文件名按 01、02、03 排序；
3. 编辑 theme.json 里的 name / id / author / description；
   - id 必须是反向域名式小写英文，且全网唯一，例如 com.yourname.my-cat；
   - 引用的每个文件都必须真实存在于包里，否则导入会直接报错并指出缺哪个文件；
4. 全选文件（不要多套一层目录）→ 右键 → 压缩为 ZIP → 改名为 <id>.xptheme；
5. 小鹏工具箱 → 设置 → 桌面宠物 → 主题包 → 导入，即可预览效果。

## 可以做 / 不可以做

- 可以：图片（png/gif/webp/jpg/bmp）与文本（json/md/txt）；
- 不可以：任何可执行文件、脚本、动态库——主题包不允许包含代码，导入时会被直接拒绝。

## 授权提醒

请只使用你有权分享的图片素材，并在 license 字段写明授权协议（如 CC-BY-4.0）。
`;

  const example = {
    format: THEME_FORMAT,
    formatVersion: THEME_FORMAT_VERSION,
    id: 'com.yourname.example',
    name: '我的主题',
    version: '1.0.0',
    author: '你的名字',
    description: '一句话介绍这个主题。',
    license: 'CC-BY-4.0',
    homepage: '',
    tags: ['示例'],
    image: 'pet.png',
    actions: { nod: [], wave: [], blink: [], jump: [] },
    bubble: { bg: '', color: '', fontSize: 12, radius: 8 },
    skin: null,
    createdAt: new Date().toISOString()
  };

  const entries: { name: string; data: Uint8Array }[] = [
    { name: THEME_ENTRY, data: new TextEncoder().encode(JSON.stringify(example, null, 2)) },
    { name: '制作说明.md', data: new TextEncoder().encode(readme) }
  ];
  const pet = defaultPetImage();
  if (existsSync(pet)) entries.push({ name: 'pet.png', data: new Uint8Array(readFileSync(pet)) });

  let out = targetPath ?? '';
  if (!out) {
    const picked = await dialog.showSaveDialog({
      title: '导出制作模板',
      defaultPath: `主题包模板${THEME_FILE_EXT}`,
      filters: [{ name: '小鹏主题包', extensions: ['xptheme'] }]
    });
    if (picked.canceled || !picked.filePath) return null;
    out = picked.filePath;
  }
  writeFileSync(out, buildZip(entries));
  return out;
}

/**
 * 资源自检：主题包内引用的文件必须存在。
 * 导入时已校验过一次，但用户可能事后手工删掉包内图片——设置页据此显示"已损坏"而不是让宠物变空白。
 */
export function verifyTheme(id: string): { ok: boolean; missing: string[] } {
  const info = getThemeInfo(id);
  if (!info || info.builtin) return { ok: true, missing: [] };
  const missing: string[] = [];
  const check = (rel: string): void => {
    if (!existsSync(join(info.dir, rel))) missing.push(rel);
  };
  check(info.manifest.image);
  for (const list of Object.values(info.manifest.actions)) for (const f of list) check(f);
  return { ok: missing.length === 0, missing };
}
