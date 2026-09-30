<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import AppsGrid from './components/AppsGrid.vue';
import SearchPanel from './components/SearchPanel.vue';
import type { DesktopBox, DesktopBoxItem } from '../shared/types';

/**
 * 收纳盒页面（DR-01 / DR-02 / DR-04 / DR-05 + T-08 深化）
 *
 * - 毛玻璃半透明卡片，无边框置顶窗口由主进程 boxWindow 管理；
 * - 标题栏：置顶开关、折叠/展开、收成胶囊（T-08 盒子组/胶囊模式）、隐藏；
 * - 文件盒：点击打开、右键移除索引、拖入收纳；拖 A 到 B 手动叠放（Stacks），
 *   叠放仅索引分组绝不动原文件；空格预览（QuickLook 或内置预览）；
 * - 胶囊模式：收起成胶囊栏之一（同组并排停靠），悬停临时展开、点击固定展开。
 */

const api = window.api;
const boxId = new URLSearchParams(window.location.search).get('box') ?? '';
const box = ref<DesktopBox | null>(null);
const filter = ref('');
/** path → 系统图标 data URL */
const itemIcons = ref<Record<string, string>>({});
const iconLoading = new Set<string>();
let offChanged: (() => void) | null = null;
let loadSeq = 0;

// ---- T-08 胶囊模式 ----
const hovering = ref(false);
const pillMode = computed(() => Boolean(box.value?.capsule) && !hovering.value);

function onPillEnter(): void {
  if (!box.value?.capsule) return;
  hovering.value = true;
  void api.boxes.capsuleHover(boxId, true);
}

function onPillLeave(): void {
  if (!box.value?.capsule) return;
  hovering.value = false;
  void api.boxes.capsuleHover(boxId, false);
}

function pinExpand(): void {
  if (box.value) void api.boxes.setCapsule(box.value.id, false);
}

function collapseToPill(): void {
  if (box.value) void api.boxes.setCapsule(box.value.id, true);
}

// ---- T-08 文件叠放 ----
const expandedStack = ref<string | null>(null);
const dragPath = ref('');
/** UI-4 修复：用“拖拽结束时间戳”代替永不复位的布尔标志，
 *  只吞掉拖拽结束后 300ms 内的收尾点击，之后单击打开恢复正常 */
let lastDragEndAt = 0;

interface Cell {
  type: 'item' | 'stack';
  name: string;
  stack?: string;
  item?: DesktopBoxItem;
  members: DesktopBoxItem[];
}

/** 渲染单元：叠放组收成一摞，其余平铺（仍走渲染前去重） */
const cells = computed<Cell[]>(() => {
  const items = visibleItems.value;
  const stacks = new Map<string, DesktopBoxItem[]>();
  const flat: Cell[] = [];
  for (const i of items) {
    if (i.stack) {
      const list = stacks.get(i.stack) ?? [];
      list.push(i);
      stacks.set(i.stack, list);
    } else {
      flat.push({ type: 'item', name: i.name, item: i, members: [i] });
    }
  }
  const stackCells: Cell[] = [...stacks.entries()].map(([name, members]) => ({
    type: 'stack',
    name,
    stack: name,
    members
  }));
  return [...stackCells, ...flat];
});

const stackMembers = computed(() => {
  const s = expandedStack.value;
  if (!s) return [];
  return (box.value?.items ?? []).filter((i) => i.stack === s);
});

function toggleStack(name: string): void {
  expandedStack.value = expandedStack.value === name ? null : name;
}

function unstackItem(path: string): void {
  void api.boxes.stack(boxId, path, null).then(() => {
    if (!stackMembers.value.length) expandedStack.value = null;
  });
}

function dissolveStack(name: string): void {
  const members = (box.value?.items ?? []).filter((i) => i.stack === name);
  for (const m of members) void api.boxes.stack(boxId, m.path, null);
  expandedStack.value = null;
}

