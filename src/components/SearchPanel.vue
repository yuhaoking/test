<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { plain } from '../utils';
import type { PaletteResult } from '../../shared/types';

/**
 * 收纳盒内容类型 = search 的渲染（需求 1：盒子 = 常驻桌面的统一搜索入口）
 *
 * 复用主进程 paletteSearch.search/execute：应用 / 文件 / 网站 / 插件命令 / 待办 统搜。
 * 与命令面板共用一套内核，只是把弹窗换成盒子内的内嵌面板。
 */
defineProps<{ box: unknown }>();
const api = window.api;

const query = ref('');
const results = ref<PaletteResult[]>([]);
const searching = ref(false);
const selectedIndex = ref(0);
let seq = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;

async function run(q: string): Promise<void> {
  const trimmed = q.trim();
  if (!trimmed) {
    results.value = [];
    selectedIndex.value = 0;
    return;
  }
  const s = ++seq;
  searching.value = true;
  try {
    const list = await api.palette.search(trimmed);
    if (s !== seq) return;
    results.value = list;
    selectedIndex.value = 0;
  } catch {
    /* 搜索异常静默 */
  } finally {
    if (s === seq) searching.value = false;
  }
}

function onInput(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void run(query.value), 220);
}

async function execute(result: PaletteResult): Promise<void> {
  try {
    await api.palette.execute(plain(result));
  } catch {
    /* ignore */
  }
}

function onKey(e: KeyboardEvent): void {
  if (!results.value.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex.value = (selectedIndex.value - 1 + results.value.length) % results.value.length;
  } else if (e.key === 'Enter') {
    const cur = results.value[selectedIndex.value];
    if (cur) void execute(cur);
  } else if (e.key === 'Escape') {
    query.value = '';
    results.value = [];
  }
}

const hasResults = computed(() => results.value.length > 0);

function categoryLabel(c: string): string {
  const map: Record<string, string> = {
    app: '应用',
    file: '文件',
    website: '网站',
    function: '功能',
    plugin: '插件',
    todo: '待办'
  };
  return map[c] ?? c;
}

onMounted(() => {
  /* 焦点可选：盒内搜索面板不强制聚焦，避免抢桌面焦点 */
  void run('');
});
onBeforeUnmount(() => {
  if (debounce) clearTimeout(debounce);
});
</script>

<template>
  <div class="search-root">
    <div class="search-bar">
      <Icon name="search" :size="15" />
      <input
        v-model="query"
        class="search-input"
        placeholder="搜索应用、文件、网站、插件、待办…"
        @input="onInput"
        @keydown="onKey"
      />
      <span v-if="searching" class="searching">…</span>
    </div>

    <div v-if="!query.trim()" class="search-hint">
      <span>输入关键词，统一搜索电脑内容</span>
    </div>
    <div v-else-if="!hasResults" class="search-hint">没有匹配结果</div>
    <div v-else class="search-list">
      <div
        v-for="(r, i) in results"
        :key="r.id"
        class="search-item"
        :class="{ active: i === selectedIndex }"
        @click="execute(r)"
        @mouseenter="selectedIndex = i"
      >
        <span class="cat-badge">{{ categoryLabel(r.category) }}</span>
        <img v-if="r.icon" :src="r.icon" class="cat-ico" alt="" />
        <span v-else class="cat-ico dummy">{{ r.label.slice(0, 1).toUpperCase() }}</span>
        <div class="search-meta">
          <div class="search-label">{{ r.label }}</div>
          <div v-if="r.sublabel" class="search-sublabel">{{ r.sublabel }}</div>
        </div>
        <span class="enter-tip">⏎</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(0, 0, 0, 0.25);
  color: inherit;
  font-size: 12px;
}

.searching {
  font-size: 12px;
  opacity: 0.6;
}

.search-hint {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  opacity: 0.5;
  padding: 12px;
  text-align: center;
}

.search-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.search-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.search-item.active {
  background: rgba(255, 255, 255, 0.1);
}

.cat-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(91, 140, 255, 0.25);
  color: #9db9ff;
  flex-shrink: 0;
}

.cat-ico {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  object-fit: contain;
  flex-shrink: 0;
}

.cat-ico.dummy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  color: #e8eaf0;
  font-size: 11px;
}

.search-meta {
  flex: 1;
  min-width: 0;
}

.search-label {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-sublabel {
  font-size: 11px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enter-tip {
  font-size: 10px;
  opacity: 0.4;
}
</style>
