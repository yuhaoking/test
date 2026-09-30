import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher
} from 'fs';
import { homedir } from 'os';
import { basename, extname, join } from 'path';
import { BrowserWindow, dialog, screen, shell } from 'electron';
import { db } from '../store/db';
import { dataStore } from '../store/dataStore';
import {
  destroyBoxWindow,
  ensureBoxWindow,
  arrangeCapsuleGroups,
  registerBoxLookup,
  setCapsulePreview,
  syncBoxWindows,
  boxWindowByBoxId
} from '../windows/boxWindow';
import { scanInstalledApps } from './appScanner';
import { logError, logWarn } from '../utils/log';
import type { DesktopBox, DesktopBoxItem, DesktopFileType } from '../../shared/types';

/**
 * 桌面收纳服务（规格 DR-01 ~ DR-07）
 *
 * 核心原则（DR-02/DR-06）：
 * - 默认“仅整理视图”：只建立路径索引，绝不物理移动文件；
 * - “真移动”模式：文件移动到盒子目标目录，操作前二次确认并写入操作日志（5.4）；
 * - 智能分类（boxAutoMode）：监听 watchDir（默认桌面）新增文件，按类别自动归入对应收纳盒。
 */

const BOX_COLORS = ['#5b8cff', '#3ecf8e', '#f7b500', '#e5484d', '#b06ef7', '#ff8a3d'];

/** 三大分类（用户需求：软件/文件/图片 各一个盒子，其余统一归“文件”） */
const SMART_TYPES: Record<DesktopFileType, { label: string; color: string }> = {
  file: { label: '文件', color: '#5b8cff' },
  software: { label: '软件', color: '#e5484d' },
  image: { label: '图片', color: '#3ecf8e' }
};

/** 扩展名 → 类别（image/software；其余一切归 file） */
const EXT_TYPE_MAP: Array<[DesktopFileType, string[]]> = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']],
  ['software', ['exe', 'lnk', 'bat', 'cmd', 'msi', 'msix', 'com', 'ps1', 'wsh', 'reg']]
];

/** 智能分类忽略的临时/隐藏文件前缀 */
const IGNORE_NAMES = ['~$', '.tmp', '~', '.git', '$RECYCLE.BIN', 'System Volume Information'];

let boxes: DesktopBox[] | null = null;

function loadBoxes(): DesktopBox[] {
  if (boxes) return boxes;
  boxes = [];
  for (const row of db().all('desktop_boxes')) {
    try {
      boxes.push(JSON.parse(row.value) as DesktopBox);
    } catch {
      /* 跳过损坏项 */
    }
  }
  boxes.sort((a, b) => a.order - b.order);
  return boxes;
}

function persistBox(box: DesktopBox): void {
  try {
    db().set('desktop_boxes', box.id, JSON.stringify(box));
  } catch (e) {
    logError('[boxes] 保存失败', e);
  }
}

function broadcast(): void {
  const list = listBoxes();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('boxes:changed', list);
  }
}

/**
 * 读时净化（最终防线）：任何读取入口都会去除盒内重复（含大小写变体），
 * 保证盒子窗口、侧边栏等界面拿到的数据永远唯一；发现重复时立即持久化并广播。
 * （写入路径已全局去重，此处兜底未知来源的重复，确保“界面显示重复”绝不可能发生）
 */
function sanitizeBoxForRead(box: DesktopBox): DesktopBox {
  // 迁移：旧数据缺 kind → 默认 files（apps/search 由创建方显式设置）
  if (!box.kind) box.kind = 'files';
  const seen = new Set<string>();
  const keep: DesktopBox['items'] = [];
  let changed = false;
  for (const item of box.items) {
    const key = normalizePath(item.path);
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    keep.push(item);
  }
  if (changed) {
    box.items = keep;
    persistBox(box);
    broadcast();
  }
  return box;
}

export function listBoxes(): DesktopBox[] {
  return loadBoxes().map((b) => sanitizeBoxForRead(b));
}

export function getBox(id: string): DesktopBox | null {
  const box = loadBoxes().find((b) => b.id === id) ?? null;
  return box ? sanitizeBoxForRead(box) : null;
}

let cachedDesktopDir = '';

/**
 * 桌面目录：优先读取注册表 User Shell Folders（正确处理 OneDrive 桌面重定向），
 * 失败时回退 %USERPROFILE%\Desktop；结果进程内缓存。
 */
