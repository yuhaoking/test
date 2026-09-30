<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import { plain } from './utils';
import type { ClipboardEntry, PasteMode, Snippet } from '../shared/types';

/**
 * 浮动粘贴面板（CH-04 / CH-05）
 *
 * - 历史 / 片段 两个标签页，输入即搜（文本 + OCR 文本）；
 * - Enter 粘贴（写回剪贴板并发送 Ctrl+V）/ Ctrl+Enter 仅复制 / Del 删除 / Ctrl+P 置顶；
 * - 片段页 Tab 展开缩写（写入展开内容并粘贴）；Ctrl+N 新建片段；Esc 关闭。
 */

const api = window.api;
const tab = ref<'history' | 'snippets'>('history');
const query = ref('');
const entries = ref<ClipboardEntry[]>([]);
const snippets = ref<Snippet[]>([]);
const index = ref(0);
const thumbs = ref<Record<string, string>>({});
const inputEl = ref<HTMLInputElement | null>(null);
const showEditor = ref(false);
const draft = ref<Snippet>({ id: '', name: '', abbr: '', content: '', createdAt: 0, updatedAt: 0 });

const items = computed<Array<ClipboardEntry | Snippet>>(() => (tab.value === 'history' ? entries.value : snippets.value));

/** UI-9 修复：序号守卫（慢响应不覆盖新结果）+ 输入防抖 */
let refreshSeq = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function refresh(): Promise<void> {
  const seq = ++refreshSeq;
  const q = query.value.trim();
  if (tab.value === 'history') {
    const list = await api.clipboard.list({ query: q, limit: 200 });
    if (seq !== refreshSeq) return;
    entries.value = list;
    await loadThumbs();
  } else {
    const list = await api.snippets.list();
    if (seq !== refreshSeq) return;
    snippets.value = q
      ? list.filter((s) => `${s.name} ${s.abbr} ${s.content}`.toLowerCase().includes(q.toLowerCase()))
      : list;
  }
  if (seq !== refreshSeq) return;
  index.value = 0;
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 150);
}

async function loadThumbs(): Promise<void> {
  for (const e of entries.value) {
    if (e.kind !== 'image' || thumbs.value[e.id]) continue;
    try {
      const asset = await api.clipboard.image(e.id, false);
      if (asset) thumbs.value = { ...thumbs.value, [e.id]: `data:${asset.mime};base64,${asset.data}` };
    } catch {
      /* 缩略图失败忽略 */
    }
  }
}

function timeLabel(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function preview(e: ClipboardEntry): string {
  return (e.text ?? '').replace(/\s+/g, ' ').slice(0, 120) || (e.ocrText ? `OCR：${e.ocrText.slice(0, 60)}` : '（图片）');
}

function move(delta: number): void {  const n = items.value.length;
  if (!n) return;
  index.value = (index.value + delta + n) % n;
}

async function enterSelected(ctrl: boolean): Promise<void> {
  const it = items.value[index.value];
  if (!it) return;
  if (tab.value === 'history') {
    await api.clipboard.copy(it.id, !ctrl);
    if (!ctrl) close();
  } else {
    await api.snippets.expand(it.id, !ctrl);
    if (!ctrl) close();
  }
}

async function removeSelected(): Promise<void> {
  const it = items.value[index.value];
  if (!it) return;
  if (tab.value === 'history') entries.value = await api.clipboard.remove(it.id);
  else snippets.value = await api.snippets.remove(it.id);
}

async function togglePin(e: ClipboardEntry): Promise<void> {
  entries.value = await api.clipboard.update(e.id, { pinned: !e.pinned });
}

async function onTabExpand(): Promise<void> {
  // CH-05：输入缩写按 Tab 展开（在片段页直接展开选中项；历史页按缩写精确匹配）
  if (tab.value === 'snippets') {
    const it = snippets.value[index.value];
    if (it) {
      await api.snippets.expand(it.id, true);
      close();
      return;
    }
  }
  const abbr = query.value.trim();
  const hit = (await api.snippets.list()).find((s) => s.abbr && s.abbr.toLowerCase() === abbr.toLowerCase());
  if (hit) {
    await api.snippets.expand(hit.id, true);
    close();
  }
}

function openEditor(s?: Snippet): void {
  draft.value = s ? { ...s } : { id: '', name: '', abbr: '', content: '', createdAt: 0, updatedAt: 0 };
  showEditor.value = true;
}

async function saveDraft(): Promise<void> {
  if (!draft.value.content.trim()) return;
  snippets.value = await api.snippets.save(plain(draft.value));
  showEditor.value = false;
}

// ---------- CH-07 ~ CH-09（T-14）：格式化粘贴三件套 ----------

/** 右键菜单状态（入口：纯文本粘贴 / JSON 格式化粘贴 / 图片 OCR 转文字粘贴） */
const menu = ref<{ x: number; y: number; entry: ClipboardEntry } | null>(null);

function openMenu(e: MouseEvent, entry: ClipboardEntry): void {
  if (tab.value !== 'history') return;
  menu.value = { x: e.clientX, y: e.clientY, entry };
}

function closeMenu(): void {
  menu.value = null;
}

/** 该条目是否为合法 JSON（决定「JSON 格式化粘贴」是否可用） */
function isJsonEntry(entry: ClipboardEntry): boolean {
  const t = (entry.text ?? '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

async function pasteAs(entry: ClipboardEntry | undefined, mode: PasteMode): Promise<void> {
  closeMenu();
  if (!entry) return;
  try {
    const r = await api.clipboard.pasteAs(entry.id, mode);
    if (!r?.ok) {
      flash(r?.message ?? '该条目不支持此粘贴方式');
      return;
    }
    close();
  } catch (e) {
    flash('粘贴失败：' + (e as Error).message);
  }
}

const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function flash(text: string): void {
  notice.value = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = '';
  }, 2600);
}

function close(): void {
  api.clipboard.hide();
}

function onKey(e: KeyboardEvent): void {
  if (showEditor.value) return;
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
      void enterSelected(e.ctrlKey);
      break;
    case 'Delete':
      e.preventDefault();
      void removeSelected();
      break;
    case 'Tab':
      e.preventDefault();
      void onTabExpand();
      break;
    case 'Escape':
      e.preventDefault();
      close();
      break;
    default:
      if (e.ctrlKey && e.key.toLowerCase() === 'p' && tab.value === 'history') {
        e.preventDefault();
        const it = entries.value[index.value];
        if (it) void togglePin(it);
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openEditor();
      }
      // CH-07：纯文本粘贴（去格式）
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't' && tab.value === 'history') {
        e.preventDefault();
        void pasteAs(entries.value[index.value], 'plain');
      }
  }
}

