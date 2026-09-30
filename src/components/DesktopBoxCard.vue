<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { showToast } from '../utils';
import type { DesktopBox } from '../../shared/types';

/**
 * 侧边栏“桌面收纳”卡片（DR-05：与桌面盒子窗口双向同步）
 *
 * 提供：新建盒子、一键分类整理（软件/文件/图片三大类）、显示/隐藏、删除、拖拽排序；
 * 所有变更经主进程广播回盒子窗口与设置页。
 */

const api = window.api;
const boxes = ref<DesktopBox[]>([]);
const dragId = ref('');
let offChanged: (() => void) | null = null;
let offStore: (() => void) | null = null;

async function load(): Promise<void> {
  boxes.value = await api.boxes.list();
}

function create(kind: 'files' | 'apps' | 'search' = 'files'): void {
  const label = kind === 'apps' ? '应用盒' : kind === 'search' ? '搜索盒' : `收纳盒 ${boxes.value.length + 1}`;
  void api.boxes.create({ name: label, kind });
  showToast(`已创建${label}，可拖入文件`);
}

function toggle(box: DesktopBox): void {
  void api.boxes.setVisible(box.id, !box.visible);
}

async function applyRules(): Promise<void> {
  const summary = await api.boxes.applyRules();
  const added = summary.reduce((s, r) => s + r.added, 0);
  const moved = summary.reduce((s, r) => s + Math.max(0, r.moved), 0);
  // 整理后权威统计（list 来自主进程去重后的数据）与每条路径唯一性
  const after = await api.boxes.list();
  const count = (autoType: string) =>
    after.filter((b) => b.autoType === autoType).reduce((s, b) => s + b.items.length, 0);
  const total = after.reduce((s, b) => s + b.items.length, 0);
  const uniq = new Set<string>();
  for (const b of after) for (const it of b.items) uniq.add(it.path.toLowerCase());
  const dup = total - uniq.size;
  showToast(
    `整理完成：软件 ${count('software')} · 图片 ${count('image')} · 文件 ${count('file')}${dup > 0 ? `，清理重复 ${dup} 项` : '，无重复'}（新增 ${added} / 重排 ${moved}）`
  );
}

function remove(box: DesktopBox): void {
  if (window.confirm(`删除收纳盒“${box.name}”？索引将被移除（文件本体不受影响）`)) {
    void api.boxes.remove(box.id);
  }
}

/**
 * 卡片内拖拽排序（顺序持久化到盒子 order 字段）
 *
 * P2-16 修复：原来无条件"插入到目标之前"，于是**向下拖拽**时视觉上没有变化
 * （[A,B,C,D] 把 A 拖到 B 上 → 又插回 B 前面 → 顺序不变）。现在按拖拽方向决定
 * 插到目标之前还是之后，向上/向下行为对称。
 */
function onDrop(targetId: string): void {
  const drag = boxes.value.find((b) => b.id === dragId.value);
  if (!drag || drag.id === targetId) {
    dragId.value = '';
    return;
  }
  const from = boxes.value.findIndex((b) => b.id === drag.id);
  const to = boxes.value.findIndex((b) => b.id === targetId);
  const arr = boxes.value.filter((b) => b.id !== drag.id);
  const targetIdx = arr.findIndex((b) => b.id === targetId);
  const insertAt = from < to ? targetIdx + 1 : targetIdx;
  arr.splice(insertAt, 0, drag);
  dragId.value = '';
  // 逐个持久化 order（数量少，直接全量更新）
  for (const [i, b] of arr.entries()) {
    void api.boxes.update(b.id, { order: i });
  }
}

const visibleCount = computed(() => boxes.value.filter((b) => b.visible).length);

/** 一键扫描全部软件进应用盒（没有则先创建），复用 ScanInstalledApps 缓存 */
async function scanApps(): Promise<void> {
  let appBox = boxes.value.find((b) => b.kind === 'apps');
  if (!appBox) {
    await api.boxes.create({ name: '应用盒', kind: 'apps' });
    await load();
    appBox = boxes.value.find((b) => b.kind === 'apps');
  }
  if (!appBox) return;
  const res = await api.boxes.addApps(appBox.id);
  showToast(
    res.added > 0 ? `扫描完成：新增 ${res.added} 个应用（共 ${res.total}）` : `应用盒已是最新（共 ${res.total} 个应用）`
  );
}

function kindLabel(k: string): string {
  const map: Record<string, string> = { apps: '应用', search: '搜索', files: '文件' };
  return map[k] ?? k;
}

onMounted(() => {
  void load();
  offChanged = api.boxes.onChanged(() => void load());
  // 总开关变化时重新拉取（窗口同步状态）
  offStore = api.onStore(() => void load());
});

onBeforeUnmount(() => {
  offChanged?.();
  offStore?.();
});
</script>

<template>
  <div class="dbc">
    <div class="row dbc-actions">
      <button class="btn small primary" @click="create('files')"><Icon name="plus" :size="12" />收纳盒</button>
      <button class="btn small" @click="create('apps')"><Icon name="rocket" :size="12" />应用盒</button>
      <button class="btn small" @click="create('search')"><Icon name="search" :size="12" />搜索盒</button>
      <button class="btn small" @click="scanApps"><Icon name="drive" :size="12" />扫软件</button>
      <button class="btn small" @click="applyRules"><Icon name="refresh" :size="12" />整理</button>
    </div>
    <div class="row dbc-meta">
      <span class="muted">{{ boxes.length }} 盒 · {{ visibleCount }} 显示</span>
    </div>

    <div v-if="boxes.length" class="box-list">
      <div
        v-for="box in boxes"
        :key="box.id"
        class="box-row"
        :class="{ dragging: dragId === box.id }"
        draggable="true"
        @dragstart="dragId = box.id"
        @dragend="dragId = ''"
        @dragover.prevent
        @drop.prevent="onDrop(box.id)"
      >
        <span class="color-dot" :style="{ background: box.color }"></span>
        <span class="box-name">{{ box.name }}</span>
        <span v-if="box.kind && box.kind !== 'files'" class="kind-badge">{{ kindLabel(box.kind) }}</span>
        <span class="muted box-meta">{{ box.items.length }} 项{{ box.collapsed ? ' · 已折叠' : '' }}</span>
        <span class="spacer"></span>
        <button class="icon-btn" :title="box.visible ? '隐藏' : '显示'" @click="toggle(box)">
          <Icon :name="box.visible ? 'eye' : 'eye-off'" :size="13" />
        </button>
        <button class="icon-btn del" title="删除盒子" @click="remove(box)">
          <Icon name="trash" :size="13" />
        </button>
      </div>
    </div>
    <div v-else class="empty">尚未创建收纳盒；点击“新建盒子”后在桌面拖入文件即可收纳（默认仅建立索引）</div>
    <div class="muted dbc-tip">拖拽排序 · 盒子窗口与这里双向同步</div>
  </div>
</template>

<style scoped>
.dbc {
  padding: 0 12px 12px;
}

.dbc-actions {
  padding-bottom: 8px;
}

.box-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.box-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: grab;
  border: 1px solid transparent;
}

.box-row:hover {
  background: var(--bg-hover);
}

.box-row.dragging {
  opacity: 0.5;
}

.color-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.box-name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.kind-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-dim);
  flex-shrink: 0;
}

.dbc-meta {
  padding: 0 2px 8px;
}

.box-meta {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.del {
  color: var(--danger);
}

.dbc-tip {
  font-size: 11px;
  margin-top: 6px;
}
</style>
