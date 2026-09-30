<script setup lang="ts">
import { computed, ref } from 'vue';
import { useModulesStore } from '../stores/modules';
import Icon from './Icon.vue';
import { showToast, uid } from '../utils';
import type { Module, TodoColor, TodoItem, TodoRepeat } from '../../shared/types';

/**
 * 待办模块（T-09 升级）
 *
 * - 截止日期 / 重复任务（完成后自动滚动下一期）/ 颜色标签 / Markdown 备注；
 * - 筛选（全部 / 今天 / 逾期 / 已完成）与批量操作（选中完成 / 删除、清空已完成）；
 * - 情感联动（T-05）：提醒走宠物气泡 + 点头动画（主进程），完成时宠物跳跃庆祝。
 */

const props = defineProps<{ module: Module }>();
const api = window.api;

const store = useModulesStore();
const items = computed<TodoItem[]>(() => (props.module.config.items as TodoItem[] | undefined) ?? []);
const text = ref('');

// ---------- 筛选（T-09） ----------
const filter = ref<'all' | 'today' | 'overdue' | 'done'>('all');

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isOverdue(item: TodoItem): boolean {
  return Boolean(item.dueAt && !item.done && item.dueAt < startOfToday());
}

function isDueToday(item: TodoItem): boolean {
  return Boolean(item.dueAt && !item.done && item.dueAt >= startOfToday() && item.dueAt < startOfToday() + 86400000);
}

const counts = computed(() => ({
  all: items.value.length,
  today: items.value.filter(isDueToday).length,
  overdue: items.value.filter(isOverdue).length,
  done: items.value.filter((i) => i.done).length
}));

const filtered = computed<TodoItem[]>(() =>
  items.value.filter((i) => {
    if (filter.value === 'done') return i.done;
    if (filter.value === 'today') return isDueToday(i);
    if (filter.value === 'overdue') return isOverdue(i);
    return true;
  })
);

// ---------- 基础操作 ----------

function save(newItems: TodoItem[]): Promise<unknown> {
  const latest = store.modules.find((m) => m.id === props.module.id);
  return store.update(props.module.id, {
    config: { ...(latest?.config ?? props.module.config), items: newItems }
  });
}

async function add(): Promise<void> {
  const lines = text.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return;
  const newItems: TodoItem[] = lines.map((l) => ({ id: `todo-${uid()}`, text: l, done: false }));
  await save([...items.value, ...newItems]);
  text.value = '';
  showToast(`已添加 ${newItems.length} 条待办`);
}

/** 重复任务：完成后自动生成下一期（T-09）
 *  UI-10 修复：① monthly 月末溢出（1/31 + 1 月 → 3/3）改为“先归一到 1 号、加月、再按当月天数回填日”；
 *  ② 逾期补勾时按周期滚动到“未来第一个到期时间”，不再连环生成已逾期副本 */
function nextDue(from: number, repeat: TodoRepeat): number {
  const step = new Date(from);
  const now = Date.now();
  for (let guard = 0; guard < 400; guard++) {
    const prevDay = step.getDate();
    if (repeat === 'daily') step.setDate(step.getDate() + 1);
    else if (repeat === 'weekly') step.setDate(step.getDate() + 7);
    else if (repeat === 'monthly') {
      step.setDate(1);
      step.setMonth(step.getMonth() + 1);
      const daysInMonth = new Date(step.getFullYear(), step.getMonth() + 1, 0).getDate();
      step.setDate(Math.min(prevDay, daysInMonth));
    } else break;
    if (step.getTime() > now) break;
  }
  return step.getTime();
}

async function toggle(item: TodoItem): Promise<void> {
  const nextDone = !item.done;
  let next = items.value.map((i) => (i.id === item.id ? { ...i, done: nextDone } : i));
  if (nextDone) {
    const rep = item.repeat ?? 'none';
    if (rep !== 'none') {
      const carry: TodoItem = {
        id: `todo-${uid()}`,
        text: item.text,
        done: false,
        dueAt: nextDue(item.dueAt ?? Date.now(), rep),
        repeat: rep,
        color: item.color,
        note: item.note,
        remindType: item.remindType
      };
      next = [...next, carry];
    }
    // T-05 情感联动：完成庆祝
    void api.pet.play('jump');
    showToast(rep !== 'none' ? '🎉 完成！下一期已自动生成' : '🎉 待办完成！');
  }
  await save(next);
}

