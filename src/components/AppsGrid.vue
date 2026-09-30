<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { showToast } from '../utils';
import type { DesktopBox } from '../../shared/types';

/**
 * 收纳盒内容类型 = apps 的渲染（需求 1：把快捷启动整合进盒）
 *
 * - 展示盒内全部应用（复用文件索引 items，点击即启动）；
 * - 提供「添加全部软件」按钮：一键扫描已安装软件（scanInstalledApps）填充本盒；
 * - 图标复用 `files.getIcons`（系统图标缓存），按需加载。
 * 沿用 DR-02：只记路径，不移动/复制原文件。
 */
const props = defineProps<{ box: DesktopBox }>();
const api = window.api;

const filter = ref('');
const filling = ref(false);
/** path → 系统图标 data URL */
const icons = ref<Record<string, string>>({});
const iconLoading = new Set<string>();

const items = computed(() => props.box.items ?? []);

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((i) => i.name.toLowerCase().includes(q));
});

/** 批量提取图标（复用系统图标缓存；无图标的用首字母兜底） */
async function ensureIcons(): Promise<void> {
  const targets = items.value.filter((i) => !icons.value[i.path] && !iconLoading.has(i.path));
  if (!targets.length) return;
  for (const t of targets) iconLoading.add(t.path);
  try {
    const map = await api.files.getIcons(targets.map((t) => t.path));
    for (const [path, cachePath] of Object.entries(map)) {
      if (icons.value[path]) continue;
      try {
        icons.value[path] = await api.asset.toUrl(cachePath);
      } catch {
        /* 图标读取失败跳过 */
      }
    }
  } finally {
    for (const t of targets) iconLoading.delete(t.path);
  }
}

/** 一键添加全部已安装软件 */
async function addAll(): Promise<void> {
  filling.value = true;
  try {
    const res = await api.boxes.addApps(props.box.id);
    showToast(res.added > 0 ? `已添加 ${res.added} 个软件` : '软件已在盒中');
  } catch {
    showToast('扫描失败');
  } finally {
    filling.value = false;
  }
}

function openApp(path: string): void {
  void api.boxes.openPath(path);
}

function removeApp(path: string): void {
  if (window.confirm('从盒子移除该应用？（不删除文件本体）')) {
    void api.boxes.removeItem(props.box.id, path);
  }
}

watch(items, () => void ensureIcons(), { deep: true });
onMounted(() => void ensureIcons());
onBeforeUnmount(() => {
  /* noop */
});
</script>

<template>
  <div class="apps-grid-root">
    <div class="apps-toolbar">
      <input v-model="filter" class="apps-filter" placeholder="筛选应用…" />
      <button
        class="head-btn add-all"
        :disabled="filling"
        :title="filling ? '扫描中…' : '扫描全部软件并加入本盒'"
        @click="addAll"
      >
        <Icon name="plus" :size="13" />{{ filling ? '扫描中…' : '添加全部软件' }}
      </button>
    </div>
    <div v-if="!visible.length" class="apps-empty">
      <span>点击「添加全部软件」自动扫描已安装应用</span>
    </div>
    <div v-else class="apps-grid">
      <div v-for="item in visible" :key="item.path" class="apps-tile" :title="item.path" @click="openApp(item.path)">
        <img v-if="icons[item.path]" :src="icons[item.path]" class="app-ico" alt="" />
        <span v-else class="app-ico dummy">{{ item.name.slice(0, 1).toUpperCase() }}</span>
        <span class="app-name">{{ item.name }}</span>
        <button class="app-del" title="移除" @click.stop="removeApp(item.path)">
          <Icon name="trash" :size="11" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.apps-grid-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.apps-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  flex-shrink: 0;
}

.apps-filter {
  flex: 1;
  min-width: 60px;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(0, 0, 0, 0.25);
  color: inherit;
  font-size: 12px;
}

.add-all {
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(91, 140, 255, 0.22);
  color: inherit;
  font-size: 11px;
  gap: 4px;
  white-space: nowrap;
}

.add-all:disabled {
  opacity: 0.6;
  cursor: default;
}

.apps-grid {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 10px;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
}

.apps-tile {
  position: relative;
  width: 78px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 4px;
  border-radius: 8px;
  cursor: pointer;
}

.apps-tile:hover {
  background: rgba(255, 255, 255, 0.08);
}

.app-ico {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  object-fit: contain;
}

.app-ico.dummy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  color: #e8eaf0;
  font-size: 14px;
  font-weight: 700;
}

.app-name {
  font-size: 11px;
  line-height: 1.3;
  max-width: 76px;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-align: center;
}

.app-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  cursor: pointer;
}

.apps-tile:hover .app-del {
  display: inline-flex;
}

.apps-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  opacity: 0.55;
  padding: 12px;
  text-align: center;
}
</style>
