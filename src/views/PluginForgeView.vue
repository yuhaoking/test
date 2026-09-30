<script setup lang="ts">
import { computed, ref } from 'vue';
import { plain, showToast } from '../utils';
import type { ForgeResult } from '../../shared/types';

/**
 * AI 造插件向导（T-06）：一句话需求 → AI 生成 → 预览 → 一键安装 → 发布市场。
 * 提示词工程固化于主进程 pluginForge（docs/ai-plugin-prompt.md），DeepSeek 驱动。
 */
const api = window.api;

const prompt = ref('');
const generating = ref(false);
const result = ref<ForgeResult | null>(null);
const activeFile = ref('');
const acting = ref('');

const fileNames = computed(() => Object.keys(result.value?.files ?? {}));
const fileContent = computed(() => (result.value?.files ?? {})[activeFile.value] ?? '');

const EXAMPLES = [
  '做一个显示“距离过年还有多少天”的卡片插件',
  '做一个倒计时工具：输入分钟数，开始后到点弹系统通知并让宠物气泡提醒',
  '做一个文本统计工具：输入文本，统计字数/词频 Top5'
];

async function generate(example?: string): Promise<void> {
  const text = (example || prompt.value).trim();
  if (!text) {
    showToast('先用一句话描述你想要的插件');
    return;
  }
  if (example) prompt.value = example;
  generating.value = true;
  result.value = null;
  try {
    const r = await api.forge.generate(text);
    result.value = r;
    activeFile.value = Object.keys(r.files)[0] ?? 'manifest.json';
    showToast(`已生成插件“${r.manifest.name}”，请审阅代码后安装`);
  } catch (e) {
    showToast(String((e as Error).message ?? e));
  } finally {
    generating.value = false;
  }
}

async function install(): Promise<void> {
  if (!result.value) return;
  acting.value = 'install';
  try {
    await api.forge.install(plain(result.value));
    showToast(`插件“${result.value.manifest.name}”已安装并加载，可在插件管理 / 命令面板使用`);
  } catch (e) {
    showToast(String((e as Error).message ?? e));
  } finally {
    acting.value = '';
  }
}

async function publish(): Promise<void> {
  if (!result.value) return;
  acting.value = 'publish';
  try {
    const dir = await api.forge.publish(plain(result.value));
    if (dir) showToast(`已发布到市场源目录：${dir}（上传到 HTTPS 托管即可被其他用户安装）`);
  } catch (e) {
    showToast(String((e as Error).message ?? e));
  } finally {
    acting.value = '';
  }
}
</script>

<template>
  <div class="forge">
    <p class="desc">
      一句话需求，AI 帮你写插件（DeepSeek 生成 Python 插件，自动写好协议与清单）→ 审阅代码 → 一键安装 /
      发布到插件市场。零代码 5 分钟内拿到可用插件（T-06）。
    </p>
    <textarea
      v-model="prompt"
      rows="3"
      placeholder="描述你想要的插件，如：做一个“显示距离过年还有多少天”的卡片插件…"
      :disabled="generating"
    ></textarea>
    <div class="set-line">
      <button class="btn small primary" :disabled="generating" @click="void generate()">
        {{ generating ? 'AI 生成中…（约 20~60 秒）' : '✨ 生成插件' }}
      </button>
      <span class="hint">灵感：</span>
      <button v-for="ex in EXAMPLES" :key="ex" class="btn small ghost" :disabled="generating" @click="void generate(ex)">
        {{ ex.slice(0, 12) }}…
      </button>
    </div>

    <template v-if="result">
      <div class="result-head">
        <b>{{ result.manifest.name }}</b>
        <span class="hint"
          >v{{ result.manifest.version }} · {{ result.manifest.type === 'pet' ? '宠物插件' : '模块插件' }} ·
          {{ result.manifest.id }}</span
        >
        <span v-if="result.manifest.commands?.length" class="hint"
          >· 命令：{{ result.manifest.commands.map((c) => c.title).join('、') }}</span
        >
      </div>
      <p v-if="result.notes" class="hint">📝 {{ result.notes }}</p>
      <div class="files">
        <div class="file-tabs">
          <button
            v-for="name in ['manifest.json', ...fileNames.filter((n) => n !== 'manifest.json')]"
            :key="name"
            class="file-tab"
            :class="{ on: activeFile === name }"
            @click="activeFile = name"
          >
            {{ name }}
          </button>
        </div>
        <pre class="file-code">{{ activeFile === 'manifest.json' ? JSON.stringify(result.manifest, null, 2) : fileContent }}</pre>
      </div>
      <div class="set-line">
        <button class="btn small primary" :disabled="acting !== ''" @click="void install()">
          {{ acting === 'install' ? '安装中…' : '一键安装并加载' }}
        </button>
        <button class="btn small" :disabled="acting !== ''" @click="void publish()">
          {{ acting === 'publish' ? '发布中…' : '发布到市场源…' }}
        </button>
        <span class="hint">安装会运行生成代码；发布生成 zip + SHA256 + index.json（可上传 HTTPS 托管）</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.forge {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.forge textarea {
  width: 100%;
  resize: vertical;
}

.result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.files {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.file-tabs {
  display: flex;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.file-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.file-tab.on {
  background: var(--card);
  color: var(--text);
}

.file-code {
  margin: 0;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.6;
  background: var(--bg-solid);
  white-space: pre-wrap;
  word-break: break-word;
}

.ghost {
  opacity: 0.85;
}
</style>
