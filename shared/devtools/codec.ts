/**
 * Base64 / URL 编解码（DEV-03 / DEV-12）
 *
 * 纯 JS 实现（不依赖 Buffer / atob / btoa），主进程与渲染层行为完全一致；
 * 全部按 UTF-8 处理中文与 emoji。
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符串 → UTF-8 字节 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // 代理对（emoji 等）合并为一个码点
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    /*
     * P3-1：孤立代理项（半个 emoji，如单独的 \ud83d）不是合法码点。
     * 旧实现按 WTF-8 直接编成 3 字节，而 Node / Python 等标准实现产出的是 U+FFFD，
     * 导致"同一字符串"的 Base64 / 哈希在不同实现间对不上。这里统一替换为 U+FFFD。
     */
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
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
  return Uint8Array.from(out);
}

/** UTF-8 字节 → 字符串（非法字节以 U+FFFD 占位，不抛错） */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let code: number;
    if (b < 0x80) code = b;
    else if ((b & 0xe0) === 0xc0) code = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if ((b & 0xf0) === 0xe0) code = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else if ((b & 0xf8) === 0xf0)
      code =
        ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else code = 0xfffd;
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else out += String.fromCharCode(code);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

/** Base64 → 字节；含非法字符时返回 null */
export function base64ToBytes(text: string): Uint8Array | null {
  const clean = String(text ?? '')
    .replace(/[\s\r\n]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  if (!clean) return Uint8Array.from([]);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function base64Encode(text: string): string {
  return bytesToBase64(utf8Encode(String(text ?? '')));
}

/** Base64 解码为文本；失败返回 null */
export function base64Decode(text: string): string | null {
  const bytes = base64ToBytes(text);
  if (!bytes) return null;
  return utf8Decode(bytes);
}

/** 是否像 Base64（长度 4 的倍数或含填充，字符集合法，且解码后可打印） */
export function looksLikeBase64(text: string): boolean {
  const t = String(text ?? '').trim();
  if (t.length < 8) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return false;
  const decoded = base64Decode(t);
  if (decoded === null) return false;
  // 解码结果必须「可读」：不含大量控制字符，避免把普通英文单词误判为 Base64
  let printable = 0;
  for (const ch of decoded) {
    const c = ch.charCodeAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0x7f)) printable++;
  }
  return decoded.length > 0 && printable / decoded.length > 0.9;
}

export function urlEncode(text: string): string {
  try {
    return encodeURIComponent(String(text ?? ''));
  } catch {
    return String(text ?? '');
  }
}

/**
 * URL 解码；非法百分号序列返回 null。
 *
 * P3-3：不再把 '+' 当作空格。urlEncode 用 encodeURIComponent（空格 → %20），
 * 旧实现却"编码用 %20、解码认 '+'"，与自身规则不对称，
 * 会把字面量 'a+b'（base64 串、查询值里的加号等）静默改成 'a b'。
 */
export function urlDecode(text: string): string | null {
  try {
    return decodeURIComponent(String(text ?? ''));
  } catch {
    return null;
  }
}

/** 是否像已编码的 URL 文本（含 %XX 转义） */
export function looksUrlEncoded(text: string): boolean {
  const t = String(text ?? '');
  if (!/%[0-9A-Fa-f]{2}/.test(t)) return false;
  return urlDecode(t) !== null;
}

export interface CodecResult {
  /** encode = 原文 → 编码；decode = 编码 → 原文 */
  mode: 'encode' | 'decode';
  out: string;
}

/** Base64 双向自动识别（DEV-03：双向自动识别） */
export function base64Auto(text: string): CodecResult | null {
  if (looksLikeBase64(text)) {
    const decoded = base64Decode(text);
    if (decoded !== null && decoded !== text) return { mode: 'decode', out: decoded };
  }
  if (!text) return null;
  return { mode: 'encode', out: base64Encode(text) };
}

/** URL 双向自动识别（DEV-03：双向自动识别） */
export function urlAuto(text: string): CodecResult | null {
  if (looksUrlEncoded(text)) {
    const decoded = urlDecode(text);
    if (decoded !== null && decoded !== text) return { mode: 'decode', out: decoded };
  }
  if (!text) return null;
  const encoded = urlEncode(text);
  if (encoded === text) return null;
  return { mode: 'encode', out: encoded };
}
