<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import Icon from './components/Icon.vue';
import { t } from './i18n';
import { plain } from './utils';
import MusicPlayer from './components/MusicPlayer.vue';
import SystemInfo from './components/SystemInfo.vue';
import type {
  AppData,
  AppItem,
  ContextAction,
  ContextCaptureEvent,
  ContextPayload,
  Module,
  PaletteResult,
  WeatherData
} from '../shared/types';

/**
 * 桌面工作台（DeskBox 参考排版）：
 * ┌ 左：功能列（设置/侧边栏/收纳整理） ┬ 中央：搜索 + 全部应用网格 ┬ 右：可折叠功能卡列 ┐
 * 右侧卡：音乐播放 / 天气日历 / 待办 / 系统信息 / 最近文件。
 * 全部复用现有内核（paletteSearch / appScanner / musicControl / systemInfo / todo）。
 */

const api = window.api;

// ---------- 窗口控制 ----------
function hide(): void {
  api.deskboard.hide();
}

// ---------- 左功能列 ----------
/**
 * 执行功能后自动收起工作台（"用完即走"，默认开启）。
 * 工作台是"呼之即来"的启动面板：执行完功能后留在屏幕上会挡住后面的窗口，
 * 因此默认执行完就收起；需要常驻可在 设置 → 桌面工作台 关闭「执行后自动收起」。
 */
function hideAfterAction(): void {
  if (storeData.value?.settings.deskboardHideAfterAction !== false) api.deskboard.hide();
}

async function actionSettings(): Promise<void> {
  await api.settings.open();
  hideAfterAction();
}
async function actionSidebar(): Promise<void> {
  // 先执行功能再收起：绝不能先 hide() —— 窗口一旦隐藏，渲染进程会被后台节流/冻结，
  // 之后的 await api.sidebar.toggle() 将无法送达主进程（实测：日志里只有 hideDeskboard，没有 toggle）。
  // "执行后收起"由两处兜底：主进程的失焦自动隐藏（可靠）+ 这里的 hideAfterAction()。
  await api.sidebar.toggle();
  hideAfterAction();
}
async function actionOrganize(): Promise<void> {
  await api.boxes.applyRules();
  hideAfterAction();
}
/** 左栏「收藏」：展开右栏文件卡并切到收藏页（不收起工作台——用户正要在这里挑文件） */
async function actionFavorites(): Promise<void> {
  cards.files = true;
  fileTab.value = 'favorite';
  await nextTick();
  filesCard.value?.scrollIntoView({ block: 'nearest' });
}

// ---------- T-14（WK-01 ~ WK-03）：上下文动作区 ----------
/**
 * 呼出工作台时主进程会抓取上下文（选中文本 / 文件路径 / 剪贴板 / 前台应用），
 * 这里按上下文类型展示动作分组；支持固定（Pin）与 Ctrl+数字 快捷执行。
 */
const ctxPayload = ref<ContextPayload>({ type: 'none' });
const ctxActions = ref<ContextAction[]>([]);
const ctxLoading = ref(true);
const ctxNotice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** 上下文类型标签（T-12：改为运行时取词，这样切换语言后无需重载页面） */
const CTX_LABEL = computed<Record<string, string>>(() => ({
  text: t('deskboard.context.text'),
  file: t('deskboard.context.file'),
  url: t('deskboard.context.url'),
  image: t('deskboard.context.image'),
  none: t('deskboard.context.none')
}));

function onContext(e: ContextCaptureEvent): void {
  ctxPayload.value = e.payload ?? { type: 'none' };
  ctxActions.value = e.actions ?? [];
  ctxLoading.value = false;
}

function showNotice(text: string): void {
  ctxNotice.value = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    ctxNotice.value = '';
  }, 2600);
}

async function runAction(a: ContextAction): Promise<void> {
  if (!a) return;
  try {
    const r = await api.deskboard.runContextAction(a.id, plain(ctxPayload.value));
    if (r?.message) showNotice(r.message);
    if (!r?.ok) return;
    // 朗读不收起（用户要听结果），其余动作沿用"用完即走"
    if (a.id !== 'text.speak') hideAfterAction();
  } catch (e) {
    showNotice(t('deskboard.actionFailed', { message: (e as Error).message }));
  }
}

