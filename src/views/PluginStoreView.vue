<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { showToast } from '../utils';
import type { PluginRecord } from '../../shared/types';

const api = window.api;
const plugins = ref<PluginRecord[]>([]);
const loading = ref(false);
const acting = ref('');
const icons = ref<Record<string, string>>({});

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    plugins.value = await api.plugins.list();
    await Promise.all(
      plugins.value
        .filter((p) => p.icon && !icons.value[p.id])
        .map(async (p) => {
          try {
            icons.value = { ...icons.value, [p.id]: await api.asset.toUrl(p.icon!) };
          } catch {
            /* skip */
          }
        })
    );
  } finally {
    loading.value = false;
  }
}

// UI-5 修复：保存订阅 disposer 并在卸载时退订
let offPluginsChanged: (() => void) | null = null;

onMounted(() => {
  void refresh();
  offPluginsChanged = window.api.plugins.onChanged(() => void refresh());
});

onBeforeUnmount(() => offPluginsChanged?.());

async function load(p: PluginRecord): Promise<void> {
  acting.value = p.id;
  try {
    await api.plugins.load(p.id);
    showToast(`插件“${p.name}”已加载`);
  } catch (e) {
    showToast(String(e));
  } finally {
    acting.value = '';
  }
}

async function unload(p: PluginRecord): Promise<void> {
  acting.value = p.id;
  try {
    await api.plugins.unload(p.id);
    showToast(`插件“${p.name}”已卸载`);
  } finally {
    acting.value = '';
  }
}

async function remove(p: PluginRecord): Promise<void> {
  if (!confirm(`确定移除插件“${p.name}”？该操作将删除插件目录。`)) return;
  acting.value = p.id;
  try {
    await api.plugins.remove(p.id);
    showToast('插件已移除');
  } catch (e) {
    showToast(String(e));
  } finally {
    acting.value = '';
  }
}

async function trust(p: PluginRecord): Promise<void> {
  const sources = await api.plugins.trust(p.id);
  const trusted = sources.includes(p.id);
  const idx = plugins.value.findIndex((x) => x.id === p.id);
  if (idx >= 0) {
    plugins.value = plugins.value.map((x) => (x.id === p.id ? { ...x, trusted } : x));
  }
  showToast(trusted ? '已加入信任来源' : '已取消信任');
}

async function install(): Promise<void> {
  acting.value = '-';
  try {
    await api.plugins.install();
    showToast('插件已安装');
  } catch (e) {
    showToast(String(e));
  } finally {
    acting.value = '';
  }
}

const TYPE_LABEL: Record<string, string> = { module: '模块插件', pet: '宠物插件' };
</script>

<template>
  <div class="store">
    <div class="row" style="margin-bottom: 10px">
      <span class="muted">共 {{ plugins.length }} 个插件</span>
      <span class="spacer"></span>
      <button class="btn" :disabled="loading" @click="refresh">刷新</button>
      <button class="btn primary" :disabled="acting === '-'" @click="install">安装插件…</button>
    </div>
    <div class="plug-list">
      <div v-for="p in plugins" :key="p.id" class="plug-card">
        <img v-if="icons[p.id]" :src="icons[p.id]" class="plug-icon" />
        <span v-else class="plug-icon placeholder"><Icon name="puzzle" :size="18" /></span>
        <div class="plug-meta">
          <div class="plug-name">
            {{ p.name }}
            <span v-if="p.category" class="tag cat">{{ p.category }}</span>
            <span class="tag">{{ TYPE_LABEL[p.type] ?? p.type }}</span>
            <!-- SEC-005 / OPT-15：同 id 出现在多个目录时显式标注，不再让用户猜"生效的是哪一份" -->
            <span
              v-if="p.conflict"
              class="tag warn-tag"
              :title="`插件标识 ${p.id} 在多个插件目录中同时存在（如内置目录与用户目录同名），当前生效的是：${p.dir}`"
            >
              标识冲突
            </span>
            <span v-if="p.status" class="status" :class="{ err: p.status.startsWith('error'), off: !p.enabled }">
              {{ p.enabled ? p.status : '已停用' }}
            </span>
          </div>
          <div class="muted plug-sub">
            v{{ p.version }} · {{ p.author || '未知作者' }} · {{ p.status === 'user' ? '本地安装' : '内置' }}
          </div>
          <div v-if="p.description" class="muted plug-sub">{{ p.description }}</div>
        </div>
        <div class="plug-actions">
          <button v-if="!p.enabled" class="btn small primary" :disabled="acting === p.id" @click="load(p)">加载</button>
          <button v-else class="btn small" :disabled="acting === p.id" @click="unload(p)">卸载</button>
          <button class="btn small" @click="trust(p)">{{ p.trusted ? '取消信任' : '信任' }}</button>
          <button v-if="p.status === 'user'" class="btn small danger" :disabled="acting === p.id" @click="remove(p)">
            移除
          </button>
        </div>
      </div>
      <div v-if="!plugins.length && !loading" class="empty">
        暂无插件。内置示例插件位于项目 plugins/ 目录，可通过“安装插件…”选择自定义插件目录。
      </div>
    </div>
  </div>
</template>

<style scoped>
.plug-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plug-card {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}

.plug-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  object-fit: cover;
  background: var(--bg-card);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.plug-icon.placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}

.plug-meta {
  flex: 1;
  min-width: 0;
}

.plug-name {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}

.tag.cat {
  color: var(--accent);
  border-color: var(--accent);
}

.tag.warn-tag {
  color: var(--danger);
  border-color: var(--danger);
  cursor: help;
}

.status {
  font-size: 11px;
  color: var(--success);
}

.status.err {
  color: var(--danger);
}

.status.off {
  color: var(--text-dim);
}

.plug-sub {
  font-size: 12px;
}

.plug-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
