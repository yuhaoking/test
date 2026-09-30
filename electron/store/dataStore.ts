import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { db, type DbBackend, type DbTable } from './db';
import { logError, logWarn } from '../utils/log';
import type { AppData, AppSettings, FavoriteFile, Module, PluginRecord, RecentFile } from '../../shared/types';

const defaults: AppData = {
  settings: {
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
    // T-06：UGC 主题包（petThemeId='' 表示使用内置默认形象；气泡样式空值 = 跟随应用主题）
    petThemeId: '',
    petBubbleBg: '',
    petBubbleColor: '',
    petBubbleFontSize: 12,
    petBubbleRadius: 8,
    // v2.0 新增（默认关闭，规格 8）
    desktopBoxesEnabled: false,
    hideDesktopIcons: false,
    boxMoveMode: false,
    // 智能分类：用户明确要求的开箱即用能力，默认开启（设置中可关闭）
    boxAutoMode: true,
    paletteEnabled: false,
    paletteHotkey: 'Ctrl+Space',
    paletteSort: 'usage',
    paletteExcludeExts: [],
    // T-07：无 Everything 时用 Windows 搜索索引兜底（零安装零提权；不可用自动回退遍历）
    searchUseWindowsIndex: true,
    // 桌面工作台：主界面默认开启（DeskBox 式排版），热键 Ctrl+Shift+D 显示/隐藏
    deskboardEnabled: true,
    // 非常驻模式：用完即走 + 启动不自动显示（均可在设置 → 桌面工作台 改回常驻）
    deskboardHideAfterAction: true,
    deskboardShowOnStartup: false,
    deskboardHotkey: 'Ctrl+Shift+D',
    // ---- P0 新增（tasks.md T-01 ~ T-04） ----
    // 托盘常驻（SY-03）：默认开启，主窗口关闭最小化到托盘
    trayEnabled: true,
    closeToTray: true,
    // 剪贴板历史（CH-01）：默认开启，500 条上限，记录文本与图片
    clipboardEnabled: true,
    clipboardHotkey: 'Ctrl+Shift+V',
    clipboardMaxItems: 500,
    clipboardExcludeKeywords: [],
    clipboardAppWhitelist: [],
    clipboardEncrypt: false,
    clipboardImages: true,
    clipboardOcr: true,
    // 截图增强（T-04）
    captureHotkey: 'Ctrl+Alt+A',
    pinHotkey: 'F3',
    // 插件市场（PM-01）：默认内置示例源，可配置 HTTPS 索引
    marketIndexUrl: 'builtin://index',
    // SEC-004 / OPT-16：远程索引默认**关闭**（verified 由索引自报，签名制 T-05 未落地前不放开）
    marketAllowRemoteIndex: false,
    // ---- P1 新增（tasks.md T-05 ~ T-08） ----
    // T-05 语音：播报默认关闭（避免意外发声），语速 0
    petVoiceEnabled: false,
    petVoiceRate: 0,
    // T-05 MCP 对外工具协议：默认关闭，开启后监听本机回环端口
    mcpEnabled: false,
    mcpPort: 47111,
    mcpToken: '',
    // T-07 划词翻译 / 取词 OCR（pot 模式悬浮条）
    translateHotkey: 'Ctrl+Alt+T',
    ocrHotkey: 'Ctrl+Alt+O',
    // T-08 自动整理增强：默认监听下载目录
    boxWatchDownloads: true,
    // ---- P2 新增（tasks.md T-10 / T-11） ----
    // T-10 性能模式：均衡（动画开 + 闲置释放开）
    perfMode: 'balanced',
    perfAnimations: true,
    perfIdleRelease: true,
    // T-11 插件安装包加密留存：默认关闭
    marketEncryptPackages: false,
    // 幽灵窗口排查：默认不禁用硬件加速
    disableGpuAccel: false,
    // GW-01 / OPT-14：窗口活性探测默认开启（幽灵窗口的治本防线）
    windowLivenessProbe: true,
    // ---- T-14 新增（主流化功能补齐） ----
    // WK-04：呼出工作台时自动抓取上下文（模拟 Ctrl+C + 剪贴板保护），默认开启
    deskboardContextCapture: true,
    // WK-03：工作台常驻区固定的动作（默认空 = 无固定，按上下文分组展示）
    deskboardPins: [],
    // CP-07：命令面板粘贴智能匹配推荐，默认开启
    paletteSmartSuggest: true,
    // 命令面板热键尚未做过"废弃默认值"升级（Alt+Space → Ctrl+Space）：首次注册失败时自动改一次
    paletteHotkeyMigrated: false,
    // WK-07：划词动作条默认动作（≥ 6 个，可在设置 → 系统集成 增删排序）
    selectionBarActions: [
      { id: 'text.translate', enabled: true, order: 0 },
      { id: 'text.webSearch', enabled: true, order: 1 },
      { id: 'text.copy', enabled: true, order: 2 },
      { id: 'text.upper', enabled: true, order: 3 },
      { id: 'text.lower', enabled: true, order: 4 },
      { id: 'text.trim', enabled: true, order: 5 },
      { id: 'text.speak', enabled: true, order: 6 }
    ],
    // T-12：界面语言（'auto' = 跟随系统；可选 zh-CN / zh-TW / en / ja）
    locale: 'auto',
    // UPD-01：启动后检查更新（GitHub Releases，≤1 次/天，失败静默，不自动下载）
    updateCheckEnabled: true,
    updateFeedUrl: '',
    lastUpdateCheck: 0,
    lastUpdateVersion: ''
  },
  modules: [
    {
      id: 'mod-system-info',
      type: 'system_info',
      name: '系统信息',
      fixed: true,
      pinned: true,
      order: 0,
      config: {}
    },
    {
      id: 'mod-music-player',
      type: 'music_player',
      name: '音乐控制',
      fixed: true,
      pinned: true,
      order: 1,
      config: {}
    }
  ],
  recentFiles: [],
  favoriteFiles: [],
  plugins: []
};

