<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { CaptureSurface } from '../shared/types';

/**
 * 全屏遮罩（T-04 / CH-06）：
 * - region / long：拖选区域（多显示器虚拟桌面坐标），提交给主进程裁剪；
 * - color：屏幕取色器——放大镜取色，点击复制 HEX/RGB。
 */

const api = window.api;
const mode = (new URLSearchParams(location.search).get('mode') ?? 'region') as 'region' | 'long' | 'color';

const containerEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const loupeEl = ref<HTMLCanvasElement | null>(null);

let surfaces: CaptureSurface[] = [];
let originX = 0;
let originY = 0;
let painting = false;
let startX = 0;
let startY = 0;

const sel = ref({ x: 0, y: 0, w: 0, h: 0, active: false });
const loupe = ref({ visible: false, x: 0, y: 0, hex: '#000000', rgb: 'rgb(0, 0, 0)' });

function surfaceAt(x: number, y: number): CaptureSurface | null {
  return (
    surfaces.find(
      (s) => x >= s.bounds.x && y >= s.bounds.y && x < s.bounds.x + s.bounds.width && y < s.bounds.y + s.bounds.height
    ) ?? surfaces[0] ?? null
  );
}

async function drawSurfaces(list: CaptureSurface[]): Promise<void> {
  surfaces = list;
  originX = Math.min(...list.map((s) => s.bounds.x));
  originY = Math.min(...list.map((s) => s.bounds.y));
  const canvas = canvasEl.value;
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const s of list) {
    const img = await loadImage(s.dataUrl);
    ctx.drawImage(img, s.bounds.x - originX, s.bounds.y - originY, s.bounds.width, s.bounds.height);
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function onDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  if (mode === 'color') {
    void pickColor();
    return;
  }
  painting = true;
  startX = e.clientX;
  startY = e.clientY;
  sel.value = { x: startX, y: startY, w: 0, h: 0, active: true };
}

function onMove(e: MouseEvent): void {
  if (mode === 'color') {
    updateLoupe(e.clientX, e.clientY);
    return;
  }
  if (!painting) return;
  sel.value = {
    x: Math.min(startX, e.clientX),
    y: Math.min(startY, e.clientY),
    w: Math.abs(e.clientX - startX),
    h: Math.abs(e.clientY - startY),
    active: true
  };
}

function onUp(): void {
  if (mode === 'color' || !painting) return;
  painting = false;
  const { x, y, w, h } = sel.value;
  if (w < 4 || h < 4) {
    sel.value = { ...sel.value, active: false };
    return;
  }
  // 选区归属显示器 = 拖拽起点所在显示器（避免跨屏 DPI 换算歧义）
  const startSurface = surfaceAt(startX + originX, startY + originY);
  if (!startSurface) return;
  const b = startSurface.bounds;
  const vx = Math.max(b.x, x + originX);
  const vy = Math.max(b.y, y + originY);
  const vw = Math.min(x + originX + w, b.x + b.width) - vx;
  const vh = Math.min(y + originY + h, b.y + b.height) - vy;
  void api.capture.pickRegion({ displayId: startSurface.displayId, x: vx, y: vy, width: vw, height: vh });
}

function updateLoupe(cx: number, cy: number): void {
  const canvas = canvasEl.value;
  const loupeCanvas = loupeEl.value;
  if (!canvas || !loupeCanvas) return;
  const ctx = canvas.getContext('2d');
  const lctx = loupeCanvas.getContext('2d');
  if (!ctx || !lctx) return;
  const px = Math.round(cx);
  const py = Math.round(cy);
  const cell = 12;
  lctx.imageSmoothingEnabled = false;
  lctx.clearRect(0, 0, loupeCanvas.width, loupeCanvas.height);
  try {
    lctx.drawImage(canvas, px - cell / 2, py - cell / 2, cell, cell, 0, 0, loupeCanvas.width, loupeCanvas.height);
  } catch {
    /* 忽略越界 */
  }
  // 中心像素色值
  try {
    const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
    loupe.value = {
      visible: true,
      x: cx + 24,
      y: cy + 24,
      hex,
      rgb: `rgb(${r}, ${g}, ${b})`
    };
  } catch {
    /* 忽略取色失败 */
  }
}

