import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function makeCanvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function blendPx(img, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  const sa = a / 255;
  const da = img.data[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  img.data[i] = Math.round((r * sa + img.data[i] * da * (1 - sa)) / oa);
  img.data[i + 1] = Math.round((g * sa + img.data[i + 1] * da * (1 - sa)) / oa);
  img.data[i + 2] = Math.round((b * sa + img.data[i + 2] * da * (1 - sa)) / oa);
  img.data[i + 3] = Math.round(oa * 255);
}

function fillCircle(img, cx, cy, r, color, alpha = 255) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r) blendPx(img, x, y, color[0], color[1], color[2], alpha);
    }
  }
}

function fillEllipse(img, cx, cy, rx, ry, color, alpha = 255) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (d <= 1) blendPx(img, x, y, color[0], color[1], color[2], alpha);
    }
  }
}

function fillRect(img, x0, y0, x1, y1, color, alpha = 255) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) blendPx(img, x, y, color[0], color[1], color[2], alpha);
  }
}

function fillTriangle(img, ax, ay, bx, by, cx, cy, color, alpha = 255) {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d1 = sign(x, y, ax, ay, bx, by);
      const d2 = sign(x, y, bx, by, cx, cy);
      const d3 = sign(x, y, cx, cy, ax, ay);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) blendPx(img, x, y, color[0], color[1], color[2], alpha);
    }
  }
}

const ORANGE = [245, 167, 74];
const DARK = [58, 42, 32];
const PINK = [255, 200, 190];
const CREAM = [255, 238, 214];
const WHITE = [255, 255, 255];

function drawPetFrame(bobY, eye, smile, paw) {
  const img = makeCanvas(128, 128);
  const bodyY = 84 + bobY;
  fillCircle(img, 88, 108, 16, ORANGE);
  fillCircle(img, 64, bodyY, 40, ORANGE);
  fillEllipse(img, 64, bodyY + 22, 20, 13, CREAM);
  fillTriangle(img, 36, 42 + bobY, 52, 10 + bobY, 60, 46 + bobY, ORANGE);
  fillTriangle(img, 92, 42 + bobY, 76, 10 + bobY, 68, 46 + bobY, ORANGE);
  fillTriangle(img, 41, 38 + bobY, 50, 20 + bobY, 55, 40 + bobY, PINK);
  fillTriangle(img, 87, 38 + bobY, 78, 20 + bobY, 73, 40 + bobY, PINK);
  if (eye === 'open') {
    fillCircle(img, 50, 72 + bobY, 5, DARK);
    fillCircle(img, 78, 72 + bobY, 5, DARK);
    fillCircle(img, 51.5, 70.5 + bobY, 1.8, WHITE);
    fillCircle(img, 79.5, 70.5 + bobY, 1.8, WHITE);
  } else if (eye === 'happy') {
    fillRect(img, 44, 70 + bobY, 58, 74 + bobY, DARK);
    fillRect(img, 70, 70 + bobY, 84, 74 + bobY, DARK);
  } else {
    fillRect(img, 45, 71 + bobY, 55, 73 + bobY, DARK);
    fillRect(img, 73, 71 + bobY, 83, 73 + bobY, DARK);
  }
  fillCircle(img, 64, 84 + bobY, 3, DARK);
  fillRect(img, 56, 88 + bobY, 72, 90 + bobY, DARK);
  if (smile) fillEllipse(img, 64, 91 + bobY, 6, 3, DARK, 200);
  fillRect(img, 20, 78 + bobY, 36, 79 + bobY, DARK, 150);
  fillRect(img, 92, 78 + bobY, 108, 79 + bobY, DARK, 150);
  if (paw) fillCircle(img, paw.x, paw.y, 11, ORANGE);
  return img;
}

function writePng(path, img) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePNG(img.w, img.h, img.data));
}

function icoFromPng(pngPath, outPath) {
  const png = readFileSync(pngPath);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.concat([header, entry, png]));
}

const resize = (img, size) => {
  const out = makeCanvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * img.w);
      const sy = Math.floor((y / size) * img.h);
      const si = (sy * img.w + sx) * 4;
      out.data.set(img.data.subarray(si, si + 4), (y * size + x) * 4);
    }
  }
  return out;
};

const frames = join(ROOT, 'resources', 'pet-frames');
const idle = [drawPetFrame(0, 'open', false, null), drawPetFrame(-3, 'open', false, null)];
idle.forEach((img, i) => writePng(join(frames, 'idle', i + 1 + '.png'), img));

