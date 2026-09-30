<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import { t } from './i18n';
import { plain } from './utils';
import type { PaletteCategory, PaletteResult } from '../shared/types';

/**
 * 全局命令面板（规格 CP-01 ~ CP-06）
 *
 * - 输入防抖 150ms（SY-06），结果按类别分组实时展示；
 * - Enter 打开 / Ctrl+Enter 在文件夹中打开 / Ctrl+1~9 快速选择 / ↑↓ 选择 / Esc 隐藏；
 * - 窗口失焦自动隐藏由主进程处理。
 */

const api = window.api;
const query = ref('');
const results = ref<PaletteResult[]>([]);
const index = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

const CATEGORY_LABEL: Record<PaletteCategory, string> = {
  instant: '即时结果',
  suggest: '推荐动作 · 当前剪贴板',
  app: '应用',
  file: '文件',
  website: '网站',
  function: '内部功能',
  plugin: '插件命令',
  todo: '待办',
  clipboard: '剪贴板',
  snippet: '片段'
};
// T-14：即时结果 / 推荐动作置顶（DEV-12 / CP-07）
const CATEGORY_ORDER: PaletteCategory[] = [
  'instant',
  'suggest',
  'app',
  'file',
  'website',
  'function',
  'plugin',
  'todo',
  'clipboard',
  'snippet'
];

const groups = computed(() => {
  const map = new Map<PaletteCategory, PaletteResult[]>();
  for (const r of results.value) {
    const list = map.get(r.category) ?? [];
    list.push(r);
    map.set(r.category, list);
  }
  return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({
    key: c,
    label: CATEGORY_LABEL[c],
    items: map.get(c)!
  }));
});

/** UI-12 修复：键盘/高亮顺序 = 显示顺序（按分组展开）——
 *  此前 UI 按分类分组渲染、index/↑↓/Ctrl+数字却走扁平 results，导致高亮跳动、Ctrl+N 选错行 */
const ordered = computed<PaletteResult[]>(() => groups.value.flatMap((g) => g.items));

async function doSearch(): Promise<void> {
  const s = ++seq;
  const list = await api.palette.search(query.value);
  if (s !== seq) return;
  results.value = list;
  index.value = 0;
}

function onInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void doSearch(), 150);
}

function move(delta: number): void {
  const n = ordered.value.length;
  if (!n) return;
  index.value = (index.value + delta + n) % n;
}

function run(result: PaletteResult | null, openFolder = false): void {
  if (result) void api.palette.execute(plain(result), openFolder);
}

function onKey(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      move(-1);
      break;
    case 'Enter':
      e.preventDefault();
      run(ordered.value[index.value] ?? null, e.ctrlKey);
      break;
    case 'Escape':
      e.preventDefault();
      api.palette.hide();
      break;
    default:
      // Ctrl+数字 快速选择前几个结果（CP-05）
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const i = parseInt(e.key, 10) - 1;
        if (i < ordered.value.length) {
          e.preventDefault();
          run(ordered.value[i]);
        }
      }
  }
}