/**
 * SVC-8 修复：reg.exe 输出在中文系统为 GBK（如 OneDrive 重定向后的中文桌面路径），
 * 按 UTF-8 解码会得到乱码导致路径识别失败。此处先按 UTF-8 尝试，出现替换字符再回退 GBK。
 */
function decodeRegOutput(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf;
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

export function desktopDir(): string {
  if (cachedDesktopDir) return cachedDesktopDir;
  try {
    const out = decodeRegOutput(
      execFileSync(
        'reg.exe',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
        { encoding: 'buffer', timeout: 5000, windowsHide: true }
      )
    );
    const line = out.split(/\r?\n/).find((l) => l.includes('REG_EXPAND_SZ') || l.includes('REG_SZ'));
    if (line) {
      const val = line
        .replace(/^.*REG_[A-Z_]+/, '')
        .trim()
        .replace(/%USERPROFILE%/gi, process.env.USERPROFILE ?? '');
      if (val && existsSync(val)) {
        cachedDesktopDir = val;
        return val;
      }
    }
  } catch {
    /* 回退 */
  }
  const user = process.env.USERPROFILE ?? homedir();
  cachedDesktopDir = join(user, 'Desktop');
  return cachedDesktopDir;
}

/** 新建收纳盒（DR-01：自定义名称/颜色/图标由 update 补全；默认位置为当前显示器工作区居中偏左） */
export function createBox(partial?: Partial<DesktopBox>): DesktopBox {
  const { workArea } = screen.getPrimaryDisplay();
  const box: DesktopBox = {
    id: `box-${randomUUID()}`,
    name: `收纳盒 ${loadBoxes().length + 1}`,
    color: BOX_COLORS[loadBoxes().length % BOX_COLORS.length],
    collapsed: false,
    visible: true,
    onTop: true,
    x: workArea.x + 120,
    y: workArea.y + 120,
    width: 320,
    height: 260,
    watchDir: desktopDir(),
    targetDir: '',
    order: loadBoxes().length,
    rules: [],
    items: [],
    // 缺省为文件盒；apps/search 由创建方显式指定 kind
    kind: 'files',
    ...partial
  };
  loadBoxes().push(box);
  persistBox(box);
  ensureBoxWindow(box);
  broadcast();
  return box;
}

/** 可被外部 patch 的字段白名单（SVC-2：`id`/`items`/`targetDir` 等不允许由渲染层改写） */
const BOX_PATCHABLE = new Set<keyof DesktopBox>([
  'name',
  'color',
  'collapsed',
  'onTop',
  'visible',
  'x',
  'y',
  'width',
  'height',
  'displayId',
  'layouts',
  'watchDir',
  'order',
  'kind',
  'capsule',
  'group',
  'expandBounds'
]);

/** 更新盒子；涉及位置/尺寸/折叠/可见性/置顶时同步窗口；watchDir 变化时重启智能监听 */
export function updateBox(id: string, patch: Partial<DesktopBox>): DesktopBox | null {
  const box = getBox(id);
  if (!box) return null;
  // SVC-2 修复：只接受白名单字段，避免 id/items/targetDir 被篡改导致窗口孤儿或“真移动”逃逸
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!BOX_PATCHABLE.has(key as keyof DesktopBox) || value === undefined) continue;
    (box as unknown as Record<string, unknown>)[key] = value;
  }
  /*
   * P2-6（数据侧第二处入口）：任何位置/尺寸/胶囊状态变更都必须让 expandBounds 与现状一致 ——
   * 胶囊态下它是"展开后的完整尺寸"（跟随更新），非胶囊态下它没有意义（直接清除）。
   * 这样无论走 updateBox（设置页/审计脚本）还是 updateBoxBounds（窗口拖拽），
   * 都不会再留下会被误用的陈旧坐标。
   */
  if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined || patch.capsule !== undefined) {
    if (box.capsule) box.expandBounds = { x: box.x, y: box.y, width: box.width, height: box.height };
    else box.expandBounds = undefined;
  }
  persistBox(box);
  ensureBoxWindow(box);
  if (patch.watchDir !== undefined) restartSmartWatch();
  broadcast();
  return box;
}

