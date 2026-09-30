import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BrowserWindow, clipboard, nativeImage, type NativeImage } from 'electron';
import { db } from '../store/db';
import { dataStore, userDataDir } from '../store/dataStore';
import { decryptBuffer, decryptText, encryptBuffer, encryptText } from '../utils/secrets';
import { sendKeys } from '../utils/sendkeys';
import { ocrImage } from './ocr';
import { jsonFormat } from '../../shared/devtools/json.ts';
import { inferClipboardIntent } from '../../shared/devtools/intent.ts';
import { logDebug, logWarn } from '../utils/log';
import type { AssetData, ClipboardEntry, ClipboardIntentInfo, ClipboardQuery, PasteMode } from '../../shared/types';

/**
 * 剪贴板历史（CH-01 ~ CH-04、CH-06）
 *
 * - 托盘常驻监听（600ms 轮询，内容指纹去重），文本/图片落 SQLite `clipboard` 表；
 * - 图片存 userData/clipboard-images（缩略图 + 原图），条目本体仅元数据 → 内存占用极小；
 * - 隐私（CH-03）：排除关键词、应用白名单、可选 AES-256-GCM 加密存储（spec 5.4）；
 * - 图片 OCR（CH-06）复用 Tesseract 引擎，识别文本索引进历史；
 * - copy(id, paste) 写回剪贴板并可向焦点窗口发送 Ctrl+V（浮动面板 CH-04）。
 */

const POLL_INTERVAL_MS = 600;
const THUMB_WIDTH = 200;

let entries: ClipboardEntry[] = [];
let loaded = false;
let timer: NodeJS.Timeout | null = null;
let busy = false;
let lastText = '';
let lastImageFp = '';

function imagesDir(): string {
  return join(userDataDir(), 'clipboard-images');
}

function imagePaths(id: string): { full: string; encrypted: string; thumb: string; thumbEncrypted: string } {
  const dir = imagesDir();
  return {
    full: join(dir, `${id}.png`),
    encrypted: join(dir, `${id}.png.bin`),
    thumb: join(dir, `${id}.thumb.png`),
    // P1-3：加密存储开启时缩略图同样落密文——否则「已加密」的历史仍能被任意程序/同步盘读出明文图
    thumbEncrypted: join(dir, `${id}.thumb.bin`)
  };
}

// ---------- 持久化（db 'clipboard' 表；加密时文本/原图落盘为密文） ----------

function persistEntry(e: ClipboardEntry): void {
  const row: ClipboardEntry & { text?: string; ocrText?: string } = { ...e };
  if (e.kind === 'text' && e.encrypted && typeof e.text === 'string') {
    row.text = encryptText(e.text);
  }
  // P1-3：OCR 文本与正文同等保护（此前只加密 text，OCR 结果明文躺在库里，可直接读出）
  if (e.encrypted && typeof e.ocrText === 'string' && e.ocrText) {
    row.ocrText = encryptText(e.ocrText);
    row.ocrEncrypted = true;
  } else {
    row.ocrEncrypted = false;
  }
  db().set('clipboard', e.id, JSON.stringify(row));
}

function loadAll(): void {
  if (loaded) return;
  loaded = true;
  entries = [];
  for (const row of db().all('clipboard')) {
    try {
      const e = JSON.parse(row.value) as ClipboardEntry;
      if (e.encrypted && typeof e.text === 'string') {
        try {
          e.text = decryptText(e.text);
        } catch {
          logWarn('[clipboard] 条目解密失败，跳过', e.id);
          continue;
        }
      }
      if (e.ocrEncrypted && typeof e.ocrText === 'string') {
        try {
          e.ocrText = decryptText(e.ocrText);
        } catch {
          logWarn('[clipboard] OCR 文本解密失败，忽略该字段', e.id);
          e.ocrText = undefined;
          e.ocrEncrypted = false;
        }
      }
      entries.push(e);
    } catch {
      /* 跳过损坏条目 */
    }
  }
  sortEntries();
}

function sortEntries(): void {
  entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
}