const nod = [
  drawPetFrame(0, 'open', false, null),
  drawPetFrame(5, 'open', true, null),
  drawPetFrame(9, 'happy', true, null),
  drawPetFrame(5, 'open', true, null)
];
nod.forEach((img, i) => writePng(join(frames, 'nod', i + 1 + '.png'), img));
const wave0 = drawPetFrame(0, 'open', true, { x: 88, y: 46 });
const wave1 = drawPetFrame(0, 'open', true, { x: 96, y: 36 });
const wave2 = drawPetFrame(0, 'open', true, { x: 92, y: 27 });
const wave3 = drawPetFrame(0, 'open', true, { x: 96, y: 36 });
[wave0, wave1, wave2, wave3].forEach((img, i) => writePng(join(frames, 'wave', i + 1 + '.png'), img));
const blink = [
  drawPetFrame(0, 'open', false, null),
  drawPetFrame(0, 'shut', false, null),
  drawPetFrame(0, 'open', false, null)
];
blink.forEach((img, i) => writePng(join(frames, 'blink', i + 1 + '.png'), img));
const jump = [
  drawPetFrame(0, 'open', false, null),
  drawPetFrame(-12, 'open', true, null),
  drawPetFrame(-24, 'happy', true, null),
  drawPetFrame(-12, 'open', true, null),
  drawPetFrame(0, 'open', false, null)
];
jump.forEach((img, i) => writePng(join(frames, 'jump', i + 1 + '.png'), img));

writePng(join(ROOT, 'resources', 'default-pet.png'), idle[0]);

const icon = makeCanvas(64, 64);
fillCircle(icon, 32, 34, 24, ORANGE);
fillTriangle(icon, 16, 20, 26, 2, 31, 22, ORANGE);
fillTriangle(icon, 48, 20, 38, 2, 33, 22, ORANGE);
fillCircle(icon, 26, 30, 3.2, DARK);
fillCircle(icon, 38, 30, 3.2, DARK);
fillCircle(icon, 32, 38, 2, DARK);
writePng(join(ROOT, 'plugins', 'example-plugin', 'icon.png'), icon);
writePng(join(ROOT, 'plugins', 'example-pet-plugin', 'icon.png'), icon);

const bigIcon = resize(icon, 256);
writePng(join(ROOT, 'build', 'icon.png'), bigIcon);
icoFromPng(join(ROOT, 'build', 'icon.png'), join(ROOT, 'build', 'icon.ico'));

const OFFICE_PLUGINS = {
  'office-screenshot-full': [59, 110, 246],
  'office-screenshot-region': [59, 110, 246],
  'office-screenshot-delay': [59, 110, 246],
  'office-screenshot-window': [59, 110, 246],
  'office-screenrecord-full': [229, 72, 77],
  'office-screenrecord-region': [229, 72, 77],
  'office-screenrecord-gif': [229, 72, 77],
  'office-convert-all': [24, 158, 92],
  'office-translate-cnen': [139, 92, 246],
  'office-translate-any': [139, 92, 246],
  'office-translate-file': [139, 92, 246],
  'office-translate-pro': [139, 92, 246],
  'office-deepseek-monitor': [13, 60, 122]
};

function drawOfficeIcon(color, kind) {
  const img = makeCanvas(64, 64);
  fillCircle(img, 32, 32, 30, color);
  fillCircle(img, 32, 32, 29, color);
  if (kind === 'camera') {
    fillRect(img, 13, 20, 51, 44, WHITE);
    fillCircle(img, 32, 32, 8, color);
    fillRect(img, 24, 15, 32, 20, WHITE);
  } else if (kind === 'record') {
    fillCircle(img, 32, 29, 12, WHITE);
    fillCircle(img, 32, 45, 5, WHITE);
  } else if (kind === 'convert') {
    fillTriangle(img, 14, 34, 26, 24, 26, 44, WHITE);
    fillTriangle(img, 50, 30, 38, 40, 38, 20, WHITE);
  } else {
    fillRect(img, 14, 16, 36, 40, WHITE);
    fillRect(img, 22, 24, 50, 48, WHITE);
  }
  return img;
}

for (const [dir, color] of Object.entries(OFFICE_PLUGINS)) {
  const kind = dir.includes('screenshot')
    ? 'camera'
    : dir.includes('screenrecord')
      ? 'record'
      : dir.includes('convert')
        ? 'convert'
        : 'translate';
  writePng(join(ROOT, 'plugins', dir, 'icon.png'), drawOfficeIcon(color, kind));
}

console.log(
  'assets generated: default-pet.png, pet-frames (idle/nod/wave/blink/jump), plugin icons, office plugin icons, build/icon.ico'
);
