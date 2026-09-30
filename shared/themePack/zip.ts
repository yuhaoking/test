/**
 * 最小 ZIP 读写（T-06 UGC 宠物/皮肤主题包）
 *
 * 为什么自研：
 * 1) 项目约定不新增运行时依赖；
 * 2) 主题包是 UGC，导入必须**先审后解**——只有先读到中央目录里"声明的解压后大小"，
 *    才可能在落盘任何一个字节之前识别 zip 炸弹与 zip-slip。外挂 tar / Expand-Archive 做不到；
 * 3) 外挂进程还有 250~400ms 冷启动成本，而主题包导入是交互路径。
 *
 * 支持范围（够用即止）：STORED(0) 与 DEFLATE(8) 两种方式、ZIP64 目录、UTF-8/GBK 文件名。
 * 明确不支持：加密条目、ZIP64 单条目（>4GB，主题包体积上限远低于此）、多卷归档——一律报错拒绝。
 */

import { inflateRaw } from './inflate.ts';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

export interface ZipLimits {
  maxEntries: number;
  /** 单条目解压后上限（字节） */
  maxEntryUncompressed: number;
  /** 全部条目解压后总上限（字节） */
  maxTotalUncompressed: number;
  /** 单个条目允许的最大压缩比（解压后 / 压缩后），超过视为 zip 炸弹 */
  maxCompressionRatio: number;
  maxNameLength: number;
}

/** 主题包默认限额：单文件 8MB、总计 64MB、512 个条目、压缩比 200 —— 远超正常皮肤包 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 512,
  maxEntryUncompressed: 8 * 1024 * 1024,
  maxTotalUncompressed: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxNameLength: 180
};

export interface ZipEntry {
  /** 已归一化的相对路径（统一 `/` 分隔、已转义 % 已去除首尾斜杠） */
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: 0 | 8;
  crc32: number;
  localOffset: number;
  isDirectory: boolean;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32（IEEE 802.3，ZIP 用的那种）：用于校验条目完整性 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function u16(buf: Uint8Array, at: number): number {
  return view(buf).getUint16(at, true);
}

function u32(buf: Uint8Array, at: number): number {
  return view(buf).getUint32(at, true);
}

function u64(buf: Uint8Array, at: number, what: string): number {
  const dv = view(buf);
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  const v = hi * 4294967296 + lo;
  if (!Number.isSafeInteger(v)) throw new Error(`${what} 超出可处理范围`);
  return v;
}

/** ZIP 文件名解码：优先 UTF-8，无 UTF-8 标志且解码出替换字符时回退 GBK（中文 Windows 打包工具常见） */
function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  const tryDecode = (label: string, fatal: boolean): string | null => {
    try {
      return new TextDecoder(label, { fatal }).decode(bytes);
    } catch {
      return null;
    }
  };
  if (utf8Flag) return tryDecode('utf-8', false) ?? '';
  return tryDecode('utf-8', true) ?? tryDecode('gbk', false) ?? tryDecode('utf-8', false) ?? '';
}

/**
 * 归一化并校验 ZIP 内路径。
 * 返回 null 表示非法（调用方据此拒绝整包）。
 *
 * 拦截面（全部是真实攻击/故障向量）：
 * - `..` 路径穿越（zip-slip）；反斜杠先归一化再判断，避免 `a\..\..\x` 绕过；
 * - 绝对路径（`/x`、`\\server\share`、`C:\x`）；
 * - 盘符与 NTFS 交换数据流（`file.png:evil`，Windows 上 `:` 必须整体拒绝）；
 * - 控制字符 / NUL（可截断日志与路径）；
 * - Windows 设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）与「尾随点/空格」——
 *   Windows 会静默把 `a. ` 与 `a` 视作同名，是覆盖攻击的经典手法。
 */
export function normalizeZipPath(raw: string): string | null {
  const s = String(raw ?? '').replace(/\\/g, '/');
  if (!s || s.length > 1024) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (s.includes(':')) return null;
  if (s.startsWith('/')) return null;
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    if (/[. ]$/.test(seg)) return null;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) return null;
    parts.push(seg);
  }
  if (!parts.length) return null;
  return parts.join('/');
}

