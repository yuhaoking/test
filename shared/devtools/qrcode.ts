/**
 * 二维码生成 / 解码（DEV-09，Q7：自研实现，不引第三方库）
 *
 * - 编码：版本 1~10，纠错等级 L/M/Q/H，数字 / 字母数字 / 字节（UTF-8）三种模式，8 种掩码择优；
 * - 解码：位图（布尔矩阵）或 RGBA 像素 → 定位角标 → 采样 → 去掩码 → 反交织 → 还原文本；
 *   支持版本 1~10、正射（无透视畸变）图像，覆盖截图 / 生成的二维码场景。
 * 全部为纯函数（无 IO、无全局状态），主进程与渲染层共用。
 */

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrEncodeOk {
  ok: true;
  version: number;
  size: number;
  ecc: EccLevel;
  /** modules[row][col]，true = 深色 */
  modules: boolean[][];
}
export interface QrFail {
  ok: false;
  message: string;
}
export type QrEncodeResult = QrEncodeOk | QrFail;

export interface QrDecodeOk {
  ok: true;
  text: string;
  version: number;
  ecc: EccLevel;
}
export type QrDecodeResult = QrDecodeOk | QrFail;

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** [每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]（ISO/IEC 18004 表 13~22，版本 1~10） */
const RS_BLOCKS: Record<number, Record<EccLevel, [number, number, number, number, number]>> = {
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] }
};

const ALIGN_CENTERS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

const MAX_ENCODE_VERSION = 10;

// ---------- GF(256) ----------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 ∏(x - a^i) */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 计算一个数据块的纠错码字 */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

// ---------- 版本 / 容量 ----------

function sizeOf(version: number): number {
  return version * 4 + 17;
}

/** 功能图形占用的模块数（由几何推导，用于与 RS 分块表交叉校验） */
function dataModuleCount(version: number): number {
  const size = sizeOf(version);
  let count = size * size;
  // 角标 + 分隔符：3 个 8x8
  count -= 3 * 64;
  // 定位图形（第 6 行/列）
  count -= 2 * (size - 16);
  // 校正图形
  const centers = ALIGN_CENTERS[version];
  const coords: Array<[number, number]> = [];
  for (const r of centers) for (const c of centers) coords.push([r, c]);
  for (const [r, c] of coords) {
    const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
    if (nearFinder) continue;
    // 位于第 6 行 / 第 6 列的校正图形与定位图形重叠 5 个模块（标准允许重叠覆盖）
    count -= r === 6 || c === 6 ? 20 : 25;
  }
  // 格式信息 + 固定深色模块
  count -= 31;
  if (version >= 7) count -= 36;
  return count;
}

export function totalCodewords(version: number): number {
  return Math.floor(dataModuleCount(version) / 8);
}

function blockInfo(version: number, ecc: EccLevel): [number, number, number, number, number] {
  return RS_BLOCKS[version][ecc];
}

function dataCodewords(version: number, ecc: EccLevel): number {
  const [ec, b1, d1, b2, d2] = blockInfo(version, ecc);
  void ec;
  return b1 * d1 + b2 * d2;
}

export const ECC_LEVELS: EccLevel[] = ['L', 'M', 'Q', 'H'];

// ---------- 数据编码 ----------

interface BitBuffer {
  bits: number[];
}

function put(buffer: BitBuffer, value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) buffer.bits.push((value >>> i) & 1);
}

function utf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
  }
  return out;
}

function isNumeric(text: string): boolean {
  return text.length > 0 && /^[0-9]+$/.test(text);
}

function isAlnum(text: string): boolean {
  if (!text) return false;
  for (const ch of text) if (ALNUM.indexOf(ch) < 0) return false;
  return true;
}

function charCountBits(mode: 'numeric' | 'alnum' | 'byte', version: number): number {
  const group = version <= 9 ? 0 : 1;
  if (mode === 'numeric') return [10, 12][group];
  if (mode === 'alnum') return [9, 11][group];
  return [8, 16][group];
}

