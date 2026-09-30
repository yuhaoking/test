<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { formatBytes } from '../utils';
import type { Module, SystemInfoData } from '../../shared/types';

defineProps<{ module: Module }>();

const api = window.api;
const info = ref<SystemInfoData | null>(null);
let offPush: (() => void) | null = null;
let disposed = false;

function onInfo(data: SystemInfoData | null): void {
  if (data) info.value = data;
}

onMounted(async () => {
  onInfo(await api.system.getInfo());
  // UI-5 修复：await 期间组件可能已卸载，此时不得再订阅（否则订阅永久泄漏）
  if (disposed) return;
  offPush = api.system.onPush((data) => onInfo(data));
});

onBeforeUnmount(() => {
  disposed = true;
  offPush?.();
});
</script>

<template>
  <div class="si">
    <template v-if="info">
      <div class="metric">
        <div class="row">
          <span class="muted">CPU</span>
          <span class="spacer"></span>
          <span>{{ info.cpu.usage }}%</span>
        </div>
        <div class="bar"><div :style="{ width: info.cpu.usage + '%' }" class="fill cpu"></div></div>
        <div class="muted sub">
          {{ info.cpu.model }} · {{ info.cpu.cores }} 核
          <template v-if="info.temps.cpu != null"> · {{ info.temps.cpu }}℃</template>
        </div>
      </div>
      <div class="metric">
        <div class="row">
          <span class="muted">内存</span>
          <span class="spacer"></span>
          <span>{{ info.mem.usage }}%</span>
        </div>
        <div class="bar"><div :style="{ width: info.mem.usage + '%' }" class="fill mem"></div></div>
        <div class="muted sub">{{ formatBytes(info.mem.used) }} / {{ formatBytes(info.mem.total) }}</div>
      </div>
      <div class="metric">
        <div class="row">
          <span class="muted">磁盘</span>
          <span class="spacer"></span>
          <span>{{ info.disk.usage }}%</span>
        </div>
        <div class="bar"><div :style="{ width: info.disk.usage + '%' }" class="fill disk"></div></div>
        <div class="muted sub">{{ formatBytes(info.disk.used) }} / {{ formatBytes(info.disk.total) }}</div>
      </div>
      <div class="metric">
        <div class="row">
          <span class="muted">显卡</span>
          <span class="spacer"></span>
          <span>{{ info.gpu.usage != null ? info.gpu.usage + '%' : '—' }}</span>
        </div>
        <div v-if="info.gpu.usage != null" class="bar">
          <div :style="{ width: info.gpu.usage + '%' }" class="fill gpu"></div>
        </div>
        <div class="muted sub">
          {{ info.gpu.model || '未识别到显卡' }}
          <template v-if="info.temps.gpu != null"> · {{ info.temps.gpu }}℃</template>
        </div>
      </div>
      <div class="muted tip">主进程实时推送 · 每 2 秒刷新 · 温度数据受硬件支持限制</div>
    </template>
    <div v-else class="empty">正在获取系统信息…</div>
  </div>
</template>

<style scoped>
.si {
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-hover);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s;
}

.fill.cpu {
  background: #5b8cff;
}

.fill.mem {
  background: #3ecf8e;
}

.fill.disk {
  background: #f7b500;
}

.fill.gpu {
  background: #b06ef7;
}

.sub {
  font-size: 11px;
}

.tip {
  font-size: 11px;
}
</style>
