<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { showToast } from '../utils';
import type { FavoriteFile, RecentFile, SearchResult } from '../../shared/types';

const api = window.api;
const tab = ref<'recent' | 'favorite' | 'all'>('all');
const query = ref('');
const fullDisk = ref(false);
const searching = ref(false);
const results = ref<SearchResult[]>([]);
const drives = ref<string[]>([]);
const selectedDrives = ref(new Set<string>());

async function loadDrives(): Promise<void> {
  if (drives.value.length) return;
  try {
    drives.value = await api.files.getDrives();
    selectedDrives.value = new Set(drives.value);
  } catch {
    /* skip */
  }
}

function toggleDrive(d: string): void {
  const s = new Set(selectedDrives.value);
  if (s.has(d)) s.delete(d);
  else s.add(d);
  selectedDrives.value = s;
}

const favorites = ref<FavoriteFile[]>([]);
const recents = ref<RecentFile[]>([]);

function refresh(): void {
  void api.store.get().then((d) => {
    favorites.value = d.favoriteFiles;
    recents.value = d.recentFiles;
  });
}

onMounted(refresh);

const favSet = computed(() => new Set(favorites.value.map((f) => f.path)));

function toResult(path: string, ts: number): SearchResult {
  return { path, name: path.split(/[\\/]/).pop() ?? path, isDir: false, size: 0, mtime: ts };
}

const visible = computed(() => {
  if (searching.value || fullDisk.value) return results.value;
  const q = query.value.trim().toLowerCase();
  let pool: { path: string; ts: number }[];
  if (tab.value === 'recent') pool = recents.value.map((f) => ({ path: f.path, ts: f.lastOpened }));
  else if (tab.value === 'favorite') pool = favorites.value.map((f) => ({ path: f.path, ts: f.addedAt }));
  else {
    pool = [
      ...recents.value.map((f) => ({ path: f.path, ts: f.lastOpened })),
      ...favorites.value.map((f) => ({ path: f.path, ts: f.addedAt }))
    ];
    const seen = new Set<string>();
    pool = pool.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  }
  return pool.filter((f) => !q || f.path.toLowerCase().includes(q)).map((f) => toResult(f.path, f.ts));
});

async function doSearch(): Promise<void> {
  const q = query.value.trim();
  if (!q) return;
  if (fullDisk.value && !selectedDrives.value.size) {
    showToast('请选择至少一个盘符');
    return;
  }
  searching.value = true;
  try {
    results.value = await api.files.search(
      q,
      fullDisk.value,
      fullDisk.value ? Array.from(selectedDrives.value) : undefined
    );
    if (results.value.length === 0) showToast('没有找到匹配结果');
  } catch {
    showToast('搜索失败');
  } finally {
    searching.value = false;
  }
}

async function open(r: SearchResult): Promise<void> {
  try {
    await api.files.open(r.path);
  } catch {
    showToast('无法打开');
  }
}

async function star(r: SearchResult): Promise<void> {
  if (favSet.value.has(r.path)) {
    await api.files.removeFavorite(r.path);
  } else {
    await api.files.addFavorite(r.path);
  }
  refresh();
}

async function clearRecents(): Promise<void> {
  await api.files.clearRecents();
  refresh();
  showToast('最近记录已清除');
}
</script>

<template>
  <div class="fm">
    <div class="row" style="padding: 0 12px 8px">
      <input v-model="query" placeholder="搜索文件" style="flex: 1" @keyup.enter="doSearch" />
      <label class="full-disk" title="全盘搜索可能较慢">
        <input
          v-model="fullDisk"
          type="checkbox"
          @change="
            fullDisk && loadDrives();
            query && doSearch();
          "
        />
        全盘
      </label>
      <button class="btn small primary" @click="doSearch">搜索</button>
    </div>
    <div v-if="fullDisk && drives.length" class="row drive-bar">
      <span class="muted drive-label">盘符</span>
      <span
        v-for="d in drives"
        :key="d"
        class="drive-item"
        :class="{ on: selectedDrives.has(d) }"
        @click="toggleDrive(d)"
      >
        {{ d }}
      </span>
    </div>
    <div class="row tabs">
      <button
        v-for="t in [
          { k: 'all', label: '全部' },
          { k: 'recent', label: '最近' },
          { k: 'favorite', label: '收藏' }
        ]"
        :key="t.k"
        class="tab-btn"
        :class="{ on: tab === t.k }"
        @click="tab = t.k as 'recent' | 'favorite' | 'all'"
      >
        {{ t.label }}
      </button>
      <span class="spacer"></span>
      <button class="btn small" @click="clearRecents">清除记录</button>
    </div>
    <div class="file-list">
      <div v-for="r in visible" :key="r.path" class="file-item" @click="open(r)">
        <span class="file-ico">
          <Icon :name="r.isDir ? 'folder' : 'file'" :size="14" />
        </span>
        <div class="file-meta">
          <div class="file-name">{{ r.name }}</div>
          <div class="file-path muted">{{ r.path }}</div>
        </div>
        <button class="icon-btn star" :class="{ on: favSet.has(r.path) }" title="收藏" @click.stop="star(r)">
          <Icon :name="favSet.has(r.path) ? 'star' : 'star-outline'" :size="14" />
        </button>
      </div>
      <div v-if="!visible.length" class="empty">暂无文件，打开过的文件会自动记录</div>
    </div>
  </div>
</template>

<style scoped>
.fm {
  padding-bottom: 12px;
}

.full-disk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  cursor: pointer;
}

.tabs {
  padding: 0 12px 6px;
}

.drive-bar {
  padding: 0 12px 6px;
  flex-wrap: wrap;
  gap: 6px;
}

.drive-label {
  font-size: 12px;
}

.drive-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-dim);
}

.drive-item.on {
  border-color: var(--accent);
  color: var(--text);
  background: var(--bg-hover);
}

.tab-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.tab-btn.on {
  background: var(--bg-hover);
  color: var(--text);
}

.file-list {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  cursor: pointer;
}

.file-item:hover {
  background: var(--bg-hover);
}

.file-ico {
  flex-shrink: 0;
}

.file-meta {
  flex: 1;
  min-width: 0;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-path {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.star {
  opacity: 0;
}

.star.on {
  color: #f7b500;
  opacity: 1;
}

.file-item:hover .star {
  opacity: 1;
}
</style>