function autoStackAll(): void {
  void api.boxes.autoStack(boxId);
}

function onDragStart(path: string): void {
  dragPath.value = path;
}

function onDropOn(target: Cell): void {
  const src = dragPath.value;
  dragPath.value = '';
  if (!src) return;
  const targetPath = target.item?.path ?? target.members[0]?.path;
  if (!targetPath || targetPath === src) return;
  // 手动叠放：拖入目标所在组（无组则以目标名成组）
  const stackName = target.stack ?? target.name;
  void api.boxes.stack(boxId, src, stackName);
}

function onDropGrid(): void {
  // 空白处放下 = 取消拖拽（不改动）
  dragPath.value = '';
}

/** 空格预览（T-08 QuickLook / 内置预览）：预览悬停中的条目 */
const hoverPath = ref('');

function onKey(e: KeyboardEvent): void {
  if (e.key === ' ' && hoverPath.value) {
    e.preventDefault();
    void api.boxes.preview(hoverPath.value);
  }
}

async function load(): Promise<void> {
  // 时序守卫：仅应用最新一次响应，防止慢响应覆盖新数据造成“旧内容/重复”闪现
  const seq = ++loadSeq;
  const data = await api.boxes.get(boxId);
  if (seq !== loadSeq) return;
  box.value = data;
}

function toggleCollapse(): void {
  if (box.value) void api.boxes.update(box.value.id, { collapsed: !box.value.collapsed });
}

function toggleOnTop(): void {
  if (box.value) void api.boxes.update(box.value.id, { onTop: !box.value.onTop });
}

function hideBox(): void {
  if (box.value) void api.boxes.setVisible(box.value.id, false);
}

function openItem(path: string): void {
  // UI-4：拖拽刚结束的收尾点击忽略，避免“拖一次后单击永久失效”
  if (Date.now() - lastDragEndAt < 300) return;
  void api.boxes.openPath(path);
}

function removeItem(path: string): void {
  if (window.confirm('移除该索引？（不会删除文件本体）')) {
    void api.boxes.removeItem(boxId, path);
  }
}

/** 去重后的条目总数（审计徽标：若与原始数量不同，说明发现并净化了重复） */
const totalUniq = computed(() => {
  const seen = new Set<string>();
  let n = 0;
  for (const i of box.value?.items ?? []) {
    const key = i.path.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
  }
  return n;
});

/** 盒子内容类型（缺省 = files，兼容旧数据） */
const kind = computed(() => (box.value?.kind ?? 'files') as 'files' | 'apps' | 'search');

