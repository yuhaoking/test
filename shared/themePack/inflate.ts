/**
 * RFC 1951 原始 DEFLATE 解压（纯 JS，零依赖、无 IO、无全局状态）
 *
 * 为什么自研而不用 node:zlib：
 * 主题包是 UGC / 网络来源，导入流程必须"先审后解"——路径、条目数、声明大小、压缩比全部通过
 * 校验之后，才允许解出任何一个字节。外挂 tar / Expand-Archive 会把"校验"与"解压"拆成两次
 * 独立解析（ZIP 的中央目录与本地头可以不一致），是经典的 zip-slip 绕过面；node:zlib 只能对
 * 整段 buffer 解压，做不到"按条目按需解压"。纯实现同时让本模块保持渲染层可用、
 * 且 `npm test` 可直接断言（不需要 Electron 运行时）。
 */

const MAX_BITS = 15;

/** 位读取器：DEFLATE 是 LSB-first 的位流 */
class BitReader {
  /** 当前缓冲的位（低位在前） */
  private bitBuf = 0;
  /** bitBuf 中有效位数 */
  private bitCnt = 0;
  /** 下一个待读字节下标 */
  pos = 0;

  /**
   * 注意：这里刻意不用 TS 的「构造函数参数属性」写法（constructor(private x)），
   * 因为 Node 的类型剥离（type stripping）在 strip-only 模式下不支持该语法，
   * 而 npm test 正是靠它直接 import 本文件断言的。
   */
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** 读 n 位（n ≤ 16）；数据意外结束时抛错，绝不静默返回半截数据 */
  bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.data.length) throw new Error('压缩数据意外结束');
      this.bitBuf |= this.data[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  }

  /** 丢弃当前字节内剩余的位（stored 块按字节对齐） */
  alignToByte(): void {
    const drop = this.bitCnt & 7;
    this.bitBuf >>>= drop;
    this.bitCnt -= drop;
  }

  /** 按字节读取（必须先对齐；用于 stored 块） */
  readBytes(n: number): Uint8Array {
    if (this.bitCnt % 8 !== 0) throw new Error('内部错误：未按字节对齐');
    const out = new Uint8Array(n);
    let i = 0;
    while (this.bitCnt >= 8 && i < n) {
      out[i++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
    if (i < n) {
      if (this.pos + (n - i) > this.data.length) throw new Error('压缩数据意外结束');
      out.set(this.data.subarray(this.pos, this.pos + (n - i)), i);
      this.pos += n - i;
    }
    return out;
  }
}

interface Huffman {
  /** counts[len] = 码长为 len 的符号个数 */
  counts: Int32Array;
  /** 按（码长，符号）排序后的符号表 */
  symbols: Int32Array;
}

/**
 * 构造规范 Huffman 解码表（puff.c 的计数法）。
 * 相比逐位建树：内存恒定、无需递归、对畸形码表只报错不爆栈——UGC 输入必须抗畸形。
 */
function buildHuffman(lengths: ArrayLike<number>, n: number, what: string): Huffman {
  const counts = new Int32Array(MAX_BITS + 1);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len < 0 || len > MAX_BITS) throw new Error(`${what} 码长非法`);
    counts[len]++;
  }
  if (counts[0] === n) return { counts, symbols: new Int32Array(0) };
  // 校验码表完备性（Kraft 不等式）：不校验的话畸形表会解出垃圾数据而非报错
  let left = 1;
  for (let len = 1; len <= MAX_BITS; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) throw new Error(`${what} 码表过完备`);
  }
  const offsets = new Int32Array(MAX_BITS + 2);
  for (let len = 1; len <= MAX_BITS; len++) offsets[len + 1] = offsets[len] + counts[len];
  const symbols = new Int32Array(n - counts[0]);
  for (let i = 0; i < n; i++) {
    if (lengths[i] !== 0) symbols[offsets[lengths[i]]++] = i;
  }
  return { counts, symbols };
}

