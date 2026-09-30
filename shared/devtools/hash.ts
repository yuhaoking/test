/**
 * 哈希（DEV-05 / DEV-12）：MD5 / SHA-1 / SHA-256
 *
 * 纯 JS 实现（零依赖、无 IO、无全局状态），主进程与渲染层共用同一份代码，
 * Node 的 npm test 也可直接断言（不依赖 node:crypto，渲染层无法使用原生模块）。
 */

import { utf8Encode } from './codec.ts';

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

function rotr(x: number, c: number): number {
  return ((x >>> c) | (x << (32 - c))) >>> 0;
}

function toHex(bytes: Uint32Array, littleEndian = false): string {
  let out = '';
  for (const v of bytes) {
    const b = littleEndian
      ? [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
      : [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (const x of b) out += x.toString(16).padStart(2, '0');
  }
  return out;
}

/** 补齐 512 位分组的公共填充：0x80 + 0 填充 + 64 位长度（bitLength） */
function padBytes(bytes: Uint8Array, littleEndianLength: boolean): Uint8Array {
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const total = withOne + ((56 - (withOne % 64)) + 64) % 64 + 8;
  const out = new Uint8Array(total);
  out.set(bytes, 0);
  out[bytes.length] = 0x80;
  const lenBytes = new Uint8Array(8);
  // 64 位长度：高 32 位（JS 数字安全范围内）
  const hi = Math.floor(bitLen / 4294967296);
  const lo = bitLen >>> 0;
  if (littleEndianLength) {
    lenBytes[0] = lo & 0xff;
    lenBytes[1] = (lo >>> 8) & 0xff;
    lenBytes[2] = (lo >>> 16) & 0xff;
    lenBytes[3] = (lo >>> 24) & 0xff;
    lenBytes[4] = hi & 0xff;
  } else {
    lenBytes[7] = lo & 0xff;
    lenBytes[6] = (lo >>> 8) & 0xff;
    lenBytes[5] = (lo >>> 16) & 0xff;
    lenBytes[4] = (lo >>> 24) & 0xff;
    lenBytes[3] = hi & 0xff;
  }
  out.set(lenBytes, total - 8);
  return out;
}

// ---------- MD5 ----------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

function md5K(): Uint32Array {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  return k;
}

export function md5(text: string): string {
  const data = padBytes(utf8Encode(String(text ?? '')), true);
  const K = md5K();
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const m = new Uint32Array(16);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      m[i] = (data[j] | (data[j + 1] << 8) | (data[j + 2] << 16) | (data[j + 3] << 24)) >>> 0;
    }
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + (f >>> 0) + K[i] + m[g]) >>> 0;
      b = (b + rotl(sum, MD5_S[i])) >>> 0;
      a = tmp;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
  }
  return toHex(Uint32Array.from(h), true);
}

// ---------- SHA-1 ----------

export function sha1(text: string): string {
  const data = padBytes(utf8Encode(String(text ?? '')), false);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return toHex(Uint32Array.from(h));
}

// ---------- SHA-256 ----------

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2
]);

export function sha256(text: string): string {
  const data = padBytes(utf8Encode(String(text ?? '')), false);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const w = new Uint32Array(64);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return toHex(Uint32Array.from(h));
}

export interface HashTriple {
  md5: string;
  sha1: string;
  sha256: string;
}

/** DEV-05：一次算三值（命令面板即时结果 / 独立面板共用） */
export function hashAll(text: string): HashTriple {
  return { md5: md5(text), sha1: sha1(text), sha256: sha256(text) };
}