watch(query, () => scheduleRefresh());
watch(tab, () => {
  query.value = '';
  void refresh();
});

// UI-5 修复：保存订阅 disposer 并在卸载时退订
let offClipboardChanged: (() => void) | null = null;
let offSnippetsChanged: (() => void) | null = null;

onMounted(() => {
  offClipboardChanged = api.clipboard.onChanged(() => void refresh());
  offSnippetsChanged = api.snippets.onChanged(() => void refresh());
  void refresh();
  void nextTick(() => inputEl.value?.focus());
  window.addEventListener('keydown', onKey);
  window.addEventListener('click', closeMenu);
});

onBeforeUnmount(() => {
  offClipboardChanged?.();
  offSnippetsChanged?.();
  if (refreshTimer) clearTimeout(refreshTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('click', closeMenu);
});
</script>

<template>
  <div class="clip-root">
    <div class="clip-tabs">
      <button class="tab" :class="{ on: tab === 'history' }" @click="tab = 'history'">历史</button>
      <button class="tab" :class="{ on: tab === 'snippets' }" @click="tab = 'snippets'">片段</button>
      <span class="spacer"></span>
      <span class="kbd-hint">{{ tab === 'history' ? 'Ctrl+P 置顶' : 'Ctrl+N 新建' }}</span>
    </div>

    <div class="clip-input-row">
      <Icon name="search" :size="16" />
      <input
        ref="inputEl"
        v-model="query"
        class="clip-input"
        :placeholder="tab === 'history' ? '搜索剪贴板历史（支持 OCR 文本）…' : '搜索片段 / 输入缩写后按 Tab 展开…'"
      />
    </div>

    <main class="clip-body">
      <template v-if="items.length">
        <template v-if="tab === 'history'">
          <div
            v-for="(e, i) in entries"
            :key="e.id"
            class="row-item"
            :class="{ active: i === index }"
            @click="index = i"
            @dblclick="void enterSelected(false)"
            @mousemove="index = i"
            @contextmenu.prevent="openMenu($event, e)"
          >
            <img v-if="e.kind === 'image' && thumbs[e.id]" :src="thumbs[e.id]" class="thumb" />
            <span v-else class="thumb text-thumb"><Icon name="doc" :size="14" /></span>
            <div class="meta">
              <div class="primary">{{ preview(e) }}</div>
              <div class="sub muted">
                {{ timeLabel(e.createdAt) }}{{ e.sourceApp ? ` · ${e.sourceApp}` : ''
                }}{{ e.encrypted ? ' · 已加密' : '' }}{{ e.ocrText ? ' · OCR' : '' }}
              </div>
            </div>
            <button v-if="e.pinned" class="icon-btn pin-on" title="取消置顶" @click.stop="void togglePin(e)">
              <Icon name="star" :size="13" />
            </button>
          </div>
        </template>
        <template v-else>
          <div
            v-for="(s, i) in snippets"
            :key="s.id"
            class="row-item"
            :class="{ active: i === index }"
            @click="index = i"
            @dblclick="void enterSelected(false)"
            @mousemove="index = i"
          >
            <span class="thumb text-thumb"><Icon name="pen" :size="14" /></span>
            <div class="meta">
              <div class="primary">{{ s.name }}</div>
              <div class="sub muted">{{ s.content.replace(/\s+/g, ' ').slice(0, 80) }}</div>
            </div>
            <span v-if="s.abbr" class="abbr">{{ s.abbr }}</span>
            <button class="icon-btn" title="编辑" @click.stop="openEditor(s)"><Icon name="pen" :size="13" /></button>
          </div>
        </template>
      </template>
      <div v-else class="empty">
        {{ query.trim() ? '没有匹配结果' : tab === 'history' ? '暂无剪贴板记录（复制即记录）' : '暂无片段，Ctrl+N 新建' }}
      </div>
    </main>

    <footer class="clip-footer">
      <span><b>↑↓</b> 选择</span>
      <span><b>Enter</b> 粘贴</span>
      <span><b>Ctrl+Enter</b> 复制</span>
      <span><b>Ctrl+Shift+T</b> 纯文本粘贴</span>
      <span><b>右键</b> 格式化粘贴</span>
      <span><b>Del</b> 删除</span>
      <span><b>Tab</b> 展开缩写</span>
      <span><b>Esc</b> 关闭</span>
      <span v-if="notice" class="notice">{{ notice }}</span>
    </footer>

    <!-- CH-07 ~ CH-09：格式化粘贴菜单 -->
    <div
      v-if="menu"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <button class="menu-item" @click="void pasteAs(menu.entry, 'plain')">
        纯文本粘贴<span class="menu-hint">Ctrl+Shift+T</span>
      </button>
      <button
        class="menu-item"
        :disabled="menu.entry.kind !== 'text' || !isJsonEntry(menu.entry)"
        @click="void pasteAs(menu.entry, 'json')"
      >
        JSON 格式化粘贴<span class="menu-hint">DEV-01 共用</span>
      </button>
      <button
        class="menu-item"
        :disabled="menu.entry.kind !== 'image'"
        @click="void pasteAs(menu.entry, 'ocr')"
      >
        图片 OCR 转文字粘贴<span class="menu-hint">CH-09</span>
      </button>
      <button class="menu-item" @click="closeMenu(); void enterSelected(false)">直接粘贴（原样）</button>
      <button class="menu-item" @click="closeMenu(); void enterSelected(true)">仅复制到剪贴板</button>
    </div>

    <div v-if="showEditor" class="dialog-mask" @click.self="showEditor = false">
      <div class="dialog">
        <div class="dialog-header">{{ draft.id ? '编辑片段' : '新建片段' }}</div>
        <div class="dialog-body">
          <div class="label">名称</div>
          <input v-model="draft.name" placeholder="例如：常用邮箱" />
          <div class="label">缩写（输入缩写按 Tab 展开）</div>
          <input v-model="draft.abbr" placeholder="例如：mail" />
          <div class="label">内容</div>
          <textarea v-model="draft.content" rows="5" placeholder="预设的常用文本"></textarea>
        </div>
        <div class="dialog-footer">
          <button class="btn" @click="showEditor = false">取消</button>
          <button class="btn primary" @click="void saveDraft()">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.clip-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: rgba(18, 20, 27, 0.82);
  backdrop-filter: blur(24px) saturate(1.2);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e8eaf0;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}

