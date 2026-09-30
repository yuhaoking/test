#!/usr/bin/env node
/**
 * 插件图标生成器（纯 Node，无第三方依赖）
 *
 * 设计语言：128×128 圆角渐变色块 + 白色线性字形，按插件族取色：
 *   截图=青 · 录屏=红 · 翻译=蓝紫 · 转换=橙 · 监控=紫 · 示例=灰 · 宠物=粉 · 命令=绿
 * 渲染：SDF 覆盖率 + 3× 超采样抗锯齿；PNG 编码内置（zlib + CRC32）。
 * 运行：node scripts/generate-plugin-icons.mjs [--preview]
 */

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 128;
const SS = 3; // 超采样倍数

// ---------- SDF 图元（统一 0~100 设计坐标） ----------
// shape: ['circle', cx, cy, r] | ['rrect', x, y, w, h, r] | ['capsule', x1, y1, x2, y2, r] | ['tri', x1,y1,x2,y2,x3,y3]
// mode: 'add'（加白）| 'sub'（镂空）

function sdShape(px, py, s) {
  const k = s[0];
  if (k === 'circle') {
    const dx = px - s[1];
    const dy = py - s[2];
    return Math.hypot(dx, dy) - s[3];
  }
  if (k === 'rrect') {
    const [, x, y, w, h, r] = s;
    const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
    const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
  }
  if (k === 'capsule') {
    const [, x1, y1, x2, y2, r] = s;
    const vx = x2 - x1;
    const vy = y2 - y1;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((px - x1) * vx + (py - y1) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)) - r;
  }
  if (k === 'tri') {
    // 凸三角形：三条有向边距离取最大（内部为负）
    const pts = [s[1], s[2], s[3], s[4], s[5], s[6]];
    // 确保逆时针
    const area =
      (pts[2] - pts[0]) * (pts[5] - pts[1]) - (pts[4] - pts[0]) * (pts[3] - pts[1]);
    const p = area < 0 ? [pts[2], pts[3], pts[0], pts[1], pts[4], pts[5]] : pts;
    let sd = -Infinity;
    for (let i = 0; i < 3; i++) {
      const ax = p[i * 2];
      const ay = p[i * 2 + 1];
      const bx = p[((i + 1) % 3) * 2];
      const by = p[((i + 1) % 3) * 2 + 1];
      const ex = bx - ax;
      const ey = by - ay;
      const len = Math.hypot(ex, ey) || 1;
      // area>0 时：内部对三边的 (p-a)×e 均为负 → 取 max 得到负 SDF（内部为负）
      sd = Math.max(sd, ((px - ax) * ey - (py - ay) * ex) / len);
    }
    return sd;
  }
  throw new Error('unknown shape ' + k);
}

/** 渲染字形覆盖率掩码（0~1），按配方顺序 add（并集）/ sub（镂空）合成 */
function renderGlyph(shapes) {
  const buf = new Float32Array(SIZE * SIZE);
  const pxScale = SIZE / 100; // 设计坐标 → 像素
  for (let y = 0; y < SIZE * SS; y++) {
    for (let x = 0; x < SIZE * SS; x++) {
      const px = (x + 0.5) / SS / pxScale;
      const py = (y + 0.5) / SS / pxScale;
      let cov = 0;
      for (const { shape, mode } of shapes) {
        const sdPx = sdShape(px, py, shape) * pxScale;
        const cover = Math.max(0, Math.min(1, 0.5 - sdPx));
        if (mode === 'sub') cov = cov * (1 - cover);
        else cov = cov + cover - cov * cover;
      }
      buf[((y / SS) | 0) * SIZE + ((x / SS) | 0)] += cov;
    }
  }
  for (let i = 0; i < buf.length; i++) buf[i] = Math.min(1, buf[i] / (SS * SS));
  return buf;
}

// ---------- 底：圆角渐变色块 ----------

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function renderTile(top, bottom) {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  const t = hex(top);
  const b = hex(bottom);
  const r = 28 / 128; // 圆角
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // 超采样覆盖率（圆角矩形）
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const qx = Math.abs(px - SIZE / 2) - (SIZE / 2 - r * SIZE);
          const qy = Math.abs(py - SIZE / 2) - (SIZE / 2 - r * SIZE);
          const sd =
            Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r * SIZE;
          cov += Math.max(0, Math.min(1, 0.5 - sd));
        }
      }
      cov /= SS * SS;
      const g = y / (SIZE - 1);
      const i = (y * SIZE + x) * 4;
      rgba[i] = lerp(t[0], b[0], g);
      rgba[i + 1] = lerp(t[1], b[1], g);
      rgba[i + 2] = lerp(t[2], b[2], g);
      rgba[i + 3] = Math.round(cov * 255);
    }
  }
  return rgba;
}

