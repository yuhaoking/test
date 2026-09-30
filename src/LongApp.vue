<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Icon from './components/Icon.vue';
import { plain, showToast } from './utils';
import type { CaptureRect } from '../shared/types';

/**
 * 滚动长截图控制条（T-04）
 *
 * - 手动捕获：滚动一屏后点击“捕获下一屏”；
 * - 自动滚动捕获：向目标窗口发送 PgDn 并自动捕获，画面不再变化自动停止（≤40 段）；
 * - 完成拼接：进入标注器自动拼接（重叠区比对）；控制条不抢焦点（滚轮/按键仍达目标窗口）。
 */

const api = window.api;
const rect = ref<CaptureRect | null>(null);
const segments = ref<string[]>([]);
const running = ref(false);
const busy = ref(false);

const MAX_SEGMENTS = 40;

async function capture(autoScroll: boolean): Promise<void> {
  if (busy.value || segments.value.length >= MAX_SEGMENTS) return;
  busy.value = true;
  try {
    const seg = await api.capture.longStep(autoScroll);
    if (seg) segments.value = [...segments.value, seg];
    else if (autoScroll) {
      showToast('已到页面底部（画面不再变化）');
    }
  } finally {
    busy.value = false;
  }
}

async function autoRun(): Promise<void> {
  if (running.value) {
    running.value = false;
    api.capture.longStop();
    return;
  }
  running.value = true;
  while (running.value && segments.value.length < MAX_SEGMENTS) {
    const before = segments.value.length;
    await capture(true);
    if (segments.value.length === before) break;
  }
  running.value = false;
}

async function finish(): Promise<void> {
  if (!segments.value.length) {
    showToast('尚未捕获任何分段');
    return;
  }
  await api.capture.longFinish(plain(segments.value));
}

function cancel(): void {
  running.value = false;
  api.capture.longStop();
  api.capture.cancel();
}

onMounted(() => {
  api.capture.onLongPayload((p) => {
    rect.value = p.rect;
    // 先捕获当前一屏作为首段
    void capture(false);
  });
});
</script>

<template>
  <div class="long-root">
    <header class="head drag">
      <Icon name="image" :size="14" />
      <span>滚动长截图</span>
      <span class="spacer"></span>
      <button class="icon-btn" title="取消" @click="cancel"><Icon name="close" :size="13" /></button>
    </header>
    <div class="body">
      <div class="muted info">
        <template v-if="rect">区域 {{ Math.round(rect.width) }} × {{ Math.round(rect.height) }}</template>
        · 已捕获 {{ segments.length }} 段
      </div>
      <div class="thumbs">
        <img v-for="(s, i) in segments" :key="i" :src="s" class="seg" :title="`第 ${i + 1} 段`" />
        <div v-if="!segments.length" class="empty">点击下方按钮开始捕获</div>
      </div>
      <div class="btns">
        <button class="btn small" :disabled="busy" @click="void capture(false)">捕获下一屏（手动滚动）</button>
        <button class="btn small" :class="{ danger: running }" :disabled="busy" @click="void autoRun()">
          {{ running ? '停止自动滚动' : '自动滚动捕获' }}
        </button>
        <button class="btn small primary" @click="void finish()">完成拼接</button>
      </div>
      <div class="muted tip">提示：控制条不会抢焦点，滚轮 / PgUp·PgDn 仍作用于目标窗口</div>
    </div>
  </div>
</template>

<style scoped>
.long-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: rgba(18, 20, 27, 0.9);
  backdrop-filter: blur(18px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e8eaf0;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  -webkit-app-region: drag;
}

.head button {
  -webkit-app-region: no-drag;
}

.spacer {
  flex: 1;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

.muted {
  color: rgba(232, 234, 240, 0.55);
  font-size: 11px;
}

.thumbs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 6px;
}

.seg {
  width: 100%;
  border-radius: 4px;
  display: block;
}

.empty {
  padding: 20px 8px;
  text-align: center;
  font-size: 11px;
  opacity: 0.5;
}

.btns {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.btns .btn {
  width: 100%;
  -webkit-app-region: no-drag;
}

.tip {
  line-height: 1.5;
}
</style>