function decodeSymbol(br: BitReader, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= br.bits(1);
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('无效的 Huffman 编码');
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!fixedLit || !fixedDist) {
    const litLens = new Uint8Array(288);
    for (let i = 0; i < 144; i++) litLens[i] = 8;
    for (let i = 144; i < 256; i++) litLens[i] = 9;
    for (let i = 256; i < 280; i++) litLens[i] = 7;
    for (let i = 280; i < 288; i++) litLens[i] = 8;
    fixedLit = buildHuffman(litLens, 288, '固定字面量');
    fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30, '固定距离');
  }
  return { lit: fixedLit, dist: fixedDist };
}

function dynamicTables(br: BitReader): { lit: Huffman; dist: Huffman } {
  const hlit = br.bits(5) + 257;
  const hdist = br.bits(5) + 1;
  const hclen = br.bits(4) + 4;
  const clenLens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clenLens[CLEN_ORDER[i]] = br.bits(3);
  const clen = buildHuffman(clenLens, 19, '码长表');
  const lengths = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < lengths.length) {
    const sym = decodeSymbol(br, clen);
    if (sym < 16) {
      lengths[i++] = sym;
    } else if (sym === 16) {
      if (i === 0) throw new Error('码长重复码出现在首位');
      const prev = lengths[i - 1];
      const repeat = 3 + br.bits(2);
      if (i + repeat > lengths.length) throw new Error('码长重复越界');
      for (let k = 0; k < repeat; k++) lengths[i++] = prev;
    } else if (sym === 17) {
      const repeat = 3 + br.bits(3);
      if (i + repeat > lengths.length) throw new Error('码长零填充越界');
      i += repeat;
    } else {
      const repeat = 11 + br.bits(7);
      if (i + repeat > lengths.length) throw new Error('码长零填充越界');
      i += repeat;
    }
  }
  if (lengths[256] === 0) throw new Error('码表缺少块结束符');
  return {
    lit: buildHuffman(lengths, hlit, '字面量'),
    dist: buildHuffman(lengths.subarray(hlit), hdist, '距离')
  };
}

/**
 * 解压一段原始 DEFLATE 数据。
 * @param maxSize 允许的最大输出字节数（0 = 不限制）；超限立即抛错，用于拦截解压炸弹。
 */
export function inflateRaw(data: Uint8Array, maxSize = 0): Uint8Array {
  const br = new BitReader(data);
  let cap = 1 << 16;
  if (maxSize > 0) cap = Math.min(cap, maxSize);
  let out = new Uint8Array(cap);
  let len = 0;

  const ensure = (extra: number): void => {
    if (len + extra <= out.length) return;
    let next = out.length || 64;
    while (next < len + extra) next = next * 2;
    if (maxSize > 0 && next > maxSize) next = maxSize;
    if (next < len + extra) throw new Error('解压输出超过允许大小');
    const grown = new Uint8Array(next);
    grown.set(out.subarray(0, len));
    out = grown;
  };

  let final = 0;
  do {
    final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.alignToByte();
      const blockLen = br.bits(16);
      const nlen = br.bits(16);
      // NLEN 是 LEN 的反码：ZIP 里这一段被破坏时必须报错，否则会静默丢数据
      if ((blockLen ^ 0xffff) !== nlen) throw new Error('stored 块长度校验失败');
      ensure(blockLen);
      out.set(br.readBytes(blockLen), len);
      len += blockLen;
    } else if (type === 1 || type === 2) {
      const tables = type === 1 ? fixedTables() : dynamicTables(br);
      for (;;) {
        const sym = decodeSymbol(br, tables.lit);
        if (sym < 256) {
          ensure(1);
          out[len++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= LENGTH_BASE.length) throw new Error('无效的长度码');
          const length = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li]);
          const dsym = decodeSymbol(br, tables.dist);
          if (dsym >= DIST_BASE.length) throw new Error('无效的距离码');
          const distance = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
          if (distance > len) throw new Error('回溯距离超出已解压数据');
          ensure(length);
          for (let k = 0; k < length; k++, len++) out[len] = out[len - distance];
        }
      }
    } else {
      throw new Error('非法的压缩块类型');
    }
  } while (!final);

  return out.subarray(0, len);
}
