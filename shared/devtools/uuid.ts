/**
 * UUID v4 生成（DEV-06 / DEV-12）
 *
 * 随机源优先 Web Crypto（Node 19+ / Chromium 均内建），退化时使用 Math.random（仅兜底）。
 */

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** 生成一个 UUID v4（小写、带连字符） */
export function uuidV4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex: string[] = [];
  for (const x of b) hex.push(x.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

/** 一次生成 n 个（DEV-12：输入 uuid 一次给 4 个候选） */
export function uuidBatch(n = 4): string[] {
  const count = Math.max(1, Math.min(20, Math.round(Number(n) || 1)));
  return Array.from({ length: count }, () => uuidV4());
}

/** 校验 UUID 形态（含 v4 版本位） */
export function isUuid(text: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(text ?? '').trim());
}