/** 窗口拖拽/缩放后仅同步位置尺寸（不触发窗口重建，避免抖动） */
export function updateBoxBounds(
  id: string,
  bounds: { x: number; y: number; width: number; height: number },
  layoutKey?: string
): void {
  const box = getBox(id);
  if (!box) return;
  box.x = Math.round(bounds.x);
  box.y = Math.round(bounds.y);
  box.width = Math.round(bounds.width);
  box.height = Math.round(bounds.height);
  /*
   * P2-6 修复（数据侧）：expandBounds 只在胶囊模式下才有意义。
   *
   * 用户"用过胶囊 → 展开 → 拖到新位置"后，box.x/y 已更新而 expandBounds 仍是收起前的快照，
   * 重启时一旦被优先采用就会弹回旧坐标。这里明确同步：胶囊态下跟随更新，非胶囊态直接清掉，
   * 不留任何可能被误用的陈旧值（窗口侧 applyBounds 也只在胶囊态读它，双保险）。
   */
  if (box.capsule) box.expandBounds = { x: box.x, y: box.y, width: box.width, height: box.height };
  else box.expandBounds = undefined;
  // T-08 多显示器布局记忆：按显示器组合（拓扑 + DPI）分别保存，最多留 8 组
  if (layoutKey) {
    box.layouts = {
      ...(box.layouts ?? {}),
      [layoutKey]: { x: box.x, y: box.y, width: box.width, height: box.height }
    };
    const keys = Object.keys(box.layouts);
    for (const k of keys.slice(0, Math.max(0, keys.length - 8))) delete box.layouts[k];
  }
  persistBox(box);
}

export function removeBox(id: string): void {
  destroyBoxWindow(id);
  boxes = loadBoxes().filter((b) => b.id !== id);
  try {
    db().delete('desktop_boxes', id);
  } catch (e) {
    logError('[boxes] 删除失败', e);
  }
  broadcast();
}

export function setBoxVisible(id: string, visible: boolean): void {
  const box = getBox(id);
  if (!box) return;
  box.visible = Boolean(visible);
  persistBox(box);
  ensureBoxWindow(box);
  broadcast();
}

/**
 * 拖入文件（DR-02：默认只建立索引）
 * “真移动”模式（DR-06）：文件物理移动到 box.targetDir，操作前二次确认，并记录 move_log。
 *
 * 去重原则：索引模式下做“全局去重”——同一路径（大小写不敏感）已在任何盒子中
 * 就不再重复添加（监听/拖入/整理多路径并发也不会积累重复）。
 */
export async function addPaths(boxId: string, paths: string[]): Promise<void> {
  const box = getBox(boxId);
  if (!box || !paths.length) return;
  const settings = dataStore().get().settings;
  if (settings.boxMoveMode && box.targetDir) {
    const confirmed = await confirmMove(box.name, paths, box.targetDir);
    if (!confirmed) return;
    // P2-5：失败不再静默——收集失败原因，并用系统通知如实告知用户
    // （跨盘移动文件夹此前是 logWarn 吞掉异常：界面无提示、move_log 无记录）
    const failed: string[] = [];
    for (const src of paths) {
      try {
        moveFile(src, box.targetDir, box.id);
      } catch (e) {
        failed.push(`${basename(src)}：${(e as Error).message}`);
        logWarn('[boxes] 移动失败', src, (e as Error).message);
      }
    }
    broadcast();
    if (failed.length) {
      try {
        const { Notification } = await import('electron');
        if (Notification.isSupported()) {
          new Notification({
            title: '收纳盒：部分文件未能移动',
            body: failed.slice(0, 3).join('\n') + (failed.length > 3 ? `\n…共 ${failed.length} 项失败` : '')
          }).show();
        }
      } catch {
        /* 通知不可用时忽略（日志已留痕） */
      }
    }
    return;
  }
  // 全局已索引路径集合（任何盒子）
  const indexed = new Set<string>();
  for (const b of loadBoxes()) {
    for (const i of b.items) indexed.add(normalizePath(i.path));
  }
  // 逐个 stat：仅索引（不读取内容），失效路径跳过
  for (const path of paths) {
    if (indexed.has(normalizePath(path))) continue;
    try {
      const st = statSync(path);
      box.items.push({ path, name: basename(path), isDir: st.isDirectory(), addedAt: Date.now() });
      indexed.add(normalizePath(path));
    } catch {
      /* 路径已失效 */
    }
  }
  persistBox(box);
  ensureBoxWindow(box);
  broadcast();
}