// 选中项滚动到可视区域
watch(index, () => {
  void nextTick(() => {
    const root = listEl.value;
    const el = root?.querySelector<HTMLElement>(`[data-idx="${index.value}"]`);
    if (root && el) {
      const cRect = root.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      if (eRect.top < cRect.top || eRect.bottom > cRect.bottom) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  });
});

let offResults: (() => void) | null = null;

onMounted(() => {
  /*
   * T-07：Windows 索引的增强结果会异步推回来（首屏先用内置遍历，索引结果到了再补）。
   * 只有「推送的查询仍是当前输入」时才替换，避免打字过程中被旧结果覆盖。
   */
  offResults = api.palette.onResults((e) => {
    if (!e || e.query.trim().toLowerCase() !== query.value.trim().toLowerCase()) return;
    if (!Array.isArray(e.list) || !e.list.length) return;
    results.value = e.list;
  });
  api.palette.onShown(() => {
    query.value = '';
    results.value = [];
    index.value = 0;
    void nextTick(() => inputEl.value?.focus());
    // T-14（CP-07）：面板打开即拉取剪贴板推荐动作（空查询时展示在顶部）
    void doSearch();
  });
  /*
   * P2-2 兜底：若本页在 palette:shown 之后才挂载（首次呼出 = 窗口冷启动），事件会丢，
   * 表现为"空白面板 + 输入框无焦点、必须点一下才能打字"。这里挂载即聚焦并拉一次首屏。
   */
  void nextTick(() => {
    inputEl.value?.focus();
    if (!results.value.length) void doSearch();
  });
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  offResults?.();
});
</script>

<template>
  <div class="palette-root">
    <div class="palette-input-row">
      <Icon name="search" :size="16" />
      <input
        ref="inputEl"
        v-model="query"
        class="palette-input"
        :placeholder="t('palette.placeholder')"
        @input="onInput"
        @keydown="onKey"
      />
      <span class="kbd-hint">Esc 关闭</span>
    </div>

    <main ref="listEl" class="palette-body">
      <template v-if="groups.length">
        <div v-for="g in groups" :key="g.key" class="palette-group">
          <div class="group-label">{{ g.label }}</div>
          <div
            v-for="r in g.items"
            :key="r.id"
            :data-idx="ordered.indexOf(r)"
            class="result-row"
            :class="{ active: ordered.indexOf(r) === index }"
            @click="run(r)"
            @mousemove="index = ordered.indexOf(r)"
          >
            <span class="cat-dot" :class="r.category"></span>
            <span class="result-label">{{ r.label }}</span>
            <span v-if="r.sublabel" class="result-sub muted">{{ r.sublabel }}</span>
          </div>
        </div>
      </template>
      <div v-else class="empty">
        <template v-if="query.trim()">没有匹配结果</template>
        <template v-else>输入关键词开始搜索 · 支持拼音 / 首字母<br />（剪贴板可识别时会在顶部推荐对应动作）</template>
      </div>
    </main>

    <footer class="palette-footer">
      <span><b>↑↓</b> 选择</span>
      <span><b>Enter</b> 打开</span>
      <span><b>Ctrl+Enter</b> 文件夹中打开</span>
      <span><b>Ctrl+1~9</b> 快速选择</span>
      <span><b>devtools</b> 开发者工具箱</span>
    </footer>
  </div>
</template>

<style scoped>
.palette-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: rgba(18, 20, 27, 0.78);
  backdrop-filter: blur(24px) saturate(1.2);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e8eaf0;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}

.palette-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(232, 234, 240, 0.6);
}

.palette-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 15px;
}

.palette-input::placeholder {
  color: rgba(232, 234, 240, 0.35);
}

.kbd-hint {
  font-size: 11px;
  opacity: 0.5;
}

.palette-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 8px;
}

.palette-group {
  margin-bottom: 6px;
}

.group-label {
  font-size: 11px;
  color: rgba(232, 234, 240, 0.45);
  padding: 6px 10px 4px;
  letter-spacing: 0.05em;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  min-width: 0;
}

.result-row.active {
  background: rgba(91, 140, 255, 0.18);
}

.cat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.cat-dot.app {
  background: #5b8cff;
}

.cat-dot.file {
  background: #3ecf8e;
}

.cat-dot.website {
  background: #f7b500;
}

.cat-dot.function {
  background: #b06ef7;
}

.cat-dot.plugin {
  background: #ff8a3d;
}

.cat-dot.todo {
  background: #e5484d;
}

.cat-dot.clipboard {
  background: #3ecfd8;
}

.cat-dot.snippet {
  background: #c9a2ff;
}

.cat-dot.instant {
  background: #22d3a6;
}

.cat-dot.suggest {
  background: #ff6ba8;
}

.result-label {
  font-size: 13px;
  flex-shrink: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-sub {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 30px 16px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}

.palette-footer {
  display: flex;
  gap: 14px;
  padding: 8px 14px;
  font-size: 11px;
  color: rgba(232, 234, 240, 0.5);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.palette-footer b {
  color: rgba(232, 234, 240, 0.85);
}
</style>
