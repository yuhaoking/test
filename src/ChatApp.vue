<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import Icon from './components/Icon.vue';
import type { ChatMessage } from '../shared/types';

/**
 * AI 宠物对话面板（T-05）
 * Enter 发送（Shift+Enter 换行）；显示 Agent 工具调用轨迹；记忆持久化（llm:history/llm:clear）。
 */
const api = window.api;

const messages = ref<ChatMessage[]>([]);
const input = ref('');
const pending = ref(false);
const listening = ref(false);
const autoSpeak = ref(false);
const listEl = ref<HTMLElement | null>(null);

async function scrollBottom(): Promise<void> {
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
}

/** T-05 语音输入：听写 8 秒，识别文本填入输入框 */
async function dictate(): Promise<void> {
  if (listening.value || pending.value) return;
  listening.value = true;
  try {
    const text = (await api.voice.dictate(8)).trim();
    if (text) input.value = text;
  } catch (e) {
    messages.value = [...messages.value, { role: 'assistant', content: `（听不清…${(e as Error).message}）` }];
  } finally {
    listening.value = false;
    void scrollBottom();
  }
}

/** T-05 语音播报：朗读一条回复 */
function speakText(text: string): void {
  void api.voice.speak(text);
}

/** T-05 自动朗读回复开关（与桌宠气泡播报共用设置） */
async function toggleAutoSpeak(): Promise<void> {
  autoSpeak.value = !autoSpeak.value;
  await api.store.updateSettings({ petVoiceEnabled: autoSpeak.value });
  if (!autoSpeak.value) await api.voice.stop();
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || pending.value) return;
  input.value = '';
  messages.value = [...messages.value, { role: 'user', content: text }];
  pending.value = true;
  await scrollBottom();
  try {
    const res = await api.llm.chat(text);
    messages.value = [
      ...messages.value,
      { role: 'assistant', content: res.reply, trace: res.trace.length ? res.trace : undefined }
    ];
  } catch (e) {
    messages.value = [...messages.value, { role: 'assistant', content: `（出错了：${(e as Error).message}）` }];
  } finally {
    pending.value = false;
    void scrollBottom();
  }
}

async function clearAll(): Promise<void> {
  if (!confirm('清空与小鹏的对话记忆？')) return;
  await api.llm.clear();
  messages.value = [];
}

function close(): void {
  window.close();
}

onMounted(async () => {
  try {
    messages.value = await api.llm.history();
  } catch {
    /* 首次使用无历史 */
  }
  try {
    const data = await api.store.get();
    autoSpeak.value = Boolean(data.settings.petVoiceEnabled);
  } catch {
    /* 设置读取失败按关闭处理 */
  }
  void scrollBottom();
});
</script>

<template>
  <div class="chat">
    <header class="chat-head">
      <span class="logo"><Icon name="panda" :size="16" /></span>
      <span class="title">与小鹏聊天</span>
      <span class="spacer"></span>
      <button
        class="icon-btn"
        :class="{ on: autoSpeak }"
        :title="autoSpeak ? '自动朗读回复：开' : '自动朗读回复：关'"
        @click="void toggleAutoSpeak()"
      >
        🔊
      </button>
      <button class="icon-btn" title="清空记忆" @click="void clearAll()"><Icon name="trash" :size="13" /></button>
      <button class="icon-btn" title="关闭" @click="close"><Icon name="close" :size="14" /></button>
    </header>

    <div ref="listEl" class="msg-list">
      <div v-if="!messages.length" class="empty">
        我是小鹏，你的桌面伙伴 🐼<br />
        陪聊、翻译、记待办都可以喊我（需在设置中配置 DeepSeek API Key）
      </div>
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div class="bubble">{{ m.content }}</div>
        <div v-if="m.role === 'assistant'" class="trace">
          <button class="trace-chip speak" title="朗读这条回复" @click="speakText(m.content)">🔊 朗读</button>
          <span v-for="(t, j) in m.trace ?? []" :key="j" class="trace-chip">🔧 {{ t }}</span>
        </div>
      </div>
      <div v-if="pending" class="msg assistant"><div class="bubble dim">小鹏正在想…</div></div>
    </div>

    <footer class="chat-input">
      <button
        class="btn mic"
        :class="{ listening }"
        :title="listening ? '正在听…' : '语音输入（说 8 秒）'"
        :disabled="pending"
        @click="void dictate()"
      >
        {{ listening ? '🎙 正在听…' : '🎙' }}
      </button>
      <textarea
        v-model="input"
        rows="2"
        placeholder="跟我说点什么…（Enter 发送，Shift+Enter 换行）"
        @keydown.enter.exact.prevent="void send()"
      ></textarea>
      <button class="btn primary" :disabled="pending" @click="void send()">发送</button>
    </footer>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}

.chat-head .icon-btn {
  -webkit-app-region: no-drag;
}

.title {
  font-weight: 700;
  font-size: 13px;
}

.msg-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.msg.user {
  align-items: flex-end;
}

.msg.assistant {
  align-items: flex-start;
}

.bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user .bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.bubble.dim {
  color: var(--text-dim);
}

.trace {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.trace-chip {
  font-size: 10px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}

.trace-chip.speak {
  cursor: pointer;
  background: transparent;
}

.trace-chip.speak:hover {
  color: var(--text);
  border-color: var(--accent);
}

.icon-btn.on {
  color: var(--accent);
  border-color: var(--accent);
}

.btn.mic {
  min-width: 42px;
}

.btn.mic.listening {
  border-color: var(--accent);
  color: var(--accent);
  animation: mic-pulse 1s ease-in-out infinite;
}

@keyframes mic-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.chat-input {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  align-items: flex-end;
}

.chat-input textarea {
  flex: 1;
  resize: none;
}
</style>