/** 移除盒子中的索引（不删除文件本体，DR-02） */
export function removeItem(boxId: string, path: string): void {
  const box = getBox(boxId);
  if (!box) return;
  box.items = box.items.filter((i) => i.path !== path);
  cleanupStacks(box);
  persistBox(box);
  broadcast();
}

// ---------- 文件叠放（T-08 Stacks：仅索引分组，绝不动原文件） ----------

/** 叠放组清理：组内不足 2 个成员自动解散（单个文件无需叠放） */
function cleanupStacks(box: DesktopBox): void {
  const counts = new Map<string, number>();
  for (const i of box.items) {
    if (i.stack) counts.set(i.stack, (counts.get(i.stack) ?? 0) + 1);
  }
  for (const i of box.items) {
    if (i.stack && (counts.get(i.stack) ?? 0) < 2) delete i.stack;
  }
}

const STACK_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const STACK_SOFT = ['exe', 'lnk', 'bat', 'cmd', 'msi', 'msix', 'com', 'ps1', 'wsh', 'reg'];
const STACK_ARCHIVE = ['zip', 'rar', '7z', 'tar', 'gz', 'iso'];
const STACK_DOC = ['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'];
const STACK_VIDEO = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'wmv', 'flv'];
const STACK_AUDIO = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];

/** 自动归组用的类别标签（图片/软件/压缩包/文档/视频/音频/其他） */
function stackLabelOf(item: DesktopBoxItem): string {
  if (item.isDir) return '文件夹';
  const ext = extname(item.name).slice(1).toLowerCase();
  if (STACK_IMAGE.includes(ext)) return '图片';
  if (STACK_SOFT.includes(ext)) return '软件';
  if (STACK_ARCHIVE.includes(ext)) return '压缩包';
  if (STACK_DOC.includes(ext)) return '文档';
  if (STACK_VIDEO.includes(ext)) return '视频';
  if (STACK_AUDIO.includes(ext)) return '音频';
  return '其他';
}

/** 手动叠放：把某条索引并入指定叠放组（stackName=null 取消叠放） */
export function stackItem(boxId: string, path: string, stackName: string | null): DesktopBox[] {
  const box = getBox(boxId);
  if (!box) return listBoxes();
  const item = box.items.find((i) => i.path === path);
  if (!item) return listBoxes();
  if (stackName) item.stack = stackName;
  else delete item.stack;
  cleanupStacks(box);
  persistBox(box);
  broadcast();
  return listBoxes();
}

/** 自动归组叠放：按类别聚组，2 个以上才成组（仅索引，不移动文件） */
export function autoStack(boxId: string): DesktopBox[] {
  const box = getBox(boxId);
  if (!box) return listBoxes();
  const groups = new Map<string, DesktopBoxItem[]>();
  for (const item of box.items) {
    const label = stackLabelOf(item);
    const list = groups.get(label) ?? [];
    list.push(item);
    groups.set(label, list);
  }
  for (const [label, list] of groups) {
    if (list.length < 2) continue;
    for (const item of list) item.stack = label;
  }
  cleanupStacks(box);
  persistBox(box);
  broadcast();
  return listBoxes();
}

// ---------- 胶囊模式 / 盒子组（T-08：盒子收起成胶囊栏，悬停/点击展开） ----------

/** 收起成胶囊（记忆当前完整尺寸）/ 展开恢复；同组胶囊并排停靠成胶囊栏 */
export function setCapsule(id: string, capsule: boolean): DesktopBox[] {
  const box = getBox(id);
  if (!box) return listBoxes();
  const win = boxWindowByBoxId(id);
  if (capsule) {
    const b = win && !win.isDestroyed() ? win.getBounds() : { x: box.x, y: box.y, width: box.width, height: box.height };
    box.expandBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    box.capsule = true;
    box.collapsed = false;
  } else {
    box.capsule = false;
    if (box.expandBounds) {
      box.x = box.expandBounds.x;
      box.y = box.expandBounds.y;
      box.width = box.expandBounds.width;
      box.height = box.expandBounds.height;
    }
    setCapsulePreview(id, false);
  }
  persistBox(box);
  ensureBoxWindow(box);
  arrangeCapsuleGroups(loadBoxes());
  broadcast();
  return listBoxes();
}