async function remove(id: string): Promise<void> {
  await save(items.value.filter((i) => i.id !== id));
}

function isDue(item: TodoItem): boolean {
  return Boolean(item.reminderAt && !item.done && item.reminderAt <= Date.now());
}

function dueBadge(item: TodoItem): { text: string; cls: string } | null {
  if (!item.dueAt) return null;
  if (isOverdue(item)) return { text: '已逾期', cls: 'overdue' };
  if (isDueToday(item)) return { text: '今天', cls: 'today' };
  const d = new Date(item.dueAt);
  return { text: `${d.getMonth() + 1}-${d.getDate()}`, cls: 'normal' };
}

// ---------- 批量操作（T-09） ----------

const selectMode = ref(false);
const selected = ref<Record<string, boolean>>({});
const selectedCount = computed(() => Object.values(selected.value).filter(Boolean).length);

function toggleSelect(id: string): void {
  selected.value = { ...selected.value, [id]: !selected.value[id] };
}

function selectAll(): void {
  const all: Record<string, boolean> = {};
  for (const i of filtered.value) all[i.id] = true;
  selected.value = all;
}

function exitSelect(): void {
  selectMode.value = false;
  selected.value = {};
}

async function batchDone(): Promise<void> {
  if (!selectedCount.value) return;
  await save(items.value.map((i) => (selected.value[i.id] && !i.done ? { ...i, done: true } : i)));
  void api.pet.play('jump');
  showToast(`已完成 ${selectedCount.value} 条待办`);
  exitSelect();
}

async function batchDelete(): Promise<void> {
  if (!selectedCount.value) return;
  if (!confirm(`删除选中的 ${selectedCount.value} 条待办？`)) return;
  await save(items.value.filter((i) => !selected.value[i.id]));
  exitSelect();
}

async function clearDone(): Promise<void> {
  const n = counts.value.done;
  if (!n) return;
  if (!confirm(`清空 ${n} 条已完成待办？`)) return;
  await save(items.value.filter((i) => !i.done));
}

// ---------- 编辑弹窗（截止 / 重复 / 颜色 / 备注 / 提醒） ----------

const COLORS: Array<{ key: TodoColor; hex: string; label: string }> = [
  { key: 'red', hex: '#e5484d', label: '红' },
  { key: 'orange', hex: '#f76707', label: '橙' },
  { key: 'green', hex: '#2f9e44', label: '绿' },
  { key: 'blue', hex: '#1c7ed6', label: '蓝' },
  { key: 'purple', hex: '#7048e8', label: '紫' }
];

const REPEAT_LABEL: Record<TodoRepeat, string> = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
  monthly: '每月'
};

const showEdit = ref(false);
const showNotePreview = ref(false);
const editForm = ref({
  id: '',
  text: '',
  due: '',
  repeat: 'none' as TodoRepeat,
  color: '' as TodoColor | '',
  note: '',
  remind: '',
  remindType: 'pet' as 'pet' | 'list'
});

function isoOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openEdit(item: TodoItem): void {
  editForm.value = {
    id: item.id,
    text: item.text,
    due: item.dueAt ? isoOf(item.dueAt) : '',
    repeat: item.repeat ?? 'none',
    color: item.color ?? '',
    note: item.note ?? '',
    remind: item.reminderAt ? isoOf(item.reminderAt) : '',
    remindType: item.remindType ?? 'pet'
  };
  showNotePreview.value = false;
  showEdit.value = true;
}

async function saveEdit(): Promise<void> {
  const f = editForm.value;
  const dueAt = f.due ? new Date(f.due).getTime() : undefined;
  const reminderAt = f.remind ? new Date(f.remind).getTime() : undefined;
  await save(
    items.value.map((i) =>
      i.id === f.id
        ? {
            ...i,
            text: f.text.trim() || i.text,
            dueAt,
            repeat: f.repeat === 'none' ? undefined : f.repeat,
            color: f.color || undefined,
            note: f.note.trim() || undefined,
            reminderAt,
            remindType: f.remindType,
            notified: false
          }
        : i
    )
  );
  showEdit.value = false;
  showToast('待办已更新');
}

