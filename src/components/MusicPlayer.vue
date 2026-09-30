<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { formatTime, showToast } from '../utils';
import type { LyricLine, Module, MusicState } from '../../shared/types';

defineProps<{ module: Module }>();

const api = window.api;
const state = ref<MusicState | null>(null);
const coverUrl = ref('');
const seekValue = ref(0);
const seeking = ref(false);
const lyrics = ref<LyricLine[]>([]);
const lyricIndex = ref(-1);
const lyricEl = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
let lyricKey = '';
/** 轮询间隔：主进程侧已有 1.5~5s 自适应缓存，渲染侧 2s 一次即可覆盖进度条更新 */
const POLL_INTERVAL = 2000;
/** 本地文件封面转 data URL 的结果缓存，避免每次轮询重复 IPC 与读取 */
const coverPathCache = new Map<string, string>();

async function coverOf(s: MusicState): Promise<string> {
  const art = s.albumArt ?? '';
  if (!art) return '';
  if (/^https?:/i.test(art)) return art;
  const cached = coverPathCache.get(art);
  if (cached !== undefined) return cached;
  try {
    const url = await api.asset.toUrl(art);
    coverPathCache.set(art, url);
    return url;
  } catch {
    coverPathCache.set(art, '');
    return '';
  }
}

/** UI-7 修复：歌词请求序号 + 可重入保护（旧响应晚到不再覆盖新歌词，setInterval 不会重入） */
let lyricSeq = 0;
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await api.music.state();
    state.value = s;
    if (s.hasSession) {
      if (!seeking.value) seekValue.value = s.positionMs;
      coverUrl.value = await coverOf(s);
      await loadLyrics(s);
      updateLyricLine(s.positionMs);
    } else {
      coverUrl.value = '';
      lyrics.value = [];
      lyricKey = '';
    }
  } finally {
    refreshing = false;
  }
}

async function loadLyrics(s: MusicState): Promise<void> {
  const key = `${s.title}|${s.artist}`;
  if (!s.title || key === lyricKey) return;
  lyricKey = key;
  const seq = ++lyricSeq;
  try {
    const list = await api.music.lyrics(s.title, s.artist);
    // 期间已切歌：丢弃过期响应（并允许后续重新拉取正确歌词）
    if (seq !== lyricSeq || lyricKey !== key) return;
    lyrics.value = list;
  } catch {
    if (seq === lyricSeq && lyricKey === key) lyrics.value = [];
  }
}

function updateLyricLine(posMs: number): void {
  const lines = lyrics.value;
  if (!lines.length) {
    lyricIndex.value = -1;
    return;
  }
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= posMs) idx = i;
    else break;
  }
  if (idx !== lyricIndex.value) {
    lyricIndex.value = idx;
    if (idx >= 0) {
      void nextTick(() => {
        const container = lyricEl.value;
        const el = container?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
        if (!container || !el) return;
        // 用视口相对位置计算元素在容器内容中的偏移，只滚动歌词容器自身
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const top = eRect.top - cRect.top + container.scrollTop;
        const target = top - container.clientHeight / 2 + el.offsetHeight / 2;
        container.scrollTop = Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight));
      });
    }
  }
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    // 窗口隐藏（侧边栏收起）时停止轮询，避免后台持续启动 PowerShell
    if (timer) clearInterval(timer);
    timer = null;
  } else if (!timer) {
    void refresh();
    timer = setInterval(refresh, POLL_INTERVAL);
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  void refresh();
  timer = setInterval(refresh, POLL_INTERVAL);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  document.removeEventListener('visibilitychange', onVisibility);
});

async function control(action: string): Promise<void> {
  state.value = await api.music.control(action);
  seekValue.value = state.value?.positionMs ?? 0;
  coverUrl.value = await coverOf(state.value!);
}

async function onSeek(): Promise<void> {
  try {
    const target = seekValue.value;
    const s = await api.music.control('seek', target);
    state.value = s;
    const moved = Math.abs((s?.positionMs ?? 0) - target);
    if (s?.hasSession && moved > 3000) {
      showToast(`该播放器暂不支持拖动进度（${formatTime(target)} 未响应）`);
    } else {
      showToast(`已跳转到 ${formatTime(target)}`);
    }
    seekValue.value = s?.hasSession ? s.positionMs : target;
  } catch {
    showToast('当前播放器不支持拖动进度');
  } finally {
    seeking.value = false;
  }
}

