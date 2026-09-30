<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useModulesStore } from '../stores/modules';
import Icon from './Icon.vue';
import { showToast, uid } from '../utils';
import type { Module, WebsiteItem } from '../../shared/types';

const props = defineProps<{ module: Module }>();

const api = window.api;
const store = useModulesStore();
const items = computed<WebsiteItem[]>(() => (props.module.config.items as WebsiteItem[] | undefined) ?? []);
const showAdd = ref(false);
const urls = ref('');
const icons = ref<Record<string, string>>({});

function save(newItems: WebsiteItem[]): Promise<unknown> {
  const latest = store.modules.find((m) => m.id === props.module.id);
  return store.update(props.module.id, {
    config: { ...(latest?.config ?? props.module.config), items: newItems }
  });
}

function iconFor(item: WebsiteItem): string {
  return (item.icon && icons.value[item.icon]) || '';
}

async function loadIcons(): Promise<void> {
  const updates: Record<string, string> = {};
  for (const item of items.value) {
    if (!item.icon || icons.value[item.icon]) continue;
    try {
      updates[item.icon] = await api.asset.toUrl(item.icon);
    } catch {
      /* skip */
    }
  }
  if (Object.keys(updates).length) icons.value = { ...icons.value, ...updates };
}

onMounted(loadIcons);
watch(items, () => void loadIcons());

function normalizeUrl(url: string): string {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return `https://${u}`;
  return u;
}

async function open(item: WebsiteItem): Promise<void> {
  await api.websites.open(normalizeUrl(item.url));
}

async function addItems(): Promise<void> {
  const lines = urls.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return;
  const newItems: WebsiteItem[] = [];
  for (const line of lines) {
    const idx = line.indexOf('|');
    const name = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const url = (idx >= 0 ? line.slice(idx + 1) : line).trim();
    if (!url) continue;
    newItems.push({
      id: `web-${uid()}`,
      name: name || url,
      url: normalizeUrl(url)
    });
  }
  if (!newItems.length) return;
  await save([...items.value, ...newItems]);
  showAdd.value = false;
  urls.value = '';
  showToast(`已添加 ${newItems.length} 个网站`);
}

async function removeItem(id: string): Promise<void> {
  await save(items.value.filter((i) => i.id !== id));
}
</script>

<template>
  <div class="web">
    <div class="row" style="padding: 0 12px 8px">
      <span class="muted" style="font-size: 12px">{{ items.length }} 个网站</span>
      <span class="spacer"></span>
      <button class="btn small primary" @click="showAdd = true"><Icon name="plus" :size="12" />添加</button>
    </div>
    <div class="item-list">
      <div v-for="item in items" :key="item.id" class="web-item" @click="open(item)">
        <img v-if="iconFor(item)" :src="iconFor(item)" class="web-ico" />
        <span v-else class="web-ico dummy"><Icon name="globe" :size="14" /></span>
        <div class="meta">
          <span class="name">{{ item.name }}</span>
          <span class="url muted">{{ item.url }}</span>
        </div>
        <button class="icon-btn del" title="删除" @click.stop="removeItem(item.id)">
          <Icon name="trash" :size="13" />
        </button>
      </div>
      <div v-if="!items.length" class="empty">暂无网站</div>
    </div>

    <div v-if="showAdd" class="dialog-mask" @click.self="showAdd = false">
      <div class="dialog">
        <div class="dialog-header">添加网站（支持批量）</div>
        <div class="dialog-body">
          <div>
            <div class="label">网址（每行一个，可写「名称|网址」，名称省略时取网址）</div>
            <textarea
              v-model="urls"
              rows="5"
              placeholder="GitHub|github.com&#10;Docker Hub|hub.docker.com&#10;https://www.bing.com"
              style="width: 100%; resize: vertical; font-family: Consolas, monospace"
            ></textarea>
          </div>
          <div class="muted" style="font-size: 12px">点击后自动补全 https:// 并用系统默认浏览器打开。</div>
        </div>
        <div class="dialog-footer">
          <button class="btn" @click="showAdd = false">取消</button>
          <button class="btn primary" :disabled="!urls.trim()" @click="addItems">批量添加</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.web {
  padding-bottom: 12px;
}

.item-list {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  overflow-y: auto;
}

.web-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  cursor: pointer;
}

.web-item:hover {
  background: var(--bg-hover);
}

.web-ico {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  object-fit: contain;
  flex-shrink: 0;
}

.web-ico.dummy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
}

.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.url {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.del {
  opacity: 0;
  color: var(--danger);
}

.web-item:hover .del {
  opacity: 1;
}
</style>
