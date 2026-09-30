<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Icon from './components/Icon.vue';

/**
 * 贴图窗口（T-04）：截图钉到桌面置顶。
 * 可缩放（按钮）、透明度调节、复制、关闭；窗口可拖动（app-region）。
 */

const api = window.api;
const imgSrc = ref('');
const opacity = ref(1);
const hover = ref(false);

async function op(o: 'close' | 'copy' | 'zoomIn' | 'zoomOut' | 'reset'): Promise<void> {
  await api.capture.pinOp(o);
}

async function onOpacity(): Promise<void> {
  await api.capture.pinOp('opacity', opacity.value);
}

onMounted(() => {
  api.capture.onPinPayload((p) => {
    imgSrc.value = p.dataUrl;
  });
});
</script>

<template>
  <div class="pin-root" @mouseenter="hover = true" @mouseleave="hover = false">
    <div class="drag-area">
      <img :src="imgSrc" class="pin-img" draggable="false" />
    </div>
    <transition name="fade">
      <div v-if="hover" class="toolbar">
        <button class="icon-btn" title="缩小" @click="void op('zoomOut')"><Icon name="down" :size="13" /></button>
        <button class="icon-btn" title="放大" @click="void op('zoomIn')"><Icon name="up" :size="13" /></button>
        <input
          v-model.number="opacity"
          type="range"
          min="0.15"
          max="1"
          step="0.05"
          class="opacity"
          title="透明度"
          @change="void onOpacity()"
        />
        <button class="icon-btn" title="复制" @click="void op('copy')"><Icon name="copy" :size="13" /></button>
        <button class="icon-btn" title="关闭" @click="void op('close')"><Icon name="close" :size="13" /></button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.pin-root {
  height: 100%;
  position: relative;
}

.drag-area {
  -webkit-app-region: drag;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.4);
}

.pin-img {
  max-width: 100%;
  max-height: 100%;
  user-select: none;
  border-radius: 6px;
}

.toolbar {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: rgba(18, 20, 27, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  padding: 3px 6px;
  -webkit-app-region: no-drag;
}

.toolbar .icon-btn {
  color: #e8eaf0;
}

.opacity {
  width: 74px;
  padding: 0;
  border: none;
  background: transparent;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