/** 按文件名过滤（本地小列表，直接内存过滤）；渲染前强制去重（最终保险丝） */
const visibleItems = computed(() => {
  const items = box.value?.items ?? [];
  // 无论数据来源，展示层永远只保留一份（大小写不敏感）
  const seen = new Set<string>();
  const uniq = items.filter((i) => {
    const key = i.path.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const q = filter.value.trim().toLowerCase();
  if (!q) return uniq;
  return uniq.filter((i) => i.name.toLowerCase().includes(q) || (i.stack ?? '').toLowerCase().includes(q));
});

/** 扩展名标签颜色（无系统图标时的兜底色块） */
function extLabel(name: string): string {
  const ext = name.split('.').pop();
  return ext && ext !== name ? ext.toUpperCase().slice(0, 4) : 'FILE';
}

function extColor(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    png: '#3ecf8e',
    jpg: '#3ecf8e',
    jpeg: '#3ecf8e',
    gif: '#3ecf8e',
    webp: '#3ecf8e',
    svg: '#3ecf8e',
    mp4: '#b06ef7',
    mkv: '#b06ef7',
    avi: '#b06ef7',
    mov: '#b06ef7',
    zip: '#f7b500',
    rar: '#f7b500',
    '7z': '#f7b500',
    iso: '#f7b500',
    doc: '#5b8cff',
    docx: '#5b8cff',
    pdf: '#e5484d',
    xls: '#3ecf8e',
    xlsx: '#3ecf8e',
    txt: '#8aa0b8',
    exe: '#e5484d'
  };
  return map[ext] ?? '#8aa0b8';
}

/** 批量提取文件/文件夹系统图标（文件夹也用系统图标，与桌面显示一致） */
async function ensureIcons(): Promise<void> {
  const items = box.value?.items ?? [];
  const targets = items.filter((i) => !itemIcons.value[i.path] && !iconLoading.has(i.path));
  if (!targets.length) return;
  for (const t of targets) iconLoading.add(t.path);
  try {
    const map = await api.files.getIcons(targets.map((t) => t.path));
    for (const [path, cachePath] of Object.entries(map)) {
      if (itemIcons.value[path]) continue;
      try {
        itemIcons.value[path] = await api.asset.toUrl(cachePath);
      } catch {
        /* 图标读取失败跳过（显示兜底图标） */
      }
    }
  } finally {
    for (const t of targets) iconLoading.delete(t.path);
  }
}

function onContext(e: MouseEvent, path: string): void {
  e.preventDefault();
  removeItem(path);
}

onMounted(() => {
  void load();
  void ensureIcons();
  window.addEventListener('keydown', onKey);
  window.addEventListener('dragend', () => {
    lastDragEndAt = Date.now();
    dragPath.value = '';
  });
  offChanged = api.boxes.onChanged(() => {
    void load();
    void ensureIcons();
  });
});

onBeforeUnmount(() => {
  offChanged?.();
  window.removeEventListener('keydown', onKey);
});

// 盒子对象更新（新增/删除文件）后刷新图标
watch(box, () => void ensureIcons(), { deep: true });
</script>

<template>
  <div class="box-root" :style="{ '--box-color': box?.color ?? '#5b8cff' }">
    <!-- T-08 胶囊模式：收起成胶囊（悬停临时展开 / 点击固定展开） -->
    <template v-if="pillMode">
      <div class="pill" title="悬停展开 · 点击固定展开" @mouseenter="onPillEnter" @mouseleave="onPillLeave" @click="pinExpand">
        <span class="box-dot"></span>
        <span class="pill-name">{{ box?.name ?? '收纳盒' }}</span>
        <span class="pill-count">{{ totalUniq }}</span>
      </div>
    </template>

    <template v-else>
      <header class="box-header" @mouseenter="onPillEnter" @mouseleave="onPillLeave">
        <span class="box-dot"></span>
        <span class="box-title">{{ box?.name ?? '收纳盒' }}</span>
        <span class="box-count muted"
          >{{ totalUniq }} 项<span v-if="totalUniq !== (box?.items.length ?? 0)"
            >（已去重 {{ (box?.items.length ?? 0) - totalUniq }}）</span
          ></span
        >
        <span class="spacer"></span>
        <input v-if="box && !box.collapsed" v-model="filter" class="box-filter" placeholder="筛选…" />
        <button
          class="head-btn"
          :class="{ active: box?.onTop }"
          :title="box?.onTop ? '取消置顶（不浮在最上层）' : '置顶到第一层'"
          @click="toggleOnTop"
        >
          <Icon name="pin" :size="13" />
        </button>
        <button class="head-btn" title="折叠 / 展开" @click="toggleCollapse">
          <Icon :name="box?.collapsed ? 'down' : 'up'" :size="13" />
        </button>
        <button class="head-btn" title="收成胶囊（T-08 胶囊模式）" @click="collapseToPill">💊</button>
        <button class="head-btn" title="隐藏" @click="hideBox">
          <Icon name="close" :size="13" />
        </button>
      </header>

      <main v-if="box && !box.collapsed" class="box-body" :class="`kind-${kind}`" @dragover.prevent @drop="onDropGrid">
        <!-- 应用盒：点开即启动，一键扫描全部软件（需求 1） -->
        <AppsGrid v-if="kind === 'apps'" :box="box" />
        <!-- 搜索盒：盒内统一搜索（复用命令面板内核，需求 1） -->
        <SearchPanel v-else-if="kind === 'search'" :box="box" />
        <!-- 文件盒：既有索引网格（默认）+ T-08 叠放 -->
        <template v-else>
          <div v-if="!cells.length" class="box-empty">
            <span>拖入文件或文件夹，仅建立索引（原文件不动）<br />拖文件叠到另一文件上可叠放 · 空格预览</span>
          </div>
          <div
            v-for="cell in cells"
            :key="cell.type === 'stack' ? `stack-${cell.stack}` : cell.item!.path"
            class="box-item"
            :class="{ stack: cell.type === 'stack' }"
            :title="cell.type === 'stack' ? `${cell.name}（${cell.members.length} 个，点击展开）` : cell.item!.path"
            :draggable="true"
            @dragstart="onDragStart(cell.type === 'stack' ? cell.members[0].path : cell.item!.path)"
            @dragover.prevent
            @drop.stop="onDropOn(cell)"
            @mouseenter="hoverPath = cell.type === 'stack' ? cell.members[0].path : cell.item!.path"
            @click="cell.type === 'stack' ? toggleStack(cell.stack!) : openItem(cell.item!.path)"
            @contextmenu="onContext($event, cell.type === 'stack' ? cell.members[0].path : cell.item!.path)"
          >
            <!-- 叠放组：堆叠视觉 + 数量徽标 -->
            <template v-if="cell.type === 'stack'">
              <span class="stack-pile">
                <span class="pile-card c3"></span>
                <span class="pile-card c2"></span>
                <img v-if="itemIcons[cell.members[0].path]" :src="itemIcons[cell.members[0].path]" class="item-ico img pile-front" alt="" />
                <span v-else class="item-ico pile-front" :style="{ background: extColor(cell.members[0].name) }">{{
                  extLabel(cell.members[0].name)
                }}</span>
                <span class="stack-badge">{{ cell.members.length }}</span>
              </span>
              <span class="item-name">{{ cell.name }}</span>
            </template>
            <template v-else>
              <img v-if="itemIcons[cell.item!.path]" :src="itemIcons[cell.item!.path]" class="item-ico img" alt="" />
              <span v-else-if="cell.item!.isDir" class="item-ico dir"><Icon name="folder" :size="20" /></span>
              <span v-else class="item-ico" :style="{ background: extColor(cell.item!.name) }">{{ extLabel(cell.item!.name) }}</span>
              <span class="item-name">{{ cell.item!.name }}</span>
            </template>
          </div>
        </template>
      </main>

      <!-- T-08 叠放展开面板 -->
      <div v-if="expandedStack && kind === 'files'" class="stack-pop" @click.self="expandedStack = null">
        <div class="stack-pop-card">
          <header class="stack-pop-head">
            <span class="box-title">{{ expandedStack }}（{{ stackMembers.length }}）</span>
            <span class="spacer"></span>
            <button class="head-btn" title="解散叠放（不动原文件）" @click="dissolveStack(expandedStack)">解散</button>
            <button class="head-btn" title="关闭" @click="expandedStack = null"><Icon name="close" :size="13" /></button>
          </header>
          <div class="stack-pop-list">
            <div
              v-for="m in stackMembers"
              :key="m.path"
              class="stack-pop-item"
              :title="m.path"
              @mouseenter="hoverPath = m.path"
              @click="openItem(m.path)"
            >
              <img v-if="itemIcons[m.path]" :src="itemIcons[m.path]" class="item-ico img" alt="" />
              <span v-else class="item-ico small" :style="{ background: extColor(m.name) }">{{ extLabel(m.name) }}</span>
              <span class="item-name flex">{{ m.name }}</span>
              <button class="head-btn" title="取消该文件的叠放" @click.stop="unstackItem(m.path)">⧉</button>
              <button class="head-btn" title="移除索引" @click.stop="removeItem(m.path)"><Icon name="trash" :size="12" /></button>
            </div>
          </div>
        </div>
      </div>

      <footer v-if="box && !box.collapsed" class="box-footer">
        <span class="muted">
          <template v-if="kind === 'apps'">点击打开 · 添加全部软件自动扫描已安装应用</template>
          <template v-else-if="kind === 'search'">统搜应用/文件/网站/插件/待办 · ⏎ 打开 · ↑↓ 选择</template>
          <template v-else>拖 A 到 B 上叠放 · 空格预览 · 右键移除索引</template>
        </span>
        <span class="spacer"></span>
        <button v-if="kind === 'files'" class="foot-btn" title="按 图片/软件/压缩包/文档/视频/音频 自动归组叠放" @click="autoStackAll">
          自动叠放
        </button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.box-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: rgba(18, 20, 27, 0.72);
  backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e8eaf0;
  overflow: hidden;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}

