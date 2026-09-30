/**
 * 进制转换（DEV-07 / DEV-12）：2 / 8 / 10 / 16 同屏对照
 */

export type Radix = 2 | 8 | 10 | 16;
export const RADIXES: Radix[] = [2, 8, 10, 16];

export interface RadixResult {
  ok: boolean;
  /** 自动识别出的输入进制 */
  from: Radix;
  /** 输出的有符号十进制值 */
  decimal: number;
  values: Record<'2' | '8' | '10' | '16', string>;
  message?: string;
}

/** 识别前缀：0x/0b/0o；无前缀时按内容推断（含 a-f → 16，仅 0/1 → 若以 0 开头按 8 否则 10） */
export function detectRadix(input: string): Radix {
  const t = String(input ?? '').trim().toLowerCase();
  if (t.startsWith('0x')) return 16;
  if (t.startsWith('0b')) return 2;
  if (t.startsWith('0o')) return 8;
  if (/[a-f]/.test(t)) return 16;
  if (/^-?0[0-7]+$/.test(t)) return 8;
  return 10;
}

function digitsOf(radix: Radix): RegExp {
  switch (radix) {
    case 2:
      return /^-?[01]+$/;
    case 8:
      return /^-?[0-7]+$/;
    case 16:
      return /^-?[0-9a-f]+$/;
    default:
      return /^-?\d+$/;
  }
}

/** 进制转换（不传 from 时自动识别） */
export function radixConvert(input: string, from?: Radix): RadixResult {
  const raw = String(input ?? '').trim();
  const base: Radix = from ?? detectRadix(raw);
  /*
   * P3-2 修复：先摘符号再摘进制前缀。
   * 旧实现直接判断 `body.startsWith('0x')`，于是带负号的 `-0xFF` 前缀识别不到，
   * 被当成"含 16 进制不支持的字符"拒绝；而 `0xFF` 正常 —— 同类输入行为不一致。
   */
  let body = raw.toLowerCase();
  const neg = body.startsWith('-');
  if (neg) body = body.slice(1);
  if (base === 16 && body.startsWith('0x')) body = body.slice(2);
  if (base === 2 && body.startsWith('0b')) body = body.slice(2);
  if (base === 8 && body.startsWith('0o')) body = body.slice(2);
  if (neg) body = '-' + body;
  const fail = (message: string): RadixResult => ({
    ok: false,
    from: base,
    decimal: NaN,
    values: { '2': '', '8': '', '10': '', '16': '' },
    message
  });
  if (!body) return fail('请输入要转换的数值');
  if (!digitsOf(base).test(body)) return fail('含 ' + base + ' 进制不支持的字符');
  const negative = body.startsWith('-');
  const digits = negative ? body.slice(1) : body;
  let value = 0;
  for (const ch of digits) {
    const d = parseInt(ch, 16);
    value = value * base + d;
    if (value > Number.MAX_SAFE_INTEGER) return fail('数值超出安全整数范围');
  }
  if (negative) value = -value;
  return {
    ok: true,
    from: base,
    decimal: value,
    values: {
      '2': value < 0 ? '-' + Math.abs(value).toString(2) : value.toString(2),
      '8': value < 0 ? '-' + Math.abs(value).toString(8) : value.toString(8),
      '10': String(value),
      '16': (value < 0 ? '-' : '') + Math.abs(value).toString(16).toUpperCase()
    }
  };
}

/** 是否形如待转换的进制数值（DEV-12 触发布尔判断：radix 255 / 0xFF / 0b1010） */
export function looksLikeRadixInput(text: string): boolean {
  const t = String(text ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return true;
  if (/^0b[01]+$/i.test(t)) return true;
  if (/^0o[0-7]+$/i.test(t)) return true;
  return false;
}
