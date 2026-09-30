<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useModulesStore } from '../stores/modules';
import Icon from './Icon.vue';
import { buildSearchKeys, matchKeys, showToast, uid } from '../utils';
import type { AppItem, Module, QuickLaunchItem } from '../../shared/types';

const props = defineProps<{ module: Module }>();

const api = window.api;
const store = useModulesStore();
const items = computed<QuickLaunchItem[]>(() => (props.module.config.items as QuickLaunchItem[] | undefined) ?? []);
const query = ref('');
const showPicker = ref(false);
const scanning = ref(false);
const scanResult = ref<AppItem[]>([]);
const selected = ref(new Set<string>());
const icons = ref<Record<string, string>>({});

async function save(newItems: QuickLaunchItem[]): Promise<void> {
  const latest = store.modules.find((m) => m.id === props.module.id);
  await store.update(props.module.id, {
    config: { ...(latest?.config ?? props.module.config), items: newItems }
  });
}

function iconFor(item: QuickLaunchItem): string {
  return (item.icon && icons.value[item.icon]) || '';
}

async function loadIcons(): Promise<void> {
  const targets = items.value.filter((i) => i.icon && !icons.value[i.icon!]);
  const updates: Record<string, string> = {};
  for (const item of targets) {
    try {
      updates[item.icon!] = await api.asset.toUrl(item.icon!);
    } catch {
      /* skip */
    }
  }
  if (Object.keys(updates).length) icons.value = { ...icons.value, ...updates };
}

onMounted(loadIcons);
watch(items, () => void loadIcons());

const filtered = computed(() => {
  const q = query.value.trim();
  return items.value.filter((item) => matchKeys(item.name, buildSearchKeys(item.name), q));
});

async function doScan(force = false): Promise<void> {
  scanning.value = true;
  try {
    // 普通打开复用缓存（10 分钟内不重复扫描）；"重新扫描"强制刷新
    scanResult.value = await api.apps.scan(force);
    const updates: Record<string, string> = {};
    for (const a of scanResult.value) {
      if (a.icon && !icons.value[a.icon]) {
        try {
          updates[a.icon] = await api.asset.toUrl(a.icon);
        } catch {
          /* skip */
        }
      }
    }
    if (Object.keys(updates).length) icons.value = { ...icons.value, ...updates };
  } finally {
    scanning.value = false;
  }
}

function openPicker(): void {
  showPicker.value = true;
  selected.value = new Set();
  if (!scanResult.value.length) void doScan();
}

function toggleSelect(path: string): void {
  const s = new Set(selected.value);
  if (s.has(path)) s.delete(path);
  else s.add(path);
  selected.value = s;
}

const pickFiltered = computed(() => {
  const q = query.value.trim();
  return scanResult.value.filter((a) => matchKeys(a.name, buildSearchKeys(a.name), q));
});

async function addSelected(): Promise<void> {
  const chosen = scanResult.value.filter((a) => selected.value.has(a.path));
  if (!chosen.length) return;
  const add: QuickLaunchItem[] = chosen.map((a) => ({
    id: `ql-${uid()}`,
    name: a.name,
    path: a.path,
    icon: a.icon,
    searchKeys: buildSearchKeys(a.name)
  }));
  await save([...items.value, ...add]);
  showPicker.value = false;
  showToast(`已添加 ${add.length} 个应用`);
}

async function pickManual(): Promise<void> {
  const app = await api.apps.pick();
  if (!app) return;
  let icon: string | undefined;
  try {
    icon = (await api.apps.getIcon(app.path)) || undefined;
  } catch {
    icon = undefined;
  }
  await save([
    ...items.value,
    {
      id: `ql-${uid()}`,
      name: app.name,
      path: app.path,
      icon,
      searchKeys: buildSearchKeys(app.name)
    }
  ]);
}

async function openItem(item: QuickLaunchItem): Promise<void> {
  try {
    await api.files.open(item.path);
  } catch {
    showToast('无法打开，路径可能已失效');
  }
}

async function removeItem(id: string): Promise<void> {
  await save(items.value.filter((i) => i.id !== id));
}
</script>

<template>
  <div class="ql">
    <div class="row" style="padding: 0 12px 8px">
      <input v-model="query" placeholder="搜索应用（支持拼音/首字母）" style="flex: 1" />
      <button class="btn small primary" @click="openPicker"><Icon name="plus" :size="12" />添加</button>
    </div>
    <div class="item-list">
      <div v-for="item in filtered" :key="item.id" class="ql-item" @click="openItem(item)">
        <img v-if="iconFor(item)" :src="iconFor(item)" class="app-ico" />
        <span v-else class="app-ico dummy">{{ item.name.slice(0, 1) }}</span>
        <span class="item-name">{{ item.name }}</span>
        <span class="item-path muted">{{ item.path }}</span>
        <button class="icon-btn del" title="移除" @click.stop="removeItem(item.id)">
          <Icon name="trash" :size="13" />
        </button>
      </div>
      <div v-if="!filtered.length" class="empty">暂无应用，点击“添加”</div>
    </div>

    <div v-if="showPicker" class="dialog-mask" @click.self="showPicker = false">
      <div class="dialog">
        <div class="dialog-header">添加应用</div>
        <div class="dialog-body">
          <div class="row">
            <input v-model="query" placeholder="搜索已安装应用" style="flex: 1" />
            <button class="btn small" :disabled="scanning" @click="doScan(true)">
              {{ scanning ? '扫描中…' : '重新扫描' }}
            </button>
            <button class="btn small" @click="pickManual">手动选择</button>
          </div>
          <div class="app-list">
            <div v-for="a in pickFiltered" :key="a.path" class="picker-item" @click="toggleSelect(a.path)">
              <input type="checkbox" :checked="selected.has(a.path)" @click.stop />
              <img v-if="a.icon && icons[a.icon]" :src="icons[a.icon]" />
              <span v-else class="app-icon">{{ a.name.slice(0, 1) }}</span>
              <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ a.name }}</span>
            </div>
            <div v-if="!scanResult.length && !scanning" class="empty">点击“重新扫描”获取已安装应用</div>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn" @click="showPicker = false">取消</button>
          <button class="btn primary" :disabled="!selected.size" @click="addSelected">
            添加（{{ selected.size }}）
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ql {
  padding-bottom: 12px;
}

.item-list {
  display: flex;
  flex-direction: column;
  max-height: 260px;
  overflow-y: auto;
}

.ql-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  cursor: pointer;
}

.ql-item:hover {
  background: var(--bg-hover);
}

.app-ico {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  object-fit: contain;
  flex-shrink: 0;
}

.app-ico.dummy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover);
  color: var(--text-dim);
  font-size: 11px;
}

.item-name {
  flex-shrink: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 11px;
}

.del {
  opacity: 0;
}

.ql-item:hover .del {
  opacity: 1;
}

.app-list {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>
