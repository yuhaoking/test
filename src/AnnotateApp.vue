<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Icon from './components/Icon.vue';
import { showToast } from './utils';
import type { AnnotatePayload, CaptureTool } from '../shared/types';

/**
 * 截图标注器（T-04）：
 * - 工具：箭头 / 矩形 / 文字 / 马赛克 / 画笔，颜色与线宽可调，撤销；
 * - 输出：复制 / 保存 / 贴图（钉到桌面）/ 关闭（验收：截图 → 标注 → 贴图/复制 ≤ 3 步）；
 * - mode=stitch：滚动长截图分段自动拼接（重叠区像素比对）后进入标注。
 */

const api = window.api;
const canvasEl = ref<HTMLCanvasElement | null>(null);
const tool = ref<CaptureTool>('arrow');
const color = ref('#ff4d4f');
const lineWidth = ref(3);
const ready = ref(false);
const textDraft = ref('');
const textPos = ref({ x: 0, y: 0, visible: false });
const undoStack = ref<ImageData[]>([]);

let drawing = false;
let startX = 0;
let startY = 0;
let snapshot: ImageData | null = null;
let lastX = 0;
let lastY = 0;

// ---------- 加载 / 拼接 ----------

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function loadPayload(p: AnnotatePayload): Promise<void> {
  const dataUrl = p.mode === 'stitch' && p.segments?.length ? await stitch(p.segments) : p.dataUrl ?? '';
  if (!dataUrl) return;
  const img = await loadImage(dataUrl);
  const canvas = canvasEl.value;
  if (!canvas) return;
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(img, 0, 0);
  undoStack.value = [];
  ready.value = true;
}

/** 长截图拼接：逐段寻找重叠区（采样像素比对），裁掉重叠后纵向合并 */
async function stitch(segments: string[]): Promise<string> {
  const imgs = await Promise.all(segments.map(loadImage));
  let result = imgToCanvas(imgs[0]);
  for (let i = 1; i < imgs.length; i++) {
    const next = imgToCanvas(imgs[i]);
    const overlap = findOverlap(result, next);
    const merged = document.createElement('canvas');
    merged.width = result.width;
    merged.height = result.height + next.height - overlap;
    const ctx = merged.getContext('2d')!;
    ctx.drawImage(result, 0, 0);
    ctx.drawImage(next, 0, overlap, next.width, next.height - overlap, 0, result.height, next.width, next.height - overlap);
    result = merged;
  }
  return result.toDataURL('image/png');
}

function imgToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}

function findOverlap(prev: HTMLCanvasElement, next: HTMLCanvasElement): number {
  const pctx = prev.getContext('2d')!;
  const nctx = next.getContext('2d')!;
  const maxD = Math.min(prev.height, next.height) - 8;
  const minD = 8;
  const colStep = Math.max(1, Math.floor(prev.width / 48));
  let best = 0;
  let bestDiff = Infinity;
  for (let d = minD; d <= maxD; d += 2) {
    const rows = Math.min(d, next.height, prev.height);
    const p = pctx.getImageData(0, prev.height - rows, prev.width, rows).data;
    const n = nctx.getImageData(0, 0, next.width, rows).data;
    let diff = 0;
    let count = 0;
    for (let y = 0; y < rows; y += 2) {
      for (let x = 0; x < prev.width; x += colStep) {
        const i = (y * prev.width + x) * 4;
        diff += Math.abs(p[i] - n[i]) + Math.abs(p[i + 1] - n[i + 1]) + Math.abs(p[i + 2] - n[i + 2]);
        count += 3;
      }
    }
    const avg = count ? diff / count : 255;
    if (avg < bestDiff) {
      bestDiff = avg;
      best = d;
    }
  }
  return bestDiff < 18 ? best : 0;
}

// ---------- 标注 ----------

function scale(): number {
  const canvas = canvasEl.value;
  if (!canvas) return 1;
  return canvas.width / (canvas.getBoundingClientRect().width || canvas.width);
}

function pointOf(e: MouseEvent): { x: number; y: number } {
  const rect = canvasEl.value!.getBoundingClientRect();
  const s = scale();
  return { x: Math.round((e.clientX - rect.left) * s), y: Math.round((e.clientY - rect.top) * s) };
}

