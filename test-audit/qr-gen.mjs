// 用被测实现生成二维码 PNG，供独立解码器（zxing-cpp）验证
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as qr from '../shared/devtools/qrcode.ts';

const OUT = join(process.env.TEMP, 'qr-cross');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'app'), { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function pngGray(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width + 1)] = 0; pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const cases = [];
const texts = ['A', 'hello', 'hello world', 'https://example.com', 'https://example.com/a?b=1&c=中文', '小鹏工具箱', 'mixed 中文 English 123', '0'.repeat(60), 'x'.repeat(120)];
const ecs = ['L', 'M', 'Q', 'H'];
let idx = 0;
for (const t of texts) for (const ec of ecs) {
  const enc = qr.qrEncode(t, ec);
  if (!enc.ok) { cases.push({ id: idx, text: t, ec, ok: false, err: enc.message }); idx++; continue; }
  const scale = 4, quiet = 4, dim = enc.size, W = (dim + quiet * 2) * scale;
  const px = Buffer.alloc(W * W, 255);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const mr = Math.floor(y / scale) - quiet, mc = Math.floor(x / scale) - quiet;
    if (mr >= 0 && mc >= 0 && mr < dim && mc < dim && enc.modules[mr][mc]) px[y * W + x] = 0;
  }
  const file = join(OUT, 'app', 'qr' + idx + '.png');
  writeFileSync(file, pngGray(W, W, px));
  cases.push({ id: idx, text: t, ec, version: enc.version, mask: enc.mask, ok: true, file, px: W });
  idx++;
}
writeFileSync(join(OUT, 'expect.json'), JSON.stringify(cases, null, 1));
console.log('generated ' + cases.filter((c) => c.ok).length + ' QR PNGs to ' + join(OUT, 'app'));
