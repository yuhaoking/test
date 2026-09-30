<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { useSettingsStore } from '../stores/settings';
import { plain, showToast } from '../utils';
import type { ClipboardEntry, Snippet } from '../../shared/types';

/**
 * 剪贴板中心（CH-01 ~ CH-06）：监听开关 / 隐私保护 / 历史管理 / 片段库。
 */

const api = window.api;
const settings = useSettingsStore();
const s = computed(() => settings.settings);

const entries = ref<ClipboardEntry[]>([]);
const snippets = ref<Snippet[]>([]);
const thumbs = ref<Record<string, string>>({});
const query = ref('');
const kind = ref<'all' | 'text' | 'image'>('all');
const timeRange = ref<'all' | 'today' | 'week' | 'month'>('all');
const keywordsDraft = ref('');
const whitelistDraft = ref('');
const keepPinned = ref(true);
const editing = ref<Snippet | null>(null);

/** UI-9 修复：序号守卫，慢响应不再覆盖新结果 */
let refreshSeq = 0;

async function refresh(): Promise<void> {
  const seq = ++refreshSeq;
  const list = await api.clipboard.list({
    query: query.value.trim(),
    kind: kind.value,
    timeRange: timeRange.value,
    limit: 300
  });
  if (seq !== refreshSeq) return;
  entries.value = list;
  for (const e of entries.value) {
    if (seq !== refreshSeq) return;
    if (e.kind !== 'image' || thumbs.value[e.id]) continue;
    try {
      const asset = await api.clipboard.image(e.id, false);
      if (asset) thumbs.value = { ...thumbs.value, [e.id]: `data:${asset.mime};base64,${asset.data}` };
    } catch {
      /* 忽略 */
    }
  }
  const snips = await api.snippets.list();
  if (seq !== refreshSeq) return;
  snippets.value = snips;
}

/** UI-9 修复：输入防抖，避免每个按键都触发一次全量查询 + 批量缩略图 IPC */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 150);
}

async function toggle(field: 'clipboardEnabled' | 'clipboardImages' | 'clipboardOcr' | 'clipboardEncrypt'): Promise<void> {
  await settings.update({ [field]: !s.value[field] });
  showToast('设置已保存');
}

async function applyKeywords(): Promise<void> {
  const list = keywordsDraft.value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  await settings.update({ clipboardExcludeKeywords: list });
  showToast('排除关键词已保存（命中文本将不记录）');
}

async function applyWhitelist(): Promise<void> {
  const list = whitelistDraft.value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  await settings.update({ clipboardAppWhitelist: list });
  showToast('应用白名单已保存（留空 = 不限制）');
}

async function applyMaxItems(): Promise<void> {
  const n = Math.max(50, Math.min(5000, s.value.clipboardMaxItems || 500));
  await settings.update({ clipboardMaxItems: n });
}

async function togglePin(e: ClipboardEntry): Promise<void> {
  await api.clipboard.update(e.id, { pinned: !e.pinned });
  await refresh();
}

async function removeEntry(id: string): Promise<void> {
  await api.clipboard.remove(id);
  await refresh();
}

async function clearAll(): Promise<void> {
  if (!confirm(keepPinned.value ? '清空剪贴板历史（保留置顶条目）？' : '清空全部剪贴板历史（含置顶）？')) return;
  await api.clipboard.clear(keepPinned.value);
  showToast('剪贴板历史已清空');
  await refresh();
}

function editSnippet(sn?: Snippet): void {
  editing.value = sn ? { ...sn } : { id: '', name: '', abbr: '', content: '', createdAt: 0, updatedAt: 0 };
}

async function saveSnippet(): Promise<void> {
  if (!editing.value) return;
  snippets.value = await api.snippets.save(plain(editing.value));
  editing.value = null;
  showToast('片段已保存');
}

async function removeSnippet(id: string): Promise<void> {
  snippets.value = await api.snippets.remove(id);
}

function preview(e: ClipboardEntry): string {
  return (e.text ?? '').replace(/\s+/g, ' ').slice(0, 90) || (e.ocrText ? `OCR：${e.ocrText.slice(0, 50)}` : '（图片）');
}

watch([query, kind, timeRange], () => scheduleRefresh());

// UI-1 修复：保存订阅 disposer，组件卸载时退订（此前每次切换标签泄漏 2 个监听器）
let offClipboardChanged: (() => void) | null = null;
let offSnippetsChanged: (() => void) | null = null;

