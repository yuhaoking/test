<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import PluginTile from './PluginTile.vue';
import Icon from './Icon.vue';
import type { Module, PluginRecord } from '../../shared/types';

/**
 * 插件模块卡（需求 2：所有插件制作成一个模块，纵向罗列全部插件）
 *
 * - 聚合卡：module.config.pluginAggregate 为 true 时，纵向列出所有已启用 module 插件；
 *   每个插件一栏，UI 由 PluginTile 渲染（复用插件协议，功能不丢失）。
 * - 兼容旧数据：旧“一插件一卡”仍能单独显示（按 config.pluginId）。
 */
const props = defineProps<{ module: Module }>();
const api = window.api;

const list = ref<PluginRecord[]>([]);
/** 插件图标 data URL（p.icon 是磁盘路径，<img> 无法直接加载，须经 asset:to-url 转换） */
const iconUrls = ref<Record<string, string>>({});
let offChanged: (() => void) | null = null;

/** 是否为聚合卡（一卡多插件）；否则为旧版单插件卡 */
const aggregate = computed(() => props.module.config.pluginAggregate === true);

/** 聚合卡 → 全部已启用 module 插件；单卡 → 仅 config.pluginId 对应的插件 */
const active = computed<(PluginRecord & { state: string })[]>(() => {
  if (aggregate.value) {
    return list.value.filter((p) => p.enabled && p.type === 'module').map((p) => ({ ...p, state: 'enabled' }));
  }
  const pid = String(props.module.config.pluginId ?? '');
  const rec = list.value.find((p) => p.id === pid);
  return rec && rec.enabled ? [{ ...rec, state: 'enabled' }] : [];
});

async function load(): Promise<void> {
  list.value = await api.plugins.list();
  await Promise.all(
    list.value
      .filter((p) => p.icon && !iconUrls.value[p.id])
      .map(async (p) => {
        try {
          iconUrls.value = { ...iconUrls.value, [p.id]: await api.asset.toUrl(p.icon!) };
        } catch {
          /* 图标缺失/不可读时回退首字母占位 */
        }
      })
  );
}

async function openManager(): Promise<void> {
  // 复用设置页的插件管理入口（打开设置窗口）
  void api.settings.open();
}

onMounted(() => {
  void load();
  offChanged = api.plugins.onChanged(() => void load());
});

onBeforeUnmount(() => offChanged?.());
</script>

<template>
  <div class="plug-mod">
    <!-- 聚合卡：标题 + 插件管理入口 -->
    <div v-if="aggregate" class="plug-head">
      <span class="muted">{{ active.length }} 个插件已启用</span>
      <span class="spacer"></span>
      <button class="btn small" @click="openManager"><Icon name="gear" :size="12" />插件管理</button>
    </div>

    <!-- 空态 -->
    <div v-if="!active.length" class="empty">
      {{ aggregate ? '暂无已启用的模块插件（到“插件管理”中启用）' : '插件未加载（请在插件管理中启用）' }}
    </div>

    <!-- 聚合卡：纵向罗列每个插件一栏 -->
    <div v-else-if="aggregate" class="plug-list">
      <div v-for="p in active" :key="p.id" class="plug-section">
        <div class="plug-sec-head">
          <img v-if="iconUrls[p.id]" :src="iconUrls[p.id]" class="plug-ico" alt="" />
          <span v-else class="plug-ico dummy">{{ p.name.slice(0, 1).toUpperCase() }}</span>
          <span class="plug-sec-name">{{ p.name }}</span>
          <span class="muted plug-sec-meta">{{ p.version }}</span>
        </div>
        <PluginTile :plugin-id="p.id" />
      </div>
    </div>

    <!-- 旧版单插件卡：直接渲染 -->
    <PluginTile v-else :plugin-id="String(props.module.config.pluginId ?? '')" />
  </div>
</template>

<style scoped>
.plug-mod {
  padding-bottom: 12px;
}

.plug-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 8px;
}

.plug-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.plug-section {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.plug-sec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px 6px;
  font-size: 12px;
  font-weight: 600;
}

.plug-ico {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  object-fit: cover;
  flex-shrink: 0;
}

.plug-ico.dummy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover);
  color: var(--text-dim);
  font-size: 10px;
}

.plug-sec-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plug-sec-meta {
  font-size: 10px;
}
</style>