function encodeData(text: string, version: number): BitBuffer {
  const buffer: BitBuffer = { bits: [] };
  if (isNumeric(text)) {
    put(buffer, 1, 4);
    put(buffer, text.length, charCountBits('numeric', version));
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      put(buffer, parseInt(chunk, 10), chunk.length * 3 + 1);
    }
    return buffer;
  }
  if (isAlnum(text)) {
    put(buffer, 2, 4);
    put(buffer, text.length, charCountBits('alnum', version));
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) put(buffer, ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      else put(buffer, ALNUM.indexOf(text[i]), 6);
    }
    return buffer;
  }
  const bytes = utf8(text);
  put(buffer, 4, 4);
  put(buffer, bytes.length, charCountBits('byte', version));
  for (const b of bytes) put(buffer, b, 8);
  return buffer;
}

function buildCodewords(text: string, version: number, ecc: EccLevel): number[] {
  const capacity = dataCodewords(version, ecc);
  const buffer = encodeData(text, version);
  const capacityBits = capacity * 8;
  if (buffer.bits.length > capacityBits) throw new Error('内容超出该版本容量');
  // 终止符（最多 4 个 0）
  const term = Math.min(4, capacityBits - buffer.bits.length);
  for (let i = 0; i < term; i++) buffer.bits.push(0);
  // 补齐到字节边界
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);
  const bytes: number[] = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buffer.bits[i + j];
    bytes.push(v);
  }
  const PAD = [0xec, 0x11];
  let p = 0;
  while (bytes.length < capacity) bytes.push(PAD[p++ % 2]);
  return bytes;
}

/** 分块 + 纠错 + 交织（返回最终码字序列） */
function interleave(bytes: number[], version: number, ecc: EccLevel): number[] {
  const [ecLen, b1, d1, b2, d2] = blockInfo(version, ecc);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < b1; i++) {
    const d = bytes.slice(offset, offset + d1);
    offset += d1;
    dataBlocks.push(d);
    ecBlocks.push(rsEncode(d, ecLen));
  }
  for (let i = 0; i < b2; i++) {
    const d = bytes.slice(offset, offset + d2);
    offset += d2;
    dataBlocks.push(d);
    ecBlocks.push(rsEncode(d, ecLen));
  }
  const out: number[] = [];
  const maxData = Math.max(d1, d2 || 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// ---------- 矩阵构建 ----------

function makeMatrix(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function maskFn(mask: number, i: number, j: number): boolean {
  switch (mask) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
  }
}

/** 功能图形占位图（true = 已占用，不可放数据） */
export function reservedMap(version: number): boolean[][] {
  const size = sizeOf(version);
  const res = makeMatrix(size);
  const mark = (r: number, c: number): void => {
    if (r >= 0 && r < size && c >= 0 && c < size) res[r][c] = true;
  };
  // 角标 + 分隔符
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c);
  }
  // 定位图形
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  // 校正图形
  const centers = ALIGN_CENTERS[version];
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  // 格式信息
  for (let i = 0; i < 9; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  mark(size - 8, 8);
  // 版本信息
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mark(size - 11 + j, i);
        mark(i, size - 11 + j);
      }
    }
  }
  return res;
}

function bchFormat(data: number): number {
  let d = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
  }
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(version: number): number {
  let d = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((d >>> i) & 1) d ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | d;
}

const ECC_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

function drawFormat(matrix: boolean[][], ecc: EccLevel, mask: number): void {
  const size = matrix.length;
  const bits = bchFormat((ECC_BITS[ecc] << 3) | mask);
  // 副本 A：环绕左上角标（列 8 上半 + 行 8 左半）
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    if (i < 6) matrix[i][8] = dark;
    else if (i < 8) matrix[i + 1][8] = dark;
    else matrix[size - 15 + i][8] = dark;
  }
  // 副本 B：右上（行 8 右半）+ 左下（列 8 下半）
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    if (i < 8) matrix[8][size - 1 - i] = dark;
    else if (i === 8) matrix[8][15 - i] = dark;
    else matrix[8][14 - i] = dark;
  }
  matrix[size - 8][8] = true; // 固定深色模块
}

function drawVersion(matrix: boolean[][], version: number): void {
  if (version < 7) return;
  const size = matrix.length;
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    matrix[size - 11 + c][r] = dark;
    matrix[r][size - 11 + c] = dark;
  }
}

