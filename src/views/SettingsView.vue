<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useSettingsStore } from '../stores/settings';
import Icon from '../components/Icon.vue';
import DesktopBoxCard from '../components/DesktopBoxCard.vue';
import { t } from '../i18n';
import { LOCALES as LOCALES_LIST, normalizeSystemLocale } from '../../shared/i18n/index.ts';
import { formatBytes, showToast } from '../utils';
import PluginStoreView from './PluginStoreView.vue';
import ClipboardView from './ClipboardView.vue';
import MarketView from './MarketView.vue';
import SystemIntegrationView from './SystemIntegrationView.vue';
import type { AppInfo, PerfUsage, ThemePackInfo } from '../../shared/types';

const api = window.api;
const settings = useSettingsStore();
type TabKey = 'general' | 'pet' | 'sidebar' | 'privacy' | 'plugins' | 'boxes' | 'palette' | 'deskboard' | 'clipboard' | 'market' | 'system';
const TAB_KEYS: TabKey[] = ['general', 'pet', 'sidebar', 'privacy', 'plugins', 'boxes', 'palette', 'deskboard', 'clipboard', 'market', 'system'];
// 支持深链（如命令面板“打开插件市场”→ settings.html?tab=market）
const initialTab = (new URLSearchParams(location.search).get('tab') ?? 'general') as TabKey;
const tab = ref<TabKey>(TAB_KEYS.includes(initialTab) ? initialTab : 'general');
const hotkeyDraft = ref('');
const paletteHotkeyDraft = ref('');
const deskboardHotkeyDraft = ref('');
const paletteExclDraft = ref('');
const appInfo = ref<AppInfo | null>(null);
const petImageUrl = ref('');

const s = computed(() => settings.settings);

// 进入宠物页时刷新 MCP 服务状态（T-05）；通用页刷新资源占用（T-10）；隐私页刷新加密留存包（T-11）
watch(tab, (t) => {
  if (t === 'pet') {
    void refreshMcp();
    void refreshThemes();
  }
  if (t === 'general') void refreshPerf();
  if (t === 'privacy') void refreshSecure();
  if (t === 'palette') void refreshSearchBackend();
});

// ---- T-10：性能模式与资源占用可视化 ----
const perfUsage = ref<PerfUsage | null>(null);

async function refreshPerf(): Promise<void> {
  try {
    perfUsage.value = await api.perf.usage();
  } catch {
    /* 展示失败静默 */
  }
}

async function onPerfMode(mode: 'balanced' | 'saver' | 'custom'): Promise<void> {
  await settings.update({ perfMode: mode });
  void refreshPerf();
}

function onPerfAnim(e: Event): void {
  void settings.update({ perfAnimations: (e.target as HTMLInputElement).checked }).then(refreshPerf);
}

function onPerfIdle(e: Event): void {
  void settings.update({ perfIdleRelease: (e.target as HTMLInputElement).checked }).then(refreshPerf);
}

/** 幽灵窗口排查：禁用硬件加速（需重启生效） */
function onGpuAccel(e: Event): void {
  const on = (e.target as HTMLInputElement).checked;
  void settings.update({ disableGpuAccel: on }).then(() => {
    showToast(on ? '已开启禁用硬件加速，请重启应用生效' : '已恢复硬件加速，请重启应用生效');
  });
}