async function togglePinAction(a: ContextAction): Promise<void> {
  try {
    await api.deskboard.pinContextAction(a.id, !a.pinned);
    ctxActions.value = await api.deskboard.contextActions(plain(ctxPayload.value));
  } catch (e) {
    showNotice(t('deskboard.pinFailed', { message: (e as Error).message }));
  }
}

/** Ctrl+1~9 快捷执行（仅在搜索框为空时生效，避免与搜索冲突） */
function onGlobalKey(e: KeyboardEvent): void {
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  if (query.value.trim()) return;
  if (!/^[1-9]$/.test(e.key)) return;
  const idx = parseInt(e.key, 10) - 1;
  const action = ctxActions.value[idx];
  if (!action) return;
  e.preventDefault();
  void runAction(action);
}

const ctxTypeLabel = computed(() => CTX_LABEL.value[ctxPayload.value.type] ?? t('deskboard.context.none'));
const ctxPreview = computed(() => {
  const p = ctxPayload.value;
  if (p.type === 'image') return p.detail ?? '剪贴板图片';
  const t = (p.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return p.detail ?? '';
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
});
const pinnedActions = computed(() => ctxActions.value.filter((a) => a.pinned));
const normalActions = computed(() => ctxActions.value.filter((a) => !a.pinned));

// ---------- 中央：搜索 ----------
const query = ref('');
const results = ref<PaletteResult[]>([]);
const searching = ref(false);
let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const inputEl = ref<HTMLInputElement | null>(null);

async function doSearch(): Promise<void> {
  const s = ++searchSeq;
  if (!query.value.trim()) {
    results.value = [];
    searching.value = false;
    return;
  }
  searching.value = true;
  const list = await api.palette.search(query.value);
  if (s !== searchSeq) return;
  results.value = list;
  searching.value = false;
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void doSearch(), 150);
}

async function execute(r: PaletteResult): Promise<void> {
  if (!r) return;
  query.value = '';
  results.value = [];
  await api.palette.execute(plain(r));
  hideAfterAction();
}

// ---------- 中央：全部应用网格 ----------
const apps = ref<AppItem[]>([]);
const appIcons = reactive<Record<string, string>>({});
const appsLoading = ref(false);

async function loadApps(): Promise<void> {
  if (appsLoading.value || apps.value.length) return;
  appsLoading.value = true;
  try {
    apps.value = await api.apps.scan();
    // 图标（扫描结果自带 icon 缓存路径）
    const updates: Record<string, string> = {};
    for (const a of apps.value) {
      if (a.icon && !appIcons[a.icon]) {
        try {
          updates[a.icon] = await api.asset.toUrl(a.icon);
        } catch {
          /* skip */
        }
      }
    }
    if (Object.keys(updates).length) Object.assign(appIcons, updates);
  } finally {
    appsLoading.value = false;
  }
}

function appLabel(name: string): string {
  return name.replace(/\.(exe|lnk)$/i, '').slice(0, 14);
}

async function openApp(a: AppItem): Promise<void> {
  try {
    await api.files.open(a.path);
  } catch {
    /* 路径失效 */
  }
  // 应用已启动：工作台完成使命，按"用完即走"收起（可在设置中关闭）
  hideAfterAction();
}

const GRID_CAP = 60;
/** 中央视图：home = 搜索+时钟；apps = 全部应用网格（由右栏按钮呼出） */
const view = ref<'home' | 'apps'>('home');
const showAllApps = ref(false);
const visibleApps = computed(() => (showAllApps.value ? apps.value : apps.value.slice(0, GRID_CAP)));