function drawFunctionPatterns(matrix: boolean[][], version: number): void {
  const size = matrix.length;
  // 角标
  const finder = (r0: number, c0: number): void => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[r0 + r][c0 + c] = edge || core;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  // 定位图形
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }
  // 校正图形
  const centers = ALIGN_CENTERS[version];
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          matrix[r + dr][c + dc] = ring !== 1;
        }
      }
    }
  }
}

/** 按掩码规则放置数据位（从右下角开始，两列一组蛇形前进） */
function placeData(matrix: boolean[][], reserved: boolean[][], codewords: number[], mask: number): void {
  const size = matrix.length;
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let idx = 0;
  let row = size - 1;
  let dir = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (!reserved[row][cc]) {
          const bit = idx < bits.length ? bits[idx] === 1 : false;
          matrix[row][cc] = bit !== maskFn(mask, row, cc);
          idx++;
        }
      }
      row += dir;
      if (row < 0 || row >= size) {
        row -= dir;
        dir = -dir;
        break;
      }
    }
  }
}

function penalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0;
  // 规则 1：同色连续 >= 5
  for (let i = 0; i < size; i++) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j++) {
      runRow = matrix[i][j] === matrix[i][j - 1] ? runRow + 1 : 1;
      if (runRow === 5) score += 3;
      else if (runRow > 5) score += 1;
      runCol = matrix[j][i] === matrix[j - 1][i] ? runCol + 1 : 1;
      if (runCol === 5) score += 3;
      else if (runCol > 5) score += 1;
    }
  }
  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }
  // 规则 3：1:1:3:1:1 形态（含 4 个浅色模块）
  const pattern = [true, false, true, true, true, false, true];
  const matches = (get: (k: number) => boolean, start: number): boolean => {
    for (let k = 0; k < 7; k++) if (get(start + k) !== pattern[k]) return false;
    return true;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 7 <= size; j++) {
      const rowGet = (k: number): boolean => matrix[i][k];
      const colGet = (k: number): boolean => matrix[k][i];
      if (matches(rowGet, j)) {
        let before = true;
        let after = true;
        for (let k = 1; k <= 4; k++) {
          if (j - k >= 0 && matrix[i][j - k]) before = false;
          if (j + 6 + k < size && matrix[i][j + 6 + k]) after = false;
        }
        if (before || after) score += 40;
      }
      if (matches(colGet, j)) {
        let before = true;
        let after = true;
        for (let k = 1; k <= 4; k++) {
          if (j - k >= 0 && matrix[j - k][i]) before = false;
          if (j + 6 + k < size && matrix[j + 6 + k][i]) after = false;
        }
        if (before || after) score += 40;
      }
    }
  }
  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/** 生成二维码矩阵（DEV-09：文本 → 二维码） */
export function qrEncode(text: string, ecc: EccLevel = 'M', minVersion = 1): QrEncodeResult {
  const payload = String(text ?? '');
  if (!payload) return { ok: false, message: '请输入要生成二维码的文本' };
  const level: EccLevel = ECC_LEVELS.includes(ecc) ? ecc : 'M';
  let version = Math.max(1, Math.min(MAX_ENCODE_VERSION, Math.round(minVersion) || 1));
  for (; version <= MAX_ENCODE_VERSION; version++) {
    try {
      const bytes = buildCodewords(payload, version, level);
      const size = sizeOf(version);
      const reserved = reservedMap(version);
      const codewords = interleave(bytes, version, level);
      let best: boolean[][] | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let mask = 0; mask < 8; mask++) {
        const matrix = makeMatrix(size);
        drawFunctionPatterns(matrix, version);
        placeData(matrix, reserved, codewords, mask);
        drawFormat(matrix, level, mask);
        drawVersion(matrix, version);
        const score = penalty(matrix);
        if (score < bestScore) {
          bestScore = score;
          best = matrix;
        }
      }
      if (best) return { ok: true, version, size, ecc: level, modules: best };
    } catch {
      /* 容量不足，尝试更高版本 */
    }
  }
  return {
    ok: false,
    message: '内容过长：版本 1~10 在纠错等级 ' + level + ' 下最多可容纳约 ' + dataCodewords(MAX_ENCODE_VERSION, level) + ' 字节'
  };
}