function fmtUptime(sec: number | undefined): string {
  if (sec == null) return '…';
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m} 分 ${sec % 60} 秒` : `${sec} 秒`;
}

// ---- T-11：插件安装包加密留存 ----
const secureInfo = ref<{ count: number; sizeMB: number; dir: string } | null>(null);

async function refreshSecure(): Promise<void> {
  try {
    secureInfo.value = await api.market.secureInfo();
  } catch {
    /* 展示失败静默 */
  }
}

/** GW-01 / OPT-14：窗口活性探测开关（默认开启） */
async function toggleLivenessProbe(): Promise<void> {
  await settings.update({ windowLivenessProbe: s.value.windowLivenessProbe === false });
  showToast(s.value.windowLivenessProbe ? '已开启窗口活性探测' : '已关闭窗口活性探测（幽灵窗口将只能手动修复）');
}

async function toggleMarketEncrypt(): Promise<void> {
  await settings.update({ marketEncryptPackages: !s.value.marketEncryptPackages });
  showToast(s.value.marketEncryptPackages ? '已开启安装包加密留存（AES-256-GCM）' : '已关闭安装包加密留存');
  void refreshSecure();
}

async function clearSecurePackages(): Promise<void> {
  if (!confirm(`清理全部加密留存的安装包（${secureInfo.value?.count ?? 0} 个）？不影响已安装插件。`)) return;
  const n = await api.market.clearSecure();
  showToast(`已清理 ${n} 个加密留存包`);
  void refreshSecure();
}

const ACCENTS = ['#5b8cff', '#3ecf8e', '#f7b500', '#e5484d', '#b06ef7', '#ff8a3d'];

const ACTIONS = [
  { key: 'nod', label: '点头' },
  { key: 'wave', label: '摆手' },
  { key: 'blink', label: '眨眼' },
  { key: 'jump', label: '跳动' }
];

// ---------- v2.0：桌面收纳 / 命令面板 ----------

async function toggleBoxesEnabled(): Promise<void> {
  await settings.update({ desktopBoxesEnabled: !s.value.desktopBoxesEnabled });
  showToast(s.value.desktopBoxesEnabled ? '桌面收纳已启用' : '桌面收纳已关闭（盒子窗口隐藏）');
}

async function toggleMoveMode(): Promise<void> {
  await settings.update({ boxMoveMode: !s.value.boxMoveMode });
  showToast(
    s.value.boxMoveMode
      ? '已切换为“真移动”模式（拖入文件将移动到目标目录）'
      : '已切换为“仅整理视图”（只建立索引，不移动文件）'
  );
}

async function toggleBoxAutoMode(): Promise<void> {
  await settings.update({ boxAutoMode: !s.value.boxAutoMode });
  showToast(s.value.boxAutoMode ? '智能分类已开启（监听桌面新增文件，自动归入类别盒）' : '智能分类已关闭');
}

async function toggleHideIcons(): Promise<void> {
  await settings.update({ hideDesktopIcons: !s.value.hideDesktopIcons });
  showToast('设置已保存；部分系统需重启资源管理器后生效');
}

async function togglePaletteEnabled(): Promise<void> {
  await settings.update({ paletteEnabled: !s.value.paletteEnabled });
  showToast(s.value.paletteEnabled ? '命令面板已启用' : '命令面板已关闭');
}

// ---------- 桌面工作台（DeskBox 式主面板） ----------
async function toggleDeskboardEnabled(): Promise<void> {
  await settings.update({ deskboardEnabled: !s.value.deskboardEnabled });
  showToast(s.value.deskboardEnabled ? '桌面工作台已启用（启动即显示）' : '桌面工作台已关闭');
}

async function applyDeskboardHotkey(): Promise<void> {
  await settings.update({ deskboardHotkey: deskboardHotkeyDraft.value.trim() });
  showToast('工作台热键已更新；若被占用请更换快捷键');
}

/** 非常驻模式：执行功能后自动收起工作台 */
async function toggleDeskboardHideAfterAction(): Promise<void> {
  await settings.update({ deskboardHideAfterAction: !s.value.deskboardHideAfterAction });
  showToast(s.value.deskboardHideAfterAction ? '工作台将在执行功能后自动收起' : '工作台将保持显示（不自动收起）');
}

/** 是否随启动自动显示工作台 */
async function toggleDeskboardShowOnStartup(): Promise<void> {
  await settings.update({ deskboardShowOnStartup: !s.value.deskboardShowOnStartup });
  showToast(
    s.value.deskboardShowOnStartup ? '工作台将在启动时自动显示' : '工作台改为按需呼出（热键 / 托盘），不再常驻'
  );
}

/** T-14（WK-04）：工作台呼出时是否自动抓取上下文 */
async function toggleDeskboardContextCapture(): Promise<void> {
  await settings.update({ deskboardContextCapture: !s.value.deskboardContextCapture });
  showToast(
    s.value.deskboardContextCapture
      ? '已开启上下文感知（呼出工作台时模拟取词，其间会短暂占用剪贴板并自动恢复）'
      : '已关闭上下文感知：工作台行为与之前完全一致'
  );
}

/** T-14（WK-03）：清空工作台固定动作 */
async function clearDeskboardPins(): Promise<void> {
  await settings.update({ deskboardPins: [] });
  showToast('已清空工作台固定的动作');
}

// ---- T-07：搜索内核（Everything / Windows 搜索索引 / 内置遍历） ----
const searchBackend = ref<{ everything: boolean; windowsIndex: boolean } | null>(null);

async function refreshSearchBackend(): Promise<void> {
  try {
    searchBackend.value = await api.search.backend();
  } catch {
    searchBackend.value = null;
  }
}

async function toggleWindowsIndex(): Promise<void> {
  await settings.update({ searchUseWindowsIndex: !s.value.searchUseWindowsIndex });
  showToast(
    s.value.searchUseWindowsIndex
      ? '已启用 Windows 搜索索引兜底（无 Everything 时用它快速找文件）'
      : '已关闭 Windows 搜索索引兜底（仅用内置目录遍历）'
  );
}

/** T-14（CP-07）：命令面板粘贴智能匹配 */
async function togglePaletteSmartSuggest(): Promise<void> {
  await settings.update({ paletteSmartSuggest: !s.value.paletteSmartSuggest });
  showToast(s.value.paletteSmartSuggest ? '已开启粘贴智能匹配（面板打开时推荐对应动作）' : '已关闭粘贴智能匹配');
}

async function applyPaletteHotkey(): Promise<void> {
  await settings.update({ paletteHotkey: paletteHotkeyDraft.value.trim() });
  showToast('命令面板热键已更新；若被占用请更换快捷键');
}

async function onPaletteSort(): Promise<void> {
  await settings.update({ paletteSort: s.value.paletteSort });
}

async function applyPaletteExclude(): Promise<void> {
  const exts = paletteExclDraft.value
    .split(',')
    .map((x) => x.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  await settings.update({ paletteExcludeExts: exts });
  showToast('搜索排除类型已保存');
}

async function applyHotkey(): Promise<void> {
  await settings.update({ hotkey: hotkeyDraft.value.trim() });
  showToast('全局快捷键已更新');
}

async function pickPetImage(): Promise<void> {
  const p = await api.settings.pickImage();
  if (p) {
    await settings.update({ petImage: p });
    void loadPetImage();
  }
}

async function resetPetImage(): Promise<void> {
  await settings.update({ petImage: '' });
  petImageUrl.value = '';
  showToast('已恢复默认宠物图片');
}

async function loadPetImage(): Promise<void> {
  petImageUrl.value = '';
  if (s.value.petImage) {
    try {
      petImageUrl.value = await api.asset.toUrl(s.value.petImage);
    } catch {
      petImageUrl.value = '';
    }
  }
}

async function pickFrames(action: string): Promise<void> {
  const paths = await api.settings.pickFrames(action);
  if (paths?.length) {
    await settings.update({ petActions: { ...s.value.petActions, [action]: paths } });
    showToast(`${action} 帧已更新（${paths.length} 张）`);
  }
}

async function clearFrames(action: string): Promise<void> {
  await settings.update({ petActions: { ...s.value.petActions, [action]: [] } });
}

// ---------- T-06：UGC 主题包（制作 / 导入 / 分享） ----------

const themes = ref<ThemePackInfo[]>([]);
/** id → 预览图 URL（内置默认形象没有实体文件，用占位图） */
const themePreviews = ref<Record<string, string>>({});
const themeMaking = ref(false);
/** 应用主题时是否同时套用包内界面皮肤（默认不套用） */
const themeSkin = ref(false);
const themeDraft = ref({
  name: '',
  author: '',
  description: '',
  version: '1.0.0',
  license: 'CC-BY-4.0',
  homepage: '',
  tags: ''
});

// ---------- T-12：界面语言 ----------
const LOCALES = LOCALES_LIST;
/** 跟随系统时，把系统语言显示出来（否则"跟随系统"是个黑盒，用户不知道实际生效哪种） */
const systemLocaleLabel = computed(() => LOCALES_LIST.find((l) => l.id === normalizeSystemLocale(navigator.language))?.label ?? navigator.language);

async function onLocale(value: string): Promise<void> {
  await settings.update({ locale: value });
  const name = value === 'auto' ? systemLocaleLabel.value : (LOCALES_LIST.find((l) => l.id === value)?.label ?? value);
  showToast(t('settings.language.changed', { name }));
}

const activeThemeName = computed(() => themes.value.find((t) => t.active)?.manifest.name ?? '默认形象');
const frameTotal = computed(() =>
  Object.values(s.value.petActions ?? {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0)
);

async function refreshThemes(): Promise<void> {
  themes.value = await api.theme.list();
  const urls: Record<string, string> = {};
  for (const t of themes.value) {
    if (t.builtin || !t.manifest.image) continue;
    try {
      urls[t.manifest.id] = await api.asset.toUrl(`${t.dir}/${t.manifest.image}`);
    } catch {
      /* 预览图取不到不影响列表可用 */
    }
  }
  themePreviews.value = urls;
}

async function importThemePack(): Promise<void> {
  const r = await api.theme.import();
  if (!r) return; // 用户取消
  if (r.ok) {
    await refreshThemes();
    showToast(`已导入主题包：${r.info?.manifest.name ?? ''}`);
    return;
  }
  if (r.exists) {
    if (!confirm('已安装同 id 的主题包，是否覆盖更新？')) return;
    const r2 = await api.theme.importConfirm();
    if (r2.ok) {
      await refreshThemes();
      showToast('主题包已覆盖更新');
    } else {
      showToast(r2.error ?? '导入失败');
    }
    return;
  }
  showToast(r.error ?? '导入失败');
}

async function applyThemePack(theme: ThemePackInfo): Promise<void> {
  const r = await api.theme.apply(theme.manifest.id, themeSkin.value);
  if (!r.ok) {
    showToast(r.error ?? '应用失败');
    return;
  }
  await loadPetImage();
  await refreshThemes();
  showToast(`已应用主题：${theme.manifest.name}`);
}

async function deleteThemePack(theme: ThemePackInfo): Promise<void> {
  if (!confirm(`删除主题包“${theme.manifest.name}”？包内文件会被移除（你在设置里单独选过的图片不受影响）`)) return;
  const r = await api.theme.remove(theme.manifest.id);
  if (!r.ok) {
    showToast(r.error ?? '删除失败');
    return;
  }
  await refreshThemes();
  await loadPetImage();
  showToast('主题包已删除');
}

async function exportThemePack(theme: ThemePackInfo): Promise<void> {
  const r = await api.theme.exportPack(theme.manifest.id);
  if ('error' in r) {
    showToast(r.error);
    return;
  }
  if (!r.path) return; // 取消保存
  showToast(`已导出主题包：${r.path}`);
}

/** 复制分享文案到剪贴板（社区发帖用，与创意工坊的"投稿帖"习惯对齐） */
async function copyThemeShare(theme: ThemePackInfo): Promise<void> {
  const text = await api.theme.shareText(theme.manifest.id);
  if (!text) {
    showToast('暂时拿不到分享文案');
    return;
  }
  await api.clipboard.setText(text);
  showToast('分享文案已复制（含 SHA256 与安装说明）');
}

async function submitThemePack(): Promise<void> {
  if (!themeDraft.value.name.trim()) {
    showToast('请先填写主题名称');
    return;
  }
  const r = await api.theme.create({
    name: themeDraft.value.name.trim(),
    author: themeDraft.value.author.trim(),
    description: themeDraft.value.description.trim(),
    version: themeDraft.value.version.trim() || '1.0.0',
    license: themeDraft.value.license.trim(),
    homepage: themeDraft.value.homepage.trim(),
    tags: themeDraft.value.tags
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  });
  if ('error' in r) {
    showToast(r.error);
    return;
  }
  if (!r.path) return; // 取消保存
  themeMaking.value = false;
  showToast(`主题包已生成（${formatBytes(r.bytes)}）：${r.path}`);
}

async function exportThemeTemplate(): Promise<void> {
  const p = await api.theme.template();
  if (p) showToast(`制作模板已保存：${p}`);
}

// ---------- T-05：语音播报 / 语音输入 / MCP ----------

async function togglePetVoice(): Promise<void> {
  await settings.update({ petVoiceEnabled: !s.value.petVoiceEnabled });
  if (!s.value.petVoiceEnabled) await api.voice.stop();
  showToast(s.value.petVoiceEnabled ? '语音播报已开启（气泡消息将被朗读）' : '语音播报已关闭');
}

async function onVoiceRate(): Promise<void> {
  await settings.update({ petVoiceRate: Number(s.value.petVoiceRate) || 0 });
}

async function testVoice(): Promise<void> {
  try {
    await api.voice.speak(`你好，我是${s.value.petName || '小鹏'}，很高兴见到你！`);
  } catch (e) {
    showToast(`播报失败：${(e as Error).message}`);
  }
}

async function testDictate(): Promise<void> {
  showToast('请对着麦克风说话（8 秒）…');
  try {
    const text = (await api.voice.dictate(8)).trim();
    showToast(text ? `识别结果：${text}` : '没有识别到语音');
  } catch (e) {
    showToast((e as Error).message);
  }
}

const mcpInfo = ref<{ running: boolean; port: number; token: string; error?: string } | null>(null);

async function refreshMcp(): Promise<void> {
  try {
    mcpInfo.value = await api.llm.mcpStatus();
  } catch {
    mcpInfo.value = null;
  }
}

async function toggleMcp(): Promise<void> {
  await settings.update({ mcpEnabled: !s.value.mcpEnabled });
  await refreshMcp();
  showToast(s.value.mcpEnabled ? 'MCP 工具服务已启动（仅本机回环）' : 'MCP 工具服务已停止');
}

async function applyMcpPort(): Promise<void> {
  const port = Math.max(1024, Math.min(65535, Math.round(Number(s.value.mcpPort) || 47111)));
  await settings.update({ mcpPort: port });
  await refreshMcp();
  showToast(`MCP 端口已设为 ${port}`);
}

function mcpConfigSnippet(): string {
  const token = mcpInfo.value?.token || '<在设置页开启 MCP 后显示>';
  return `{"mcpServers":{"xiaopeng-toolbox":{"command":"node","args":["<安装目录>\\\\scripts\\\\mcp-stdio.js"],"env":{"XIAOPENG_MCP_TOKEN":"${token}"}}}}`;
}

async function toggleAutostart(): Promise<void> {
  await settings.update({ autostart: !s.value.autostart });
}

async function togglePetOnTop(): Promise<void> {
  await settings.update({ petOnTop: !s.value.petOnTop });
}

async function toggleSidebarOnTop(): Promise<void> {
  await settings.update({ sidebarOnTop: !s.value.sidebarOnTop });
}

async function toggleAutoCollapse(): Promise<void> {
  await settings.update({ sidebarAutoCollapse: !s.value.sidebarAutoCollapse });
}

async function onAccent(color: string): Promise<void> {
  await settings.update({ accent: color });
}

async function saveKey(): Promise<void> {
  await settings.update({ deepseekApiKey: s.value.deepseekApiKey.trim() });
  showToast('已保存');
}

async function onWidthChange(): Promise<void> {
  await settings.update({ sidebarWidth: s.value.sidebarWidth });
}

async function addExcluded(): Promise<void> {
  const folder = await api.settings.pickFolder();
  if (folder && !s.value.excludedFolders.includes(folder)) {
    await settings.update({ excludedFolders: [...s.value.excludedFolders, folder] });
  }
}

async function removeExcluded(folder: string): Promise<void> {
  await settings.update({ excludedFolders: s.value.excludedFolders.filter((f) => f !== folder) });
}

async function clearRecents(): Promise<void> {
  await api.files.clearRecents();
  showToast('最近记录已清除');
}

async function onTheme(t: 'dark' | 'light'): Promise<void> {
  await settings.update({ theme: t });
}

async function onPlatform(): Promise<void> {
  await settings.update({ musicPlatform: s.value.musicPlatform });
}

async function pickSaveDir(): Promise<void> {
  const folder = await api.settings.pickFolder();
  if (folder) {
    await settings.update({ saveDir: folder });
    showToast('保存路径已更新（插件需重新加载后生效）');
  }
}

async function clearSaveDir(): Promise<void> {
  await settings.update({ saveDir: '' });
  showToast('已恢复默认保存路径');
}

watch(
  () => s.value.petImage,
  () => void loadPetImage()
);
// UI-2 修复：草稿改为「跟随已落盘的设置回填」——SettingsApp 的 store.load() 是异步 IPC，
// 若在 setup 阶段用默认值初始化草稿，深链进入或手快保存会把用户真实配置覆盖成默认值。
watch(
  () => [s.value.paletteHotkey, s.value.deskboardHotkey, s.value.paletteExcludeExts.join(',')],
  () => {
    paletteHotkeyDraft.value = s.value.paletteHotkey;
    deskboardHotkeyDraft.value = s.value.deskboardHotkey;
    paletteExclDraft.value = s.value.paletteExcludeExts.join(', ');
  },
  { immediate: true }
);
void loadPetImage();
// 运行环境诊断（确认运行版本/引擎状态）
void api.settings.info().then((info) => {
  appInfo.value = info;
});
</script>

<template>
  <div class="settings-root">
    <header class="header">
      <span class="title"><Icon name="gear" :size="16" /> 小鹏工具箱 · 设置</span>
      <span class="spacer"></span>
      <button class="icon-btn" @click="api.settings.close()"><Icon name="close" :size="15" /></button>
    </header>
    <div class="body">
      <aside class="nav">
        <button class="nav-item" :class="{ on: tab === 'general' }" @click="tab = 'general'">{{ t('settings.nav.general') }}</button>
        <button class="nav-item" :class="{ on: tab === 'pet' }" @click="tab = 'pet'">{{ t('settings.nav.pet') }}</button>
        <button class="nav-item" :class="{ on: tab === 'sidebar' }" @click="tab = 'sidebar'">{{ t('settings.nav.sidebar') }}</button>
        <button class="nav-item" :class="{ on: tab === 'boxes' }" @click="tab = 'boxes'">{{ t('settings.nav.boxes') }}</button>
        <button class="nav-item" :class="{ on: tab === 'palette' }" @click="tab = 'palette'">{{ t('settings.nav.palette') }}</button>
        <button class="nav-item" :class="{ on: tab === 'deskboard' }" @click="tab = 'deskboard'">{{ t('settings.nav.deskboard') }}</button>
        <button class="nav-item" :class="{ on: tab === 'clipboard' }" @click="tab = 'clipboard'">{{ t('settings.nav.clipboard') }}</button>
        <button class="nav-item" :class="{ on: tab === 'market' }" @click="tab = 'market'">{{ t('settings.nav.market') }}</button>
        <button class="nav-item" :class="{ on: tab === 'system' }" @click="tab = 'system'">{{ t('settings.nav.system') }}</button>
        <button class="nav-item" :class="{ on: tab === 'privacy' }" @click="tab = 'privacy'">{{ t('settings.nav.privacy') }}</button>
        <button class="nav-item" :class="{ on: tab === 'plugins' }" @click="tab = 'plugins'">{{ t('settings.nav.plugins') }}</button>
      </aside>
      <main class="content">
        <section v-if="tab === 'general'">
          <h3>{{ t('settings.language') }}</h3>
          <div class="row">
            <select :value="s.locale" @change="onLocale(($event.target as HTMLSelectElement).value)">
              <option value="auto">{{ t('settings.language.auto') }}（{{ systemLocaleLabel }}）</option>
              <option v-for="l in LOCALES" :key="l.id" :value="l.id">{{ l.label }}</option>
            </select>
          </div>
          <p class="muted">{{ t('settings.language.hint') }}</p>
          <h3>主题</h3>
          <div class="row">
            <label class="radio"
              ><input type="radio" :checked="s.theme === 'dark'" @change="onTheme('dark')" /> 暗色</label
            >
            <label class="radio"
              ><input type="radio" :checked="s.theme === 'light'" @change="onTheme('light')" /> 亮色</label
            >
          </div>
          <h3>皮肤（强调色）</h3>
          <div class="row">
            <span
              v-for="c in ACCENTS"
              :key="c"
              class="swatch"
              :class="{ on: s.accent === c }"
              :style="{ background: c }"
              @click="onAccent(c)"
            ></span>
            <span class="muted">选择主题强调色，界面即时换肤</span>
          </div>
          <h3>开机自启动</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.autostart }" @click="toggleAutostart"></div>
            <span class="muted">登录系统后自动启动小鹏工具箱</span>
          </div>
          <h3>全局快捷键（呼出/收起侧边栏）</h3>
          <div class="row">
            <input v-model="hotkeyDraft" :placeholder="s.hotkey" style="width: 200px" />
            <button class="btn primary" @click="applyHotkey">应用</button>
            <span class="muted">当前：{{ s.hotkey || '未设置' }}</span>
          </div>
          <h3>音乐平台</h3>
          <div class="row">
            <select v-model="s.musicPlatform" style="width: 200px" @change="onPlatform">
              <option value="qq">QQ 音乐</option>
              <option value="netease">网易云音乐</option>
              <option value="spotify">Spotify</option>
              <option value="kugou">酷狗音乐</option>
            </select>
            <span class="muted">点击专辑封面时打开对应播放器</span>
          </div>
          <h3>DeepSeek API Key（用于余额监控插件）</h3>
          <div class="row">
            <input v-model="s.deepseekApiKey" type="password" placeholder="sk-..." style="flex: 1" />
            <button class="btn" @click="saveKey">保存</button>
            <span class="muted">在 https://platform.deepseek.com 创建，仅保存于本机</span>
          </div>
          <h3>保存路径（截图/录屏/转换等插件输出位置）</h3>
          <div class="row">
            <input :value="s.saveDir || '默认（图片/视频/源文件目录）'" style="flex: 1" readonly />
            <button class="btn" @click="pickSaveDir">选择目录</button>
            <button v-if="s.saveDir" class="btn" @click="clearSaveDir">清除</button>
          </div>
          <h3>运行环境（用于确认版本与插件引擎状态）</h3>
          <div class="row">
            <span class="muted"
              >应用版本 {{ appInfo?.version ?? '…' }} · tkinter {{ appInfo?.tkinterOk ? '就绪' : '缺失' }} · Python：
              {{ appInfo?.python ?? '…' }}</span
            >
          </div>
          <p class="muted" style="word-break: break-all">数据目录：{{ appInfo?.dataDir ?? '…' }}</p>
          <h3>性能与资源（T-10）</h3>
          <div class="row">
            <label class="radio"
              ><input type="radio" :checked="s.perfMode === 'balanced'" @change="void onPerfMode('balanced')" /> 均衡</label
            >
            <label class="radio"
              ><input type="radio" :checked="s.perfMode === 'saver'" @change="void onPerfMode('saver')" /> 节省资源</label
            >
            <label class="radio"
              ><input type="radio" :checked="s.perfMode === 'custom'" @change="void onPerfMode('custom')" /> 自定义</label
            >
            <span class="muted">均衡=动画开+闲置释放开；节省=动画关+闲置释放开</span>
          </div>
          <div class="row">
            <label class="radio"
              ><input
                type="checkbox"
                :checked="s.perfAnimations"
                :disabled="s.perfMode !== 'custom'"
                @change="onPerfAnim"
              />
              界面动画</label
            >
            <label class="radio"
              ><input
                type="checkbox"
                :checked="s.perfIdleRelease"
                :disabled="s.perfMode !== 'custom'"
                @change="onPerfIdle"
              />
              窗口隐藏时闲置释放（降帧率）</label
            >
          </div>
          <div class="row">
            <label class="radio"
              ><input type="checkbox" :checked="s.disableGpuAccel" @change="onGpuAccel" />
              禁用硬件加速（渲染进程反复崩溃时开启，需重启应用）</label
            >
            <span class="muted">
              个别显卡驱动下透明悬浮窗的渲染进程可能崩溃，表现为「看不见却挡住点击」的窗口；开启此项可规避（耗时略增）。
            </span>
          </div>
          <div class="row">
            <div class="switch" :class="{ on: s.windowLivenessProbe !== false }" @click="toggleLivenessProbe"></div>
            <span class="muted">
              窗口活性探测（GW-01）：每 30 秒采样常驻动画窗的画面，连续 3 次完全无变化即判定"渲染冻结"并自动恢复。
              这是"系统不发崩溃事件"那类幽灵窗口的唯一兜底——关掉后只能靠托盘菜单手动修复。
            </span>
          </div>
          <div class="row">
            <span class="muted"
              >资源占用（坦诚换信任）：RSS {{ perfUsage?.rssMB ?? '…' }} MB · 堆内存
              {{ perfUsage?.heapMB ?? '…' }} MB · 窗口 {{ perfUsage?.windows ?? '…' }}（可见
              {{ perfUsage?.visibleWindows ?? '…' }}） · 已运行 {{ fmtUptime(perfUsage?.uptimeSec) }}</span
            >
            <button class="btn" @click="void refreshPerf()">刷新</button>
          </div>
        </section>

        <section v-if="tab === 'pet'">
          <h3>宠物置顶</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.petOnTop }" @click="togglePetOnTop"></div>
            <span class="muted">始终显示在其他窗口之上</span>
          </div>
          <h3>人设与对话（T-05）</h3>
          <div class="row">
            <span class="muted" style="width: 64px">名字</span>
            <input
              v-model="s.petName"
              placeholder="小鹏"
              style="flex: 1"
              @change="void settings.update({ petName: s.petName })"
            />
          </div>
          <div class="row">
            <span class="muted" style="width: 64px">性格人设</span>
            <textarea
              v-model="s.petPersona"
              rows="3"
              style="flex: 1"
              placeholder="温暖、俏皮、可靠……"
              @change="void settings.update({ petPersona: s.petPersona })"
            ></textarea>
          </div>
          <div class="row">
            <span class="muted" style="width: 64px">口癖</span>
            <input
              v-model="s.petCatchphrase"
              placeholder="如：交给我吧！"
              style="flex: 1"
              @change="void settings.update({ petCatchphrase: s.petCatchphrase })"
            />
          </div>
          <div class="row">
            <span class="muted" style="width: 64px">世界观</span>
            <textarea
              v-model="s.petWorldview"
              rows="3"
              style="flex: 1"
              placeholder="背景故事/自我介绍，如：我是来自桌面上空的云朵精灵，最喜欢看用户高效完成任务…"
              @change="void settings.update({ petWorldview: s.petWorldview })"
            ></textarea>
          </div>
          <p class="muted">
            对话入口：右键宠物 →「与小鹏聊天」，或命令面板搜"聊天"。需 DeepSeek API Key（设置 → 通用）。
          </p>
          <h3>语音（T-05）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.petVoiceEnabled }" @click="togglePetVoice"></div>
            <span class="muted">语音播报：气泡消息 / 聊天回复 / 提醒由桌宠朗读（TTS）</span>
          </div>
          <div class="row">
            <span class="muted" style="width: 64px">语速</span>
            <input
              type="range"
              min="-5"
              max="5"
              step="1"
              v-model.number="s.petVoiceRate"
              style="flex: 1"
              @change="onVoiceRate"
            />
            <span class="muted" style="width: 32px">{{ s.petVoiceRate > 0 ? '+' : '' }}{{ s.petVoiceRate }}</span>
          </div>
          <div class="row">
            <button class="btn" @click="testVoice">试听播报</button>
            <button class="btn" @click="testDictate">测试语音输入</button>
            <span class="muted">语音输入：聊天窗口点 🎙 说 8 秒自动转文字（Windows 语音组件）</span>
          </div>
          <h3>MCP 工具服务（宠物即 Agent 入口，T-05）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.mcpEnabled }" @click="toggleMcp"></div>
            <span class="muted"
              >允许外部 MCP 客户端调用桌宠工具（待办/插件命令/音乐/找文件/截图），仅绑定本机回环</span
            >
          </div>
          <div class="row">
            <span class="muted" style="width: 64px">端口</span>
            <input v-model.number="s.mcpPort" type="number" min="1024" max="65535" style="width: 100px" />
            <button class="btn" @click="applyMcpPort">应用</button>
            <span class="muted">{{ mcpInfo?.running ? `运行中 · 127.0.0.1:${mcpInfo.port}` : '未运行' }}</span>
          </div>
          <p class="muted">
            MCP 客户端配置（stdio 桥，需小鹏工具箱正在运行）：
            <code>{{ mcpConfigSnippet() }}</code>
          </p>
          <h3>宠物图片</h3>
          <div class="row">
            <img v-if="petImageUrl" :src="petImageUrl" class="preview" />
            <span v-else class="preview placeholder"><Icon name="panda" :size="30" /></span>
            <button class="btn" @click="pickPetImage">选择图片</button>
            <button v-if="s.petImage" class="btn" @click="resetPetImage">恢复默认</button>
          </div>
          <p class="muted">支持 PNG/GIF/APNG；窗口大小随图片自动调整。</p>
          <h3>动作帧（单击宠物随机播放，支持多帧动画）</h3>
          <div v-for="a in ACTIONS" :key="a.key" class="row frame-row">
            <span class="frame-label">{{ a.label }}</span>
            <span class="muted">{{ s.petActions[a.key]?.length ?? 0 }} 帧</span>
            <span class="spacer"></span>
            <button class="btn small" @click="pickFrames(a.key)">选择帧</button>
            <button v-if="(s.petActions[a.key] ?? []).length" class="btn small" @click="clearFrames(a.key)">
              清除
            </button>
          </div>

          <h3>主题包（UGC：制作 / 导入 / 分享）</h3>
          <p class="muted">
            主题包 = 宠物形象 + 动作帧 + 气泡样式，可附界面皮肤。本质是一个 ZIP（theme.json + 图片），
            扩展名 .xptheme。主题包<strong>不含任何可执行内容</strong>，导入时先校验后解压。当前生效：{{
              activeThemeName
            }}
          </p>
          <div class="row theme-toolbar">
            <button class="btn small" @click="importThemePack">导入主题包…</button>
            <button class="btn small" @click="themeMaking = !themeMaking">
              {{ themeMaking ? '收起制作面板' : '制作主题包…' }}
            </button>
            <button class="btn small" @click="exportThemeTemplate">下载制作模板</button>
            <button class="btn small" @click="api.theme.openFolder()">打开主题目录</button>
          </div>

          <div v-if="themeMaking" class="card theme-make">
            <div class="label">主题名称</div>
            <input v-model="themeDraft.name" placeholder="例如：橘猫" maxlength="40" />
            <div class="row">
              <div class="grow">
                <div class="label">作者</div>
                <input v-model="themeDraft.author" placeholder="你的昵称" maxlength="40" />
              </div>
              <div class="grow">
                <div class="label">版本</div>
                <input v-model="themeDraft.version" placeholder="1.0.0" />
              </div>
              <div class="grow">
                <div class="label">授权协议</div>
                <input v-model="themeDraft.license" placeholder="CC-BY-4.0" maxlength="40" />
              </div>
            </div>
            <div class="label">一句话介绍</div>
            <textarea v-model="themeDraft.description" rows="2" maxlength="200"></textarea>
            <div class="row">
              <div class="grow">
                <div class="label">标签（逗号分隔）</div>
                <input v-model="themeDraft.tags" placeholder="猫,可爱" />
              </div>
              <div class="grow">
                <div class="label">主页（可选）</div>
                <input v-model="themeDraft.homepage" placeholder="https://" maxlength="200" />
              </div>
            </div>
            <p class="muted">
              将打包：当前宠物形象 + 已设置的 {{ frameTotal }} 张动作帧。图片建议 PNG 透明背景、96~256px。
            </p>
            <div class="row">
              <button class="btn primary" @click="submitThemePack">生成主题包…</button>
              <span class="muted">生成后把 .xptheme 发给别人，或点“分享文案”复制投稿帖</span>
            </div>
          </div>

          <div class="theme-grid">
            <!-- 循环变量用 theme 而不是 t：t 现在是 i18n 的取词函数，局部变量会把它遮蔽掉 -->
            <div v-for="theme in themes" :key="theme.manifest.id" class="theme-card" :class="{ on: theme.active }">
              <img
                v-if="themePreviews[theme.manifest.id]"
                class="theme-preview"
                :src="themePreviews[theme.manifest.id]"
                alt=""
              />
              <div v-else class="theme-preview theme-placeholder">🐾</div>
              <div class="theme-name">{{ theme.manifest.name }}</div>
              <div class="muted theme-meta">
                {{ theme.manifest.author || '匿名' }} · v{{ theme.manifest.version }}
                <span v-if="theme.builtin"> · 内置</span>
                <span v-else> · {{ formatBytes(theme.bytes) }}</span>
              </div>
              <div v-if="theme.manifest.skin" class="muted theme-meta">
                含界面皮肤<span v-if="theme.manifest.skin.accent"> · {{ theme.manifest.skin.accent }}</span>
              </div>
              <div class="row theme-actions">
                <button class="btn small" :disabled="theme.active" @click="applyThemePack(theme)">
                  {{ theme.active ? '使用中' : '应用' }}
                </button>
                <button v-if="!theme.builtin" class="btn small" @click="exportThemePack(theme)">导出</button>
                <button v-if="!theme.builtin" class="btn small" @click="copyThemeShare(theme)">分享文案</button>
                <button v-if="!theme.builtin" class="btn small danger" @click="deleteThemePack(theme)">删除</button>
              </div>
            </div>
          </div>
          <div class="row">
            <div class="switch" :class="{ on: themeSkin }" @click="themeSkin = !themeSkin"></div>
            <span class="muted">
              应用主题时同时套用包内界面皮肤（明暗主题 / 强调色）。默认不套用——换一只宠物不该顺手改掉你调好的配色
            </span>
          </div>
        </section>

        <section v-if="tab === 'sidebar'">
          <h3>侧边栏置顶</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.sidebarOnTop }" @click="toggleSidebarOnTop"></div>
            <span class="muted">固定在其他应用窗口之上，切换应用不被覆盖</span>
          </div>
          <h3>自动收回</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.sidebarAutoCollapse }" @click="toggleAutoCollapse"></div>
            <span class="muted"
              >鼠标焦点离开侧边栏时自动收回，恢复宠物形态（双击宠物/右键菜单/Ctrl+Alt+X 可再次展开）</span
            >
          </div>
          <h3>侧边栏宽度</h3>
          <div class="row">
            <input
              type="range"
              min="260"
              max="600"
              step="4"
              v-model.number="s.sidebarWidth"
              style="flex: 1"
              @change="onWidthChange"
            />
            <span class="width">{{ s.sidebarWidth }}px</span>
          </div>
          <p class="muted">范围 260px ~ 600px；也可在侧边栏左边缘直接拖动调整。</p>
        </section>

        <section v-if="tab === 'privacy'">
          <h3>排除的文件夹（文件搜索与最近记录将跳过）</h3>
          <div class="folder-list">
            <div v-for="f in s.excludedFolders" :key="f" class="row folder">
              <span class="folder-path">{{ f }}</span>
              <span class="spacer"></span>
              <button class="icon-btn" @click="removeExcluded(f)"><Icon name="close" :size="14" /></button>
            </div>
            <div v-if="!s.excludedFolders.length" class="empty">未设置排除文件夹</div>
          </div>
          <div class="row">
            <button class="btn" @click="addExcluded"><Icon name="plus" :size="12" />添加文件夹</button>
          </div>
          <h3>最近记录</h3>
          <div class="row">
            <button class="btn danger" @click="clearRecents">一键清除最近记录</button>
          </div>
          <h3>插件安装包加密留存（T-11）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.marketEncryptPackages }" @click="void toggleMarketEncrypt()"></div>
            <span class="muted"
              >安装插件时把安装包 AES-256-GCM 加密归档到本机（{{
                secureInfo ? `${secureInfo.count} 个 / ${secureInfo.sizeMB} MB` : '…'
              }}）。仅作加密归档，暂不支持从留存包离线重装</span
            >
            <button v-if="secureInfo?.count" class="btn danger" @click="void clearSecurePackages()">清理留存包</button>
          </div>
          <p v-if="secureInfo?.count" class="muted" style="word-break: break-all">留存目录：{{ secureInfo.dir }}</p>
        </section>

        <section v-if="tab === 'plugins'">
          <PluginStoreView />
        </section>

        <section v-if="tab === 'clipboard'">
          <ClipboardView />
        </section>

        <section v-if="tab === 'market'">
          <MarketView />
        </section>

        <section v-if="tab === 'system'">
          <h3>开发者工具箱（DEV-01 ~ DEV-12 · T-14）</h3>
          <div class="row">
            <button class="btn small" @click="api.devtools.open()">打开开发者工具箱</button>
            <span class="muted"
              >JSON / 时间戳 / Base64 / 哈希 / UUID / 进制 / 单位 / cron / 正则 / diff / 二维码；命令面板输入
              <code>devtools</code> 或 <code>json {…}</code>、<code>ts 1727…</code> 可直接出即时结果</span
            >
          </div>
          <SystemIntegrationView />
        </section>

        <section v-if="tab === 'boxes'">
          <h3>桌面收纳（DR-01 ~ DR-07）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.desktopBoxesEnabled }" @click="toggleBoxesEnabled"></div>
            <span class="muted">启用桌面收纳，盒子窗口显示于桌面最上层（半透明毛玻璃）</span>
          </div>
          <h3>文件处理模式（DR-06）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.boxMoveMode }" @click="toggleMoveMode"></div>
            <span class="muted"
              >“真移动”：拖入的文件物理移动到目标目录（移动前二次确认并记录日志）；默认仅整理视图，只建立索引不移动文件</span
            >
          </div>
          <h3>隐藏桌面原生图标（可选，DR-04）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.hideDesktopIcons }" @click="toggleHideIcons"></div>
            <span class="muted">写入系统注册表切换资源管理器桌面图标显示</span>
          </div>
          <h3>智能分类（软件 / 文件 / 图片 三大类）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.boxAutoMode }" @click="toggleBoxAutoMode"></div>
            <span class="muted"
              >监听桌面新增文件，自动归入：软件盒（exe/lnk/msi 等）、图片盒（png/jpg
              等）、文件盒（文档/视频/音频/压缩包等其余全部）；
              没有对应盒子时自动创建；点“分类整理”可把盒内已有内容按三类重排</span
            >
          </div>
          <h3>收纳盒管理（与桌面双向同步）</h3>
          <DesktopBoxCard />
          <p class="muted">盒子配置保存在 SQLite（spec 4 / DR-07）；拖拽排序、删除即时生效。</p>
        </section>

        <section v-if="tab === 'palette'">
          <h3>全局命令面板（CP-01 ~ CP-06）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.paletteEnabled }" @click="togglePaletteEnabled"></div>
            <span class="muted"
              >一键呼出：统一搜索应用、文件、网站、内部功能、插件命令与待办（输入防抖，首屏 ≤200ms）</span
            >
          </div>
          <h3>全局热键（CP-01）</h3>
          <div class="row">
            <input v-model="paletteHotkeyDraft" :placeholder="s.paletteHotkey" style="width: 200px" />
            <button class="btn primary" @click="applyPaletteHotkey">应用</button>
            <span class="muted">当前：{{ s.paletteHotkey || '未设置' }}</span>
          </div>
          <h3>结果排序（CP-06）</h3>
          <div class="row">
            <select v-model="s.paletteSort" style="width: 200px" @change="onPaletteSort">
              <option value="usage">最常使用</option>
              <option value="recent">最近使用</option>
              <option value="alpha">字母序</option>
            </select>
          </div>
          <h3>搜索内核（T-07 增强）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.searchUseWindowsIndex }" @click="toggleWindowsIndex"></div>
            <span class="muted"
              >无 Everything 时使用 <b>Windows 自带搜索索引</b>兜底：命中索引是毫秒级（本机实测 ~40ms），
              且能找到内置遍历因深度/时间预算到不了的深层文件。依赖系统 WSearch 服务，
              <b>不可用时自动回退内置遍历</b>，因此默认开启无风险</span
            >
          </div>
          <div class="row">
            <span class="muted">当前可用搜索后端：</span>
            <span class="muted">
              <b>{{ searchBackend?.everything ? 'Everything（最快最全）' : '未检测到 Everything' }}</b>
              ·
              {{ searchBackend?.windowsIndex ? 'Windows 搜索索引可用' : 'Windows 搜索索引不可用' }}
              · 内置目录遍历（始终可用）
            </span>
          </div>
          <p class="muted">
            说明：不采用"直读 NTFS MFT"方案 —— 它需要管理员权限与原始卷访问，与"双击即用、不要求提权"的产品定位冲突（T-07 评估结论）。
          </p>
          <h3>粘贴智能匹配（CP-07 · T-14）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.paletteSmartSuggest }" @click="togglePaletteSmartSuggest"></div>
            <span class="muted"
              >打开面板时识别剪贴板内容（文件路径 / 网址 / JSON / 时间戳 / 颜色），在顶部推荐「归档到收纳盒 / 网页快开 /
              JSON 格式化」等动作，回车即可执行</span
            >
          </div>
          <h3>排除的文件类型（CP-06）</h3>
          <div class="row">
            <input v-model="paletteExclDraft" placeholder="例如：tmp, log, cache" style="flex: 1" />
            <button class="btn" @click="applyPaletteExclude">保存</button>
          </div>
          <p class="muted">逗号分隔的扩展名（不含点），命令面板文件结果将跳过这些类型。</p>
        </section>

        <section v-if="tab === 'deskboard'">
          <h3>桌面工作台（DeskBox 式主面板）</h3>
          <div class="row">
            <div class="switch" :class="{ on: s.deskboardEnabled }" @click="toggleDeskboardEnabled"></div>
            <span class="muted"
              >启用统一主面板：左功能列 + 中央搜索/全部应用网格 + 右侧功能卡（音乐/天气日历/待办/系统信息/最近文件）；
              关闭后热键与托盘入口一并停用</span
            >
          </div>
          <h3>使用方式（呼之即来 · 用完即走）</h3>
          <div class="row">
            <div
              class="switch"
              :class="{ on: s.deskboardHideAfterAction }"
              @click="toggleDeskboardHideAfterAction"
            ></div>
            <span class="muted"
              >执行功能后自动收起（打开设置/切换侧边栏/整理/启动应用/执行搜索结果后自动隐藏，不再挡住后面窗口）</span
            >
          </div>
          <div class="row">
            <div
              class="switch"
              :class="{ on: s.deskboardShowOnStartup }"
              @click="toggleDeskboardShowOnStartup"
            ></div>
            <span class="muted"
              >启动时自动显示（默认关闭 = 非常驻；需要时常驻可打开，随时可用热键/托盘「显示主窗口（工作台）」呼出）</span
            >
          </div>
          <h3>上下文感知（WK-01 ~ WK-04 · T-14）</h3>
          <div class="row">
            <div
              class="switch"
              :class="{ on: s.deskboardContextCapture }"
              @click="toggleDeskboardContextCapture"
            ></div>
            <span class="muted"
              >呼出工作台时自动感知上下文：选中文本 → 翻译/搜索/复制/大小写/朗读；选中文件 → 打开目录/复制路径/预览/归档；网址 →
              网页快开；剪贴板图片 → 贴图/OCR。抓取采用「模拟 Ctrl+C + 剪贴板保护」（与划词翻译同款，不引入全局钩子），
              抓取期间短暂占用剪贴板并立即恢复原内容，且不写入剪贴板历史</span
            >
          </div>
          <div class="row">
            <span class="muted">已固定动作：{{ (s.deskboardPins || []).length }} 个</span>
            <button v-if="(s.deskboardPins || []).length" class="btn small" @click="clearDeskboardPins">
              清空固定
            </button>
            <span class="muted">（在工作台里对动作点右键或点 📌 可固定 / 取消固定）</span>
          </div>
          <p class="muted">
            提示：「归档到收纳盒」默认不启用（WK-06），需要手动固定后才出现在文件组；收纳盒关闭时该动作强制隐藏。
          </p>
          <h3>全局热键（显示/隐藏工作台）</h3>
          <div class="row">
            <input v-model="deskboardHotkeyDraft" :placeholder="s.deskboardHotkey" style="width: 200px" />
            <button class="btn primary" @click="applyDeskboardHotkey">应用</button>
            <span class="muted">当前：{{ s.deskboardHotkey || '未设置' }}</span>
          </div>
          <p class="muted">
            提示：工作台标题栏「×」随时收起；若出现"看不见却挡住点击"的窗口，可从托盘菜单执行「修复卡住的窗口」。
          </p>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* T-06 主题包：卡片式网格（预览图 + 名称 + 操作），与插件市场卡片的视觉语言保持一致 */
.theme-toolbar {
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
  gap: 10px;
  margin: 10px 0;
}

.theme-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.theme-card.on {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.theme-preview {
  width: 100%;
  height: 84px;
  object-fit: contain;
}

.theme-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 34px;
}

.theme-name {
  font-size: 13px;
  font-weight: 600;
}

.theme-meta {
  font-size: 11px;
  line-height: 1.4;
}

.theme-actions {
  flex-wrap: wrap;
  gap: 4px;
}

.theme-make {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0;
}

.theme-make input,
.theme-make textarea {
  width: 100%;
}

.grow {
  flex: 1;
  min-width: 0;
}

.settings-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-solid);
  color: var(--text);
}

.header {
  display: flex;
  align-items: center;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.nav {
  width: 130px;
  border-right: 1px solid var(--border);
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.nav-item.on {
  background: var(--bg-hover);
  color: var(--text);
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 22px;
}

h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 16px 0 10px;
}

h3:first-child {
  margin-top: 0;
}

.radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 18px;
  cursor: pointer;
}

.preview {
  width: 72px;
  height: 72px;
  border-radius: 12px;
  object-fit: contain;
  background: var(--bg-card);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  flex-shrink: 0;
}

.swatch.on {
  border-color: var(--text);
  transform: scale(1.15);
}

.preview.placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
}

.frame-row {
  gap: 10px;
  padding: 4px 0;
}

.frame-label {
  width: 56px;
  font-size: 13px;
}

.width {
  width: 56px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.folder-list {
  max-height: 160px;
  overflow-y: auto;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px;
}

.folder {
  padding: 4px 6px;
}

.folder-path {
  font-size: 12px;
  font-family: Consolas, monospace;
}
</style>