function findEocd(buf: Uint8Array): number {
  // EOCD 最多 22 + 65535 字节；注释里可能恰好出现签名，因此要求「注释长度自洽」
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) !== SIG_EOCD) continue;
    const commentLen = u16(buf, i + 20);
    if (i + 22 + commentLen <= buf.length) return i;
  }
  return -1;
}

/**
 * 读取中央目录（不解压任何数据）。
 * 这是导入流程的第一道闸门：所有体积/路径/加密判断都发生在这里，通过之后才允许解压。
 */
export function listZipEntries(buf: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < 22) throw new Error('不是有效的压缩包（文件过小）');
  if (u32(buf, 0) !== SIG_LOCAL && findEocd(buf) < 0) throw new Error('不是有效的 ZIP 压缩包');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('压缩包已损坏（找不到目录结尾记录）');

  let total = u16(buf, eocd + 10);
  let cdSize = u32(buf, eocd + 12);
  let cdOffset = u32(buf, eocd + 16);

  // ZIP64：字段溢出为 0xFFFFFFFF/0xFFFF 时改读 ZIP64 目录
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAt = eocd - 20;
    if (locAt < 0 || u32(buf, locAt) !== SIG_EOCD64_LOC) throw new Error('ZIP64 压缩包缺少目录定位记录');
    const eocd64 = u64(buf, locAt + 8, 'ZIP64 目录偏移');
    if (eocd64 + 56 > buf.length || u32(buf, eocd64) !== SIG_EOCD64) throw new Error('ZIP64 目录记录损坏');
    total = u64(buf, eocd64 + 32, 'ZIP64 条目数');
    cdSize = u64(buf, eocd64 + 40, 'ZIP64 目录大小');
    cdOffset = u64(buf, eocd64 + 48, 'ZIP64 目录偏移');
  }

  if (total > limits.maxEntries) throw new Error(`压缩包条目过多（${total} > ${limits.maxEntries}）`);
  if (cdOffset + cdSize > buf.length) throw new Error('压缩包目录越界（文件被截断或伪造）');

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let at = cdOffset;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    if (at + 46 > buf.length || u32(buf, at) !== SIG_CENTRAL) throw new Error('压缩包目录项损坏');
    const flags = u16(buf, at + 8);
    const method = u16(buf, at + 10);
    const crc = u32(buf, at + 16);
    let compSize = u32(buf, at + 20);
    let uncompSize = u32(buf, at + 24);
    const nameLen = u16(buf, at + 28);
    const extraLen = u16(buf, at + 30);
    const commentLen = u16(buf, at + 32);
    // ZIP64 场景会被下面的扩展字段改写，故用 let
    let localOffset = u32(buf, at + 42);
    const nameAt = at + 46;
    if (nameAt + nameLen + extraLen + commentLen > buf.length) throw new Error('压缩包目录项越界');

    const rawName = decodeName(buf.subarray(nameAt, nameAt + nameLen), (flags & FLAG_UTF8) !== 0);

    // ZIP64 扩展字段：本地头偏移/大小溢出时按顺序取 8 字节值
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let ex = nameAt + nameLen;
      const exEnd = ex + extraLen;
      while (ex + 4 <= exEnd) {
        const id = u16(buf, ex);
        const size = u16(buf, ex + 2);
        if (id === 0x0001) {
          let p = ex + 4;
          if (uncompSize === 0xffffffff) { uncompSize = u64(buf, p, 'ZIP64 条目大小'); p += 8; }
          if (compSize === 0xffffffff) { compSize = u64(buf, p, 'ZIP64 压缩大小'); p += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(buf, p, 'ZIP64 本地头偏移'); p += 8; }
          break;
        }
        ex += 4 + size;
      }
    }

    if (flags & FLAG_ENCRYPTED) throw new Error(`压缩包含加密条目，暂不支持：${rawName}`);
    if (method !== 0 && method !== 8) throw new Error(`压缩包使用了不支持的压缩方式（${method}）：${rawName}`);
    if (nameLen > limits.maxNameLength * 4) throw new Error('压缩包条目名过长');

    const isDirectory = rawName.replace(/\\/g, '/').endsWith('/');
    const name = normalizeZipPath(rawName);
    if (!name) throw new Error(`压缩包含非法路径条目（已拦截）：${rawName}`);
    if (seen.has(name)) throw new Error(`压缩包含重复条目（可覆盖同名文件，已拦截）：${name}`);
    seen.add(name);

    if (!isDirectory) {
      if (uncompSize > limits.maxEntryUncompressed) {
        throw new Error(`压缩包内单文件过大（${Math.round(uncompSize / 1048576)}MB）：${name}`);
      }
      if (compSize > 0 && uncompSize / compSize > limits.maxCompressionRatio) {
        throw new Error(`压缩包疑似解压炸弹（压缩比 ${Math.round(uncompSize / compSize)}:1）：${name}`);
      }
      if (compSize === 0 && uncompSize > 0) throw new Error(`压缩包条目大小自相矛盾：${name}`);
      sum += uncompSize;
      if (sum > limits.maxTotalUncompressed) {
        throw new Error(`压缩包解压后总大小超限（>${Math.round(limits.maxTotalUncompressed / 1048576)}MB）`);
      }
    }
    if (localOffset + 30 > buf.length) throw new Error(`压缩包条目越界：${name}`);

    entries.push({
      name,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      method: method as 0 | 8,
      crc32: crc,
      localOffset,
      isDirectory
    });
    at = nameAt + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 解压单个条目（含 CRC 与长度校验）。
 * 只从**本地头**重新读取数据起点偏移：中央目录与本地头的 nameLen/extraLen 允许不同，
 * 若沿用中央目录的值会读错数据流。
 */