.clip-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 12px 0;
}

.tab {
  border: none;
  background: transparent;
  color: rgba(232, 234, 240, 0.55);
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
}

.tab.on {
  background: rgba(91, 140, 255, 0.2);
  color: #e8eaf0;
}

.spacer {
  flex: 1;
}

.kbd-hint {
  font-size: 11px;
  opacity: 0.5;
}

.clip-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(232, 234, 240, 0.6);
}

.clip-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 14px;
}

.clip-input::placeholder {
  color: rgba(232, 234, 240, 0.35);
}

.clip-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}

.row-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  cursor: pointer;
  min-width: 0;
}

.row-item.active {
  background: rgba(91, 140, 255, 0.18);
}

.thumb {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  background: rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.thumb.text-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(232, 234, 240, 0.55);
}

.meta {
  flex: 1;
  min-width: 0;
}

.primary {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  font-size: 11px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  color: rgba(232, 234, 240, 0.45);
}

.abbr {
  font-size: 11px;
  font-family: Consolas, monospace;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  padding: 0 5px;
  flex-shrink: 0;
}

.pin-on {
  color: #f7b500;
}

.empty {
  padding: 30px 16px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}

.clip-footer {
  display: flex;
  gap: 12px;
  padding: 8px 14px;
  font-size: 11px;
  color: rgba(232, 234, 240, 0.5);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  flex-wrap: wrap;
}

.clip-footer b {
  color: rgba(232, 234, 240, 0.85);
}

.notice {
  color: #6ee7b7;
}

.ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 220px;
  padding: 4px;
  border-radius: 10px;
  background: rgba(22, 24, 32, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover:not(:disabled) {
  background: rgba(91, 140, 255, 0.22);
}

.menu-item:disabled {
  opacity: 0.35;
  cursor: default;
}

.menu-hint {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.5;
}
</style>