// ---------- 中央：时钟 ----------
const now = ref(new Date());
let clockTimer: ReturnType<typeof setInterval> | null = null;
const timeText = computed(() => {
  const d = now.value;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
});
const dateText = computed(() => {
  const d = now.value;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS_FULL[d.getDay()]}`;
});
const WEEKDAYS_FULL = ['日', '一', '二', '三', '四', '五', '六'];

// ---------- 右侧卡：天气 ----------
const weather = ref<WeatherData | null>(null);
async function loadWeather(): Promise<void> {
  weather.value = await api.weather.get();
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const today = new Date();
const weekDays = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i - today.getDay());
    return { label: d.getDate(), week: `周${WEEKDAYS[d.getDay()]}`, active: i === today.getDay() };
  })
);

// ---------- 右侧卡：待办 ----------
const todos = ref<Array<{ id: string; text: string; done: boolean }>>([]);
const todoInput = ref('');
const todoModuleId = ref('');
/**
 * 工作台共享的应用数据。
 * 必须用 ref：此前是普通变量，而"最近文件/收藏"卡片用 computed 读它 ——
 * 非响应式来源不会让 computed 失效，于是卡片永远停在首帧内容（换台机器看就是"列表不动"）。
 */
const storeData = ref<AppData | null>(null);

function syncTodos(): void {
  const mod = storeData.value?.modules.find((m) => m.type === 'todo_list');
  todos.value = (mod?.config.items as Array<{ id: string; text: string; done: boolean }> | undefined) ?? [];
  todoModuleId.value = mod?.id ?? '';
}

async function addTodo(): Promise<void> {
  const text = todoInput.value.trim();
  if (!text || !todoModuleId.value) return;
  const items = [...todos.value, { id: `todo-${Date.now()}`, text, done: false }];
  await updateTodos(items);
  todoInput.value = '';
}

async function toggleTodo(id: string): Promise<void> {
  const nextDone = !todos.value.find((t) => t.id === id)?.done;
  await updateTodos(todos.value.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  // T-09 情感联动：完成待办时宠物庆祝
  if (nextDone) void window.api.pet.play('jump');
}

async function updateTodos(items: Array<{ id: string; text: string; done: boolean }>): Promise<void> {
  if (!todoModuleId.value) return;
  await api.modules.update(todoModuleId.value, plain({ config: { items } }));
}

const todoProgress = computed(() => {
  if (!todos.value.length) return 0;
  return Math.round((todos.value.filter((t) => t.done).length / todos.value.length) * 100);
});

// ---------- 右侧卡：文件（最近 / 收藏） ----------
/**
 * 左栏「收藏」按钮原先接的是 actionPalette()，而那个函数打开的是**设置窗口** ——
 * 用户点"收藏"却弹出设置，就是反馈里的"工作台小功能无法正常使用"。
 * 收藏数据本来就在 AppData.favoriteFiles 里（由文件管理模块的星标写入），这里直接呈现。
 */
type FileTab = 'recent' | 'favorite';
const fileTab = ref<FileTab>('recent');
const filesCard = ref<HTMLElement | null>(null);
const recents = computed(() => (storeData.value?.recentFiles ?? []).slice(0, 12));
const favorites = computed(() => (storeData.value?.favoriteFiles ?? []).slice(0, 12));
const currentFiles = computed(() => (fileTab.value === 'favorite' ? favorites.value : recents.value));

async function openFile(path: string): Promise<void> {
  try {
    await api.files.open(path);
  } catch {
    /* skip */
  }
}

// ---------- 右侧卡：折叠状态 ----------
const cards = reactive({ weather: true, music: true, todo: true, sysinfo: true, files: true });
function toggleCard(key: keyof typeof cards): void {
  cards[key] = !cards[key];
}

// ---------- 数据流 ----------
function onStore(data: AppData): void {
  storeData.value = data;
  syncTodos();
}

/** 供复用组件占位用（音乐/系统信息组件需要 Module prop） */
const musicModule = {
  id: 'db-music',
  type: 'music_player',
  name: '音乐',
  fixed: true,
  pinned: true,
  order: 0,
  config: {}
} as Module;
const sysModule = {
  id: 'db-sys',
  type: 'system_info',
  name: '系统信息',
  fixed: true,
  pinned: true,
  order: 0,
  config: {}
} as Module;

let offContext: (() => void) | null = null;
let offPaletteResults: (() => void) | null = null;

onMounted(() => {
  window.api.onStore(onStore);
  // T-14（WK-01）：先补齐最近一次抓取结果，再订阅后续推送
  offContext = api.deskboard.onContext(onContext);
  void api.deskboard
    .lastContext()
    .then(onContext)
    .catch(() => {
      ctxLoading.value = false;
    });
  window.addEventListener('keydown', onGlobalKey);
  // T-07：Windows 索引增强结果异步补全（查询未变时才替换，避免打字途中被旧结果覆盖）
  offPaletteResults = api.palette.onResults((e) => {
    if (!e || e.query.trim().toLowerCase() !== query.value.trim().toLowerCase()) return;
    if (Array.isArray(e.list) && e.list.length) results.value = e.list;
  });
  void api.store.get().then((data) => {
    storeData.value = data;
    syncTodos();
  });
  void loadApps();
  void loadWeather();
  // 中央时钟：每分钟刷新（极低开销）
  clockTimer = setInterval(() => {
    now.value = new Date();
  }, 60_000);
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  if (clockTimer) clearInterval(clockTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
  offContext?.();
  offPaletteResults?.();
  window.removeEventListener('keydown', onGlobalKey);
});
</script>

<template>
  <div class="db-root">
    <header class="db-header">
      <span class="db-logo"><Icon name="panda" :size="18" /></span>
      <span class="db-title">小鹏 · 桌面工作台</span>
      <span class="spacer"></span>
      <span class="muted db-hint">{{ t('deskboard.hotkeyHint') }}</span>
      <button class="head-btn" :title="t('deskboard.hide')" @click="hide"><Icon name="close" :size="15" /></button>
    </header>

    <div class="db-body">
      <!-- 左：功能列 -->
      <aside class="db-left">
        <button class="fn-btn" title="打开设置" @click="actionSettings">
          <Icon name="gear" :size="18" /><span>{{ t('deskboard.settings') }}</span>
        </button>
        <button class="fn-btn" title="切换侧边栏" @click="actionSidebar">
          <Icon name="puzzle" :size="18" /><span>{{ t('deskboard.sidebar') }}</span>
        </button>
        <button class="fn-btn" title="收纳盒分类整理" @click="actionOrganize">
          <Icon name="box" :size="18" /><span>{{ t('deskboard.organize') }}</span>
        </button>
        <button class="fn-btn" title="收藏的文件" @click="actionFavorites">
          <Icon name="star" :size="18" /><span>{{ t('deskboard.favorites') }}</span>
        </button>
      </aside>

      <!-- 中：搜索 + 视图切换（home=时钟欢迎区 / apps=全部应用网格，由右栏按钮呼出） -->
      <main class="db-center">
        <!-- T-14（WK-01 ~ WK-03）：上下文动作区 -->
        <section class="ctx-area" :class="{ empty: ctxPayload.type === 'none' }">
          <div class="ctx-head">
            <span class="ctx-badge" :class="ctxPayload.type">{{ ctxTypeLabel }}</span>
            <span v-if="ctxLoading" class="ctx-preview muted">正在识别上下文…</span>
            <span v-else class="ctx-preview" :title="ctxPreview">{{ ctxPreview || ctxPayload.detail || '无可用上下文' }}</span>
            <span v-if="ctxPayload.foregroundApp" class="muted ctx-app">{{ ctxPayload.foregroundApp }}</span>
            <span class="spacer"></span>
            <span v-if="ctxNotice" class="ctx-notice">{{ ctxNotice }}</span>
            <span v-else class="muted ctx-tip">Ctrl+数字 快捷执行 · 右键/📌 固定</span>
          </div>
          <div v-if="ctxActions.length" class="ctx-actions">
            <template v-if="pinnedActions.length">
              <span class="ctx-group-label">常驻</span>
              <button
                v-for="a in pinnedActions"
                :key="'p-' + a.id"
                class="ctx-chip pinned"
                :title="a.id + ' · 点击执行'"
                @click="runAction(a)"
                @contextmenu.prevent="togglePinAction(a)"
              >
                <Icon :name="a.icon" :size="12" />
                <span>{{ a.label }}</span>
                <span class="ctx-pin on">📌</span>
              </button>
            </template>
            <template v-if="normalActions.length">
              <span v-if="pinnedActions.length" class="ctx-group-label">本次</span>
              <button
                v-for="a in normalActions"
                :key="a.id"
                class="ctx-chip"
                :title="a.id + ' · 点击执行（Ctrl+' + a.hotIndex + '）'"
                @click="runAction(a)"
                @contextmenu.prevent="togglePinAction(a)"
              >
                <span v-if="a.hotIndex" class="ctx-idx">{{ a.hotIndex }}</span>
                <Icon :name="a.icon" :size="12" />
                <span>{{ a.label }}</span>
                <span class="ctx-pin">📌</span>
              </button>
            </template>
          </div>
          <div v-else-if="!ctxLoading" class="ctx-actions">
            <span class="muted ctx-tip">
              未识别到可用上下文：先选中文本，或在资源管理器里选中文件，再按 Ctrl+Shift+D 呼出
            </span>
          </div>
        </section>

        <div class="search-area">
          <div class="search-row">
            <Icon name="search" :size="17" />
            <input
              ref="inputEl"
              v-model="query"
              class="db-search"
              placeholder="搜索文件、应用、网站、功能…（拼音/首字母）"
              @input="onSearchInput"
              @keydown.enter="execute(results[0])"
            />
          </div>
          <div v-if="results.length" class="search-results">
            <div
              v-for="(r, i) in results.slice(0, 8)"
              :key="r.id"
              class="search-row-item"
              :class="{ active: i === 0 }"
              @click="execute(r)"
            >
              <span class="cat-dot" :class="r.category"></span>
              <span class="r-label">{{ r.label }}</span>
              <span class="muted r-sub">{{ r.sublabel }}</span>
            </div>
          </div>
        </div>

        <!-- home：时钟 + 欢迎区（右栏按钮可切到应用网格） -->
        <div v-if="view === 'home'" class="home-area">
          <div class="clock-card">
            <div class="clock-time">{{ timeText }}</div>
            <div class="muted clock-date">{{ dateText }}</div>
          </div>
          <div class="home-hint muted">
            点击右侧「全部应用」浏览已安装软件；顶部搜索框统搜文件/应用/网站/插件/待办；
            右侧功能卡（音乐/天气/待办/系统信息/最近文件）常驻。
          </div>
        </div>

        <!-- apps：全部应用网格（由右栏按钮呼出，返回按钮切回） -->
        <div v-else class="apps-view">
          <div class="grid-head">
            <button class="btn small" @click="view = 'home'"><Icon name="up" :size="12" />返回</button>
            <span class="muted">全部应用</span>
            <span class="spacer"></span>
            <span class="muted">{{ apps.length }} 个</span>
            <button v-if="apps.length > GRID_CAP" class="btn small" @click="showAllApps = !showAllApps">
              {{ showAllApps ? '收起' : '显示全部' }}
            </button>
          </div>
          <div class="app-grid">
            <div v-for="a in visibleApps" :key="a.path" class="app-tile" :title="a.name" @click="openApp(a)">
              <img v-if="a.icon && appIcons[a.icon]" :src="appIcons[a.icon]" class="app-ico-img" alt="" />
              <span v-else class="app-ico-fallback">{{ appLabel(a.name).slice(0, 1) }}</span>
              <span class="app-name">{{ appLabel(a.name) }}</span>
            </div>
            <div v-if="appsLoading && !apps.length" class="empty">正在扫描已安装应用…</div>
          </div>
        </div>
      </main>

      <!-- 右：功能卡列（常驻） -->
      <aside class="db-right">
        <section class="db-card apps-entry">
          <button class="apps-btn" :class="{ on: view === 'apps' }" @click="view = view === 'apps' ? 'home' : 'apps'">
            <Icon name="rocket" :size="15" />
            <span class="apps-btn-label">全部应用</span>
            <span class="muted">{{ apps.length }} 个</span>
          </button>
        </section>
        <section v-if="cards.music" class="db-card">
          <header class="card-head" @click="toggleCard('music')">
            <Icon name="music" :size="13" /><span>{{ t('deskboard.card.music') }}</span><span class="spacer"></span
            ><Icon name="down" :size="12" class="fold" />
          </header>
          <div class="card-body">
            <MusicPlayer :module="musicModule" />
          </div>
        </section>

        <section v-if="cards.weather" class="db-card">
          <header class="card-head" @click="toggleCard('weather')">
            <Icon name="globe" :size="13" /><span>天气 · 日历</span><span class="spacer"></span
            ><Icon name="down" :size="12" class="fold" />
          </header>
          <div class="card-body">
            <div v-if="weather" class="weather-now">
              <span class="w-temp"
                >{{ weather.tempC ?? '—' }}<small>°{{ weather.tempC != null ? 'C' : '' }}</small></span
              >
              <div class="w-meta">
                <div>{{ weather.desc || '未知' }} · {{ weather.city || '当前城市' }}</div>
                <div class="muted">
                  体感 {{ weather.feelsC ?? '—' }}℃ · 湿度 {{ weather.humidity ?? '—' }}% · 风速
                  {{ weather.windKmh ?? '—' }} km/h
                </div>
              </div>
            </div>
            <div v-else class="muted">天气不可用（离线/超时）</div>
            <div class="week-row">
              <div v-for="d in weekDays" :key="d.label" class="week-cell" :class="{ active: d.active }">
                <span class="muted">{{ d.week }}</span>
                <span class="week-num">{{ d.label }}</span>
              </div>
            </div>
            <div v-if="weather && weather.forecast.length" class="forecast-row">
              <div v-for="f in weather.forecast.slice(0, 4)" :key="f.date" class="forecast-cell">
                <span class="muted">{{ f.date.slice(5) }}</span>
                <span>{{ f.maxC ?? '—' }}° / {{ f.minC ?? '—' }}°</span>
              </div>
            </div>
          </div>
        </section>

        <section v-if="cards.todo" class="db-card">
          <header class="card-head" @click="toggleCard('todo')">
            <Icon name="check" :size="13" /><span>待办</span><span class="spacer"></span
            ><span class="muted">{{ todoProgress }}%</span><Icon name="down" :size="12" class="fold" />
          </header>
          <div class="card-body">
            <div class="row">
              <input v-model="todoInput" class="min-input" :placeholder="t('deskboard.card.todo') + '…'" @keyup.enter="addTodo" />
              <button class="btn small primary" @click="addTodo">{{ t('common.apply') }}</button>
            </div>
            <div v-if="todos.length" class="todo-list">
              <!-- 循环变量用 todo：t 是 i18n 取词函数，v-for 的 t 会把它遮蔽（eslint vue/no-template-shadow） -->
              <div v-for="todo in todos" :key="todo.id" class="todo-row" @click="toggleTodo(todo.id)">
                <span class="todo-check" :class="{ on: todo.done }">{{ todo.done ? '✓' : '' }}</span>
                <span class="todo-text" :class="{ done: todo.done }">{{ todo.text }}</span>
              </div>
            </div>
            <div v-else class="empty">{{ t('deskboard.card.todo') }} · {{ t('common.empty') }}</div>
          </div>
        </section>

        <section v-if="cards.sysinfo" class="db-card">
          <header class="card-head" @click="toggleCard('sysinfo')">
            <Icon name="chart" :size="13" /><span>系统信息</span><span class="spacer"></span
            ><Icon name="down" :size="12" class="fold" />
          </header>
          <div class="card-body">
            <SystemInfo :module="sysModule" />
          </div>
        </section>

        <section v-if="cards.files" ref="filesCard" class="db-card">
          <header class="card-head" @click="toggleCard('files')">
            <Icon name="folder" :size="13" /><span>{{ t('deskboard.card.files') }}</span><span class="spacer"></span
            ><Icon name="down" :size="12" class="fold" />
          </header>
          <div class="card-body">
            <div class="file-tabs">
              <button :class="{ on: fileTab === 'recent' }" @click.stop="fileTab = 'recent'">{{ t('deskboard.tab.recent') }}</button>
              <button :class="{ on: fileTab === 'favorite' }" @click.stop="fileTab = 'favorite'">
                {{ t('deskboard.tab.favorite') }}<span v-if="favorites.length"> {{ favorites.length }}</span>
              </button>
            </div>
            <div v-if="currentFiles.length" class="file-list">
              <div v-for="f in currentFiles" :key="f.path" class="file-row" :title="f.path" @click="openFile(f.path)">
                <Icon :name="fileTab === 'favorite' ? 'star' : 'file'" :size="12" />
                <span class="file-name">{{ f.path.split(/[\\/]/).pop() }}</span>
              </div>
            </div>
            <div v-else class="empty">
              {{ fileTab === 'recent' ? t('deskboard.emptyRecents') : t('deskboard.emptyFavorites') }}
            </div>
          </div>
        </section>

        <section class="db-card" style="flex: 1">
          <header class="card-head"><Icon name="panda" :size="13" /><span>小鹏工具箱</span></header>
          <div class="card-body placeholder-body">
            <div class="muted">宠物 / 侧边栏 / 收纳盒 / 插件 均由下方系统托盘与设置管理</div>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.db-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: rgba(14, 16, 22, 0.82);
  backdrop-filter: blur(26px) saturate(1.25);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #e8eaf0;
  overflow: hidden;
  box-shadow: 0 14px 48px rgba(0, 0, 0, 0.5);
}

.db-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 8px;
  flex-shrink: 0;
  -webkit-app-region: drag;
  user-select: none;
}

.db-logo {
  color: var(--accent);
  display: inline-flex;
}

.db-title {
  font-weight: 600;
  font-size: 14px;
}

.db-hint {
  font-size: 11px;
  opacity: 0.5;
}

.head-btn {
  -webkit-app-region: no-drag;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
}

.head-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  opacity: 1;
}

.db-body {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 4px 14px 12px;
  min-height: 0;
}

.db-left {
  width: 64px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 8px;
}

.fn-btn {
  height: 56px;
  border: none;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 10px;
  cursor: pointer;
}

.fn-btn:hover {
  background: rgba(91, 140, 255, 0.18);
}

.db-center {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-right: 4px;
}

/* T-14：上下文动作区 */
.ctx-area {
  flex-shrink: 0;
  margin-bottom: 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  padding: 7px 10px 8px;
}

.ctx-area.empty {
  opacity: 0.7;
}

.ctx-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  min-width: 0;
}

.ctx-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.ctx-badge.text {
  color: #8fb4ff;
  border-color: #5b8cff;
}
.ctx-badge.file {
  color: #6ee7b7;
  border-color: #3ecf8e;
}
.ctx-badge.url {
  color: #f7d47a;
  border-color: #f7b500;
}
.ctx-badge.image {
  color: #ffb27a;
  border-color: #ff8a3d;
}
.ctx-badge.none {
  color: rgba(232, 234, 240, 0.5);
}

.ctx-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46%;
  opacity: 0.85;
}

.ctx-app {
  flex-shrink: 0;
  opacity: 0.45;
}

.ctx-notice {
  flex-shrink: 0;
  color: #6ee7b7;
  font-size: 11px;
}

.ctx-tip {
  opacity: 0.5;
}

.ctx-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.ctx-group-label {
  font-size: 10px;
  opacity: 0.45;
  margin-right: 2px;
}

.ctx-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ctx-chip:hover {
  background: rgba(91, 140, 255, 0.24);
  border-color: rgba(91, 140, 255, 0.5);
}

.ctx-chip.pinned {
  background: rgba(247, 181, 0, 0.14);
  border-color: rgba(247, 181, 0, 0.42);
}

.ctx-idx {
  font-size: 10px;
  opacity: 0.55;
  min-width: 8px;
  text-align: center;
}

.ctx-pin {
  font-size: 10px;
  opacity: 0;
  transition: opacity 0.12s;
}

.ctx-chip:hover .ctx-pin {
  opacity: 0.75;
}

.ctx-pin.on {
  opacity: 1;
}

.search-area {
  position: relative;
  flex-shrink: 0;
  margin-bottom: 10px;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.db-search {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 14px;
}

.db-search::placeholder {
  color: rgba(232, 234, 240, 0.35);
}

.search-results {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  background: rgba(18, 20, 27, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  overflow: hidden;
  max-height: 320px;
  overflow-y: auto;
}

.search-row-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
}

.search-row-item.active,
.search-row-item:hover {
  background: rgba(91, 140, 255, 0.18);
}

.cat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.r-label {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.r-sub {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.home-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 20px;
}

.clock-card {
  text-align: center;
}

.clock-time {
  font-size: 64px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.02em;
}

.clock-date {
  margin-top: 8px;
  font-size: 14px;
}

.home-hint {
  font-size: 12px;
  max-width: 420px;
  text-align: center;
  line-height: 1.8;
  opacity: 0.55;
}

.apps-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.apps-entry {
  padding: 4px;
}

.apps-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.apps-btn:hover,
.apps-btn.on {
  background: rgba(91, 140, 255, 0.2);
}

.apps-btn-label {
  flex: 1;
  text-align: left;
}

.grid-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 6px;
  font-size: 12px;
  flex-shrink: 0;
}

.app-grid {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 6px;
}

.app-tile {
  width: calc(25% - 6px);
  min-width: 84px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 10px 4px;
  border-radius: 10px;
  cursor: pointer;
}

.app-tile:hover {
  background: rgba(255, 255, 255, 0.07);
}

.app-ico-img {
  width: 38px;
  height: 38px;
  object-fit: contain;
}

.app-ico-fallback {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: #9db9ff;
}

.app-name {
  font-size: 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 文件卡的「最近 / 收藏」切换（左栏「收藏」按钮会切到这里） */
.file-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 6px;
}

.file-tabs button {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.file-tabs button.on {
  color: var(--accent);
  border-color: var(--accent);
}

.db-right {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.db-card {
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.07);
  overflow: hidden;
  flex-shrink: 0;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.fold {
  opacity: 0.6;
}

.card-body {
  padding: 0 4px 8px;
  font-size: 12px;
}

.placeholder-body {
  padding: 10px;
}

.min-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.25);
  color: inherit;
  font-size: 12px;
}

.weather-now {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 6px;
}

.w-temp {
  font-size: 26px;
  font-weight: 700;
}

.w-temp small {
  font-size: 12px;
  font-weight: 400;
}

.w-meta {
  font-size: 11px;
  line-height: 1.6;
  min-width: 0;
}

.week-row {
  display: flex;
  gap: 4px;
  padding: 2px 8px 6px;
}

.week-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  padding: 4px 0;
  border-radius: 6px;
}

.week-cell.active {
  background: rgba(91, 140, 255, 0.25);
}

.week-num {
  font-size: 13px;
  font-weight: 600;
}

.forecast-row {
  display: flex;
  gap: 4px;
  padding: 0 8px 4px;
}

.forecast-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 10px;
  gap: 2px;
}

.todo-list {
  max-height: 180px;
  overflow-y: auto;
  padding-top: 2px;
}

.todo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
}

.todo-row:hover {
  background: rgba(255, 255, 255, 0.06);
}

.todo-check {
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  flex-shrink: 0;
}

.todo-check.on {
  background: #3ecf8e;
  border-color: #3ecf8e;
  color: #10131a;
}

.todo-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.todo-text.done {
  text-decoration: line-through;
  opacity: 0.5;
}

.file-list {
  max-height: 200px;
  overflow-y: auto;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
}

.file-row:hover {
  background: rgba(255, 255, 255, 0.06);
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态色 */
.cat-dot.app {
  background: #5b8cff;
}
.cat-dot.file {
  background: #3ecf8e;
}
.cat-dot.website {
  background: #f7b500;
}
.cat-dot.function {
  background: #b06ef7;
}
.cat-dot.plugin {
  background: #ff8a3d;
}
.cat-dot.todo {
  background: #e5484d;
}
</style>