/** 胶囊悬停临时展开（移出收回；点击胶囊则固定展开） */
export function capsuleHover(id: string, hovering: boolean): void {
  const box = getBox(id);
  if (!box || !box.capsule) return;
  setCapsulePreview(id, hovering);
}

export async function openPath(path: string): Promise<void> {
  // P3 加固：无效路径直接给出可读提示（不再静默失败）
  if (!path || !existsSync(path)) {
    logWarn('[boxes] 打开失败：路径不存在', path);
    throw new Error(`路径不存在或不可访问：${path}`);
  }
  const err = await shell.openPath(path);
  if (err) logWarn('[boxes] 打开失败', path, err);
}

/**
 * 把一个 content 类型为 apps 的盒子一键填充为“全部软件”：
 * 复用 scanInstalledApps（注册表+开始菜单，带图标缓存），将每条应用按
 * { path, name, isDir:false } 写入盒子 items；重复路径去重（大小写不敏感）。
 * 沿用 DR-02“索引不移动”哲学——只记路径，点开即启动。
 */
export async function addAppsToBox(boxId: string): Promise<{ added: number; total: number }> {
  const box = getBox(boxId);
  if (!box) return { added: 0, total: 0 };
  try {
    const apps = await scanInstalledApps(true);
    const existing = new Set(box.items.map((i) => normalizePath(i.path)));
    let added = 0;
    for (const app of apps) {
      if (!app.path || existing.has(normalizePath(app.path))) continue;
      box.items.push({ path: app.path, name: app.name, isDir: false, addedAt: Date.now() });
      existing.add(normalizePath(app.path));
      added++;
    }
    persistBox(box);
    ensureBoxWindow(box);
    broadcast();
    return { added, total: box.items.length };
  } catch (e) {
    logError('[boxes] 添加全部软件失败', e);
    return { added: 0, total: box.items.length };
  }
}

export function setAllVisible(visible: boolean): void {
  for (const box of loadBoxes()) {
    box.visible = visible;
    persistBox(box);
  }
  attachWindows();
  broadcast();
}

// ---------- 三分类智能整理（用户需求：软件/文件/图片 各一个盒子） ----------

/** 判定文件类别：软件 / 图片；其余（文档/视频/音频/压缩包等）统一归“文件” */
function extTypeOf(name: string): DesktopFileType {
  const ext = extname(name).slice(1).toLowerCase();
  for (const [type, exts] of EXT_TYPE_MAP) {
    if (exts.includes(ext)) return type;
  }
  return 'file';
}

function isSmartType(t: string): boolean {
  return t === 'file' || t === 'software' || t === 'image';
}

/** 路径规范化键：Windows 路径大小写不敏感，统一小写+反斜杠防止“同文件不同写法”误判 */
function normalizePath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase();
}

/** 盒内去重（路径大小写不敏感，保留第一条） */
function dedupeBoxItems(box: DesktopBox): void {
  const seen = new Set<string>();
  const keep: DesktopBox['items'] = [];
  for (const item of box.items) {
    const key = normalizePath(item.path);
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(item);
  }
  if (keep.length !== box.items.length) {
    box.items = keep;
    persistBox(box);
  }
}

/** 收敛重复自动盒：同一类别（软件/文件/图片）只保留第一个，其余内容并入后删除 */
function mergeDuplicateAutoBoxes(): void {
  const groups = new Map<DesktopFileType, DesktopBox[]>();
  for (const b of loadBoxes()) {
    if (b.auto && b.autoType && isSmartType(b.autoType)) {
      const list = groups.get(b.autoType) ?? [];
      list.push(b);
      groups.set(b.autoType, list);
    }
  }
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    const main = list[0];
    for (const extra of list.slice(1)) {
      for (const item of extra.items) {
        const key = normalizePath(item.path);
        if (main.items.some((i) => normalizePath(i.path) === key)) continue;
        main.items.push(item);
      }
      persistBox(main);
      removeBox(extra.id);
    }
  }
}

/** 启动/设置变更时轻量自清理：盒内去重 + 重复自动盒合并（幂等，不扫描、不建盒） */
export function cleanupBoxData(): void {
  const touched = loadBoxes().filter((b) => b.items.length);
  for (const box of touched) dedupeBoxItems(box);
  mergeDuplicateAutoBoxes();
  broadcast();
}

