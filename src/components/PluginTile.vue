<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { showToast } from '../utils';
import type { PluginJob, PluginUiDescriptor, PluginInput } from '../../shared/types';

/**
 * 单个插件的 UI 渲染（PluginModule 聚合卡内部的一栏）。
 * 逻辑与旧版“一插件一卡”完全一致：懒启动、指标轮询、输入/按钮/选择器。
 */
const props = defineProps<{ pluginId: string }>();

const api = window.api;
const ui = ref<PluginUiDescriptor | null>(null);
const failed = ref(false);
const starting = ref(false);
const enabled = ref(false);
const values = reactive<Record<string, string>>({});
let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let retries = 0;
let reqSeq = 0;

const pluginId = props.pluginId;

/**
 * 后台任务（PM-03 异步任务模型，B）：
 * 录屏/转换这类长任务由插件上报进度，宿主登记后随 plugins:changed 广播到这里。
 * 没有任务时整块不渲染，插件卡片外观与之前完全一致。
 */
const jobs = ref<PluginJob[]>([]);
/** 运行期状态提示（只在"非正常"时展示，避免日常噪音） */
const runtimeNote = ref('');

async function refreshJobs(): Promise<void> {
  try {
    const list = await api.plugins.list();
    const me = list.find((p) => p.id === pluginId);
    jobs.value = me?.jobs ?? [];
    const st = me?.runtimeStatus ?? '';
    runtimeNote.value = /^running$|^builtin$|^user$/.test(st) || !st ? '' : st;
  } catch {
    /* 忽略：任务展示失败不影响插件本身 */
  }
}

function jobPercent(job: PluginJob): number {
  return Math.max(0, Math.min(100, Math.round(job.progress ?? 0)));
}

function jobStatusText(job: PluginJob): string {
  if (job.status === 'done') return '已完成';
  if (job.status === 'error') return '失败';
  return job.progress != null ? '进行中 ' + jobPercent(job) + '%' : '进行中';
}

async function refreshUi(start = false): Promise<void> {
  const seq = ++reqSeq;
  try {
    const next = await api.plugins.ui(pluginId, JSON.parse(JSON.stringify({ ...values })), start);
    if (seq !== reqSeq) return;
    if (!next) {
      const list = await api.plugins.list();
      enabled.value = list.some((p) => p.id === pluginId && p.enabled);
      if (start) failed.value = true;
      return;
    }
    const nextInputs = next.inputs ?? [];
    for (const input of nextInputs) {
      if (values[input.id] === undefined) values[input.id] = input.default ?? '';
      if (input.type === 'select' && input.options?.length && !input.options.includes(values[input.id])) {
        values[input.id] = input.options[0];
      }
    }
    ui.value = next;
    failed.value = false;
    retries = 0;
    if (next.metrics?.length) {
      if (!pollTimer) pollTimer = setInterval(() => void refreshUi(), 5000);
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch {
    if (seq !== reqSeq) return;
    if (!ui.value && start) {
      if (retries < 2) {
        starting.value = true;
        retries += 1;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void refreshUi(true), 1500 * retries);
      } else {
        failed.value = true;
        starting.value = false;
      }
    }
  }
}

async function startPlugin(): Promise<void> {
  starting.value = true;
  await refreshUi(true);
  starting.value = false;
}

let offPlugins: (() => void) | null = null;

onMounted(() => {
  void refreshUi(false);
  void refreshJobs();
  // 宿主登记/更新任务后会广播 plugins:changed —— 这是任务进度的唯一推送来源
  offPlugins = api.plugins.onChanged(() => void refreshJobs());
});

watch(
  () => [values.paths, values.dir] as const,
  () => {
    if (!ui.value) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refreshUi(), 450);
  }
);

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  if (retryTimer) clearTimeout(retryTimer);
  if (pollTimer) clearInterval(pollTimer);
  offPlugins?.();
});

async function handleAction(action: string): Promise<void> {
  try {
    const result = await api.plugins.action(pluginId, action, JSON.parse(JSON.stringify({ ...values })));
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r.metrics) && ui.value) {
        ui.value = { ...ui.value, metrics: r.metrics as unknown as PluginUiDescriptor['metrics'] };
      }
      if (typeof r.message === 'string') showToast(r.message);
      // B：动作立即返回 job 时马上刷新一次，用户点完就能看到进度条
      if (r.job) void refreshJobs();
    } else if (typeof result === 'string' && result) {
      showToast(result);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
    showToast(msg || '插件调用失败');
  }
}

