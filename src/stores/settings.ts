import { defineStore } from 'pinia';
import { applyLocale, locale } from '../i18n';
import { plain } from '../utils';
import type { AppData, AppSettings } from '../../shared/types';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accent: '#5b8cff',
  petImage: '',
  petActions: { nod: [], wave: [], blink: [], jump: [] },
  autostart: false,
  hotkey: 'Ctrl+Alt+X',
  petOnTop: true,
  sidebarOnTop: true,
  sidebarWidth: 360,
  sidebarAutoCollapse: true,
  excludedFolders: [],
  musicPlatform: 'qq',
  trustedSources: [],
  saveDir: '',
  deepseekApiKey: '',
  // T-05：AI 宠物人设
  petName: '小鹏',
  petPersona: '温暖、俏皮、可靠，关心用户，说话简短口语化，像个贴心的小伙伴。',
  petCatchphrase: '',
  petWorldview: '',
  // T-06：UGC 主题包（petThemeId='' 表示使用内置默认形象）
  petThemeId: '',
  petBubbleBg: '',
  petBubbleColor: '',
  petBubbleFontSize: 12,
  petBubbleRadius: 8,
  // v2.0 新增（默认关闭）
  desktopBoxesEnabled: false,
  hideDesktopIcons: false,
  boxMoveMode: false,
  boxAutoMode: true,
  paletteEnabled: false,
  paletteHotkey: 'Ctrl+Space',
  paletteSort: 'usage',
  paletteExcludeExts: [],
  searchUseWindowsIndex: true,
  deskboardEnabled: true,
  deskboardHideAfterAction: true,
  deskboardShowOnStartup: false,
  deskboardHotkey: 'Ctrl+Shift+D',
  // ---- P0 新增（tasks.md T-01 ~ T-04） ----
  trayEnabled: true,
  closeToTray: true,
  clipboardEnabled: true,
  clipboardHotkey: 'Ctrl+Shift+V',
  clipboardMaxItems: 500,
  clipboardExcludeKeywords: [],
  clipboardAppWhitelist: [],
  clipboardEncrypt: false,
  clipboardImages: true,
  clipboardOcr: true,
  captureHotkey: 'Ctrl+Alt+A',
  pinHotkey: 'F3',
  marketIndexUrl: 'builtin://index',
  // SEC-004 / OPT-16：远程索引默认关闭（verified 由索引自报，签名制 T-05 落地前不放开）
  marketAllowRemoteIndex: false,
  // ---- P1 新增（tasks.md T-05 ~ T-08） ----
  petVoiceEnabled: false,
  petVoiceRate: 0,
  mcpEnabled: false,
  mcpPort: 47111,
  mcpToken: '',
  translateHotkey: 'Ctrl+Alt+T',
  ocrHotkey: 'Ctrl+Alt+O',
  boxWatchDownloads: true,
  perfMode: 'balanced',
  perfAnimations: true,
  perfIdleRelease: true,
  marketEncryptPackages: false,
  disableGpuAccel: false,
  windowLivenessProbe: true,
  // ---- T-14 新增（主流化功能补齐） ----
  deskboardContextCapture: true,
  deskboardPins: [],
  paletteSmartSuggest: true,
  paletteHotkeyMigrated: false,
  selectionBarActions: [
    { id: 'text.translate', enabled: true, order: 0 },
    { id: 'text.webSearch', enabled: true, order: 1 },
    { id: 'text.copy', enabled: true, order: 2 },
    { id: 'text.upper', enabled: true, order: 3 },
    { id: 'text.lower', enabled: true, order: 4 },
    { id: 'text.trim', enabled: true, order: 5 },
    { id: 'text.speak', enabled: true, order: 6 }
  ],
  // T-12：界面语言（'auto' = 跟随系统）
  locale: 'auto',
  updateCheckEnabled: true,
  updateFeedUrl: '',
  lastUpdateCheck: 0,
  lastUpdateVersion: ''
};

/** 渲染端设置合并默认值（渲染 P3 修复：新版本新增字段在旧数据里为 undefined，会导致 UI 判空异常） */
function mergeWithDefaults(raw: Partial<AppSettings> | undefined): AppSettings {
  const patch = raw ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...patch,
    petActions: { ...DEFAULT_SETTINGS.petActions, ...(patch.petActions ?? {}) }
  } as AppSettings;
}

export const useSettingsStore = defineStore('settings', {  state: () => ({
    settings: { ...DEFAULT_SETTINGS, petActions: { ...DEFAULT_SETTINGS.petActions } } as AppSettings
  }),
  getters: {
    theme: (s) => s.settings.theme
  },
  actions: {
    applyTheme() {
      const root = document.documentElement;
      root.setAttribute('data-theme', this.settings.theme);
      root.style.setProperty('--accent', this.settings.accent);
    },
    /** T-12：应用界面语言（设置变更 / 收到广播时都会走这里） */
    applyLocale() {
      applyLocale(this.settings.locale);
      // 让 CSS/无障碍也能感知当前语言（部分字体与断行规则按语言选择）
      document.documentElement.setAttribute('lang', locale.value);
    },
    async load() {
      const data = await window.api.store.get();
      this.settings = mergeWithDefaults(data.settings);
      this.applyTheme();
      this.applyLocale();
    },
    async update(patch: Partial<AppSettings>) {
      // 收口：所有设置写入都经过这里，而 patch 里常带响应式嵌套对象
      // （典型：{ petActions: { ...s.petActions, [action]: paths } } —— 展开响应式对象取到的是 Proxy）
      const data = await window.api.store.updateSettings(plain(patch));
      this.settings = mergeWithDefaults(data.settings);
      this.applyTheme();
      this.applyLocale();
    },
    sync(data: AppData) {
      this.settings = mergeWithDefaults(data.settings);
      this.applyTheme();
      this.applyLocale();
    }
  }
});