/** UI-6 修复：撤销栈按内存预算裁剪——4K 截图单张 ImageData ≈33MB，
 *  旧逻辑固定 15 张最坏可常驻 500MB+。现在同时限制张数(15)与总字节(96MB)。 */
const UNDO_MAX_BYTES = 96 * 1024 * 1024;

function undoBytes(): number {
  return undoStack.value.reduce((n, d) => n + (d?.data?.byteLength ?? 0), 0);
}

function pushUndo(): void {
  const ctx = canvasEl.value?.getContext('2d');
  if (!ctx) return;
  undoStack.value.push(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height));
  while (undoStack.value.length > 15 || (undoStack.value.length > 1 && undoBytes() > UNDO_MAX_BYTES)) {
    undoStack.value.shift();
  }
}

function undo(): void {
  const ctx = canvasEl.value?.getContext('2d');
  const img = undoStack.value.pop();
  if (ctx && img) ctx.putImageData(img, 0, 0);
}

function onDown(e: MouseEvent): void {
  if (e.button !== 0 || !ready.value) return;
  const { x, y } = pointOf(e);
  if (tool.value === 'text') {
    textPos.value = { x: e.clientX, y: e.clientY, visible: true };
    textDraft.value = '';
    return;
  }
  drawing = true;
  startX = x;
  startY = y;
  lastX = x;
  lastY = y;
  const ctx = canvasEl.value!.getContext('2d')!;
  snapshot = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (tool.value === 'pen') {
    pushUndo();
    ctx.strokeStyle = color.value;
    ctx.lineWidth = lineWidth.value;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
}

function onMove(e: MouseEvent): void {
  if (!drawing) return;
  const ctx = canvasEl.value!.getContext('2d')!;
  const { x, y } = pointOf(e);
  if (tool.value === 'pen') {
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x;
    lastY = y;
    return;
  }
  if (snapshot) ctx.putImageData(snapshot, 0, 0);
  if (tool.value === 'arrow') {
    drawArrow(ctx, startX, startY, x, y, color.value, lineWidth.value);
  } else if (tool.value === 'rect') {
    ctx.strokeStyle = color.value;
    ctx.lineWidth = lineWidth.value;
    ctx.strokeRect(startX, startY, x - startX, y - startY);
  } else if (tool.value === 'mosaic') {
    previewMosaic(ctx, startX, startY, x, y);
  }
  lastX = x;
  lastY = y;
}

function onUp(): void {
  if (!drawing) return;
  drawing = false;
  const ctx = canvasEl.value!.getContext('2d')!;
  if (tool.value !== 'pen') {
    pushUndo();
    if (snapshot) ctx.putImageData(snapshot, 0, 0);
    if (tool.value === 'arrow') drawArrow(ctx, startX, startY, lastX, lastY, color.value, lineWidth.value);
    else if (tool.value === 'rect') {
      ctx.strokeStyle = color.value;
      ctx.lineWidth = lineWidth.value;
      ctx.strokeRect(startX, startY, lastX - startX, lastY - startY);
    } else if (tool.value === 'mosaic') pixelate(ctx, startX, startY, lastX, lastY);
  }
  snapshot = null;
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, c: string, w: number): void {
  const head = Math.max(10, w * 3.4);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - Math.cos(angle) * head * 0.55, y2 - Math.sin(angle) * head * 0.55);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function normRect(x1: number, y1: number, x2: number, y2: number): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function previewMosaic(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const r = normRect(x1, y1, x2, y2);
  ctx.fillStyle = 'rgba(120,120,120,0.35)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

function pixelate(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const r = normRect(x1, y1, x2, y2);
  if (r.w < 2 || r.h < 2) return;
  const block = Math.max(6, Math.round(r.w / 40));
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(r.w / block));
  tmp.height = Math.max(1, Math.round(r.h / block));
  const tctx = tmp.getContext('2d')!;
  tctx.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, tmp.width, tmp.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = true;
}

function commitText(): void {
  const text = textDraft.value.trim();
  textPos.value = { ...textPos.value, visible: false };
  if (!text || !canvasEl.value) return;
  const ctx = canvasEl.value.getContext('2d')!;
  const rect = canvasEl.value.getBoundingClientRect();
  const s = scale();
  const x = Math.round((textPos.value.x - rect.left) * s);
  const y = Math.round((textPos.value.y - rect.top) * s);
  pushUndo();
  ctx.fillStyle = color.value;
  ctx.font = `bold ${Math.max(14, Math.round(canvasEl.value.width * 0.028))}px "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

// ---------- 输出 ----------

function exportUrl(): string {
  return canvasEl.value!.toDataURL('image/png');
}

async function copy(): Promise<void> {
  await api.capture.copyImage(exportUrl());
  api.capture.selfClose();
}

async function save(): Promise<void> {
  const path = await api.capture.saveImage(exportUrl());
  if (path) {
    showToast(`已保存：${path}`);
    api.capture.selfClose();
  }
}

async function pin(): Promise<void> {
  await api.capture.pinImage(exportUrl());
  api.capture.selfClose();
}

function close(): void {
  api.capture.selfClose();
}

function onKey(e: KeyboardEvent): void {
  if (textPos.value.visible) return;
  if (e.key === 'Escape') close();
  if (e.ctrlKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
}

const TOOLS: Array<{ key: CaptureTool; label: string }> = [
  { key: 'arrow', label: '箭头' },
  { key: 'rect', label: '矩形' },
  { key: 'text', label: '文字' },
  { key: 'mosaic', label: '马赛克' },
  { key: 'pen', label: '画笔' }
];

onMounted(() => {
  api.capture.onAnnotatePayload((p) => void loadPayload(p));
  window.addEventListener('keydown', onKey);
});
</script>

<template>
  <div class="anno-root">
    <header class="bar drag">
      <span class="title"><Icon name="image" :size="15" /> 截图标注</span>
      <div class="tools">
        <button v-for="t in TOOLS" :key="t.key" class="btn small" :class="{ primary: tool === t.key }" @click="tool = t.key">
          {{ t.label }}
        </button>
        <input v-model="color" type="color" class="color" title="颜色" />
        <input v-model.number="lineWidth" type="range" min="1" max="12" class="width-range" title="线宽" />
        <button class="btn small" title="撤销 (Ctrl+Z)" @click="undo"><Icon name="refresh" :size="13" /> 撤销</button>
      </div>
      <span class="spacer"></span>
      <div class="actions">
        <button class="btn small" @click="void copy()"><Icon name="copy" :size="13" /> 复制</button>
        <button class="btn small" @click="void save()"><Icon name="save" :size="13" /> 保存</button>
        <button class="btn small primary" @click="void pin()"><Icon name="pin" :size="13" /> 贴图</button>
        <button class="icon-btn" @click="close"><Icon name="close" :size="14" /></button>
      </div>
    </header>
    <main class="stage">
      <canvas
        ref="canvasEl"
        class="canvas"
        :class="{ crosshair: tool !== 'text' }"
        @mousedown="onDown"
        @mousemove="onMove"
        @mouseup="onUp"
      ></canvas>
      <input
        v-if="textPos.visible"
        ref="textInput"
        v-model="textDraft"
        class="text-input"
        :style="{ left: textPos.x + 'px', top: textPos.y + 'px' }"
        placeholder="输入文字后回车"
        @keyup.enter="commitText"
        @blur="commitText"
      />
    </main>
  </div>
</template>

<style scoped>
.anno-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: rgba(18, 20, 27, 0.92);
  backdrop-filter: blur(18px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e8eaf0;
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  -webkit-app-region: drag;
}

.bar button,
.bar input {
  -webkit-app-region: no-drag;
}

.title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.tools {
  display: flex;
  align-items: center;
  gap: 6px;
}

.color {
  width: 30px;
  height: 26px;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.width-range {
  width: 80px;
  padding: 0;
  border: none;
  background: transparent;
}

.spacer {
  flex: 1;
}

.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  position: relative;
  overflow: auto;
  padding: 12px;
}

.canvas {
  max-width: 100%;
  max-height: 100%;
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.canvas.crosshair {
  cursor: crosshair;
}

.text-input {
  position: fixed;
  z-index: 20;
  min-width: 220px;
}
</style>