// ---------- 解码 ----------

function readFormat(matrix: boolean[][]): { ecc: EccLevel; mask: number } | null {
  const size = matrix.length;
  let copyA = 0;
  let copyB = 0;
  for (let i = 0; i < 15; i++) {
    let darkA: boolean;
    if (i < 6) darkA = matrix[i][8];
    else if (i === 6) darkA = matrix[7][8];
    else if (i === 7) darkA = matrix[8][8];
    else if (i === 8) darkA = matrix[8][7];
    else darkA = matrix[8][14 - i];
    if (darkA) copyA |= 1 << i;
    const darkB = i < 8 ? matrix[8][size - 1 - i] : matrix[size - 15 + i][8];
    if (darkB) copyB |= 1 << i;
  }
  const decode = (raw: number): { ecc: EccLevel; mask: number; dist: number } | null => {
    let best: { ecc: EccLevel; mask: number; dist: number } | null = null;
    for (const level of ECC_LEVELS) {
      for (let mask = 0; mask < 8; mask++) {
        // bchFormat 返回的是已异或掩码常量（0x5412）的最终格式位串，需与原始读取值比较
        const expected = bchFormat((ECC_BITS[level] << 3) | mask);
        let dist = 0;
        let x = raw ^ expected;
        while (x) {
          dist += x & 1;
          x >>>= 1;
        }
        if (!best || dist < best.dist) best = { ecc: level, mask, dist };
      }
    }
    return best;
  };
  const a = decode(copyA);
  const b = decode(copyB);
  const best = !a ? b : !b ? a : a.dist <= b.dist ? a : b;
  if (!best || best.dist > 3) return null;
  return { ecc: best.ecc, mask: best.mask };
}

function readCodewords(matrix: boolean[][], reserved: boolean[][], mask: number): number[] {
  const size = matrix.length;
  const bits: number[] = [];
  let row = size - 1;
  let dir = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (!reserved[row][cc]) {
          const raw = matrix[row][cc];
          bits.push(raw !== maskFn(mask, row, cc) ? 1 : 0);
        }
      }
      row += dir;
      if (row < 0 || row >= size) {
        row -= dir;
        dir = -dir;
        break;
      }
    }
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }
  return codewords;
}

/** 反交织：还原各数据块并拼接数据码字 */
function deinterleave(codewords: number[], version: number, ecc: EccLevel): number[] | null {
  const [ecLen, b1, d1, b2, d2] = blockInfo(version, ecc);
  const blocks = b1 + b2;
  const totalData = b1 * d1 + b2 * d2;
  const lengths: number[] = [];
  for (let i = 0; i < blocks; i++) lengths.push(i < b1 ? d1 : d2);
  const data: number[][] = lengths.map(() => []);
  let idx = 0;
  const maxData = Math.max(d1, d2 || 0);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < lengths[b]) {
        if (idx >= codewords.length) return null;
        data[b].push(codewords[idx++]);
      }
    }
  }
  const ec: number[][] = lengths.map(() => []);
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < blocks; b++) {
      if (idx >= codewords.length) return null;
      ec[b].push(codewords[idx++]);
    }
  }
  const out: number[] = [];
  for (const block of data) out.push(...block);
  if (out.length !== totalData) return null;
  return out;
}

interface BitReader {
  data: number[];
  pos: number;
}

function readBits(reader: BitReader, n: number): number | null {
  if (reader.pos + n > reader.data.length * 8) return null;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const byte = reader.data[reader.pos >> 3];
    const bit = (byte >> (7 - (reader.pos & 7))) & 1;
    v = (v << 1) | bit;
    reader.pos++;
  }
  return v;
}

function decodeUtf8(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let code: number;
    if (b < 0x80) code = b;
    else if ((b & 0xe0) === 0xc0) code = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if ((b & 0xf0) === 0xe0) code = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else if ((b & 0xf8) === 0xf0)
      code = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else code = 0xfffd;
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else out += String.fromCharCode(code);
  }
  return out;
}