export function readZipEntry(buf: Uint8Array, entry: ZipEntry): Uint8Array {
  const at = entry.localOffset;
  if (u32(buf, at) !== SIG_LOCAL) throw new Error(`压缩包条目头损坏：${entry.name}`);
  const nameLen = u16(buf, at + 26);
  const extraLen = u16(buf, at + 28);
  const start = at + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error(`压缩包条目数据越界：${entry.name}`);
  const raw = buf.subarray(start, end);

  let out: Uint8Array;
  if (entry.method === 0) {
    if (raw.length !== entry.uncompressedSize) throw new Error(`压缩包条目长度不符：${entry.name}`);
    out = raw.slice();
  } else {
    // maxSize 同时兜住"头部声明大小撒谎"的情况：超出声明值即报错，不继续分配内存
    out = inflateRaw(raw, entry.uncompressedSize + 1);
    if (out.length !== entry.uncompressedSize) throw new Error(`解压结果与声明大小不符：${entry.name}`);
  }
  if (crc32(out) !== entry.crc32) throw new Error(`压缩包条目校验失败（内容损坏）：${entry.name}`);
  return out;
}

/** 读取全部条目内容（返回 name → bytes；目录条目会被忽略） */
export function readZip(
  buf: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): { entries: ZipEntry[]; files: Map<string, Uint8Array> } {
  const entries = listZipEntries(buf, limits);
  const files = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.isDirectory) continue;
    files.set(e.name, readZipEntry(buf, e));
  }
  return { entries, files };
}

export interface ZipBuildEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 生成 ZIP（全部使用 STORED 方式）。
 *
 * 不启用 DEFLATE 是刻意的：主题包允许的资产类型（PNG/GIF/WebP/JPEG）本身已是压缩格式，
 * 再压一遍几乎不减小体积；换来的是写出侧不需要任何压缩实现——少一处可能出错的地方。
 * 读取侧仍然完整支持 DEFLATE（用户会用系统自带"右键→发送到→压缩文件夹"打包）。
 */
export function buildZip(entries: ZipBuildEntry[], now: Date = new Date()): Uint8Array {
  const dosTime =
    ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f);
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = normalizeZipPath(e.name);
    if (!name || name !== e.name) throw new Error(`待打包条目名非法：${e.name}`);
    const nameBytes = encoder.encode(name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(e.data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const l of locals) {
    out.set(l, at);
    at += l.length;
  }
  for (const c of centrals) {
    out.set(c, at);
    at += c.length;
  }
  out.set(eocd, at);
  return out;
}
