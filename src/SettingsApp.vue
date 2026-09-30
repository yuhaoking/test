<script setup lang="ts">
import { onMounted } from 'vue';
import SettingsView from './views/SettingsView.vue';
import { useSettingsStore } from './stores/settings';

const settings = useSettingsStore();

onMounted(async () => {
  await settings.load();
  window.api.onStore((data) => settings.sync(data));
});
</script>

<template>
  <SettingsView />
</template>