function onSeekInput(): void {
  seeking.value = true;
}

async function openPlayerWindow(): Promise<void> {
  const ok = await api.music.openPlayer();
  if (!ok) showToast('未找到音乐播放器窗口');
}

const progress = computed(() =>
  state.value && state.value.durationMs ? Math.min(100, (state.value.positionMs / state.value.durationMs) * 100) : 0
);

watch(lyrics, () => {
  lyricIndex.value = -1;
});
</script>

<template>
  <div class="mp">
    <div v-if="state" class="row cover-row">
      <div class="cover" :class="{ playing: state.playing }" title="打开播放器主界面" @click="openPlayerWindow">
        <img v-if="coverUrl" :src="coverUrl" alt="cover" />
        <span v-else class="placeholder"><Icon name="music" :size="20" /></span>
      </div>
      <div class="meta">
        <div class="title">{{ state.title || (state.hasSession ? '未知歌曲' : '暂无播放') }}</div>
        <div class="artist muted">{{ state.artist || '—' }}</div>
        <div class="app muted">{{ state.appId || '系统媒体控制台' }}</div>
      </div>
    </div>
    <div v-else class="empty">正在获取播放状态…</div>

    <template v-if="state && state.hasSession">
      <div class="row seek">
        <span class="time muted">{{ formatTime(state.positionMs) }}</span>
        <input
          class="seeker"
          type="range"
          min="0"
          :max="state.durationMs || 0"
          v-model.number="seekValue"
          @input="onSeekInput"
          @change="onSeek"
          :style="{ '--p': progress + '%' }"
        />
        <span class="time muted">{{ formatTime(state.durationMs) }}</span>
      </div>
      <div class="row ctrls">
        <button class="ctrl-btn" title="上一首" @click="control('prev')"><Icon name="prev" :size="14" /></button>
        <button class="ctrl-btn main" title="播放/暂停" @click="control('toggle')">
          <Icon :name="state.playing ? 'pause' : 'play'" :size="16" />
        </button>
        <button class="ctrl-btn" title="下一首" @click="control('next')"><Icon name="next" :size="14" /></button>
      </div>
      <div ref="lyricEl" class="lyrics">
        <template v-if="lyrics.length">
          <div
            v-for="(line, i) in lyrics"
            :key="i"
            :data-idx="i"
            class="lyric-line"
            :class="{ active: i === lyricIndex }"
          >
            {{ line.text }}
          </div>
        </template>
        <div v-else class="muted lyric-empty">暂无歌词（QQ 音乐歌词源）</div>
      </div>
    </template>
    <div v-else class="muted hint">
      <span style="display: inline-block; text-align: left">
        {{ state && state.title ? '当前未在播放（上方为上次播放信息）' : '当前没有正在播放的媒体' }}<br />
        请确认：① 播放器正在播放音乐且系统"媒体控件"已启用（Win11 设置 → 系统 → 声音 → 媒体控件）<br />
        ② QQ 音乐/网易云等需处于播放状态才暴露媒体会话
      </span>
    </div>
  </div>
</template>

<style scoped>
.mp {
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cover-row {
  align-items: center;
  gap: 12px;
}

.cover {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-hover);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover.playing {
  box-shadow: 0 0 0 2px var(--accent);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.placeholder {
  font-size: 20px;
}

.meta {
  min-width: 0;
  flex: 1;
}

.title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist,
.app {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seek {
  gap: 6px;
}

.time {
  font-size: 11px;
  width: 34px;
  text-align: center;
}

.seeker {
  flex: 1;
  accent-color: var(--accent);
}

.ctrls {
  justify-content: center;
  gap: 14px;
}

.ctrl-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-card);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}

.ctrl-btn:hover {
  background: var(--bg-hover);
}

.ctrl-btn.main {
  width: 40px;
  height: 40px;
  font-size: 16px;
  background: var(--accent);
  color: var(--accent-text);
}

.lyrics {
  max-height: 132px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  scroll-behavior: smooth;
}

.lyric-line {
  font-size: 12px;
  color: var(--text-dim);
  padding: 2px 6px;
  border-radius: 6px;
  line-height: 1.5;
}

.lyric-line.active {
  color: var(--accent);
  font-weight: 600;
  background: var(--bg-card);
}

.lyric-empty {
  font-size: 11px;
  text-align: center;
  padding: 6px;
}

.hint {
  font-size: 11px;
  text-align: center;
  line-height: 1.6;
}
</style>