function decodeSegments(data: number[], version: number): string | null {
  const reader: BitReader = { data, pos: 0 };
  let out = '';
  const countBits = (m: 'numeric' | 'alnum' | 'byte'): number => charCountBits(m, version);
  for (;;) {
    const mode = readBits(reader, 4);
    if (mode === null) break;
    if (mode === 0) break; // 终止符
    if (mode === 7) {
      // ECI：读取并忽略（UTF-8 为默认行为）
      const first = readBits(reader, 8);
      if (first === null) return null;
      if ((first & 0x80) === 0) continue;
      if ((first & 0xc0) === 0x80) {
        readBits(reader, 8);
        continue;
      }
      readBits(reader, 16);
      continue;
    }
    if (mode === 1) {
      const count = readBits(reader, countBits('numeric'));
      if (count === null) return null;
      let i = 0;
      while (i < count) {
        const remaining = count - i;
        const chunk = Math.min(3, remaining);
        const v = readBits(reader, chunk * 3 + 1);
        if (v === null) return null;
        out += String(v).padStart(chunk, '0');
        i += chunk;
      }
      continue;
    }
    if (mode === 2) {
      const count = readBits(reader, countBits('alnum'));
      if (count === null) return null;
      let i = 0;
      while (i < count) {
        if (count - i >= 2) {
          const v = readBits(reader, 11);
          if (v === null) return null;
          out += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45];
          i += 2;
        } else {
          const v = readBits(reader, 6);
          if (v === null) return null;
          out += ALNUM[v];
          i++;
        }
      }
      continue;
    }
    if (mode === 4) {
      const count = readBits(reader, countBits('byte'));
      if (count === null) return null;
      const bytes: number[] = [];
      for (let i = 0; i < count; i++) {
        const b = readBits(reader, 8);
        if (b === null) return null;
        bytes.push(b);
      }
      out += decodeUtf8(bytes);
      continue;
    }
    // 未知模式：FNC1 / 结构链接等，放弃
    return out || null;
  }
  return out || null;
}

/** 解码布尔矩阵（true = 深色）；支持版本 1~10 */
export function qrDecodeMatrix(matrix: boolean[][]): QrDecodeResult {
  const size = matrix.length;
  if (!size || matrix.some((row) => row.length !== size)) return { ok: false, message: '矩阵不是正方形' };
  if (size < 21 || size > sizeOf(MAX_ENCODE_VERSION) || (size - 17) % 4 !== 0) {
    return { ok: false, message: '不支持的二维码尺寸（支持版本 1~10）' };
  }
  const version = (size - 17) / 4;
  const fmt = readFormat(matrix);
  if (!fmt) return { ok: false, message: '格式信息校验失败（图像可能模糊或被裁剪）' };
  const reserved = reservedMap(version);
  const codewords = readCodewords(matrix, reserved, fmt.mask);
  const data = deinterleave(codewords, version, fmt.ecc);
  if (!data) return { ok: false, message: '码字读取失败（数据区不完整）' };
  const text = decodeSegments(data, version);
  if (text === null) return { ok: false, message: '内容解析失败（可能是特殊模式或图像噪声）' };
  return { ok: true, text, version, ecc: fmt.ecc };
}

// ---------- 图像 → 矩阵 ----------

/** Otsu 全局阈值二值化（返回 true = 深色） */
export function binarizeRgba(rgba: Uint8ClampedArray | number[], width: number, height: number): boolean[][] {
  const gray = new Uint8Array(width * height);
  const hist = new Array<number>(256).fill(0);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const a = rgba[p + 3] ?? 255;
    // 透明像素按白色（浅色）处理
    const v = a < 32 ? 255 : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    gray[i] = v;
    hist[v]++;
  }
  const total = width * height;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  const out: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < width; x++) row.push(gray[y * width + x] <= threshold);
    out.push(row);
  }
  return out;
}

interface Finder {
  x: number;
  y: number;
  module: number;
}