async function pickColor(): Promise<void> {
  const { hex, rgb } = loupe.value;
  await api.clipboard.setText(`${hex}  ${rgb}`);
  api.capture.cancel();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    api.capture.cancel();
  }
}

onMounted(() => {
  api.capture.onSurfaces((list) => void drawSurfaces(list));
  window.addEventListener('keydown', onKey);
  containerEl.value?.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
});
</script>

<template>
  <div ref="containerEl" class="overlay" :class="mode" @contextmenu.prevent="api.capture.cancel()">
    <canvas ref="canvasEl" class="shot"></canvas>

    <!-- 选区遮罩（四块暗色蒙版 + 高亮框） -->
    <template v-if="mode !== 'color' && sel.active">
      <div class="dim" :style="{ left: '0px', top: '0px', width: '100%', height: sel.y + 'px' }"></div>
      <div
        class="dim"
        :style="{ left: '0px', top: sel.y + sel.h + 'px', width: '100%', bottom: '0px' }"
      ></div>
      <div class="dim" :style="{ left: '0px', top: sel.y + 'px', width: sel.x + 'px', height: sel.h + 'px' }"></div>
      <div
        class="dim"
        :style="{ left: sel.x + sel.w + 'px', top: sel.y + 'px', right: '0px', height: sel.h + 'px' }"
      ></div>
      <div class="sel-box" :style="{ left: sel.x + 'px', top: sel.y + 'px', width: sel.w + 'px', height: sel.h + 'px' }">
        <span class="sel-size">{{ Math.round(sel.w) }} × {{ Math.round(sel.h) }}</span>
      </div>
    </template>

    <div v-if="mode !== 'color'" class="hint">
      {{ mode === 'long' ? '拖选长截图区域（滚动捕获）' : '拖动选择截图区域' }} · Esc 取消 · 右键取消
    </div>

    <!-- 取色器放大镜 -->
    <div
      v-if="mode === 'color' && loupe.visible"
      class="loupe"
      :style="{ left: loupe.x + 'px', top: loupe.y + 'px' }"
    >
      <canvas ref="loupeEl" width="96" height="96"></canvas>
      <div class="loupe-meta">
        <span class="swatch" :style="{ background: loupe.hex }"></span>
        <span class="hex">{{ loupe.hex }}</span>
        <span class="rgb">{{ loupe.rgb }}</span>
      </div>
    </div>
    <div v-if="mode === 'color'" class="hint">移动取色 · 点击复制 HEX/RGB · Esc 取消</div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  cursor: crosshair;
  overflow: hidden;
  user-select: none;
}

.overlay.color {
  cursor: copy;
}

.shot {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.dim {
  position: absolute;
  background: rgba(0, 0, 0, 0.45);
}

.sel-box {
  position: absolute;
  border: 1.5px solid #5b8cff;
  box-shadow: 0 0 0 1px rgba(91, 140, 255, 0.35);
}

.sel-size {
  position: absolute;
  right: 0;
  bottom: -24px;
  background: rgba(18, 20, 27, 0.9);
  color: #e8eaf0;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  white-space: nowrap;
}

.hint {
  position: fixed;
  left: 50%;
  bottom: 36px;
  transform: translateX(-50%);
  background: rgba(18, 20, 27, 0.85);
  color: #e8eaf0;
  font-size: 12px;
  padding: 6px 16px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.loupe {
  position: fixed;
  background: rgba(18, 20, 27, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 10px;
  padding: 8px;
  pointer-events: none;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.loupe canvas {
  display: block;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  image-rendering: pixelated;
}

.loupe-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  color: #e8eaf0;
  font-size: 11px;
}

.swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.3);
}

.hex {
  font-family: Consolas, monospace;
  font-weight: 600;
}

.rgb {
  opacity: 0.7;
  font-family: Consolas, monospace;
}
</style>