function composite(rgba, glyph) {
  for (let i = 0; i < glyph.length; i++) {
    const a = glyph[i] * 0.96;
    if (a <= 0) continue;
    const o = i * 4;
    rgba[o] = Math.round(rgba[o] * (1 - a) + 255 * a);
    rgba[o + 1] = Math.round(rgba[o + 1] * (1 - a) + 255 * a);
    rgba[o + 2] = Math.round(rgba[o + 2] * (1 - a) + 255 * a);
  }
}

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter none
    Buffer.from(rgba.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 字形配方（0~100 坐标） ----------

const add = (shape) => ({ shape, mode: 'add' });
const sub = (shape) => ({ shape, mode: 'sub' });

const ring = (cx, cy, rOuter, rInner) => [add(['circle', cx, cy, rOuter]), sub(['circle', cx, cy, rInner])];
const frame = (x, y, w, h, r, t) => [
  add(['rrect', x, y, w, h, r]),
  sub(['rrect', x + t, y + t, w - 2 * t, h - 2 * t, Math.max(1, r - t)])
];

const GLYPHS = {
  // 截图族
  camera: [
    add(['rrect', 16, 30, 68, 46, 9]), // 机身
    add(['rrect', 34, 22, 22, 12, 4]), // 军舰部
    sub(['circle', 50, 53, 14]), // 镜头外圈
    add(['circle', 50, 53, 9]), // 镜头
    sub(['circle', 50, 53, 4.5])
  ],
  crop: [
    add(['capsule', 32, 18, 32, 72, 4.5]),
    add(['capsule', 28, 68, 82, 68, 4.5]),
    add(['capsule', 74, 26, 74, 82, 4.5]),
    add(['capsule', 26, 32, 80, 32, 4.5])
  ],
  windowShot: [
    ...frame(18, 24, 64, 54, 8, 5.5),
    add(['capsule', 24, 38, 76, 38, 3.5]),
    add(['circle', 28, 31, 2.6]),
    add(['circle', 37, 31, 2.6])
  ],
  delay: [
    ...ring(50, 50, 24, 19),
    add(['capsule', 50, 50, 50, 34, 3.6]),
    add(['capsule', 50, 50, 62, 56, 3.6])
  ],
  // 录屏族
  recScreen: [
    ...frame(16, 24, 68, 50, 8, 5.5),
    add(['circle', 50, 49, 11])
  ],
  recRegion: [
    add(['capsule', 32, 18, 32, 70, 4.5]),
    add(['capsule', 28, 66, 82, 66, 4.5]),
    add(['capsule', 74, 30, 74, 82, 4.5]),
    add(['capsule', 26, 34, 80, 34, 4.5]),
    add(['circle', 50, 50, 9])
  ],
  gif: [
    ...frame(18, 18, 64, 64, 10, 5.5),
    add(['tri', 42, 34, 42, 66, 66, 50])
  ],
  // 翻译族
  globe: [
    ...ring(50, 50, 24, 19.5),
    add(['capsule', 27, 50, 73, 50, 3.4]),
    add(['capsule', 50, 26, 50, 74, 3.4])
  ],
  bubbles: [
    add(['rrect', 12, 20, 46, 34, 10]),
    add(['tri', 24, 52, 24, 66, 38, 52]),
    sub(['capsule', 22, 31, 48, 31, 2.4]),
    sub(['capsule', 22, 40, 40, 40, 2.4]),
    add(['rrect', 44, 44, 44, 32, 10]),
    add(['tri', 78, 74, 78, 86, 64, 74]),
    sub(['capsule', 53, 55, 79, 55, 2.4]),
    sub(['capsule', 53, 64, 71, 64, 2.4])
  ],
  docA: [
    add(['rrect', 24, 14, 52, 72, 7]),
    sub(['tri', 58, 14, 76, 14, 76, 32]),
    sub(['capsule', 34, 44, 66, 44, 3.2]),
    sub(['capsule', 34, 56, 66, 56, 3.2]),
    sub(['capsule', 34, 68, 54, 68, 3.2])
  ],
  wand: [
    add(['capsule', 28, 74, 58, 44, 5]),
    add(['capsule', 68, 20, 68, 44, 3.6]),
    add(['capsule', 56, 32, 80, 32, 3.6]),
    add(['circle', 50, 22, 3.6]),
    add(['circle', 84, 56, 3.6])
  ],
  // 转换 / 监控 / 示例 / 宠物 / 命令
  convert: [
    ...ring(50, 50, 26, 21),
    add(['capsule', 34, 42, 58, 42, 3.4]),
    add(['tri', 56, 35, 66, 42, 56, 49]),
    add(['capsule', 66, 58, 42, 58, 3.4]),
    add(['tri', 44, 51, 34, 58, 44, 65])
  ],
  pulse: [
    add(['capsule', 14, 54, 32, 54, 4.2]),
    add(['capsule', 32, 54, 42, 32, 4.2]),
    add(['capsule', 42, 32, 54, 72, 4.2]),
    add(['capsule', 54, 72, 63, 50, 4.2]),
    add(['capsule', 63, 50, 86, 50, 4.2])
  ],
  code: [
    add(['capsule', 38, 30, 24, 50, 4]),
    add(['capsule', 24, 50, 38, 70, 4]),
    add(['capsule', 62, 30, 76, 50, 4]),
    add(['capsule', 76, 50, 62, 70, 4]),
    add(['capsule', 56, 26, 44, 74, 4])
  ],
  paw: [
    add(['rrect', 28, 44, 44, 38, 16]),
    add(['circle', 24, 34, 7]),
    add(['circle', 40, 24, 7]),
    add(['circle', 58, 24, 7]),
    add(['circle', 74, 34, 7])
  ],
  terminal: [
    ...frame(16, 22, 68, 56, 9, 5.5),
    add(['capsule', 32, 40, 44, 52, 3.6]),
    add(['capsule', 44, 52, 32, 64, 3.6]),
    add(['capsule', 50, 64, 68, 64, 3.6])
  ]
};

// ---------- 每个插件的配方 ----------

const ICONS = [
  { out: 'plugins/office-screenshot-full/icon.png', glyph: 'camera', top: '#31C7E0', bottom: '#1B8FD6' },
  { out: 'plugins/office-screenshot-region/icon.png', glyph: 'crop', top: '#31C7E0', bottom: '#1B8FD6' },
  { out: 'plugins/office-screenshot-window/icon.png', glyph: 'windowShot', top: '#31C7E0', bottom: '#1B8FD6' },
  { out: 'plugins/office-screenshot-delay/icon.png', glyph: 'delay', top: '#31C7E0', bottom: '#1B8FD6' },
  { out: 'plugins/office-screenrecord-full/icon.png', glyph: 'recScreen', top: '#FF8787', bottom: '#E03131' },
  { out: 'plugins/office-screenrecord-region/icon.png', glyph: 'recRegion', top: '#FF8787', bottom: '#E03131' },
  { out: 'plugins/office-screenrecord-gif/icon.png', glyph: 'gif', top: '#FF8787', bottom: '#E03131' },
  { out: 'plugins/office-translate-any/icon.png', glyph: 'globe', top: '#8CA4FB', bottom: '#4C6EF5' },
  { out: 'plugins/office-translate-cnen/icon.png', glyph: 'bubbles', top: '#8CA4FB', bottom: '#4C6EF5' },
  { out: 'plugins/office-translate-file/icon.png', glyph: 'docA', top: '#8CA4FB', bottom: '#4C6EF5' },
  { out: 'plugins/office-translate-pro/icon.png', glyph: 'wand', top: '#8CA4FB', bottom: '#4C6EF5' },
  { out: 'plugins/office-convert-all/icon.png', glyph: 'convert', top: '#FFB020', bottom: '#F76707' },
  { out: 'plugins/office-deepseek-monitor/icon.png', glyph: 'pulse', top: '#B197FC', bottom: '#7048E8' },
  { out: 'plugins/example-plugin/icon.png', glyph: 'code', top: '#949CAC', bottom: '#495057' },
  { out: 'plugins/example-pet-plugin/icon.png', glyph: 'paw', top: '#FF9CC5', bottom: '#F06595' },
  { out: 'resources/market/packages/com.example.command-tool/icon.png', glyph: 'terminal', top: '#46D9B0', bottom: '#0CA678' }
];

function asciiPreview(rgba) {
  const W = 40;
  const rows = [];
  for (let y = 0; y < W / 2; y++) {
    let line = '';
    for (let x = 0; x < W; x++) {
      const px = Math.floor((x / W) * SIZE);
      const py = Math.floor((y / (W / 2)) * SIZE);
      const o = (py * SIZE + px) * 4;
      const lum = ((rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3) * (rgba[o + 3] / 255);
      line += lum > 220 ? '#' : lum > 170 ? '*' : lum > 110 ? 'o' : lum > 40 ? '.' : ' ';
    }
    rows.push(line);
  }
  return rows.join('\n');
}

function main() {
  const preview = process.argv.includes('--preview');
  for (const spec of ICONS) {
    const mask = renderGlyph(GLYPHS[spec.glyph]);
    const rgba = renderTile(spec.top, spec.bottom);
    composite(rgba, mask);
    const out = join(ROOT, spec.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, encodePng(rgba));
    console.log('✓', spec.out);
    if (preview) console.log(asciiPreview(rgba) + '\n');
  }
  console.log(`共生成 ${ICONS.length} 个图标`);
}

main();