/** 极简 Markdown 渲染（转义后替换，v-html 仅注入本函数生成的标记）
 *  UI-3 修复：转义引号并收紧 URL 白名单（此前 `[x](https://a/"onmouseover="…)` 可属性注入 → XSS） */
function mdToHtml(src: string): string {
  const esc = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return esc
    .replace(/^#{1,4} (.*)$/gm, '<strong>$1</strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.*)$/gm, '<div class="md-li">• $1</div>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)"'&<>]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/\n/g, '<br/>');
}

function colorHex(c?: TodoColor): string | undefined {
  return COLORS.find((x) => x.key === c)?.hex;
}
</script>

<template>
  <div class="todo">
    <div class="row" style="padding: 0 12px 8px">
      <textarea
        v-model="text"
        rows="2"
        placeholder="添加待办（每行一条，可粘贴多行）"
        style="flex: 1; resize: vertical; overflow: hidden"
        @keydown.enter.exact.prevent="add"
      ></textarea>
      <button class="btn small primary" @click="add">添加</button>
    </div>

    <!-- 筛选 + 批量工具条（T-09） -->
    <div class="toolbar">
      <button class="chip" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部 {{ counts.all }}</button>
      <button class="chip" :class="{ on: filter === 'today' }" @click="filter = 'today'">今天 {{ counts.today }}</button>
      <button class="chip warn" :class="{ on: filter === 'overdue' }" @click="filter = 'overdue'">
        逾期 {{ counts.overdue }}
      </button>
      <button class="chip" :class="{ on: filter === 'done' }" @click="filter = 'done'">已完成 {{ counts.done }}</button>
      <span class="spacer"></span>
      <button v-if="!selectMode" class="chip" @click="selectMode = true">批量</button>
      <button v-if="!selectMode && counts.done" class="chip warn" @click="void clearDone()">清空已完成</button>
    </div>
    <div v-if="selectMode" class="toolbar batch-bar">
      <span class="muted">已选 {{ selectedCount }}</span>
      <button class="chip" @click="selectAll">全选</button>
      <button class="chip" :disabled="!selectedCount" @click="void batchDone()">完成选中</button>
      <button class="chip warn" :disabled="!selectedCount" @click="void batchDelete()">删除选中</button>
      <span class="spacer"></span>
      <button class="chip" @click="exitSelect">取消</button>
    </div>

    <div class="item-list">
      <div
        v-for="item in filtered"
        :key="item.id"
        class="todo-item"
        :class="{ done: item.done, due: isDue(item) || isOverdue(item), picked: selected[item.id] }"
      >
        <input v-if="selectMode" type="checkbox" :checked="Boolean(selected[item.id])" @change="toggleSelect(item.id)" />
        <span v-if="item.color" class="color-dot" :style="{ background: colorHex(item.color) }"></span>
        <input type="checkbox" :checked="item.done" @change="toggle(item)" />
        <span class="todo-text" @click="toggle(item)">
          {{ item.text }}
          <span v-if="item.repeat && item.repeat !== 'none'" class="badge" title="重复任务"><Icon name="refresh" :size="10" /></span>
          <span v-if="item.note" class="badge" title="有备注"><Icon name="doc" :size="10" /></span>
          <span v-if="item.reminderAt" class="badge" title="已设置提醒">
            <Icon name="clock" :size="10" />{{ isDue(item) ? '!' : '' }}
          </span>
          <span v-if="dueBadge(item)" class="due-chip" :class="dueBadge(item)!.cls">{{ dueBadge(item)!.text }}</span>
        </span>
        <button class="icon-btn" title="编辑（截止/重复/颜色/备注/提醒）" @click="openEdit(item)">
          <Icon name="pen" :size="13" />
        </button>
        <button class="icon-btn del" title="删除" @click="remove(item.id)">
          <Icon name="trash" :size="13" />
        </button>
      </div>
      <div v-if="!filtered.length" class="empty">{{ filter === 'all' ? '暂无待办' : '该筛选下暂无待办' }}</div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="showEdit" class="dialog-mask" @click.self="showEdit = false">
      <div class="dialog">
        <div class="dialog-header">编辑待办</div>
        <div class="dialog-body">
          <div class="label">内容</div>
          <input v-model="editForm.text" style="width: 100%" placeholder="待办内容" />

          <div class="label">截止日期（T-09）</div>
          <input v-model="editForm.due" type="datetime-local" style="width: 100%" />

          <div class="label">重复任务（完成后自动滚动下一期）</div>
          <select v-model="editForm.repeat" style="width: 100%">
            <option v-for="(label, key) in REPEAT_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>

          <div class="label">颜色标签</div>
          <div class="color-row">
            <span
              v-for="c in COLORS"
              :key="c.key"
              class="color-swatch"
              :class="{ on: editForm.color === c.key }"
              :style="{ background: c.hex }"
              :title="c.label"
              @click="editForm.color = editForm.color === c.key ? '' : c.key"
            ></span>
            <span v-if="editForm.color" class="muted clear-color" @click="editForm.color = ''">清除</span>
          </div>

          <div class="label">
            Markdown 备注
            <button class="chip preview-toggle" @click="showNotePreview = !showNotePreview">
              {{ showNotePreview ? '编辑' : '预览' }}
            </button>
          </div>
          <textarea v-if="!showNotePreview" v-model="editForm.note" rows="4" style="width: 100%" placeholder="支持 Markdown：# 标题、**加粗**、*斜体*、`代码`、- 列表、[链接](https://…)"></textarea>
          <!-- eslint-disable-next-line vue/no-v-html -- mdToHtml 先做 HTML 轍义，仅注入本函数生成的固定标记 -->
          <div v-else class="md-preview" v-html="mdToHtml(editForm.note)"></div>

          <div class="label">提醒时间</div>
          <input v-model="editForm.remind" type="datetime-local" style="width: 100%" />
          <div class="label">提醒方式</div>
          <select v-model="editForm.remindType" style="width: 100%">
            <option value="pet">桌面宠物提醒（气泡 + 动画）</option>
            <option value="list">仅在清单中标记</option>
          </select>
        </div>
        <div class="dialog-footer">
          <button class="btn danger" @click="(remove(editForm.id), (showEdit = false))">删除</button>
          <span class="spacer"></span>
          <button class="btn" @click="showEdit = false">取消</button>
          <button class="btn primary" @click="void saveEdit()">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo {
  padding-bottom: 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 12px 8px;
}

.batch-bar {
  padding-top: 2px;
  padding-bottom: 6px;
}

.chip {
  font-size: 11px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 999px;
  padding: 2px 10px;
  cursor: pointer;
}

.chip:hover {
  background: var(--bg-hover);
}

.chip.on {
  border-color: var(--accent);
  color: var(--accent);
}

.chip.warn {
  color: var(--danger);
}

.chip:disabled {
  opacity: 0.4;
  cursor: default;
}

.item-list {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  overflow-y: auto;
}

.todo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 6px;
}