/** 在二值图中寻找 1:1:3:1:1 角标中心 */
function findFinderAt(bitmap: boolean[][], y: number, x: number): Finder | null {
  const height = bitmap.length;
  const width = bitmap[0].length;
  if (!bitmap[y][x]) return null;
  // 只从水平游程起点判定，避免同一角标被反复命中
  if (x > 0 && bitmap[y][x - 1]) return null;
  const runs = [0, 0, 0, 0, 0];
  let cx = x;
  let idx = 0;
  let dark = true;
  while (cx < width && idx < 5) {
    if (bitmap[y][cx] === dark) {
      runs[idx]++;
      cx++;
    } else {
      idx++;
      dark = !dark;
    }
  }
  /*
   * 五个游程都必须拿到。注意末尾那一段深色游程若正好贴到图像右边界，
   * 循环会因 cx 越界而退出、idx 停在 4 —— 但此时 runs[4] 已经量到了完整的一段，
   * 属于**合格**的角标（否则"无静默区/紧贴裁切"的二维码永远找不到右上角标）。
   */
  const complete = idx === 5 || (idx === 4 && runs[4] > 0);
  if (!complete) return null;
  const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
  const unit = total / 7;
  if (unit < 1) return null;
  const tol = unit * 0.75 + 1;
  if (
    Math.abs(runs[0] - unit) > tol ||
    Math.abs(runs[1] - unit) > tol ||
    Math.abs(runs[2] - 3 * unit) > 3 * tol ||
    Math.abs(runs[3] - unit) > tol ||
    Math.abs(runs[4] - unit) > tol
  ) {
    return null;
  }
  const centerX = x + runs[0] + runs[1] + runs[2] / 2;
  const centerY = y;
  const col = Math.round(centerX);
  if (col < 0 || col >= width) return null;
  // 垂直方向完整的 1:1:3:1:1 校验（上下各三段：核心 / 浅色 / 深色）
  const verticalRuns = (from: number, step: number): number[] => {
    const out: number[] = [];
    let cy = from;
    let wantDark = true;
    while (cy >= 0 && cy < height && out.length < 3) {
      let n = 0;
      while (cy >= 0 && cy < height && bitmap[cy][col] === wantDark) {
        n++;
        cy += step;
      }
      out.push(n);
      wantDark = !wantDark;
    }
    while (out.length < 3) out.push(0);
    return out;
  };
  const upRuns = verticalRuns(centerY, -1);
  const downRuns = verticalRuns(centerY + 1, 1);
  const coreV = upRuns[0] + downRuns[0];
  const vtol = unit * 0.9 + 1.5;
  if (Math.abs(coreV - 3 * unit) > 3 * vtol) return null;
  if (Math.abs(upRuns[1] - unit) > vtol || Math.abs(upRuns[2] - unit) > vtol) return null;
  if (Math.abs(downRuns[1] - unit) > vtol || Math.abs(downRuns[2] - unit) > vtol) return null;
  // 模板校验：按模块中心采样 7x7 角标（数据区偶发的 1:1:3:1:1 形态据此剔除）
  const sample = (r: number, c: number, ox: number, oy: number): boolean => {
    const px = Math.floor(ox + (c - 3) * unit);
    const py = Math.floor(oy + (r - 3) * unit);
    if (px < 0 || py < 0 || px >= width || py >= height) return false;
    return bitmap[py][px];
  };
  const oy = centerY + 0.5;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const expected = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      if (sample(r, c, centerX, oy) !== expected) return null;
    }
  }
  return { x: centerX, y: oy, module: unit };
}