/** 历史配置项：旧版本字段（pluginSaveDir）与新版本合并时的兼容类型 */
interface LegacySettings extends Partial<AppSettings> {
  pluginSaveDir?: string;
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    petActions: { ...defaults.settings.petActions, ...(patch.petActions ?? base.petActions) }
  };
}

/** 路径类设置项：写入前统一清洗（去空白 + 去掉整体包裹的引号） */
const PATH_LIKE_SETTINGS = new Set(['petImage', 'saveDir']);

/**
 * 清洗路径类设置值。
 * 历史缺陷：`petImage` 可能被存成字面量 `""`（两个引号字符），它是真值，
 * 会让 `petImage || defaultPetImage()` 的回退失效 → 宠物窗加载图片失败变成空白幽灵窗。
 */
function normalizePathSetting(v: string): string {
  let s = v.trim();
  for (let i = 0; i < 3; i++) {
    const wrapped =
      s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")));
    if (!wrapped) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** 字符串数组类设置项（校验时逐项过滤，防止 {x:1} 这类"对象冒充数组"进入运行时） */
const STRING_ARRAY_SETTINGS = new Set([
  'clipboardExcludeKeywords',
  'clipboardAppWhitelist',
  'trustedSources',
  'excludedFolders',
  'paletteExcludeExts',
  'deskboardPins'
]);

/** Record<string, string[]> 类设置项（宠物动作帧） */
const STRING_ARRAY_MAP_SETTINGS = new Set(['petActions']);

/** 枚举类设置项（取值必须落在白名单内） */
const ENUM_SETTINGS: Record<string, readonly string[]> = {
  theme: ['dark', 'light'],
  // T-12：语言白名单（'auto' = 跟随系统）；非法值直接拒绝，不落库
  locale: ['auto', 'zh-CN', 'zh-TW', 'en', 'ja'],
  paletteSort: ['usage', 'recent', 'alpha'],
  perfMode: ['balanced', 'saver', 'custom']
};

/** 数值类设置项的合法区间（越界直接夹取，避免负数/NaN 进入运行时） */
const RANGE_SETTINGS: Record<string, { min: number; max: number; int?: boolean }> = {
  sidebarWidth: { min: 240, max: 720, int: true },
  clipboardMaxItems: { min: 10, max: 5000, int: true },
  mcpPort: { min: 1024, max: 65535, int: true },
  petVoiceRate: { min: -5, max: 5, int: true },
  lastUpdateCheck: { min: 0, max: Number.MAX_SAFE_INTEGER }
};

function sanitizeStringArray(value: unknown[]): string[] {
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** 划词动作条配置：保留合法项并归一化 order（WK-07） */
function sanitizeSelectionActions(value: unknown[]): Array<{ id: string; enabled: boolean; order: number }> {
  const out: Array<{ id: string; enabled: boolean; order: number }> = [];
  for (const [i, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!id) continue;
    out.push({
      id,
      enabled: rec.enabled !== false,
      order: Number.isFinite(Number(rec.order)) ? Math.max(0, Math.round(Number(rec.order))) : i
    });
  }
  return out;
}

function sanitizeStringArrayMap(value: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) out[k] = sanitizeStringArray(v);
  }
  return out;
}

/**
 * 设置 patch 白名单 + 类型校验（SVC-1 修复的加强版，P1-4）
 *
 * 历史缺陷：只区分「对象 / 非对象」，而数组也是 object —— 于是
 * `updateSettings({ clipboardExcludeKeywords: {x:1} })` 会被接受，随后剪贴板监听轮询抛
 * `TypeError: s.clipboardExcludeKeywords is not iterable`，**复制任何内容都不再入库**，
 * 且设置页剪贴板分区调用 .join() 同样抛错，用户无法从 UI 改回（只能删库）。
 * 触发路径主要是"被手工编辑过 / 来自其它机器或版本的设置备份"。
 *
 * 现在按默认值形态逐类校验：数组必须是数组（字符串数组逐项过滤）、
 * 对象必须是纯对象（且不能是数组）、枚举必须在白名单内、数值夹取到合法区间。
 */
/*
 * SEC-007 / OPT-18：安全敏感设置不得走通用 updateSettings 通道。
 *
 * 问题：`store:update-settings` 是渲染层的**通用**写入口，几乎任何渲染上下文都能调到它。
 * 而下面这三项直接决定安全边界：
 *   · trustedSources —— "可信插件"名单，写进去等于跳过加载前的安全确认弹窗；
 *   · mcpToken      —— MCP 对外服务的访问令牌，改了就能让任意本机程序调用工具；
 *   · deepseekApiKey—— 云 API 密钥，会随插件子进程环境变量下发。
 * 也就是说，一个被 XSS 或恶意插件影响的渲染上下文，可以静默地给自己"授权"。
 *
 * 处置（深度防御，而非漏洞修复）：把这三项从通用通道摘掉。
 * 信任关系只走 `plugins:trust`（IPC 专用入口），令牌/密钥由主进程自己生成与持有，
 * 渲染层的 patch 里出现这三项一律忽略并记一条警告（不抛错，避免旧版设置页直接崩）。
 */
const MAIN_PROCESS_ONLY_SETTINGS = new Set(['trustedSources', 'mcpToken', 'deepseekApiKey']);

function sanitizeSettingsPatch(patch: Partial<AppSettings>, trusted = false): Partial<AppSettings> {
  const defs = defaults.settings as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const reject = (key: string, value: unknown): void => {
    logWarn(`[store] 设置项 ${key} 类型不合法，已忽略：${Array.isArray(value) ? 'array' : typeof value}`);
  };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in defs) || value === undefined) continue;
    if (!trusted && MAIN_PROCESS_ONLY_SETTINGS.has(key)) {
      logWarn(`[store] 设置项 ${key} 只能由主进程写入（SEC-007），已忽略本次外部写入`);
      continue;
    }
    const def = defs[key];

    // ---- 数组类 ----
    if (Array.isArray(def)) {
      if (!Array.isArray(value)) {
        reject(key, value);
        continue;
      }
      if (STRING_ARRAY_SETTINGS.has(key)) {
        out[key] = sanitizeStringArray(value);
        continue;
      }
      if (key === 'selectionBarActions') {
        out[key] = sanitizeSelectionActions(value);
        continue;
      }
      out[key] = value;
      continue;
    }

    // ---- 对象类（数组不算对象） ----
    if (def !== null && typeof def === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        reject(key, value);
        continue;
      }
      out[key] = STRING_ARRAY_MAP_SETTINGS.has(key)
        ? sanitizeStringArrayMap(value as Record<string, unknown>)
        : value;
      continue;
    }

    // ---- 枚举 / 数值 / 其它原始类型 ----
    if (ENUM_SETTINGS[key]) {
      if (typeof value === 'string' && ENUM_SETTINGS[key].includes(value)) out[key] = value;
      else reject(key, value);
      continue;
    }
    if (typeof def === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        reject(key, value);
        continue;
      }
      const range = RANGE_SETTINGS[key];
      const clamped = range ? Math.min(range.max, Math.max(range.min, range.int ? Math.round(n) : n)) : n;
      out[key] = clamped;
      continue;
    }
    if (typeof value === typeof def) {
      out[key] = typeof value === 'string' && PATH_LIKE_SETTINGS.has(key) ? normalizePathSetting(value) : value;
    } else {
      reject(key, value);
    }
  }
  return out as Partial<AppSettings>;
}

