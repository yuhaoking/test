<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { usePetStore } from './stores/pet';

const pet = usePetStore();
const img = ref<HTMLImageElement | null>(null);
/** 幽灵窗口防线：形象加载失败时置位，用兜底占位保证窗口永远有可见内容 */
const broken = ref(false);

const imgSrc = computed(() => pet.current || pet.urls[pet.frames?.image ?? ''] || '');

/**
 * 图片加载失败兜底（幽灵窗口根因防护）：
 * 若宠物形象路径非法/文件丢失，`<img>` 会渲染成空 → 透明置顶窗"看不见却挡住点击"。
 * 这里重新拉取帧集（主进程会自愈脏配置并回退默认形象），仍然失败则显示占位图形。
 */
async function onImgError(): Promise<void> {
  broken.value = true;
  await pet.loadFrames();
  if (pet.urls[pet.frames?.image ?? '']) broken.value = false;
  await resizeToImage();
}

function onImgLoad(): void {
  broken.value = false;
  void resizeToImage();
}

let down = false;
let moved = false;
let dragging = false;
let startX = 0;
let startY = 0;
let lastMove = 0;
let lastClick = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * T-06：气泡样式来自主题包（空值 = 跟随应用主题变量）。
 * 只接受主进程校验过的 #hex 值——主题包是 UGC，绝不能把任意字符串当 CSS 值用。
 */
const bubbleStyle = computed(() => {
  const b = pet.frames?.bubble;
  if (!b) return {} as Record<string, string>;
  const style: Record<string, string> = {};
  if (b.bg) style.background = b.bg;
  if (b.color) style.color = b.color;
  if (b.fontSize) style.fontSize = `${b.fontSize}px`;
  if (typeof b.radius === 'number') style.borderRadius = `${b.radius}px`;
  return style;
});

async function resizeToImage(): Promise<void> {
  await nextTick();
  const el = img.value;
  if (el && el.naturalWidth) {
    // T-06：主题包可声明显示缩放（同一张图在不同 DPI/桌面尺寸下的观感差异）
    const scale = Number(pet.frames?.scale);
    const k = Number.isFinite(scale) && scale > 0 ? Math.min(4, Math.max(0.25, scale)) : 1;
    window.api.pet.resize(Math.round(el.naturalWidth * k), Math.round(el.naturalHeight * k));
  }
}

function onDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  down = true;
  moved = false;
  dragging = false;
  startX = e.screenX;
  startY = e.screenY;
}

function onMove(e: MouseEvent): void {
  if (!down) return;
  if (!moved && Math.hypot(e.screenX - startX, e.screenY - startY) > 5) {
    moved = true;
    dragging = true;
    window.api.pet.dragStart();
    return;
  }
  if (dragging && Date.now() - lastMove > 12) {
    lastMove = Date.now();
    window.api.pet.dragMove();
  }
}

function onUp(): void {
  if (!down) return;
  down = false;
  if (dragging) {
    dragging = false;
    window.api.pet.dragEnd();
    return;
  }
  const now = Date.now();
  if (now - lastClick < 200) {
    lastClick = 0;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    window.api.pet.doubleClicked();
  } else {
    lastClick = now;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      lastClick = 0;
      window.api.pet.clicked();
    }, 200);
  }
}

onMounted(async () => {
  await pet.loadFrames();
  await resizeToImage();
  window.api.pet.onAction((frames) => void pet.play(frames));
  window.api.pet.onNotify((text) => pet.notify(text));
  window.api.onStore(() => {
    void pet.loadFrames().then(resizeToImage);
  });
  document.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.api.pet.contextMenu();
  });
});
</script>

<template>
  <div class="pet-root">
    <div v-if="pet.bubble" class="bubble" :style="bubbleStyle">{{ pet.bubble }}</div>
    <img
      v-if="imgSrc && !broken"
      ref="img"
      class="pet-img"
      :src="imgSrc"
      @load="onImgLoad"
      @error="onImgError"
      draggable="false"
      alt="pet"
    />
    <!-- 兜底占位：即使形象文件全丢失，窗口也保持可见，绝不留下"看不见却吃点击"的空白窗 -->
    <div v-else class="pet-fallback" title="宠物形象加载失败，已回退默认形象；可从托盘菜单“修复卡住的窗口”">
      <span class="pet-fallback-emoji">🐾</span>
    </div>
  </div>
</template>

<style scoped>
.pet-root {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  cursor: grab;
}

.pet-img {
  max-width: none;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

/* 形象加载失败时的兜底占位：保证宠物窗始终有可见内容（防"隐形却吃点击"的幽灵窗） */
.pet-fallback {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, rgba(91, 140, 255, 0.95), rgba(40, 60, 120, 0.9));
  border: 2px solid rgba(255, 255, 255, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.pet-fallback-emoji {
  font-size: 44px;
  line-height: 1;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
}

.bubble {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-solid);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  white-space: nowrap;
  box-shadow: var(--shadow);
  z-index: 10;
  font-family: var(--font);
}
</style>
