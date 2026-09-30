<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import QuickLaunch from './QuickLaunch.vue';
import FileManager from './FileManager.vue';
import ServerLauncher from './ServerLauncher.vue';
import WebsiteLauncher from './WebsiteLauncher.vue';
import TodoList from './TodoList.vue';
import SystemInfo from './SystemInfo.vue';
import MusicPlayer from './MusicPlayer.vue';
import PluginModule from './PluginModule.vue';
import DesktopBoxCard from './DesktopBoxCard.vue';
import type { Module } from '../../shared/types';

const props = defineProps<{ module: Module; editing: boolean }>();
const api = window.api;

const ICON_NAMES: Record<string, string> = {
  quick_launch: 'rocket',
  file_manager: 'folder',
  server_launcher: 'server',
  website_launcher: 'globe',
  todo_list: 'check',
  system_info: 'chart',
  music_player: 'music',
  plugin: 'puzzle',
  desktop_boxes: 'box'
};

const compMap: Record<string, unknown> = {
  quick_launch: QuickLaunch,
  file_manager: FileManager,
  server_launcher: ServerLauncher,
  website_launcher: WebsiteLauncher,
  todo_list: TodoList,
  system_info: SystemInfo,
  music_player: MusicPlayer,
  plugin: PluginModule,
  desktop_boxes: DesktopBoxCard
};

const comp = computed(() => compMap[props.module.type] ?? null);
const iconName = computed(() => ICON_NAMES[props.module.type] ?? 'puzzle');
</script>

<template>
  <div class="module-card" :class="{ fixed: module.fixed }">
    <div class="module-header">
      <span class="module-icon"><Icon :name="iconName" :size="15" /></span>
      <span class="module-name">{{ module.name }}</span>
      <span v-if="module.pinned" class="pin-badge" title="置顶区"><Icon name="pin" :size="11" /></span>
      <span v-if="module.fixed" class="pin-badge" title="固定模块"><Icon name="lock" :size="11" /></span>
      <span class="spacer"></span>
      <button v-if="editing" class="icon-btn danger-btn" title="删除模块" @click.stop="api.modules.remove(module.id)">
        <Icon name="trash" :size="13" />
      </button>
      <span v-if="editing && !module.fixed" class="drag-handle" title="拖动排序"><Icon name="grip" :size="14" /></span>
    </div>
    <component :is="comp" :module="module" />
  </div>
</template>

<style scoped>
.module-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.module-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
  font-size: 13px;
  font-weight: 600;
}

.module-icon {
  color: var(--accent);
  display: inline-flex;
}

.pin-badge {
  display: inline-flex;
  color: var(--text-dim);
  cursor: default;
}

.module-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.danger-btn {
  color: var(--danger);
}

.drag-handle {
  color: var(--text-dim);
  cursor: grab;
  display: inline-flex;
}
</style>