class DataStore {
  private data: AppData;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.data = this.load();
  }

  /** 从存储后端恢复数据；首次运行（库为空）时自动迁移旧版数据来源 */
  private load(): AppData {
    const backend = db();
    let settingRows = backend.all('settings');
    if (settingRows.length === 0) {
      // 1) JSON 后端遗留文件（切换后端场景）：原样导入当前后端
      if (!this.tryMigrateV2Json(backend)) {
        // 2) 旧版 data.json：解析并落库，随后备份
        const migrated = this.migrateLegacy();
        if (migrated) {
          // 迁移后立即落库，避免退出前未触发保存导致数据丢失
          this.data = migrated;
          this.persistAll();
          return migrated;
        }
      }
      settingRows = backend.all('settings');
    }
    // 迁移后仍无任何设置行 = 全新安装（首次初始化），需要播种内置模块
    const fresh = settingRows.length === 0;
    const settingsRaw: Record<string, unknown> = {};
    for (const row of settingRows) {
      // recentFiles / favoriteFiles 作为整体存储在 settings 表内，单独解析
      if (row.key === 'recentFiles' || row.key === 'favoriteFiles') continue;
      try {
        settingsRaw[row.key] = JSON.parse(row.value);
      } catch {
        /* 跳过损坏项 */
      }
    }
    const recentFiles = parseJson<RecentFile[]>(backend.get('settings', 'recentFiles'));
    const favoriteFiles = parseJson<FavoriteFile[]>(backend.get('settings', 'favoriteFiles'));
    const data: AppData = {
      settings: mergeSettings(defaults.settings, settingsRaw),
      modules: parseRows<Module>(backend.all('modules')),
      recentFiles: Array.isArray(recentFiles) ? recentFiles : [],
      favoriteFiles: Array.isArray(favoriteFiles) ? favoriteFiles : [],
      plugins: parseRows<PluginRecord>(backend.all('plugins'))
    };
    if (fresh) {
      /*
       * 首启播种内置模块（P1-1 修复）。
       *
       * 历史缺陷：defaults.modules（系统信息 / 音乐控制，fixed: true）定义了却只被旧版 data.json
       * 迁移分支间接使用 —— 全新安装走的是 parseRows(backend.all('modules'))（空数组），
       * 于是「内置模块」在首启并不存在，用户必须手动"添加模块"，fixed 固定模块的锁定逻辑
       * 也失去作用对象。这里在确认「无任何设置行」的全新库上显式落库（随后 persistAll 一并写入默认设置）。
       */
      data.modules = defaults.modules.map((m) => JSON.parse(JSON.stringify(m)) as Module);
      this.data = data;
      this.persistAll();
      return data;
    }
    return data;
  }

  /**
   * JSON 后端遗留的 data-v2.json（结构 { 表名: { 键: 值 } }）原样导入当前后端。
   * 用于后端切换（如以后拿到 SQLite 兼容二进制）时数据无缝衔接；成功后备份源文件。
   */
  private tryMigrateV2Json(backend: DbBackend): boolean {
    const file = join(app.getPath('userData'), 'data-v2.json');
    if (!existsSync(file)) return false;
    try {
      // 同样剥离 BOM（外部编辑器/脚本改写过的文件可能带 BOM，会让解析失败并丢数据）
      const raw = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')) as Partial<
        Record<DbTable, Record<string, string>>
      >;
      for (const table of [
        'settings',
        'modules',
        'plugins',
        'desktop_boxes',
        'palette_usage',
        'move_log',
        'clipboard',
        'fragments',
        'aliases'
      ] as DbTable[]) {
        const rows = raw[table];
        if (!rows) continue;
        for (const [key, value] of Object.entries(rows)) {
          if (typeof value === 'string') backend.set(table, key, value);
        }
      }
      renameSync(file, file + '.bak');
      return true;
    } catch (e) {
      logError('[store] data-v2.json 导入失败', e);
      return false;
    }
  }

  /** 旧版 data.json → 新库一次性迁移；成功后备份旧文件，返回 null 表示无旧数据 */
  private migrateLegacy(): AppData | null {
    const legacyFile = join(app.getPath('userData'), 'data.json');
    if (!existsSync(legacyFile)) return null;
    let data: AppData;
    try {
      const legacy = JSON.parse(readFileSync(legacyFile, 'utf-8').replace(/^\uFEFF/, '')) as Partial<AppData>;
      const legacySettings = (legacy.settings ?? {}) as LegacySettings;
      const settings = mergeSettings(defaults.settings, legacySettings);
      // 兼容迁移：旧版 pluginSaveDir → saveDir
      if (legacySettings.pluginSaveDir && !settings.saveDir) settings.saveDir = legacySettings.pluginSaveDir;
      data = {
        settings,
        modules: Array.isArray(legacy.modules) ? legacy.modules : [],
        recentFiles: Array.isArray(legacy.recentFiles) ? legacy.recentFiles : [],
        favoriteFiles: Array.isArray(legacy.favoriteFiles) ? legacy.favoriteFiles : [],
        plugins: Array.isArray(legacy.plugins) ? legacy.plugins : []
      };
    } catch (e) {
      logError('[store] data.json 解析失败，使用默认配置', e);
      data = JSON.parse(JSON.stringify(defaults)) as AppData;
    }
    try {
      renameSync(legacyFile, legacyFile + '.bak');
    } catch {
      /* 备份失败不影响运行 */
    }
    return data;
  }

  /** 将当前内存数据全量写回存储后端（数据量小，先清后写保证删除同步） */
  private persistAll(): void {
    const backend = db();
    for (const row of backend.all('settings')) backend.delete('settings', row.key);
    for (const [key, value] of Object.entries(this.data.settings)) {
      backend.set('settings', key, JSON.stringify(value));
    }
    backend.set('settings', 'recentFiles', JSON.stringify(this.data.recentFiles));
    backend.set('settings', 'favoriteFiles', JSON.stringify(this.data.favoriteFiles));
    for (const row of backend.all('modules')) backend.delete('modules', row.key);
    for (const m of this.data.modules) backend.set('modules', m.id, JSON.stringify(m));
    for (const row of backend.all('plugins')) backend.delete('plugins', row.key);
    for (const p of this.data.plugins) backend.set('plugins', p.id, JSON.stringify(p));
  }

  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.persistAll();
      } catch (e) {
        logError('[store] 保存失败', e);
      }
    }, 60);
  }

  /** P2-3 修复：立即持久化（清掉防抖定时器）——退出/注销前调用，避免最后一次修改丢失 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.persistAll();
    } catch (e) {
      logError('[store] 保存失败', e);
    }
  }

  update(mutator: (data: AppData) => void): void {
    mutator(this.data);
    this.save();
    this.broadcast();
  }

  get(): AppData {
    return this.data;
  }

  /**
   * 写入设置（**渲染层可达的通用入口**）：经过白名单 + 类型校验，且拒绝安全敏感项（SEC-007）。
   * 主进程内部需要写 trustedSources / mcpToken / deepseekApiKey 时，用 `updateSettingsTrusted`。
   */
  updateSettings(patch: Partial<AppSettings>): void {
    this.updateSettingsTrusted(sanitizeSettingsPatch(patch));
  }

  /**
   * 写入设置（主进程专用）：跳过 SEC-007 的敏感项拦截，仍做类型清洗。
   *
   * 用途仅限三处：插件的信任操作（`plugins:trust`）、MCP 令牌轮换、密钥的宿主侧维护 ——
   * 全部是主进程自己发起的写入。**不要**把它接到任何 IPC 通道上。
   */
  updateSettingsTrusted(patch: Partial<AppSettings>): void {
    const safe = sanitizeSettingsPatch(patch, true);
    this.update((d) => {
      d.settings = mergeSettings(d.settings, safe);
    });
  }

  broadcast(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('store:changed', this.data);
    }
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseRows<T>(rows: Array<{ key: string; value: string }>): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = parseJson<T>(row.value);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function userDataDir(): string {
  return app.getPath('userData');
}

export function resourcesRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources');
}

export function pluginsDirs(): string[] {
  const dirs: string[] = [join(userDataDir(), 'plugins')];
  if (app.isPackaged) dirs.push(join(process.resourcesPath, 'plugins'));
  else dirs.push(join(app.getAppPath(), 'plugins'));
  return dirs;
}

export function petFramesDir(): string {
  return join(resourcesRoot(), 'pet-frames');
}

export function defaultPetImage(): string {
  return join(resourcesRoot(), 'default-pet.png');
}

export function iconCacheDir(): string {
  return join(userDataDir(), 'icon-cache');
}

export function isPathAllowed(p: string): boolean {
  const roots = [resourcesRoot(), userDataDir(), ...pluginsDirs()];
  const normalized = p.replace(/\//g, '\\').toLowerCase();
  return roots.some((r) => normalized.startsWith(r.replace(/\//g, '\\').toLowerCase() + '\\'));
}

let store: DataStore | null = null;

export function dataStore(): DataStore {
  if (!store) store = new DataStore();
  return store;
}
