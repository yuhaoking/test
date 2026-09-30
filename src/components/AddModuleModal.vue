<script setup lang="ts">
import { ref } from 'vue';
import { useModulesStore } from '../stores/modules';
import Icon from './Icon.vue';
import { uid, showToast } from '../utils';
import type { ModuleType } from '../../shared/types';

const emit = defineEmits<{ close: [] }>();

const modules = useModulesStore();

const TYPES: { type: ModuleType; label: string; icon: string; desc: string }[] = [
  { type: 'quick_launch', label: '快捷启动', icon: 'rocket', desc: '快速打开电脑中的应用' },
  { type: 'file_manager', label: '文件管理', icon: 'folder', desc: '最近文件、收藏与搜索' },
  { type: 'server_launcher', label: '服务器快捷启动', icon: 'server', desc: '启动脚本、命令、远程服务器' },
  { type: 'website_launcher', label: '网站快捷启动', icon: 'globe', desc: '快速打开常用网站' },
  { type: 'todo_list', label: '待办事项', icon: 'check', desc: '记录与提醒待办' },
  { type: 'system_info', label: '系统信息', icon: 'chart', desc: 'CPU/内存/磁盘/显卡状态' },
  { type: 'music_player', label: '音乐控制', icon: 'music', desc: '控制系统媒体播放' },
  { type: 'desktop_boxes', label: '桌面收纳', icon: 'box', desc: '可视化收纳盒：拖拽文件、规则分类' }
];

const step = ref<'type' | 'config'>('type');
const selected = ref<ModuleType | null>(null);
const name = ref('');

function pickType(t: ModuleType): void {
  selected.value = t;
  step.value = 'config';
}

function labelOf(t: ModuleType): string {
  return TYPES.find((x) => x.type === t)?.label ?? '';
}

async function save(): Promise<void> {
  if (!selected.value || !name.value.trim()) return;
  await modules.add({
    id: `mod-${uid()}`,
    type: selected.value,
    name: name.value.trim(),
    fixed: false,
    pinned: false,
    order: 9999,
    config: {}
  });
  showToast('模块已添加');
  emit('close');
}
</script>

<template>
  <div class="dialog-mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-header">{{ step === 'type' ? '添加模块' : `配置：${labelOf(selected as ModuleType)}` }}</div>
      <div class="dialog-body">
        <template v-if="step === 'type'">
          <div class="type-grid">
            <div v-for="t in TYPES" :key="t.type" class="type-item" @click="pickType(t.type)">
              <span class="type-icon"><Icon :name="t.icon" :size="24" /></span>
              <span>{{ t.label }}</span>
              <span class="type-desc">{{ t.desc }}</span>
            </div>
          </div>
        </template>
        <template v-else>
          <div>
            <div class="label">模块名称</div>
            <input v-model="name" placeholder="例如：工作软件" style="width: 100%" @keyup.enter="save" />
          </div>
          <div class="muted" style="font-size: 12px">保存后可在模块内进一步添加内容（应用、文件、网站等）。</div>
        </template>
      </div>
      <div class="dialog-footer">
        <button v-if="step === 'config'" class="btn" @click="step = 'type'">上一步</button>
        <button class="btn" @click="emit('close')">取消</button>
        <button v-if="step === 'config'" class="btn primary" :disabled="!name.trim()" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.type-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.type-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.type-item:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}

.type-icon {
  display: inline-flex;
  color: var(--accent);
}

.type-desc {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
}
</style>
