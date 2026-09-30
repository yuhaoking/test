<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { PreviewData } from '../shared/types';

/**
 * 内置文件预览（T-08：QuickLook 未检测到时的兜底）
 * 图片 / 文本（只读，截断 512KB）/ 音视频 / 元信息卡；Esc / 空格关闭。
 */
const api = window.api;
const path = new URLSearchParams(window.location.search).get('path') ?? '';
const data = ref<PreviewData | null>(null);
const error = ref('');

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function close(): void {
  window.close();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.key === ' ') close();
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  try {
    data.value = await api.boxes.previewData(path);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="pv">
    <header class="pv-head" @dblclick="close">
      <span class="pv-title">{{ data?.name ?? path.split(/[\\/]/).pop() ?? '预览' }}</span>
      <span class="pv-meta" v-if="data">{{ fmtSize(data.size) }} · {{ new Date(data.mtime).toLocaleString() }}</span>
      <span class="spacer"></span>
      <button class="icon-btn" title="打开原文件" @click="void api.boxes.openPath(path)">↗</button>
      <button class="icon-btn" title="关闭（Esc / 空格）" @click="close">✕</button>
    </header>

    <main class="pv-body">
      <div v-if="error" class="pv-error">{{ error }}</div>
      <img v-else-if="data?.kind === 'image' && data.dataUrl" :src="data.dataUrl" class="pv-img" />
      <pre v-else-if="data?.kind === 'text'" class="pv-text">{{ data.text }}</pre>
      <video v-else-if="data?.kind === 'video'" :src="'file:///' + path.replace(/\\/g, '/')" controls autoplay muted class="pv-media"></video>
      <audio v-else-if="data?.kind === 'audio'" :src="'file:///' + path.replace(/\\/g, '/')" controls autoplay class="pv-audio"></audio>
      <div v-else class="pv-other">
        <div class="pv-big">📄</div>
        <div>{{ data?.name ?? '未知文件' }}</div>
        <div class="pv-meta">{{ data?.mime }} · {{ data ? fmtSize(data.size) : '' }}</div>
        <p class="pv-meta">此类型暂无内置预览，点右上角 ↗ 用系统程序打开</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: rgba(18, 20, 27, 0.92);
  backdrop-filter: blur(18px);
  color: #e8eaf0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  overflow: hidden;
}

.pv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  -webkit-app-region: drag;
  flex-shrink: 0;
}

.pv-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
}

.pv-meta {
  font-size: 10px;
  opacity: 0.6;
}

.pv-head .icon-btn {
  -webkit-app-region: no-drag;
  cursor: pointer;
  background: transparent;
  border: none;
  color: inherit;
  opacity: 0.7;
}

.pv-head .icon-btn:hover {
  opacity: 1;
}

.pv-body {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
}

.pv-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
}

.pv-text {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 8px;
}

.pv-media {
  max-width: 100%;
  max-height: 100%;
}

.pv-audio {
  width: 80%;
}

.pv-other {
  text-align: center;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.pv-big {
  font-size: 42px;
}

.pv-error {
  color: #e5484d;
  font-size: 12px;
}

.spacer {
  flex: 1;
}
</style>