/**
 * 全量重排（“分类整理”）：
 * 把现有所有盒子内的索引按类别分配到 软件/文件/图片 三个自动盒（缺失自动创建），
 * 仅重排索引、绝不动文件本体；同时清理旧版细分类（文档/视频等）造成的空盒。
 *
 * 去重收敛：每个路径全局只保留一份——目标盒已有该路径时，来源盒的条目一并移除，
 * 跨盒重复（智能分类/拖入/整理多路径产生的）在整理后自动收敛为一份。
 */
export function reorganizeAll(): { moved: number } {
  // 0) 收敛重复自动盒 + 全量盒内去重（含目标盒自身，清除已有重复）
  mergeDuplicateAutoBoxes();
  for (const box of loadBoxes()) dedupeBoxItems(box);

  // 1) 确保三大类自动盒存在
  const target = {
    file: smartBoxFor('file'),
    software: smartBoxFor('software'),
    image: smartBoxFor('image')
  } as Record<DesktopFileType, DesktopBox | null>;

  // 2) 遍历快照移动索引（路径大小写不敏感去重）
  const snapshot = [...loadBoxes()];
  let moved = 0;
  for (const box of snapshot) {
    // 三大类自动盒自身不动（其内容本就属于该类别）
    if (box.auto && box.autoType && isSmartType(box.autoType) && target[box.autoType]?.id === box.id) continue;
    if (!box.items.length) continue;
    const keep: DesktopBox['items'] = [];
    for (const item of box.items) {
      const cat = extTypeOf(item.name);
      const t = target[cat];
      const key = normalizePath(item.path);
      if (t && t.id !== box.id && t.items.length < 500) {
        if (t.items.some((i) => normalizePath(i.path) === key)) {
          // 目标盒已有该路径：收敛为一份（从来源盒移除）
          continue;
        }
        t.items.push(item);
        moved++;
        continue;
      }
      keep.push(item);
    }
    box.items = keep;
    persistBox(box);
  }

  // 3) 保存目标盒 + 清理旧分类（文档/视频/音频等）遗留的空自动盒
  for (const t of Object.values(target)) if (t) persistBox(t);
  for (const box of snapshot) {
    if (box.auto && box.autoType && !isSmartType(box.autoType) && box.items.length === 0) {
      removeBox(box.id);
    }
  }
  if (moved > 0) {
    ensureAllWindows();
    broadcast();
  }
  return { moved };
}

/**
 * “分类整理”入口（IPC / 卡片按钮 / 命令面板）：
 * 1) 扫描各盒子 watchDir（桌面）下尚未索引的文件，按三分类补入对应自动盒；
 * 2) 全量重排已有索引。
 */
export function applyRules(): Array<{ boxId: string; added: number; moved: number }> {
  const summary: Array<{ boxId: string; added: number; moved: number }> = [];
  const roots = new Set(
    loadBoxes()
      .map((b) => b.watchDir)
      .filter((d) => d && existsSync(d))
  );
  // 全局已索引路径（任何盒子），扫描只补入真正未索引的文件
  const indexed = new Set<string>();
  for (const b of loadBoxes()) {
    for (const i of b.items) indexed.add(normalizePath(i.path));
  }
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (IGNORE_NAMES.some((p) => entry.name.startsWith(p))) continue;
      if (indexed.has(normalizePath(full))) continue;
      const cat = extTypeOf(entry.name);
      const box = smartBoxFor(cat);
      if (!box) continue;
      box.items.push({
        path: full,
        name: entry.name,
        isDir: entry.isDirectory(),
        addedAt: Date.now()
      });
      indexed.add(normalizePath(full));
      persistBox(box);
      const item = summary.find((s) => s.boxId === box.id);
      if (item) item.added++;
      else summary.push({ boxId: box.id, added: 1, moved: 0 });
    }
  }
  const { moved } = reorganizeAll();
  for (const item of summary) item.moved = moved;
  if (summary.length || moved > 0) {
    ensureAllWindows();
    broadcast();
  }
  return summary;
}

// ---------- 真移动（DR-06） ----------