function broadcast(): void {
  const list = listClipboard();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('clipboard:changed', list);
  }
  // 剪贴板历史是命令面板 / CP-07 推荐的搜索源：内容变了就让候选集缓存失效
  void import('./paletteSearch')
    .then((m) => m.invalidatePaletteCache())
    .catch(() => undefined);
}

// ---------- 查询（CH-02：搜索 / 时间 / 类型筛选，即输即显） ----------

export function listClipboard(query?: ClipboardQuery): ClipboardEntry[] {
  loadAll();
  const q = (query?.query ?? '').trim().toLowerCase();
  const kind = query?.kind ?? 'all';
  const range = query?.timeRange ?? 'all';
  const limit = query?.limit ?? 0;
  const now = Date.now();
  const span =
    range === 'today' ? 24 * 3600e3 : range === 'week' ? 7 * 24 * 3600e3 : range === 'month' ? 30 * 24 * 3600e3 : 0;
  const out: ClipboardEntry[] = [];
  for (const e of entries) {
    if (kind !== 'all' && e.kind !== kind) continue;
    if (span && now - e.createdAt > span) continue;
    if (q) {
      const hay = `${e.text ?? ''} ${e.ocrText ?? ''} ${e.sourceApp}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push({ ...e });
    if (limit && out.length >= limit) break;
  }
  return out;
}

export function clipboardStats(): { total: number; images: number; pinned: number } {
  loadAll();
  return {
    total: entries.length,
    images: entries.filter((e) => e.kind === 'image').length,
    pinned: entries.filter((e) => e.pinned).length
  };
}

// ---------- 增删改 ----------

function evictOverflow(): void {
  // P3-5：下限与设置项校验区间保持一致（原为 50，导致设置里填更小值不生效）
  const max = Math.max(10, dataStore().get().settings.clipboardMaxItems || 500);
  const unpinned = entries.filter((e) => !e.pinned).sort((a, b) => b.createdAt - a.createdAt);
  if (unpinned.length <= max) return;
  for (const e of unpinned.slice(max)) {
    deleteFiles(e);
    db().delete('clipboard', e.id);
    entries = entries.filter((x) => x.id !== e.id);
  }
}

function deleteFiles(e: ClipboardEntry): void {
  if (e.kind !== 'image') return;
  const p = imagePaths(e.id);
  for (const f of [p.full, p.encrypted, p.thumb, p.thumbEncrypted]) {
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch {
      /* 忽略删除失败 */
    }
  }
}

export function updateClipboard(id: string, patch: Partial<ClipboardEntry>): ClipboardEntry[] {
  loadAll();
  const e = entries.find((x) => x.id === id);
  if (e) {
    if (patch.pinned !== undefined) e.pinned = patch.pinned;
    if (patch.sourceApp !== undefined) e.sourceApp = patch.sourceApp;
    sortEntries();
    persistEntry(e);
  }
  broadcast();
  return listClipboard();
}

export function removeClipboard(id: string): ClipboardEntry[] {
  loadAll();
  const e = entries.find((x) => x.id === id);
  if (e) {
    deleteFiles(e);
    db().delete('clipboard', id);
    entries = entries.filter((x) => x.id !== id);
  }
  broadcast();
  return listClipboard();
}

export function clearClipboard(keepPinned = false): ClipboardEntry[] {
  loadAll();
  for (const e of [...entries]) {
    if (keepPinned && e.pinned) continue;
    deleteFiles(e);
    db().delete('clipboard', e.id);
    entries = entries.filter((x) => x.id !== e.id);
  }
  broadcast();
  return listClipboard();
}

// ---------- 隐私（CH-03） ----------

/**
 * 排除关键词命中判定。
 * 单独拆出来是因为它**不依赖来源应用**，可以在"先入库、后补来源"的快路径里同步判定
 * （早先偷懒跳过这一步，导致排除关键词在默认配置下完全失效——由独立测试抓出）。
 */
export function hitsExcludeKeyword(text: string): boolean {
  const lower = String(text ?? '').toLowerCase();
  for (const kw of dataStore().get().settings.clipboardExcludeKeywords) {
    const k = kw.trim().toLowerCase();
    if (k && lower.includes(k)) return true;
  }
  return false;
}

/** 应用白名单判定（需要来源应用，故必须等待探测结果） */
function passesAppWhitelist(sourceApp: string): boolean {
  const wl = dataStore()
    .get()
    .settings.clipboardAppWhitelist.map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!wl.length) return true;
  return wl.includes(sourceApp.trim().toLowerCase());
}

function passesPrivacy(text: string, sourceApp: string): boolean {
  return !hitsExcludeKeyword(text) && passesAppWhitelist(sourceApp);
}

/**
 * 前台应用探测（Windows：前台窗口所属进程名；失败返回空串，不阻塞记录）。
 *
 * P3-8：每条剪贴板记录都会拉起一次 PowerShell（最长 2.5s），连续复制时开销明显。
 * 这里加 1.5 秒 TTL 缓存 —— 同一段时间内的多次复制必然是同一个前台应用，
 * 既省掉重复子进程，也让"复制 → 入库"不再被探测拖慢。
 */
const FOREGROUND_TTL_MS = 1500;
let foregroundCache: { at: number; app: string } | null = null;

/** 来源应用探测（带 TTL 缓存；force=true 时强制重新探测） */
export function queryForegroundApp(force = false): Promise<string> {
  if (!force && foregroundCache && Date.now() - foregroundCache.at < FOREGROUND_TTL_MS) {
    return Promise.resolve(foregroundCache.app);
  }
  return probeForegroundApp().then((app) => {
    foregroundCache = { at: Date.now(), app };
    return app;
  });
}

function probeForegroundApp(): Promise<string> {
  return new Promise((resolve) => {
    const script =
      // SVC-7 修复：显式 UTF-8 输出编码，避免中文路径/进程名在 GBK 环境下乱码
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
      "Add-Type -Name W -Namespace U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'; " +
      '$h=[U.W]::GetForegroundWindow(); $p=0; [U.W]::GetWindowThreadProcessId($h,[ref]$p) | Out-Null; ' +
      'if ($p) { (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 2500, encoding: 'utf8' },
      (err, stdout) => resolve(err ? '' : (stdout || '').trim())
    );
  });
}

// ---------- 记录 ----------

function insertEntry(e: ClipboardEntry): void {
  // 去重置顶：内容相同的条目只刷新时间（移至顶部）
  const same = entries.find((x) => x.id !== e.id && x.kind === e.kind && (x.text ?? '') === (e.text ?? ''));
  if (same && e.kind === 'text') {
    same.createdAt = e.createdAt;
    sortEntries();
    persistEntry(same);
    return;
  }
  entries.unshift(e);
  sortEntries();
  persistEntry(e);
  evictOverflow();
}

async function recordText(text: string): Promise<void> {
  const s = dataStore().get().settings;
  /*
   * P3-8 修复：前台应用探测最长要 2.5s，而它此前挡在入库之前 ——
   * 实测"复制后要 1.5~2.5 秒条目才出现"。
   *
   * 策略：应用白名单为空（默认）时**先入库、后补来源**，复制即刻可见；
   * 白名单非空时必须先知道来源才能判定是否记录，保持原有阻塞顺序（隐私优先，不能先记后删）。
   */
  const whitelistActive = s.clipboardAppWhitelist.map((x) => x.trim()).filter(Boolean).length > 0;
  const encrypted = Boolean(s.clipboardEncrypt);

  // 排除关键词与来源应用无关，必须**在入库之前**同步判定（隐私优先）
  if (hitsExcludeKeyword(text)) {
    logDebug('[clipboard] 命中排除关键词，已跳过记录');
    return;
  }

  if (!whitelistActive) {
    const id = randomUUID();
    insertEntry({ id, kind: 'text', text, sourceApp: '', createdAt: Date.now(), pinned: false, encrypted });
    broadcast();
    void queryForegroundApp().then((app) => {
      if (!app) return;
      const e = entries.find((x) => x.id === id);
      if (!e) return;
      e.sourceApp = app;
      persistEntry(e);
      broadcast();
    });
    return;
  }

  const sourceApp = await queryForegroundApp();
  if (!passesAppWhitelist(sourceApp)) {
    logDebug('[clipboard] 来源应用不在白名单，已跳过记录');
    return;
  }
  insertEntry({
    id: randomUUID(),
    kind: 'text',
    text,
    sourceApp,
    createdAt: Date.now(),
    pinned: false,
    encrypted
  });
  broadcast();
}

function thumbOf(img: NativeImage): Buffer | null {
  try {
    const { width } = img.getSize();
    const w = Math.min(THUMB_WIDTH, width || THUMB_WIDTH);
    return img.resize({ width: w }).toPNG();
  } catch {
    return null;
  }
}

async function recordImage(img: NativeImage): Promise<void> {
  const s = dataStore().get().settings;
  const sourceApp = await queryForegroundApp();
  if (!passesPrivacy('', sourceApp)) return;
  const size = img.getSize();
  const id = randomUUID();
  const paths = imagePaths(id);
  mkdirSync(imagesDir(), { recursive: true });
  const png = img.toPNG();
  try {
    if (s.clipboardEncrypt) writeFileSync(paths.encrypted, encryptBuffer(png));
    else writeFileSync(paths.full, png);
    const thumb = thumbOf(img);
    // P1-3：缩略图与 OCR 文本同属隐私内容，加密模式下必须一并落密文
    if (thumb) {
      if (s.clipboardEncrypt) writeFileSync(paths.thumbEncrypted, encryptBuffer(thumb));
      else writeFileSync(paths.thumb, thumb);
    }
  } catch (e) {
    logWarn('[clipboard] 图片保存失败', e);
    return;
  }
  const encrypted = Boolean(s.clipboardEncrypt);
  const entry: ClipboardEntry = {
    id,
    kind: 'image',
    imageFile: encrypted ? paths.encrypted : paths.full,
    width: size.width,
    height: size.height,
    sourceApp,
    createdAt: Date.now(),
    pinned: false,
    encrypted
  };
  insertEntry(entry);
  broadcast();
  if (s.clipboardOcr) {
    void ocrEntry(entry, png);
  }
}

/** 图片 OCR（CH-06）：识别文本写回条目，索引进历史搜索 */
async function ocrEntry(entry: ClipboardEntry, png: Buffer): Promise<void> {
  // P2-22：临时明文截图必须无条件清理——原来 rmSync 在 ocrImage 之后，
  // 识别抛错/超时时会把一张明文截图永久留在 clipboard-images 里
  const tmp = join(imagesDir(), `ocr-${entry.id}.png`);
  try {
    mkdirSync(imagesDir(), { recursive: true });
    writeFileSync(tmp, png);
    const text = await ocrImage(tmp);
    if (!text) return;
    const e = entries.find((x) => x.id === entry.id);
    if (!e) return;
    e.ocrText = text;
    // persistEntry 会按 encrypted 标记把 OCR 文本加密落库（P1-3）
    persistEntry(e);
    broadcast();
  } catch (e) {
    logWarn('[clipboard] 图片 OCR 失败', e);
  }
}

// ---------- 写回剪贴板 / 粘贴（CH-04） ----------

export function setClipboardText(text: string): void {
  lastText = text;
  lastImageFp = '';
  clipboard.writeText(text);
}

function imageFingerprint(img: NativeImage): string {
  const { width, height } = img.getSize();
  if (!width || !height) return '';
  const pts: Array<[number, number]> = [
    [0, 0],
    [Math.max(0, width - 8), 0],
    [0, Math.max(0, height - 8)],
    [Math.max(0, width - 8), Math.max(0, height - 8)],
    [Math.max(0, (width >> 1) - 4), Math.max(0, (height >> 1) - 4)]
  ];
  const parts: Buffer[] = [Buffer.from(`${width}x${height}`)];
  for (const [x, y] of pts) {
    try {
      parts.push(img.crop({ x, y, width: Math.min(8, width), height: Math.min(8, height) }).toBitmap());
    } catch {
      /* 忽略越界采样 */
    }
  }
  return createHash('sha1').update(Buffer.concat(parts)).digest('hex');
}

export function setClipboardImage(img: NativeImage): void {
  lastText = '';
  lastImageFp = imageFingerprint(img);
  clipboard.writeImage(img);
}

export function copyClipboardEntry(id: string, paste = false): void {
  loadAll();
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (e.kind === 'text' && typeof e.text === 'string') {
    setClipboardText(e.text);
  } else if (e.kind === 'image') {
    const buf = readImageFile(e, true);
    if (!buf) return;
    setClipboardImage(nativeImage.createFromBuffer(buf));
  }
  // 复用到顶部
  e.createdAt = Date.now();
  sortEntries();
  persistEntry(e);
  broadcast();
  if (paste) pasteToForeground();
}

/** 向当前焦点窗口发送 Ctrl+V（先隐藏自身面板，把焦点还给目标窗口） */
function pasteToForeground(): void {
  void import('../windows/clipboardWindow').then(({ hideClipboardPanel }) => hideClipboardPanel());
  sendKeys('^v', 140);
}

// ---------- 格式化粘贴（CH-07 ~ CH-09，T-14） ----------

/**
 * 去掉富文本残留标记（零宽字符 / BOM / 兼容字符）并统一换行。
 * 说明：剪贴板历史本身只存纯文本，本函数额外清掉从网页复制时常见的隐形字符，
 * 保证「纯文本粘贴」结果不含任何样式与不可见字符（CH-07 验收：粘贴结果无字体/颜色等样式）。
 */
function plainText(text: string): string {
  return String(text ?? '')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ');
}

/**
 * 格式化粘贴：写回剪贴板 → 模拟 Ctrl+V（CH-07 / CH-08 / CH-09）
 * - plain：纯文本（去格式）
 * - json ：JSON 格式化后粘贴（与 DEV-01 共用纯函数）
 * - ocr  ：图片 OCR 识别为文本后粘贴（复用既有 ocr.ts 与 Tesseract 配置）
 */
export async function pasteClipboardAs(id: string, mode: PasteMode): Promise<{ ok: boolean; message?: string }> {
  loadAll();
  const e = entries.find((x) => x.id === id);
  if (!e) return { ok: false, message: '条目不存在' };
  if (mode === 'ocr') {
    if (e.kind !== 'image') return { ok: false, message: '只有图片条目支持 OCR 粘贴' };
    const buf = readImageFile(e, true);
    if (!buf) return { ok: false, message: '图片读取失败' };
    const tmp = join(imagesDir(), 'paste-ocr-' + e.id + '.png');
    try {
      mkdirSync(imagesDir(), { recursive: true });
      writeFileSync(tmp, buf);
      const text = (await ocrImage(tmp)).trim();
      if (!text) return { ok: false, message: '未识别到文字（需 Tesseract 引擎或图片不含文字）' };
      setClipboardText(text);
      pasteToForeground();
      return { ok: true, message: '已粘贴 OCR 文本（' + text.length + ' 字）' };
    } finally {
      try {
        if (existsSync(tmp)) rmSync(tmp, { force: true });
      } catch {
        /* 临时文件清理失败可忽略 */
      }
    }
  }
  if (e.kind !== 'text' || typeof e.text !== 'string') return { ok: false, message: '只有文本条目支持该粘贴方式' };
  if (mode === 'json') {
    const r = jsonFormat(e.text);
    if (!r.ok) return { ok: false, message: 'JSON 第 ' + r.line + ' 行第 ' + r.column + ' 列有误：' + r.message };
    setClipboardText(r.out);
    pasteToForeground();
    return { ok: true, message: '已粘贴格式化后的 JSON' };
  }
  setClipboardText(plainText(e.text));
  pasteToForeground();
  return { ok: true, message: '已粘贴纯文本' };
}

/** CP-07：当前剪贴板意图（命令面板 / 粘贴面板推荐用） */
export function clipboardIntent(): ClipboardIntentInfo {
  try {
    const text = clipboard.readText() ?? '';
    if (!text.trim()) {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        return { kind: 'unknown', text: '', paths: [], detail: '剪贴板为图片（可 OCR 转文字粘贴）' };
      }
    }
    const intent = inferClipboardIntent(text);
    return { kind: intent.kind, text: intent.text, paths: intent.paths, detail: intent.detail };
  } catch (e) {
    logWarn('[clipboard] 意图识别失败', e);
    return { kind: 'unknown', text: '', paths: [], detail: '剪贴板不可用' };
  }
}

export function clipboardImage(id: string, full = true): AssetData | null {
  loadAll();
  const e = entries.find((x) => x.id === id);
  if (!e || e.kind !== 'image') return null;
  const buf = readImageFile(e, full);
  if (!buf) return null;
  return { data: buf.toString('base64'), mime: 'image/png' };
}

function readImageFile(e: ClipboardEntry, full: boolean): Buffer | null {
  const p = imagePaths(e.id);
  try {
    if (full) {
      if (e.encrypted && existsSync(p.encrypted)) return decryptBuffer(readFileSync(p.encrypted));
      if (existsSync(p.full)) return readFileSync(p.full);
      return null;
    }
    // P1-3：加密条目的缩略图是密文；老数据（.thumb.png 明文）仍兼容读取
    if (e.encrypted && existsSync(p.thumbEncrypted)) return decryptBuffer(readFileSync(p.thumbEncrypted));
    if (existsSync(p.thumb)) return readFileSync(p.thumb);
    return readImageFile(e, true);
  } catch (err) {
    logWarn('[clipboard] 图片读取失败', err);
    return null;
  }
}

// ---------- 监听（CH-01） ----------

/** SVC-6 修复：内部剪贴板操作抑制窗口（划词翻译的模拟 Ctrl+C / 悬浮条复制），避免污染历史 */
let suppressUntil = 0;

/** 抑制随后 ms 内的剪贴板捕获（内部取词/复制用；结束时以当前内容刷新基线） */
export function suppressClipboardCapture(ms: number): void {
  suppressUntil = Math.max(suppressUntil, Date.now() + Math.max(0, ms));
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() < suppressUntil) {
      // 抑制期内：只更新指纹基线，不记录（防止把内部取词内容记为历史条目）
      try {
        lastText = clipboard.readText() ?? '';
        const img0 = clipboard.readImage();
        lastImageFp = img0.isEmpty() ? '' : imageFingerprint(img0);
      } catch {
        /* 忽略 */
      }
      return;
    }
    const text = clipboard.readText() ?? '';
    if (text && text !== lastText) {
      lastText = text;
      lastImageFp = '';
      await recordText(text);
      return;
    }
    if (text) {
      lastText = text;
      return;
    }
    if (dataStore().get().settings.clipboardImages) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const fp = imageFingerprint(img);
        if (fp && fp !== lastImageFp) {
          lastImageFp = fp;
          await recordImage(img);
        }
      }
    }
  } catch (e) {
    logWarn('[clipboard] 监听轮询异常', e);
  } finally {
    busy = false;
  }
}

/** 启动监听（托盘常驻；轮询开销近零，CPU < 1%） */
export function startClipboardMonitor(): void {
  loadAll();
  if (timer) return;
  try {
    lastText = clipboard.readText() ?? '';
    const img = clipboard.readImage();
    lastImageFp = img.isEmpty() ? '' : imageFingerprint(img);
  } catch {
    /* 剪贴板不可访问时忽略基线 */
  }
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  logDebug('[clipboard] 监听已启动');
}

export function stopClipboardMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 随设置开关启停监听 */
export function applyClipboardMonitor(): void {
  if (dataStore().get().settings.clipboardEnabled) startClipboardMonitor();
  else stopClipboardMonitor();
}