/** 图像 → 布尔矩阵 → 文本（DEV-09：粘贴图片解码） */
export function qrDecodeRgba(
  rgba: Uint8ClampedArray | number[],
  width: number,
  height: number
): QrDecodeResult {
  const bitmap = binarizeRgba(rgba, width, height);
  // 收集角标候选（按行扫描，取水平/垂直双向命中的中心）
  const candidates: Finder[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x++) {
      const f = findFinderAt(bitmap, y, x);
      if (f) candidates.push(f);
    }
  }
  if (candidates.length < 3) return { ok: false, message: '未找到二维码定位角标' };
  // 去重合并（同一角标会被多行命中）：按簇累加求均值
  interface Cluster {
    sumX: number;
    sumY: number;
    sumM: number;
    n: number;
    x: number;
    y: number;
    module: number;
  }
  const clusters: Cluster[] = [];
  for (const c of candidates) {
    const hit = clusters.find((m) => Math.abs(m.x - c.x) < c.module * 3 && Math.abs(m.y - c.y) < c.module * 3);
    if (hit) {
      hit.sumX += c.x;
      hit.sumY += c.y;
      hit.sumM += c.module;
      hit.n++;
      hit.x = hit.sumX / hit.n;
      hit.y = hit.sumY / hit.n;
      hit.module = hit.sumM / hit.n;
    } else {
      clusters.push({ sumX: c.x, sumY: c.y, sumM: c.module, n: 1, x: c.x, y: c.y, module: c.module });
    }
  }
  if (clusters.length < 3) return { ok: false, message: '未找到二维码定位角标（需要 3 个）' };
  const merged: Finder[] = clusters.map((c) => ({ x: c.x, y: c.y, module: c.module }));
  // 角标是模块尺寸最大的一类图形（数据区伪命中通常更小），取前 8 个两两组合逐一验证
  merged.sort((a, b) => b.module - a.module);
  const pool = merged.slice(0, Math.min(8, merged.length));
  let lastMessage = '无法确定二维码三个角标';
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const trio = pickTrio([pool[i], pool[j], pool[k]]);
        if (!trio) continue;
        const dimension = Math.round(Math.hypot(trio.tr.x - trio.tl.x, trio.tr.y - trio.tl.y) / trio.module) + 7;
        if (dimension < 21 || dimension > sizeOf(MAX_ENCODE_VERSION) || (dimension - 17) % 4 !== 0) {
          lastMessage = '二维码尺寸不合法（支持版本 1~10 的正射图像）';
          continue;
        }
        const matrix: boolean[][] = [];
        for (let r = 0; r < dimension; r++) {
          const row: boolean[] = [];
          for (let c = 0; c < dimension; c++) {
            const x = Math.floor(trio.tl.x + (c - 3) * trio.module);
            const y = Math.floor(trio.tl.y + (r - 3) * trio.module);
            row.push(x >= 0 && y >= 0 && x < width && y < height ? bitmap[y][x] : false);
          }
          matrix.push(row);
        }
        const decoded = qrDecodeMatrix(matrix);
        if (decoded.ok) return decoded;
        lastMessage = decoded.message;
      }
    }
  }
  return { ok: false, message: lastMessage };
}

function pickTrio(list: Finder[]): { tl: Finder; tr: Finder; bl: Finder; module: number } | null {
  let best: { tl: Finder; tr: Finder; bl: Finder; module: number; score: number } | null = null;
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < list.length; j++) {
      for (let k = 0; k < list.length; k++) {
        if (i === j || j === k || i === k) continue;
        const a = list[i];
        const b = list[j];
        const c = list[k];
        // a = 左上：到 b、c 的距离近似相等（正方形），且 b-c 为对角线
        const ab = Math.hypot(a.x - b.x, a.y - b.y);
        const ac = Math.hypot(a.x - c.x, a.y - c.y);
        const bc = Math.hypot(b.x - c.x, b.y - c.y);
        if (ab < 8 || ac < 8) continue;
        const ratio = Math.abs(ab - ac) / Math.max(ab, ac);
        const diag = Math.abs(bc - Math.hypot(ab, ac)) / Math.max(bc, 1);
        const moduleVar =
          (Math.abs(a.module - b.module) + Math.abs(a.module - c.module) + Math.abs(b.module - c.module)) /
          (3 * a.module);
        const score = ratio + diag + moduleVar;
        if (score < 0.35 && (!best || score < best.score)) {
          // 判定哪个是右上 / 左下：叉积方向
          const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          const right = cross > 0 ? b : c;
          const bottom = cross > 0 ? c : b;
          best = { tl: a, tr: right, bl: bottom, module: (a.module + b.module + c.module) / 3, score };
        }
      }
    }
  }
  return best ? { tl: best.tl, tr: best.tr, bl: best.bl, module: best.module } : null;
}

/** 便捷封装：二维码矩阵 → SVG path（渲染层直接显示，无需 canvas） */
export function qrSvgPath(modules: boolean[][]): string {
  const parts: string[] = [];
  for (let r = 0; r < modules.length; r++) {
    for (let c = 0; c < modules[r].length; c++) {
      if (modules[r][c]) parts.push('M' + c + ' ' + r + 'h1v1h-1z');
    }
  }
  return parts.join('');
}