onMounted(() => {
  keywordsDraft.value = s.value.clipboardExcludeKeywords.join(', ');
  whitelistDraft.value = s.value.clipboardAppWhitelist.join(', ');
  offClipboardChanged = api.clipboard.onChanged(() => void refresh());
  offSnippetsChanged = api.snippets.onChanged(() => void refresh());
  void refresh();
});

onBeforeUnmount(() => {
  offClipboardChanged?.();
  offSnippetsChanged?.();
  if (refreshTimer) clearTimeout(refreshTimer);
});

// UI-2 修复：异步 load() 完成后回填草稿，避免用默认值覆盖用户已保存配置
watch(
  () => [s.value.clipboardExcludeKeywords.join(','), s.value.clipboardAppWhitelist.join(',')],
  () => {
    keywordsDraft.value = s.value.clipboardExcludeKeywords.join(', ');
    whitelistDraft.value = s.value.clipboardAppWhitelist.join(', ');
  },
  { immediate: true }
);
</script>

<template>
  <div class="set-stack">
    <!-- ① 监听开关 -->
    <section class="set-card">
      <h4>剪贴板监听（CH-01）</h4>
      <p class="desc">托盘常驻监听复制动作，文本 / 图片自动记录到本地历史；条目仅存元数据，图片落盘管理，监听开销近零。</p>
      <div class="set-line">
        <div class="switch" :class="{ on: s.clipboardEnabled }" @click="void toggle('clipboardEnabled')"></div>
        <span class="hint">记录文本 / 图片复制历史（关闭后立即停止监听）</span>
      </div>
      <div class="set-line tight">
        <div class="switch" :class="{ on: s.clipboardImages }" @click="void toggle('clipboardImages')"></div>
        <span class="hint">记录图片（缩略图 + 原图存本地）</span>
      </div>
      <div class="set-line tight">
        <div class="switch" :class="{ on: s.clipboardOcr }" @click="void toggle('clipboardOcr')"></div>
        <span class="hint">图片 OCR 索引（复用 Tesseract 引擎，识别文本可被历史搜索命中，CH-06）</span>
      </div>
      <div class="set-divider"></div>
      <div class="set-line tight">
        <label class="set-field-label">历史上限</label>
        <input
          v-model.number="s.clipboardMaxItems"
          type="number"
          min="50"
          max="5000"
          style="width: 110px"
          @change="void applyMaxItems()"
        />
        <span class="hint">条（超出自动淘汰最旧的未置顶条目）</span>
      </div>
    </section>

    <!-- ② 隐私保护 -->
    <section class="set-card">
      <h4>隐私保护（CH-03 / spec 5.4）</h4>
      <p class="desc">
        命中排除关键词的文本不记录；应用白名单非空时仅记录这些来源应用；加密存储使用 AES-256-GCM，密钥仅存本机。
      </p>
      <div class="set-line">
        <div class="switch" :class="{ on: s.clipboardEncrypt }" @click="void toggle('clipboardEncrypt')"></div>
        <span class="hint">加密存储（新记录生效）</span>
      </div>
      <div class="set-line">
        <label class="set-field-label">排除关键词</label>
        <input v-model="keywordsDraft" placeholder="例如：password, token, 密码" style="flex: 1; min-width: 220px" />
        <button class="btn small" @click="void applyKeywords()">保存</button>
      </div>
      <div class="set-line tight">
        <label class="set-field-label">应用白名单</label>
        <input v-model="whitelistDraft" placeholder="例如：Code, chrome, WINWORD（留空 = 全部记录）" style="flex: 1; min-width: 220px" />
        <button class="btn small" @click="void applyWhitelist()">保存</button>
      </div>
    </section>

    <!-- ③ 历史管理 -->
    <section class="set-card">
      <h4>历史管理（CH-02）</h4>
      <p class="desc">全文搜索（含 OCR 文本）· 时间 / 类型筛选 · 置顶 / 删除 / 一键清空。</p>
      <div class="set-line">
        <input v-model="query" placeholder="搜索历史…" style="flex: 1; min-width: 200px" />
        <select v-model="kind" style="width: 110px">
          <option value="all">全部类型</option>
          <option value="text">文本</option>
          <option value="image">图片</option>
        </select>
        <select v-model="timeRange" style="width: 110px">
          <option value="all">全部时间</option>
          <option value="today">今天</option>
          <option value="week">本周</option>
          <option value="month">本月</option>
        </select>
      </div>
      <div class="set-line tight">
        <label class="check"><input v-model="keepPinned" type="checkbox" /> 清空时保留置顶</label>
        <span class="spacer"></span>
        <span class="hint">共 {{ entries.length }} 条</span>
        <button class="btn danger small" @click="void clearAll()">一键清空</button>
      </div>
      <div class="hist-list">
        <div v-for="e in entries" :key="e.id" class="hist-row">
          <img v-if="e.kind === 'image' && thumbs[e.id]" :src="thumbs[e.id]" class="hist-thumb" />
          <span v-else class="hist-thumb placeholder"><Icon name="doc" :size="14" /></span>
          <div class="hist-meta">
            <div class="hist-main">{{ preview(e) }}</div>
            <div class="hint hist-sub">
              {{ new Date(e.createdAt).toLocaleString('zh-CN') }}{{ e.sourceApp ? ` · ${e.sourceApp}` : ''
              }}{{ e.encrypted ? ' · 已加密' : '' }}{{ e.ocrText ? ' · OCR 已索引' : '' }}
            </div>
          </div>
          <button class="icon-btn" :class="{ 'pin-on': e.pinned }" :title="e.pinned ? '取消置顶' : '置顶'" @click="void togglePin(e)">
            <Icon :name="e.pinned ? 'star' : 'star-outline'" :size="14" />
          </button>
          <button class="icon-btn" title="删除" @click="void removeEntry(e.id)"><Icon name="trash" :size="14" /></button>
        </div>
        <div v-if="!entries.length" class="empty">暂无记录</div>
      </div>
    </section>

    <!-- ④ 片段库 -->
    <section class="set-card">
      <h4>片段库（CH-05）</h4>
      <p class="desc">预设常用文本 + 缩写；粘贴面板（Ctrl+Shift+V）中输入缩写按 Tab 展开，也可从命令面板直接插入。</p>
      <div class="set-line">
        <span class="hint">共 {{ snippets.length }} 个片段</span>
        <span class="spacer"></span>
        <button class="btn primary small" @click="editSnippet()"><Icon name="plus" :size="12" /> 新建片段</button>
      </div>
      <div class="hist-list">
        <div v-for="sn in snippets" :key="sn.id" class="hist-row">
          <span class="hist-thumb placeholder"><Icon name="pen" :size="14" /></span>
          <div class="hist-meta">
            <div class="hist-main">{{ sn.name }} <span v-if="sn.abbr" class="abbr">{{ sn.abbr }}</span></div>
            <div class="hint hist-sub">{{ sn.content.replace(/\s+/g, ' ').slice(0, 80) }}</div>
          </div>
          <button class="icon-btn" title="编辑" @click="editSnippet(sn)"><Icon name="pen" :size="14" /></button>
          <button class="icon-btn" title="删除" @click="void removeSnippet(sn.id)"><Icon name="trash" :size="14" /></button>
        </div>
        <div v-if="!snippets.length" class="empty">暂无片段</div>
      </div>
    </section>

    <!-- 片段编辑对话框 -->
    <div v-if="editing" class="dialog-mask" @click.self="editing = null">
      <div class="dialog">
        <div class="dialog-header">{{ editing.id ? '编辑片段' : '新建片段' }}</div>
        <div class="dialog-body">
          <div class="label">名称</div>
          <input v-model="editing.name" placeholder="例如：常用邮箱" />
          <div class="label">缩写（粘贴面板中输入缩写按 Tab 展开）</div>
          <input v-model="editing.abbr" placeholder="例如：mail" />
          <div class="label">内容</div>
          <textarea v-model="editing.content" rows="5" placeholder="预设的常用文本"></textarea>
        </div>
        <div class="dialog-footer">
          <button class="btn" @click="editing = null">取消</button>
          <button class="btn primary" @click="void saveSnippet()">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.hist-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px;
  margin-top: 12px;
  background: var(--bg-solid);
}

.hist-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 6px;
}

.hist-row:hover {
  background: var(--bg-hover);
}

.hist-thumb {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--bg-card);
  flex-shrink: 0;
}

.hist-thumb.placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  border: 1px solid var(--border);
}

.hist-meta {
  flex: 1;
  min-width: 0;
}

.hist-main {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist-sub {
  font-size: 11px;
  margin-top: 2px;
}

.abbr {
  font-size: 11px;
  font-family: Consolas, monospace;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  margin-left: 6px;
  color: var(--text-dim);
}

.pin-on {
  color: #f7b500;
}

.label {
  font-size: 12px;
  color: var(--text-dim);
  margin: 12px 0 6px;
}

.label:first-child {
  margin-top: 0;
}

textarea {
  width: 100%;
}
</style>