async function pickerFor(input: PluginInput): Promise<void> {
  try {
    const picked = input.picker === 'folder' ? await api.settings.pickFolder() : await api.settings.pickFile();
    if (picked) {
      values[input.id] = picked;
      await refreshUi();
    }
  } catch {
    showToast('选择失败');
  }
}
</script>

<template>
  <div v-if="failed" class="empty">插件启动失败（可再次点击启动）</div>
  <div v-else-if="!ui" class="empty start-box">
    <template v-if="starting">插件启动中…</template>
    <template v-else-if="enabled">
      <button class="btn small primary" @click="startPlugin"><Icon name="play" :size="12" />启动插件</button>
      <span class="muted" style="font-size: 11px">进程按需启动，闲置后自动回收</span>
    </template>
    <template v-else>插件未加载（请在插件管理中启用）</template>
  </div>
  <div v-else class="plug">
    <div v-if="ui.text" class="plug-text">{{ ui.text }}</div>
    <div v-if="ui.metrics?.length" class="plug-metrics">
      <div v-for="m in ui.metrics" :key="m.label" class="metric-card">
        <span class="metric-label">{{ m.label }}</span>
        <span class="metric-value">{{ m.value }}</span>
      </div>
    </div>
    <div v-if="ui.inputs?.length" class="plug-inputs">
      <div v-for="input in ui.inputs" :key="input.id" class="plug-input">
        <span class="plug-label">{{ input.label }}</span>
        <select v-if="input.type === 'select'" v-model="values[input.id]" class="plug-field">
          <option v-for="opt in input.options ?? []" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <input
          v-else
          v-model="values[input.id]"
          :type="input.type === 'number' ? 'number' : 'text'"
          :placeholder="input.default || ''"
          class="plug-field"
        />
        <button v-if="input.picker" class="btn small" @click="pickerFor(input)">
          <Icon name="folder" :size="12" />选择
        </button>
      </div>
    </div>
    <!-- 运行期状态：失败原因 / 后台执行 / 空闲回收等（正常运行时为空） -->
    <div v-if="runtimeNote" class="plug-runtime-note" :class="{ err: runtimeNote.startsWith('error') }">
      {{ runtimeNote }}
    </div>
    <!-- B：后台任务进度（无任务时不渲染） -->
    <div v-if="jobs.length" class="plug-jobs">
      <div v-for="job in jobs" :key="job.id" class="job-row" :class="job.status">
        <div class="job-head">
          <span class="job-title">{{ job.title }}</span>
          <span class="job-status">{{ jobStatusText(job) }}</span>
        </div>
        <div v-if="job.status === 'running'" class="job-bar">
          <div class="job-bar-fill" :style="{ width: jobPercent(job) + '%' }"></div>
        </div>
        <div v-if="job.message || job.result" class="job-msg" :title="job.result || job.message">
          {{ job.result || job.message }}
        </div>
      </div>
    </div>
    <div v-if="ui.buttons?.length" class="row" style="padding: 0 12px 12px; flex-wrap: wrap">
      <button v-for="b in ui.buttons" :key="b.id" class="btn small primary" @click="handleAction(b.id)">
        {{ b.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.plug-text {
  padding: 0 12px 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}

.plug-runtime-note {
  margin: 0 12px 8px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
}

.plug-runtime-note.err {
  color: var(--danger);
  background: rgba(229, 72, 77, 0.1);
  border-color: rgba(229, 72, 77, 0.4);
}

.plug-jobs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 12px 10px;
}

.job-row {
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 11px;
  background: rgba(91, 140, 255, 0.06);
}

.job-row.done {
  background: rgba(62, 207, 142, 0.1);
  border-color: rgba(62, 207, 142, 0.4);
}

.job-row.error {
  background: rgba(229, 72, 77, 0.1);
  border-color: rgba(229, 72, 77, 0.4);
}

.job-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.job-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-status {
  color: var(--text-dim);
  flex-shrink: 0;
}

.job-row.error .job-status {
  color: var(--danger);
}

.job-row.done .job-status {
  color: var(--success);
}

.job-bar {
  margin-top: 5px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.job-bar-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

.job-msg {
  margin-top: 4px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plug-metrics {
  display: flex;
  gap: 8px;
  padding: 0 12px 10px;
  overflow-x: auto;
}

.metric-card {
  flex: 1;
  min-width: 90px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.metric-label {
  font-size: 11px;
  color: var(--text-dim);
}

.metric-value {
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
  color: var(--text);
}

.plug-inputs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 12px 10px;
}

.plug-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plug-label {
  font-size: 12px;
  color: var(--text-dim);
  flex-shrink: 0;
  min-width: 52px;
}

.plug-field {
  flex: 1;
  user-select: text;
}
</style>