/* ---- T-08 胶囊 ---- */
.pill {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
}

.pill-name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill-count {
  font-size: 10px;
  opacity: 0.65;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  padding: 0 6px;
}

.box-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 10px;
  flex-shrink: 0;
  -webkit-app-region: drag;
  user-select: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.box-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--box-color);
  flex-shrink: 0;
}

.box-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.box-count {
  font-size: 11px;
  opacity: 0.65;
}

.box-filter {
  flex: 1;
  min-width: 60px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(0, 0, 0, 0.25);
  color: inherit;
  font-size: 12px;
  -webkit-app-region: no-drag;
}

.head-btn {
  -webkit-app-region: no-drag;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  flex-shrink: 0;
}

.head-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  opacity: 1;
}

.head-btn.active {
  background: rgba(91, 140, 255, 0.35);
  opacity: 1;
  color: #9db9ff;
}

.box-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
}

/* 应用盒 / 搜索盒由各自组件接管布局，去掉默认网格容器样式 */
.box-body.kind-apps,
.box-body.kind-search {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.box-item {
  width: 78px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 4px;
  border-radius: 8px;
  cursor: pointer;
}

.box-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.item-ico {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  font-weight: 700;
  color: #10131a;
}

.item-ico.small {
  width: 26px;
  height: 26px;
  border-radius: 6px;
}

/* 文件夹内置图标（与资源管理器一致的文件夹视觉） */
.item-ico.dir {
  background: rgba(91, 140, 255, 0.22);
  color: #9db9ff;
}

/* 系统提取的图标图片 */
.item-ico.img {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  object-fit: contain;
  background: transparent;
}

.item-name {
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

.item-name.flex {
  flex: 1;
  max-width: none;
  text-align: left;
  -webkit-line-clamp: 1;
}

/* ---- T-08 叠放（Stacks） ---- */
.stack-pile {
  position: relative;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pile-card {
  position: absolute;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.pile-card.c2 {
  transform: translate(3px, -3px);
}

.pile-card.c3 {
  transform: translate(6px, -6px);
}

.pile-front {
  position: relative;
  z-index: 2;
}

.stack-badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  z-index: 3;
  min-width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--box-color);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
}

.stack-pop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.stack-pop-card {
  width: 86%;
  max-height: 80%;
  display: flex;
  flex-direction: column;
  background: rgba(24, 27, 36, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  overflow: hidden;
}

.stack-pop-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.stack-pop-list {
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stack-pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}

.stack-pop-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.box-empty {
  width: 100%;
  height: 100%;
  min-height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  opacity: 0.55;
  padding: 12px;
  text-align: center;
  line-height: 1.8;
}

.box-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.box-footer .muted {
  opacity: 0.55;
}

.foot-btn {
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: inherit;
  font-size: 10px;
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  opacity: 0.75;
}

.foot-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  opacity: 1;
}

.spacer {
  flex: 1;
}
</style>
