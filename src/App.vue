<script setup lang="ts">
import { onMounted } from 'vue';
import SidebarView from './views/SidebarView.vue';
import { useSettingsStore } from './stores/settings';
import { useModulesStore } from './stores/modules';
import { showToast } from './utils';

const settings = useSettingsStore();
const modules = useModulesStore();

onMounted(async () => {
  // 先订阅再加载：避免错过启动早期（如自动启用插件建卡）的 store:changed 广播
  window.api.onStore((data) => {
    settings.sync(data);
    modules.sync(data);
  });
  window.api.todo.onFired((text) => showToast(`待办提醒：${text}`));
  await Promise.all([settings.load(), modules.load()]);
});
</script>

<template>
  <SidebarView />
</template>