function confirmMove(boxName: string, paths: string[], targetDir: string): Promise<boolean> {
  return dialog
    .showMessageBox({
      type: 'question',
      buttons: ['移动文件', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '真移动确认',
      message: `将 ${paths.length} 个文件物理移动到 "${targetDir}"？`,
      detail: `收纳盒：${boxName}\n原文件将被移动，且不再保留在原位置。\n本次操作会记录到移动日志。`
    })
    .then((res) => res.response === 0);
}

/** 目标目录内生成不冲突的文件名（SVC-3：杜绝同名静默覆盖用户数据） */
function uniqueDestPath(destDir: string, name: string): string {
  const ext = extname(name);
  const stem = basename(name, ext);
  let candidate = join(destDir, name);
  for (let i = 2; existsSync(candidate) && i < 1000; i++) {
    candidate = join(destDir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

/**
 * 跨盘符安全的移动：同卷 rename，跨卷复制+删除；成功后写入移动日志。
 *
 * P2-5 修复：跨卷回退分支原来无条件用 copyFileSync —— 它在遇到**目录**时会抛
 * `EPERM: operation not permitted, copyfile '<dir>'`，而调用方 desktopBoxes.addPaths 只是
 * logWarn 吞掉异常，于是"跨盘移动文件夹"表现为静默失败（界面无提示、move_log 无记录）。
 * 现在目录走 cpSync(recursive)，且失败时抛出可读错误交由上层提示用户。
 */
function moveFile(src: string, destDir: string, boxId: string): void {
  mkdirSync(destDir, { recursive: true });
  // SVC-3 修复：目标同名时自动改名（此前 renameSync 直接覆盖 → 用户数据丢失）
  const dest = uniqueDestPath(destDir, basename(src));
  const isDir = statSync(src).isDirectory();
  try {
    renameSync(src, dest);
  } catch {
    try {
      if (isDir) cpSync(src, dest, { recursive: true, errorOnExist: false, force: true });
      else copyFileSync(src, dest);
    } catch (e) {
      // 复制阶段就失败：源文件保持不动，抛出可读错误让上层提示用户（不再静默）
      throw new Error(`跨盘移动${isDir ? '文件夹' : '文件'}失败（原文件未改动）：${(e as Error).message}`);
    }
    try {
      rmSync(src, { recursive: isDir, force: true });
    } catch (e) {
      // 复制成功但删除失败：保留源文件并记录异常
      logWarn('[boxes] 移动后删除源文件失败（已复制成功）', (e as Error).message);
    }
  }
  db().set(
    'move_log',
    `${Date.now()}-${randomUUID().slice(0, 5)}`,
    JSON.stringify({ ts: Date.now(), boxId, src, dst: dest, mode: 'move' })
  );
}

// ---------- 智能分类：自动识别类别并归入对应收纳盒（三大类） ----------

function smartEnabled(): boolean {
  const s = dataStore().get().settings;
  return s.desktopBoxesEnabled && s.boxAutoMode;
}

/** 获取（必要时自动创建）类别盒：智能分类的归属盒子（软件/文件/图片） */
function smartBoxFor(type: DesktopFileType): DesktopBox | null {
  const def = SMART_TYPES[type];
  if (!def) return null;
  const existing = loadBoxes().find((b) => b.auto === true && b.autoType === type);
  if (existing) return existing;
  const exts = (EXT_TYPE_MAP.find(([t]) => t === type)?.[1] ?? []).slice();
  const box = createBox({
    name: def.label,
    color: def.color,
    auto: true,
    autoType: type,
    rules: [{ enabled: true, extensions: exts, fileTypes: [type], timeRange: 'all' }]
  });
  return box;
}

/** 智能分类入口：把新增文件按类别（软件/图片/文件）归入对应收纳盒 */
function classifySmart(path: string): void {
  if (!smartEnabled() || !path) return;
  const name = basename(path);
  if (IGNORE_NAMES.some((p) => name.startsWith(p) || name.startsWith('~$'))) return;
  if (!existsSync(path)) return;
  // 已在某盒子中则跳过
  for (const box of loadBoxes()) {
    if (box.items.some((i) => i.path === path)) return;
  }
  const box = smartBoxFor(extTypeOf(name));
  if (!box) return;
  void addPaths(box.id, [path]);
}

// ---------- 文件监听（fs.watch recursive，Windows Node 20+ 可用） ----------

const fsWatchers = new Map<string, FSWatcher>();
const pendingClassify = new Map<string, Set<string>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

let cachedDownloadsDir = '';

/** 下载目录（T-08 自动整理增强）：注册表 User Shell Folders 的 Downloads GUID，失败回退 %USERPROFILE%\Downloads */
export function downloadsDir(): string {
  if (cachedDownloadsDir) return cachedDownloadsDir;
  try {
    const out = decodeRegOutput(
      execFileSync(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
          '/v',
          '{374DE290-123F-4565-9164-39C4925E467B}'
        ],
        { encoding: 'buffer', timeout: 5000, windowsHide: true }
      )
    );
    const line = out.split(/\r?\n/).find((l) => l.includes('REG_EXPAND_SZ') || l.includes('REG_SZ'));
    if (line) {
      const val = line
        .replace(/^.*REG_[A-Z_]+/, '')
        .trim()
        .replace(/%USERPROFILE%/gi, process.env.USERPROFILE ?? '');
      if (val && existsSync(val)) {
        cachedDownloadsDir = val;
        return val;
      }
    }
  } catch {
    /* 回退 */
  }
  const user = process.env.USERPROFILE ?? homedir();
  cachedDownloadsDir = join(user, 'Downloads');
  return cachedDownloadsDir;
}

/**
 * T-08 自动整理增强：等文件"稳定"再归类（下载/解压中的文件大小与修改时间持续变化）。
 * 每 2 秒采样一次，连续 2 次一致（约 4 秒静默）即归类；30 秒兜底强制归类；文件消失则放弃。
 */
function classifyWhenStable(path: string): void {
  let lastKey = '';
  let stable = 0;
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    let key = '';
    try {
      const st = statSync(path);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      clearInterval(timer);
      return; // 文件已消失（下载取消/临时文件清理）
    }
    if (key === lastKey) stable++;
    else stable = 0;
    lastKey = key;
    if (stable >= 2 || tries >= 15) {
      clearInterval(timer);
      try {
        classifySmart(path);
      } catch (e) {
        logWarn('[boxes] 智能分类失败', path, e);
      }
    }
  }, 2000);
}

function scheduleClassify(root: string, path: string): void {
  const set = pendingClassify.get(root) ?? new Set<string>();
  if (set.size >= 200) return;
  set.add(path);
  pendingClassify.set(root, set);
  const old = debounceTimers.get(root);
  if (old) clearTimeout(old);
  // 文件创建会触发多次事件，合并 500ms 后统一进入"稳定后归类"流程
  debounceTimers.set(
    root,
    setTimeout(() => {
      debounceTimers.delete(root);
      const paths = [...(pendingClassify.get(root) ?? [])];
      pendingClassify.delete(root);
      for (const p of paths) {
        try {
          classifyWhenStable(p);
        } catch (e) {
          logWarn('[boxes] 智能分类失败', p, e);
        }
      }
    }, 500)
  );
}

/** 重启智能分类监听（设置/盒子变更时调用）：监听各盒 watchDir + 下载目录（T-08 增强） */
export function restartSmartWatch(): void {
  for (const w of fsWatchers.values()) {
    try {
      w.close();
    } catch {
      /* noop */
    }
  }
  fsWatchers.clear();
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  pendingClassify.clear();
  if (!smartEnabled()) return;
  const roots = new Set(loadBoxes().map((b) => b.watchDir));
  // T-08 自动整理增强：下载目录新增文件（下载/解压稳定后）自动归类
  if (dataStore().get().settings.boxWatchDownloads) roots.add(downloadsDir());
  for (const root of roots) {
    if (!root || !existsSync(root) || fsWatchers.has(root)) continue;
    try {
      const w = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        scheduleClassify(root, join(root, filename));
      });
      w.on('error', () => {
        try {
          w.close();
        } catch {
          /* noop */
        }
        fsWatchers.delete(root);
      });
      fsWatchers.set(root, w);
    } catch (e) {
      logWarn('[boxes] 文件监听启动失败', root, e);
    }
  }
}

// ---------- 窗口同步 ----------

export function attachWindows(): void {
  syncBoxWindows(loadBoxes(), dataStore().get().settings.desktopBoxesEnabled);
}

function ensureAllWindows(): void {
  for (const box of loadBoxes()) ensureBoxWindow(box);
}

/** 启用/关闭桌面收纳（设置开关）时的统一入口 */
export function applyBoxesEnabled(): void {
  // 自清理：盒内去重 + 重复自动盒合并（旧包可能残留重复数据）
  cleanupBoxData();
  registerBoxLookup(getBox);
  attachWindows();
  arrangeCapsuleGroups(loadBoxes());
  restartSmartWatch();
}
