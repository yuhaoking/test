<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useModulesStore } from '../stores/modules';
import Icon from './Icon.vue';
import { showToast, uid } from '../utils';
import type { Module, ServerItem } from '../../shared/types';

const props = defineProps<{ module: Module }>();

const api = window.api;
const store = useModulesStore();
const items = computed<ServerItem[]>(() => (props.module.config.items as ServerItem[] | undefined) ?? []);
const running = ref(new Set<string>());
const logs = ref<Record<string, string>>({});
const openLogs = ref(new Set<string>());
const showAdd = ref(false);
const form = reactive({ type: 'command' as ServerItem['type'], command: '', cwd: '' });

function save(newItems: ServerItem[]): Promise<unknown> {
  const latest = store.modules.find((m) => m.id === props.module.id);
  return store.update(props.module.id, {
    config: { ...(latest?.config ?? props.module.config), items: newItems }
  });
}

function appendLog(itemId: string, data: string): void {
  if (data.includes('[已退出') || data.includes('[已停止')) {
    running.value = new Set([...running.value].filter((id) => id !== itemId));
  }
  logs.value = { ...logs.value, [itemId]: (logs.value[itemId] ?? '') + data };
}

let offLog: (() => void) | null = null;

onMounted(() => {
  offLog = api.servers.onLog((e) => appendLog(e.itemId, e.data));
});

onBeforeUnmount(() => offLog?.());

async function launch(item: ServerItem): Promise<void> {
  let ok = false;
  try {
    ok = await api.servers.launch(JSON.parse(JSON.stringify(item)));
  } catch (e) {
    showToast(`启动失败：${String(e)}`);
    return;
  }
  if (ok) {
    running.value = new Set([...running.value, item.id]);
    openLogs.value = new Set([...openLogs.value, item.id]);
    appendLog(item.id, '');
  } else {
    showToast('启动失败，或该启动项已在运行');
  }
}

async function stop(item: ServerItem): Promise<void> {
  await api.servers.stop(item.id);
  running.value = new Set([...running.value].filter((id) => id !== item.id));
}

function toggleLog(id: string): void {
  const s = new Set(openLogs.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openLogs.value = s;
}

async function addItems(): Promise<void> {
  const lines = form.command
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return;
  const newItems: ServerItem[] = [];
  for (const line of lines) {
    const idx = line.indexOf('|');
    const name = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const command = (idx >= 0 ? line.slice(idx + 1) : line).trim();
    if (!command) continue;
    newItems.push({
      id: `srv-${uid()}`,
      name: name || command.split(/\s+/)[0],
      command,
      cwd: form.cwd.trim() || undefined,
      type: form.type
    });
  }
  if (!newItems.length) return;
  await save([...items.value, ...newItems]);
  showAdd.value = false;
  form.command = '';
  showToast(`已添加 ${newItems.length} 个启动项`);
}

async function removeItem(id: string): Promise<void> {
  const target = items.value.find((i) => i.id === id);
  if (target && running.value.has(id)) await stop(target);
  await save(items.value.filter((i) => i.id !== id));
}

function clearLog(id: string): void {
  logs.value = { ...logs.value, [id]: '' };
}

const TYPE_LABEL: Record<string, string> = {
  command: '命令',
  bat: '批处理',
  python: 'Python',
  exe: '可执行文件',
  remote: '远程'
};
</script>

<template>
  <div class="srv">
    <div class="row" style="padding: 0 12px 8px">
      <span class="muted" style="font-size: 12px">{{ items.length }} 个启动项</span>
      <span class="spacer"></span>
      <button class="btn small primary" @click="showAdd = true"><Icon name="plus" :size="12" />添加</button>
    </div>
    <div class="item-list">
      <div v-for="item in items" :key="item.id" class="srv-item">
        <div class="row head">
          <span class="dot" :class="{ on: running.has(item.id) }"></span>
          <span class="srv-name">{{ item.name }}</span>
          <span class="tag">{{ TYPE_LABEL[item.type] }}</span>
          <span class="spacer"></span>
          <button class="btn small primary" @click="launch(item)">启动</button>
          <button class="btn small danger" @click="stop(item)">停止</button>
          <button class="btn small" @click="toggleLog(item.id)">{{ openLogs.has(item.id) ? '收起' : '日志' }}</button>
          <button class="icon-btn del" title="删除" @click="removeItem(item.id)">
            <Icon name="trash" :size="13" />
          </button>
        </div>
        <div class="cmd muted">{{ item.command }}{{ item.cwd ? `  (${item.cwd})` : '' }}</div>
        <div v-if="openLogs.has(item.id)" class="log-box">
          <pre>{{ logs[item.id] || '（等待输出…）' }}</pre>
          <div class="row footer">
            <button class="btn small" @click="clearLog(item.id)">清空</button>
            <span class="spacer"></span>
            <span class="muted">{{ running.has(item.id) ? '运行中' : '已停止' }}</span>
          </div>
        </div>
      </div>
      <div v-if="!items.length" class="empty">暂无启动项</div>
    </div>

    <div v-if="showAdd" class="dialog-mask" @click.self="showAdd = false">
      <div class="dialog">
        <div class="dialog-header">添加启动项（支持批量）</div>
        <div class="dialog-body">
          <div>
            <div class="label">类型</div>
            <select v-model="form.type" style="width: 100%">
              <option value="command">command（Shell 命令，如 npm run dev）</option>
              <option value="bat">bat（批处理脚本 .bat）</option>
              <option value="python">python（Python 脚本 .py）</option>
              <option value="exe">exe（可执行文件）</option>
              <option value="remote">remote（远程命令，如 ssh user@host）</option>
            </select>
          </div>
          <div>
            <div class="label">命令（每行一个，可写「名称|命令」，名称省略时取命令首词）</div>
            <textarea
              v-model="form.command"
              rows="5"
              placeholder="deepseek|npx @deepseek-ai/dsh web&#10;npm run dev&#10;python D:\server\app.py"
              style="width: 100%; resize: vertical; font-family: Consolas, monospace"
            ></textarea>
          </div>
          <div>
            <div class="label">工作目录 cwd（可选，统一应用到本批）</div>
            <input v-model="form.cwd" placeholder="例如：D:\projects\my-app" style="width: 100%" />
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn" @click="showAdd = false">取消</button>
          <button class="btn primary" :disabled="!form.command.trim()" @click="addItems">批量添加</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.srv {
  padding-bottom: 12px;
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px;
  max-height: 320px;
  overflow-y: auto;
}

.srv-item {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}

.head {
  gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  flex-shrink: 0;
}

.dot.on {
  background: var(--success);
}

.srv-name {
  font-weight: 600;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}

.cmd {
  font-size: 11px;
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.del {
  opacity: 0;
  color: var(--danger);
}

.srv-item:hover .del {
  opacity: 1;
}

.log-box {
  margin-top: 6px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}

.log-box pre {
  font-size: 11px;
  font-family: Consolas, monospace;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  color: var(--text);
  margin-bottom: 6px;
}

.log-box .footer {
  gap: 6px;
  font-size: 11px;
}
</style>
