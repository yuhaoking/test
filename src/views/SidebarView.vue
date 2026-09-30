<script setup lang="ts">
import { computed, ref } from 'vue';
import { useModulesStore } from '../stores/modules';
import { useSettingsStore } from '../stores/settings';
import ModuleCard from '../components/ModuleCard.vue';
import AddModuleModal from '../components/AddModuleModal.vue';
import Icon from '../components/Icon.vue';
import { t } from '../i18n';
import { showToast } from '../utils';

const modules = useModulesStore();
const settings = useSettingsStore();
const api = window.api;

const editing = ref(false);
const showAdd = ref(false);
const menu = ref({ visible: false, x: 0, y: 0, moduleId: '' });
const dragId = ref('');

const list = computed(() => modules.visual());

function openMenu(e: MouseEvent, id: string): void {
  menu.value = { visible: true, x: Math.min(e.clientX, window.innerWidth - 160), y: e.clientY, moduleId: id };
}

function menuModule() {
  return modules.modules.find((m) => m.id === menu.value.moduleId);
}

function closeMenu(): void {
  menu.value.visible = false;
}

async function onMenuAction(action: string): Promise<void> {
  const m = menuModule();
  if (!m) return;
  const id = m.id;
  closeMenu();
  switch (action) {
    case 'pin':
      await modules.setPinned(id, !m.pinned);
      break;
    case 'up':
      await modules.move(id, -1);
      break;
    case 'down':
      await modules.move(id, 1);
      break;
    case 'delete':
      await modules.remove(id);
      showToast('模块已删除');
      break;
  }
}

function onDrop(targetId: string): void {
  if (dragId.value && dragId.value !== targetId) {
    void modules.reorderTo(dragId.value, targetId);
  }
  dragId.value = '';
}

let resizeState: { startX: number; startWidth: number } | null = null;
let resizeMoved = 0;

function onResizeDown(e: MouseEvent): void {
  resizeState = { startX: e.screenX, startWidth: settings.settings.sidebarWidth };
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeUp);
  // UI-5 修复：窗口失焦/鼠标移出也必须结束拖拽，否则监听器永不移除（拖拽卡死）
  window.addEventListener('blur', onResizeUp);
}

function onResizeMove(e: MouseEvent): void {
  if (!resizeState) return;
  const dx = e.screenX - resizeState.startX;
  if (!resizeMoved || Math.abs(dx - resizeMoved) >= 2) {
    resizeMoved = dx;
    // 主进程侧也会钳制，这里先按 260~600 收口，避免拖出极端宽度
    const next = Math.min(600, Math.max(260, resizeState.startWidth - dx));
    void window.api.sidebar.setWidth(next);
  }
}

function onResizeUp(): void {
  resizeState = null;
  resizeMoved = 0;
  window.removeEventListener('mousemove', onResizeMove);
  window.removeEventListener('mouseup', onResizeUp);
  window.removeEventListener('blur', onResizeUp);
}

function toggleTheme(): void {
  void settings.update({ theme: settings.theme === 'dark' ? 'light' : 'dark' });
}
</script>

<template>
  <div class="sidebar-shell">
    <div class="resize-handle" @mousedown="onResizeDown" :title="t('sidebar.resize')"></div>
    <header class="sidebar-header">
      <span class="logo"><Icon name="panda" :size="22" /></span>
      <span class="title">小鹏工具箱</span>
      <span class="spacer"></span>
      <button class="icon-btn" :title="t('sidebar.toggleTheme')" @click="toggleTheme">
        <Icon :name="settings.theme === 'dark' ? 'sun' : 'moon'" :size="15" />
      </button>
      <button class="icon-btn" :title="t('common.settings')" @click="api.settings.open()"><Icon name="gear" :size="15" /></button>
      <button class="icon-btn" :title="t('sidebar.collapse')" @click="api.sidebar.hide()"><Icon name="close" :size="15" /></button>
    </header>
    <main class="sidebar-body">
      <div
        v-for="m in list"
        :key="m.id"
        class="module-wrap"
        :class="{ dragging: dragId === m.id }"
        :draggable="editing && !m.fixed"
        @dragstart="dragId = m.id"
        @dragend="dragId = ''"
        @dragover.prevent
        @drop.prevent="onDrop(m.id)"
        @contextmenu.prevent="openMenu($event, m.id)"
      >
        <ModuleCard :module="m" :editing="editing" />
      </div>
      <div v-if="!list.length" class="empty">点击下方“添加模块”创建第一个卡片</div>
      <div v-if="editing" class="edit-tip">编辑模式：拖动卡片排序，固定模块不可拖动</div>
    </main>
    <footer class="sidebar-footer">
      <button class="btn primary" @click="showAdd = true"><Icon name="plus" :size="13" />添加模块</button>
      <button class="btn" @click="editing = !editing">{{ editing ? '完成' : '编辑' }}</button>
    </footer>

    <div v-if="menu.visible" class="context-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <div v-if="menuModule()" class="menu-item" @click="onMenuAction('pin')">
        {{ menuModule()?.pinned ? '取消置顶' : '置顶' }}
      </div>
      <div class="menu-item" @click="onMenuAction('up')">上移一层</div>
      <div class="menu-item" @click="onMenuAction('down')">下移一层</div>
      <div class="menu-item danger" @click="onMenuAction('delete')">删除模块</div>
    </div>
    <div v-if="menu.visible" class="menu-mask" @click="closeMenu"></div>

    <AddModuleModal v-if="showAdd" @close="showAdd = false" />
  </div>
</template>

<style scoped>
.sidebar-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  backdrop-filter: blur(24px) saturate(1.3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin: 12px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
  z-index: 50;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
  flex-shrink: 0;
}

.logo {
  display: inline-flex;
  color: var(--accent);
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.sidebar-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.module-wrap {
  border-radius: var(--radius);
}

.module-wrap.dragging {
  opacity: 0.5;
}

.module-wrap[draggable='true'] {
  cursor: grab;
}

.edit-tip {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  padding: 4px;
}

.sidebar-footer {
  display: flex;
  gap: 8px;
  padding: 10px 14px 14px;
  flex-shrink: 0;
}

.sidebar-footer .btn {
  flex: 1;
}

.context-menu {
  position: fixed;
  background: var(--bg-solid);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 4px;
  min-width: 140px;
  z-index: 120;
}

.menu-item {
  padding: 7px 12px;
  border-radius: 6px;
  cursor: pointer;
}

.menu-item:hover {
  background: var(--bg-hover);
}

.menu-item.danger {
  color: var(--danger);
}

.menu-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
}
</style>