.todo-item:hover {
  background: var(--bg-hover);
}

.todo-item.due {
  background: rgba(255, 180, 0, 0.12);
}

.todo-item.picked {
  outline: 1px solid var(--accent);
}

.color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.todo-text {
  flex: 1;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.todo-item.done .todo-text {
  text-decoration: line-through;
  color: var(--text-dim);
}

.badge {
  display: inline-flex;
  align-items: center;
  color: var(--text-dim);
  flex-shrink: 0;
}

.due-chip {
  font-size: 10px;
  border-radius: 4px;
  padding: 0 5px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  color: var(--text-dim);
}

.due-chip.today {
  color: var(--accent);
  border-color: var(--accent);
}

.due-chip.overdue {
  color: var(--danger);
  border-color: var(--danger);
}

.del {
  opacity: 0;
  color: var(--danger);
}

.todo-item:hover .del {
  opacity: 1;
}

.color-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
}

.color-swatch.on {
  border-color: var(--text);
  transform: scale(1.15);
}

.clear-color {
  font-size: 11px;
  cursor: pointer;
}

.preview-toggle {
  margin-left: 8px;
}

.md-preview {
  min-height: 76px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.md-preview :deep(code) {
  background: var(--bg-hover);
  border-radius: 3px;
  padding: 0 3px;
  font-family: Consolas, monospace;
}

.md-preview :deep(.md-li) {
  padding-left: 6px;
}
</style>
