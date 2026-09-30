<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { ContextAction, TranslateBarData } from '../shared/types';

/**
 * 划词翻译 / 取词 OCR 悬浮条（T-07，pot 模式）
 * 展示原文/译文（或 OCR 文本），支持复制、朗读、Esc 关闭；失焦由主进程隐藏。
 */
const api = window.api;

const data = ref<TranslateBarData>({ mode: 'translate', source: '', result: '' });
/** WK-07：可配置动作条（默认翻译/搜索/复制/大写/小写/去空白/朗读，可在设置中增删排序） */
const actions = ref<ContextAction[]>([]);

function onShow(d: TranslateBarData): void {
  data.value = d;
  void refreshActions();
}

async function refreshActions(): Promise<void> {
  try {
    actions.value = await api.translateBar.actions();
  } catch {
    actions.value = [];
  }
}

/** 执行动作条动作（翻译 = 重新翻译；其余走主进程上下文动作） */
async function runAction(a: ContextAction): Promise<void> {
  if (!a) return;
  // OCR 模式同样对识别出的文本生效（原文即识别结果）
  const text = data.value.source;
  if (!text) return;
  await api.translateBar.run(a.id, text);
}

/** Ctrl+数字 快捷执行 */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    close();
    return;
  }
  if (!e.ctrlKey || !/^[1-9]$/.test(e.key)) return;
  const a = actions.value[parseInt(e.key, 10) - 1];
  if (!a) return;
  e.preventDefault();
  void runAction(a);
}

async function copy(): Promise<void> {
  const text = data.value.mode === 'ocr' ? data.value.source : data.value.result;
  if (!text || text === '…') return;
  await api.translateBar.copy(text);
  close();
}

function speak(): void {
  const text = data.value.mode === 'ocr' ? data.value.source : data.value.result;
  if (text && text !== '…') void api.translateBar.speak(text);
}

function close(): void {
  api.translateBar.hide();
}



let off: (() => void) | null = null;

onMounted(async () => {
  off = api.translateBar.onShow(onShow);
  window.addEventListener('keydown', onKey);
  try {
    data.value = await api.translateBar.state();
  } catch {
    /* 无状态 */
  }
  void refreshActions();
});

onUnmounted(() => {
  off?.();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="bar" :class="data.mode">
    <header class="bar-head">
      <span class="tag">{{ data.mode === 'ocr' ? 'OCR 取词' : '划词翻译' }}</span>
      <span v-if="data.hint" class="hint">{{ data.hint }}</span>
      <span class="spacer"></span>
      <button class="icon-btn" title="朗读" @click="speak">🔊</button>
      <button class="icon-btn" title="关闭（Esc）" @click="close">✕</button>
    </header>

    <div class="bar-body">
      <div v-if="data.mode === 'translate'" class="pane">
        <div class="label">原文</div>
        <div class="text source">{{ data.source || '—' }}</div>
      </div>
      <div class="pane">
        <div class="label">{{ data.mode === 'ocr' ? '识别文本' : '译文' }}</div>
        <div v-if="data.error" class="text error">{{ data.error }}</div>
        <div v-else class="text result">{{ data.mode === 'ocr' ? data.source || '—' : data.result || '—' }}</div>
      </div>
    </div>

    <!-- WK-07：可配置动作条（Ctrl+数字 快捷执行） -->
    <div class="bar-actions">
      <button
        v-for="(a, i) in actions"
        :key="a.id"
        class="act-chip"
        :class="{ primary: a.id === 'text.translate' }"
        :title="a.id + ' · Ctrl+' + (i + 1)"
        @click="void runAction(a)"
      >
        <span class="act-idx">{{ i + 1 }}</span>
        {{ a.label }}
      </button>
    </div>

    <footer class="bar-foot">
      <button
        class="btn primary"
        :disabled="!!data.error || !(data.mode === 'ocr' ? data.source : data.result) || data.result === '…'"
        @click="void copy()"
      >
        {{ data.mode === 'ocr' ? '复制文本' : '复制译文' }}
      </button>
      <span v-if="data.notice" class="notice">{{ data.notice }}</span>
      <span v-else class="muted">Esc 关闭 · 复制后原剪贴板内容会被替换</span>
    </footer>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.bar-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}

.bar-head .icon-btn {
  -webkit-app-region: no-drag;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--text-dim);
}

.bar-head .icon-btn:hover {
  color: var(--text);
}

.tag {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 1px 6px;
}

.hint {
  font-size: 10px;
  color: var(--text-dim);
}

.bar-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.label {
  font-size: 10px;
  color: var(--text-dim);
  margin-bottom: 2px;
}

.text {
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 88px;
  overflow-y: auto;
}

.text.source {
  color: var(--text-dim);
}

.text.error {
  color: #e5484d;
}

.bar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 7px 10px 0;
}

.act-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
}

.act-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.act-chip.primary {
  border-color: var(--accent);
  color: var(--accent);
}

.act-idx {
  font-size: 9px;
  opacity: 0.55;
}

.notice {
  font-size: 10px;
  color: var(--success, #3ecf8e);
}

.bar-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
}

.muted {
  font-size: 10px;
  color: var(--text-dim);
}

.spacer {
  flex: 1;
}
</style>
