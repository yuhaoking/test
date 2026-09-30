export type ModuleType =
  | 'quick_launch'
  | 'file_manager'
  | 'server_launcher'
  | 'website_launcher'
  | 'todo_list'
  | 'system_info'
  | 'music_player'
  | 'plugin'
  | 'desktop_boxes';

export interface QuickLaunchItem {
  id: string;
  name: string;
  path: string;
  icon?: string;
  searchKeys?: string[];
}

export interface ServerItem {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  type: 'command' | 'bat' | 'python' | 'exe' | 'remote';
}

export interface WebsiteItem {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

/** T-09：重复任务周期（完成后自动滚动下一期） */
export type TodoRepeat = 'none' | 'daily' | 'weekly' | 'monthly';

/** T-09：颜色标签 */
export type TodoColor = 'red' | 'orange' | 'green' | 'blue' | 'purple';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  reminderAt?: number;
  remindType?: 'pet' | 'list';
  notified?: boolean;
  /** T-09：截止日期 */
  dueAt?: number;
  /** T-09：重复任务 */
  repeat?: TodoRepeat;
  /** T-09：颜色标签 */
  color?: TodoColor;
  /** T-09：Markdown 备注 */
  note?: string;
}

// ---------- 剪贴板历史 + 片段库（CH-01 ~ CH-06） ----------

export type ClipboardKind = 'text' | 'image';

/** 剪贴板历史条目（落 SQLite clipboard 表，CH-01） */
export interface ClipboardEntry {
  id: string;
  kind: ClipboardKind;
  /** 文本内容（kind=text；加密存储时磁盘上为密文，接口返回明文） */
  text?: string;
  /** 图片文件路径（userData/clipboard-images 下；缩略图 <id>.thumb.png） */
  imageFile?: string;
  width?: number;
  height?: number;
  /** 图片 OCR 文本（CH-06：索引进历史，可被搜索命中） */
  ocrText?: string;
  /** P1-3：ocrText 在磁盘上是否为密文（加密存储开启时与正文同等保护） */
  ocrEncrypted?: boolean;
  /** 来源应用进程名（未知为空串） */
  sourceApp: string;
  createdAt: number;
  /** 置顶条目（CH-02：不参与自动清理） */
  pinned: boolean;
  /** 内容是否加密存储（CH-03 / spec 5.4） */
  encrypted: boolean;
}

/** 剪贴板历史查询（CH-02：搜索 + 时间/类型筛选） */
export interface ClipboardQuery {
  query?: string;
  kind?: ClipboardKind | 'all';
  timeRange?: DesktopTimeRange;
  limit?: number;
}

/** 片段库条目（CH-05：预设常用文本 + 缩写展开） */
export interface Snippet {
  id: string;
  name: string;
  /** 缩写：粘贴面板内输入缩写按 Tab 展开 */
  abbr: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// ---------- 插件市场（PM-01 ~ PM-04） ----------

/** 插件市场条目（索引项） */
export interface MarketItem {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  category?: string;
  type: 'module' | 'pet';
  /** 下载地址：https://…（zip 包）或 builtin://<id>（内置示例包） */
  url: string;
  /** zip 包 SHA256（https 源必填，PM-04 安全校验） */
  sha256?: string;
  homepage?: string;
  /** 官方/社区验证标记；未验证展示“社区未验证”标签（PM-04） */
  verified?: boolean;
  downloads?: number;
  updatedAt?: string;
  /** 权限声明（安装前提示：文件 / 网络 / 剪贴板 等） */
  permissions?: string[];
}

export interface MarketIndex {
  version: number;
  generatedAt?: string;
  items: MarketItem[];
}

/** 插件市场状态（列表 + 安装态 + 可更新） */
export interface MarketState {
  source: string;
  items: MarketItem[];
  /** 已安装：id -> 本地版本 */
  installed: Record<string, string>;
  /** 可更新的插件 id 列表 */
  updatable: string[];
  error?: string;
}

// ---------- 系统整合（SY-02 / SY-03 / SY-04） ----------

export type HotkeyAction = 'sidebar' | 'palette' | 'deskboard' | 'clipboard' | 'capture' | 'pin' | 'translate' | 'ocr';

/** 全局快捷键管理项（SY-02：统一管理 + 冲突检测 + 重置） */
export interface HotkeyInfo {
  action: HotkeyAction;
  label: string;
  accelerator: string;
  defaultAccelerator: string;
  /** 是否启用（与所属功能开关联动） */
  enabled: boolean;
  /** 当前是否注册成功 */
  registered: boolean;
  /** 与哪一项冲突（同应用内重复分配） */
  conflictWith?: HotkeyAction;
  /** 注册失败原因（如被其他程序占用） */
  error?: string;
}

// ---------- 截图增强（T-04：贴图 / 标注 / 长截图） ----------

export type CaptureTool = 'arrow' | 'rect' | 'text' | 'mosaic' | 'pen';

/** 虚拟桌面上的一块屏幕捕获面（DIP 坐标 + 原始像素位图） */
export interface CaptureSurface {
  displayId: number;
  /** 显示器在虚拟桌面中的 DIP 边界 */
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** 全屏位图 dataURL（真实像素分辨率） */
  dataUrl: string;
}

/** 选区（虚拟桌面 DIP 坐标） */
export interface CaptureRect {
  displayId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotatePayload {
  /** mode=stitch 时携带待拼接的分段图，先拼接再标注 */
  mode: 'edit' | 'stitch';
  dataUrl?: string;
  segments?: string[];
}

export interface PinPayload {
  dataUrl: string;
}

export interface LongPayload {
  rect: CaptureRect;
}

// ---------- 桌面收纳（规格 DR-01 ~ DR-07） ----------

/** 盒子内索引项：仅记录路径（默认不动原文件），路径为绝对路径，支持跨盘符 */
export interface DesktopBoxItem {
  path: string;
  name: string;
  isDir: boolean;
  addedAt: number;
  /** T-08 文件叠放（Stacks）：叠放组名（同名条目叠成一摞，仅索引不动原文件） */
  stack?: string;
}

export type DesktopTimeRange = 'today' | 'week' | 'month' | 'all';

/**
 * 收纳盒内容类型（决定盒子窗口渲染什么）：
 * - files：文件索引网格（默认，兼容旧数据）
 * - apps：应用启动网格（把“快捷启动”整合进盒，点开即启动）
 * - search：统一搜索面板（复用命令面板内核，盒内搜索应用/文件/网站/插件）
 */
export type BoxKind = 'files' | 'apps' | 'search';
/**
 * 收纳分类（用户需求的三大类）：
 * - software：可执行程序/快捷方式（exe、lnk、msi…）
 * - image：图片（png、jpg…）
 * - file：其余所有文件（文档/视频/音频/压缩包等统一归入“文件”）
 */
export type DesktopFileType = 'image' | 'software' | 'file';

/** 自动分类规则：按扩展名 / 文件类型 / 时间（今日/本周/本月）匹配 */
export interface DesktopRule {
  enabled: boolean;
  /** 扩展名（小写、不含点）；空数组 = 不限扩展名 */
  extensions: string[];
  /** 文件类型分类；空数组 = 不限类型 */
  fileTypes: DesktopFileType[];
  timeRange: DesktopTimeRange;
}

/** 收纳盒配置与数据模型（保存在 SQLite，DR-07） */
export interface DesktopBox {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  /** 是否显示盒子窗口（隐藏不删除） */
  visible: boolean;
  /** 是否置顶到第一层（可逐盒设置；默认 true） */
  onTop: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 盒子所在显示器编号（多显示器适配，SY-05） */
  displayId?: number;
  /** T-08 多显示器布局记忆：按显示器组合（拓扑 + DPI）分别保存位置尺寸，热插拔后恢复 */
  layouts?: Record<string, { x: number; y: number; width: number; height: number }>;
  /** 自动分类扫描目录（默认桌面） */
  watchDir: string;
  /** “真移动”模式（DR-06）的目标目录 */
  targetDir: string;
  order: number;
  rules: DesktopRule[];
  items: DesktopBoxItem[];
  /** 智能分类自动创建的类别盒：true 表示由系统自动生成，可被复用/回收 */
  auto?: boolean;
  /** 自动类别盒对应的文件类型（image/document/video/audio/software/archive/other） */
  autoType?: DesktopFileType;
  /** 盒子内容类型（缺省 = files，兼容旧数据） */
  kind?: BoxKind;
  /** T-08 胶囊模式：盒子收起成胶囊（悬停临时展开 / 点击固定展开） */
  capsule?: boolean;
  /** T-08 盒子组：同组胶囊在桌面上并排停靠成胶囊栏 */
  group?: string;
  /** T-08 胶囊模式展开后的完整尺寸（收起前记忆，展开时恢复） */
  expandBounds?: { x: number; y: number; width: number; height: number };
}

// ---------- 全局命令面板（规格 CP-01 ~ CP-06） ----------

export type PaletteCategory =
  | 'app'
  | 'file'
  | 'website'
  | 'function'
  | 'plugin'
  | 'todo'
  | 'clipboard'
  | 'snippet'
  /** DEV-12：开发者工具即时结果（置顶显示） */
  | 'instant'
  /** CP-07：粘贴智能匹配的推荐动作分组（置顶） */
  | 'suggest';
export type PaletteSort = 'usage' | 'recent' | 'alpha';

/** 命令面板搜索结果项 */
export interface PaletteResult {
  id: string;
  label: string;
  sublabel?: string;
  category: PaletteCategory;
  /** 图标路径（可选，通常为应用图标缓存） */
  icon?: string;
  action: {
    type: 'app' | 'file' | 'url' | 'function' | 'plugin' | 'todo' | 'clipboard' | 'snippet' | 'context';
    value?: string;
  };
}

// ---------- T-14：上下文动作模型（M1 工作台 / M3 划词动作条 / M4 智能匹配共用） ----------

/** 动作分组：文本 / 文件 / 网址 / 图片 / 用户固定 */
export type ContextGroup = 'text' | 'file' | 'url' | 'image' | 'pinned';

/** 上下文动作（WK-02 / SPC 2.2） */
export interface ContextAction {
  /** 'text.translate' | 'file.reveal' | 'image.ocr' … */
  id: string;
  group: ContextGroup;
  label: string;
  /** Icon 组件名 */
  icon: string;
  /** Ctrl+数字 快捷序号（1 起） */
  hotIndex?: number;
  /** 使用次数（来自 palette_usage，WK-03 排序） */
  usage?: number;
  /** 是否已固定到常驻区（WK-03） */
  pinned?: boolean;
  /** 需要用户显式启用（如 WK-06 归档动作默认不启用） */
  requiresEnable?: boolean;
}

/** 上下文类型（WK-01 / SPC 2.1） */
export type ContextType = 'text' | 'file' | 'url' | 'image' | 'none';

/** 上下文载荷（仅内存态：不落盘、不上传，规格 §4 安全） */
export interface ContextPayload {
  type: ContextType;
  text?: string;
  paths?: string[];
  /** 剪贴板图片（dataURL；仅内存态） */
  imageDataUrl?: string;
  /** 前台应用进程名 */
  foregroundApp?: string;
  /** 人类可读说明 */
  detail?: string;
}

/** 划词动作条动作项（WK-07：可配置动作条） */
export interface SelectionBarAction {
  id: string;
  enabled: boolean;
  order: number;
}

/** 上下文抓取结果（主进程 → 工作台渲染层） */
export interface ContextCaptureEvent {
  payload: ContextPayload;
  actions: ContextAction[];
}

// ---------- T-14：指令别名（AL-01 ~ AL-03） ----------

export type AliasTargetType = 'function' | 'pluginCommand' | 'website' | 'snippet';

/** 指令别名（专表 aliases：key=id, value=JSON） */
export interface Alias {
  id: string;
  /** 短别名（唯一，冲突拒绝保存） */
  alias: string;
  /** 目标结果的 PaletteResult.id（如 fn-settings / plugincmd:<pid>:<cid> / web:<id>） */
  targetId: string;
  targetType: AliasTargetType;
  /** 目标显示名（管理页展示用） */
  targetLabel?: string;
  note?: string;
  createdAt: number;
}

// ---------- T-14：剪贴板意图（CP-07） ----------

export type ClipboardIntentKind = 'path' | 'url' | 'json' | 'timestamp' | 'color' | 'unknown';

export interface ClipboardIntentInfo {
  kind: ClipboardIntentKind;
  text: string;
  paths: string[];
  detail: string;
}

/** 格式化粘贴模式（CH-07 ~ CH-09） */
export type PasteMode = 'plain' | 'json' | 'ocr';

// ---------- T-14：检查更新（UPD-01） ----------

export interface UpdateState {
  enabled: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  publishedAt?: string;
  hasUpdate: boolean;
  checkedAt: number;
  /** 失败信息（设置页展示；检查失败本身不弹窗打扰） */
  error?: string;
  /** P1-2：当前是否仍在使用内置占位仓库（true 时设置页提示填写真实仓库） */
  placeholderFeed?: boolean;
}

export interface ModuleConfig {
  items?: QuickLaunchItem[] | ServerItem[] | WebsiteItem[] | TodoItem[];
  pluginId?: string;
  pluginName?: string;
  pluginIcon?: string;
  [key: string]: unknown;
}

export interface Module {
  id: string;
  type: ModuleType;
  name: string;
  icon?: string;
  fixed: boolean;
  pinned: boolean;
  order: number;
  config: ModuleConfig;
}

export interface RecentFile {
  path: string;
  lastOpened: number;
}

export interface FavoriteFile {
  path: string;
  addedAt: number;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  category?: string;
  type: 'module' | 'pet';
  icon?: string;
  dir: string;
  enabled: boolean;
  moduleId?: string;
  trusted?: boolean;
  status?: string;
  /** 依赖（requirements.txt）已安装成功（持久化，避免每次启动重复 pip install） */
  depsInstalled?: boolean;
  /** 依赖安装时使用的 Python 解释器路径（换解释器（如 dev→打包版）自动重装） */
  depsPython?: string;
  /** 命令声明（PM-03，来自 manifest.commands） */
  commands?: PluginCommand[];
  /** 后台任务（PM-03 异步任务模型）：仅运行时存在，不落库 */
  jobs?: PluginJob[];
  /** 来源标记：market 表示从插件市场安装 */
  origin?: 'builtin' | 'market';
  /**
   * SEC-005：同 id 出现在多个插件目录（如 userData 覆盖内置）。
   *
   * 旧实现静默取第一个，用户无从知道"生效的到底是哪一份"。标记后在插件列表可见，
   * 日志同时打印全部冲突目录。
   */
  conflict?: boolean;
  /**
   * 运行期状态（running / 等待并发槽位… / 空闲回收 / error: 缺少模块 X / exited (n) /
   * 后台执行中：… / 超时（600s）：…）。
   *
   * 与 `status`（builtin/user，表示"从哪来"）分开：UI 用 status 决定是否显示"移除"，
   * 用 runtimeStatus 告诉用户"插件现在到底怎么了" —— 长任务/失败原因此前完全看不到。
   */
  runtimeStatus?: string;
}

/**
 * 插件后台任务（PM-03 异步任务模型，T-15/B）
 *
 * 背景：录屏、大文件转换这类任务的耗时远超一次 JSON-RPC 往返的合理时长
 * （插件内部允许 600s）。让 handle_action 一直挂着等结果，既容易被宿主超时打断，
 * 也让用户看不到任何进展。改为"立即返回 jobId + 进度上报 + 宿主轮询"：
 *  · 插件在 `handle_action` 的返回里带上 `job`，或随后发 `event: job`；
 *  · 宿主登记任务、按 2s 轮询 `plugin.jobs`（插件可选实现），期间**绝不回收进程**；
 *  · 完成/失败时弹通知并广播，UI 卡片显示进度条。
 */
export interface PluginJob {
  id: string;
  title: string;
  /** 0~100；插件未上报时为 undefined（UI 显示不确定进度） */
  progress?: number;
  status: 'running' | 'done' | 'error';
  message?: string;
  /** 产物路径等结果说明（完成时展示/可复制） */
  result?: string;
  startedAt: number;
  updatedAt: number;
}

/** 插件命令声明（PM-03：manifest.commands 扩展，注册进全局命令面板） */
export interface PluginCommand {
  id: string;
  title: string;
  /** 额外搜索关键词 */
  keywords?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  category?: string;
  type: 'module' | 'pet';
  entry: string;
  icon?: string;
  permissions?: string[];
  /** 命令插件协议扩展（PM-03）：声明后命令直接进入全局命令面板；旧插件无此字段，完全兼容 */
  commands?: PluginCommand[];
}

export interface PluginInput {
  id: string;
  label: string;
  type?: 'text' | 'number' | 'select' | 'picker';
  picker?: 'file' | 'folder';
  options?: string[];
  default?: string;
}

export interface PluginMetric {
  label: string;
  value: string;
}

export interface PluginUiDescriptor {
  title?: string;
  text?: string;
  inputs?: PluginInput[];
  buttons?: { id: string; label: string }[];
  metrics?: PluginMetric[];
}

export interface AppSettings {
  theme: 'dark' | 'light';
  accent: string;
  petImage: string;
  petActions: Record<string, string[]>;
  autostart: boolean;
  hotkey: string;
  petOnTop: boolean;
  sidebarOnTop: boolean;
  sidebarWidth: number;
  sidebarAutoCollapse: boolean;
  excludedFolders: string[];
  musicPlatform: string;
  trustedSources: string[];
  saveDir: string;
  deepseekApiKey: string;
  // ---- T-05：AI 宠物人设 ----
  /** 宠物名字 */
  petName: string;
  /** 宠物性格人设描述（注入对话 System Prompt） */
  petPersona: string;
  /** 宠物口癖（偶尔自然带上的口头禅） */
  petCatchphrase: string;
  /** 宠物世界观/自我介绍（注入对话 System Prompt，T-05 扩展） */
  petWorldview: string;
  // ---- T-06：UGC 主题包 ----
  /** 当前生效的主题包 id（'' = 内置默认形象） */
  petThemeId: string;
  /** 气泡样式（主题包可覆盖；'' = 跟随应用主题） */
  petBubbleBg: string;
  petBubbleColor: string;
  petBubbleFontSize: number;
  petBubbleRadius: number;
  // ---- v2.0 新增（所有新功能默认关闭，规格 3.4 / 8） ----
  /** 桌面收纳总开关 */
  desktopBoxesEnabled: boolean;
  /** 隐藏桌面原生图标（可选，DR-04） */
  hideDesktopIcons: boolean;
  /** “仅整理视图 / 真移动”全局开关（默认仅整理视图，DR-06） */
  boxMoveMode: boolean;
  /** 智能分类：监听桌面新增文件，自动按类别（文档/图片/视频/音频/软件/其他）归入对应收纳盒 */
  boxAutoMode: boolean;
  /** 全局命令面板总开关 */
  paletteEnabled: boolean;
  /** 命令面板全局热键（CP-01，默认 Alt+Space） */
  paletteHotkey: string;
  /** 命令面板结果排序（CP-06） */
  paletteSort: PaletteSort;
  /** 命令面板排除的文件扩展名（小写、不含点，CP-06） */
  paletteExcludeExts: string[];
  /**
   * 搜索内核增强（T-07）：无 Everything 时使用 Windows 自带搜索索引（SYSTEMINDEX）快速兜底。
   * 依赖系统 WSearch 服务；不可用时自动回退到内置目录遍历，因此默认开启无风险。
   */
  searchUseWindowsIndex: boolean;
  /** 桌面工作台（DeskBox 式主面板）：总开关（默认开启） */
  deskboardEnabled: boolean;
  /** 桌面工作台：执行功能后自动收起（"用完即走"，默认开启；关闭则保持常驻不自动隐藏） */
  deskboardHideAfterAction: boolean;
  /** 桌面工作台：启动时自动显示（默认关闭 = 非常驻，用热键/托盘随时呼出） */
  deskboardShowOnStartup: boolean;
  /** 桌面工作台全局热键（显示/隐藏） */
  deskboardHotkey: string;
  // ---- P0 新增（tasks.md T-01 ~ T-04） ----
  /** 托盘常驻（SY-03） */
  trayEnabled: boolean;
  /** 主窗口关闭时最小化到托盘（SY-03） */
  closeToTray: boolean;
  /** 剪贴板历史监听总开关（CH-01） */
  clipboardEnabled: boolean;
  /** 浮动粘贴面板全局热键（CH-04，默认 Ctrl+Shift+V） */
  clipboardHotkey: string;
  /** 剪贴板历史保留条数上限（超出淘汰最旧的未置顶条目） */
  clipboardMaxItems: number;
  /** 隐私：排除关键词（文本命中任意关键词则不记录，CH-03） */
  clipboardExcludeKeywords: string[];
  /** 隐私：应用白名单（非空时仅记录这些来源应用，CH-03） */
  clipboardAppWhitelist: string[];
  /** 隐私：加密存储（CH-03 / spec 5.4） */
  clipboardEncrypt: boolean;
  /** 是否记录剪贴板图片（CH-01） */
  clipboardImages: boolean;
  /** 是否对剪贴板图片 OCR 并索引进历史（CH-06） */
  clipboardOcr: boolean;
  /** 区域截图全局热键（T-04） */
  captureHotkey: string;
  /** 贴图全局热键（T-04：剪贴板图片钉到桌面） */
  pinHotkey: string;
  /** 插件市场索引地址（PM-01 数据源可配置；builtin://index 为内置示例源） */
  marketIndexUrl: string;
  /**
   * SEC-004 / OPT-16：是否允许使用远程（HTTPS）市场索引。
   *
   * 索引条目的 verified 字段是**索引自报**的（没有签名、没有信任根），
   * 因此在签名制（T-05）落地前，远程索引默认关闭：只有用户显式打开，
   * 并且看到风险说明之后，应用才会去拉取远程索引。
   * 硬约束：T-05 完成前，本项不得改为默认 true（发版门禁第 5 条）。
   */
  marketAllowRemoteIndex: boolean;
  // ---- P1 新增（tasks.md T-05 ~ T-08） ----
  /** T-05：语音播报（宠物气泡消息 TTS 朗读） */
  petVoiceEnabled: boolean;
  /** T-05：TTS 语速（-5 ~ 5） */
  petVoiceRate: number;
  /** T-05：MCP 对外工具协议开关（宠物即 Agent 入口，供外部 MCP 客户端调用工具） */
  mcpEnabled: boolean;
  /** T-05：MCP HTTP 端点端口（仅绑定本机回环） */
  mcpPort: number;
  /** SEC-6：MCP 访问令牌（自动生成；外部客户端必须携带，防本机网页/DNS rebinding 滥用） */
  mcpToken: string;
  /** T-07：划词翻译热键（选中文本 → 复制取词 → 悬浮翻译条，pot 模式） */
  translateHotkey: string;
  /** T-07：取词 OCR 热键（框选屏幕文字 → 悬浮文本条） */
  ocrHotkey: string;
  /** T-08：自动整理增强：监听下载目录（下载/解压稳定后自动归类桌面/下载新文件） */
  boxWatchDownloads: boolean;
  // ---- P2 新增（tasks.md T-10 / T-11） ----
  /** T-10：性能模式（均衡 / 节省资源 / 自定义） */
  perfMode: 'balanced' | 'saver' | 'custom';
  /** T-10 自定义模式：动画开关 */
  perfAnimations: boolean;
  /** T-10 自定义模式：窗口隐藏时闲置释放（降帧率） */
  perfIdleRelease: boolean;
  /** T-11：插件安装包加密留存（AES-256-GCM，安装成功后加密备份到本机） */
  marketEncryptPackages: boolean;
  /**
   * 幽灵窗口排查用：禁用硬件加速。
   * 渲染进程反复崩溃（reason=crashed）时开启可显著减少崩溃；需重启应用生效，默认关闭。
   */
  disableGpuAccel: boolean;
  /**
   * GW-01 / OPT-14：窗口活性探测（每 30s 采样常驻动画窗画面，连续无变化判定冻结并恢复）。
   * 默认开启——这是"系统不发事件"那类幽灵窗口的唯一兜底；老机器或排查时可关。
   */
  windowLivenessProbe: boolean;
  // ---- T-14 新增（tasks.md T-14：主流化功能补齐） ----
  /** WK-04：工作台呼出时自动抓取上下文（模拟 Ctrl+C + 剪贴板保护；默认开启，可关） */
  deskboardContextCapture: boolean;
  /** WK-03：固定到工作台常驻区的动作 id 列表（重启保留） */
  deskboardPins: string[];
  /** CP-07：命令面板粘贴智能匹配推荐（默认开启） */
  paletteSmartSuggest: boolean;
  /**
   * 命令面板热键是否已做过「废弃默认值」升级（P3-7 的 Alt+Space → Ctrl+Space）。
   * 需要这个标记是因为默认值只在首次安装时写库：老用户库里存着必然冲突的 Alt+Space，
   * 升级只能在"该键确实注册失败"时做一次；用户之后手动改回去是他的选择，不再干涉。
   */
  paletteHotkeyMigrated: boolean;
  /** WK-07：划词悬浮条动作条配置（启用/排序） */
  selectionBarActions: SelectionBarAction[];
  // ---- T-12：国际化 ----
  /** 界面语言：'auto' = 跟随系统；其余为 'zh-CN' | 'zh-TW' | 'en' | 'ja' */
  locale: string;
  /** UPD-01：启动后检查更新（默认开启；失败静默） */
  updateCheckEnabled: boolean;
  /** UPD-01：更新源地址（留空则按 package.json homepage 推导 GitHub Releases） */
  updateFeedUrl: string;
  /** UPD-01：上次检查时间戳（≤ 1 次/天） */
  lastUpdateCheck: number;
  /** UPD-01：上次检查到的最新版本 */
  lastUpdateVersion: string;
}

/** T-10：资源占用可视化数据（设置页展示） */
export interface PerfUsage {
  rssMB: number;
  heapMB: number;
  externalMB: number;
  uptimeSec: number;
  windows: number;
  visibleWindows: number;
}
/** 天气数据（wttr.in，无 key；失败时返回 null） */
export interface WeatherData {
  city: string;
  tempC: number | null;
  feelsC: number | null;
  humidity: number | null;
  windKmh: number | null;
  desc: string;
  forecast: Array<{ date: string; maxC: number | null; minC: number | null; desc: string }>;
}

export interface AppData {
  settings: AppSettings;
  modules: Module[];
  recentFiles: RecentFile[];
  favoriteFiles: FavoriteFile[];
  plugins: PluginRecord[];
}

export interface SystemInfoData {
  cpu: { model: string; cores: number; usage: number; temp?: number };
  mem: { total: number; used: number; usage: number };
  disk: { total: number; used: number; usage: number };
  gpu: { model: string; usage?: number; temp?: number };
  temps: { cpu?: number; gpu?: number };
}

export interface MusicState {
  hasSession: boolean;
  title: string;
  artist: string;
  album: string;
  albumArt: string;
  appId: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
}

export interface LyricLine {
  t: number;
  text: string;
}

export interface ServerLogEvent {
  itemId: string;
  stream: 'stdout' | 'stderr' | 'system';
  data: string;
}

export interface SearchResult {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface AppItem {
  name: string;
  path: string;
  icon?: string;
}

/** 运行环境诊断信息（设置页显示，用于确认运行的是哪个构建、引擎是否就绪） */
export interface AppInfo {
  version: string;
  /** 实际使用的 Python 解释器（嵌入式引擎路径 或 系统 python） */
  python: string;
  /** 嵌入式 Python 是否包含 tkinter（截图插件依赖） */
  tkinterOk: boolean;
  /** 数据目录 */
  dataDir: string;
}

export interface PetFrameSet {
  image: string;
  actions: Record<string, string[]>;
  /** T-06：当前主题包的气泡样式（未使用主题包时为主进程给出的默认值） */
  bubble?: ThemeBubbleStyle;
  /** T-06：主题包声明的显示缩放（默认 1；窗口尺寸按图片原始尺寸 × scale 计算） */
  scale?: number;
}

// ---------- T-06：UGC 宠物/皮肤主题包 ----------

/** 宠物气泡样式（主题包可覆盖；空字符串表示跟随应用主题变量） */
export interface ThemeBubbleStyle {
  /** 背景色，'' = 跟随 --bg-solid */
  bg: string;
  /** 文字色，'' = 跟随 --text */
  color: string;
  /** 字号 px（9~24） */
  fontSize: number;
  /** 圆角 px（0~24） */
  radius: number;
}

/** 主题包附带的界面皮肤（默认不自动应用，需用户显式勾选） */
export interface ThemeSkin {
  /** 明暗主题，'' = 不修改 */
  theme: 'dark' | 'light' | '';
  /** 强调色 #rrggbb，'' = 不修改 */
  accent: string;
}

/**
 * 主题包清单（`theme.json`）。
 * 与插件 manifest 同样是"对外契约"：字段一旦发布就被 UGC 包引用，新增字段必须可选。
 */
export interface ThemeManifest {
  format: 'xiaopeng-theme';
  formatVersion: number;
  /** 反向域名式唯一 id（如 com.xiaopeng.orange-cat） */
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** 授权协议（如 CC-BY-4.0）；不填视为"保留所有权利" */
  license: string;
  homepage: string;
  tags: string[];
  /** 主形象（包内相对路径） */
  image: string;
  /** 动作 → 帧序列（包内相对路径） */
  actions: Record<string, string[]>;
  /** 显示缩放（0.25~4） */
  scale: number;
  bubble: ThemeBubbleStyle;
  skin: ThemeSkin | null;
  createdAt: string;
}

/** 已安装主题包（设置页列表项） */
export interface ThemePackInfo {
  manifest: ThemeManifest;
  dir: string;
  /** 占用体积（字节） */
  bytes: number;
  /** 内置（默认形象），不可删除/导出 */
  builtin: boolean;
  /** 是否当前生效 */
  active: boolean;
  installedAt: number;
}

/** 主题包导入结果 */
export interface ThemeImportResult {
  ok: boolean;
  /** 失败原因（面向用户的中文说明） */
  error?: string;
  info?: ThemePackInfo;
  /** 已存在同 id 主题：UI 据此二次确认是否覆盖 */
  exists?: boolean;
}

/** 制作主题包时的文案参数（路径类字段由主进程从当前设置读取，渲染层不传） */
export interface ThemeDraft {
  name: string;
  id?: string;
  author?: string;
  description?: string;
  version?: string;
  license?: string;
  homepage?: string;
  tags?: string[];
  bubble?: Partial<ThemeBubbleStyle>;
  skin?: Partial<ThemeSkin>;
}

/** 主题包导出结果（分享用） */
export interface ThemeExportResult {
  /** 用户取消保存对话框时为 null */
  path: string | null;
  sha256: string;
  bytes: number;
  /** 可直接发到社区的分享文案（Markdown） */
  shareText: string;
}

export interface AssetData {
  data: string;
  mime: string;
}

/** T-05：对话消息（宠物记忆持久化） */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Agent 工具调用轨迹（人类可读） */
  trace?: string[];
}

export interface ChatReply {
  reply: string;
  trace: string[];
}

/** T-07：划词翻译 / 取词 OCR 悬浮条数据 */
export interface TranslateBarData {
  mode: 'translate' | 'ocr';
  /** 原文（translate=选中文本，ocr=识别文本） */
  source: string;
  /** 译文（ocr 模式为空串） */
  result: string;
  /** 来源说明（如"中 → 英"或 OCR 引擎） */
  hint?: string;
  error?: string;
  /** WK-07：动作执行反馈（如"已复制大写文本"） */
  notice?: string;
}

/** T-06：AI 造插件生成物（manifest + 文件内容，安装/发布前可预览） */
export interface ForgeResult {
  manifest: PluginManifest;
  /** 文件名（相对插件目录）→ 内容 */
  files: Record<string, string>;
  /** 生成说明（AI 给用户的使用提示） */
  notes?: string;
}

/** T-08：内置文件预览（QuickLook 未检测到时的兜底） */
export interface PreviewData {
  name: string;
  path: string;
  kind: 'text' | 'image' | 'video' | 'audio' | 'other';
  mime: string;
  size: number;
  mtime: number;
  /** kind=text 时的文本内容（截断至 512KB） */
  text?: string;
  /** kind=image 时的图片 dataURL */
  dataUrl?: string;
}

export interface Api {
  store: {
    get: () => Promise<AppData>;
    updateSettings: (patch: Partial<AppSettings>) => Promise<AppData>;
  };
  modules: {
    add: (m: Module) => Promise<Module[]>;
    update: (id: string, patch: Partial<Module>) => Promise<Module[]>;
    remove: (id: string) => Promise<Module[]>;
    reorder: (modules: Module[]) => Promise<Module[]>;
  };
  sidebar: {
    toggle: () => Promise<void>;
    show: () => Promise<void>;
    hide: () => Promise<void>;
    setWidth: (width: number) => Promise<void>;
  };
  apps: {
    scan: (force?: boolean) => Promise<AppItem[]>;
    pick: () => Promise<AppItem | null>;
    getIcon: (path: string) => Promise<string>;
  };
  files: {
    search: (query: string, fullDisk?: boolean, drives?: string[]) => Promise<SearchResult[]>;
    getDrives: () => Promise<string[]>;
    open: (path: string) => Promise<void>;
    addFavorite: (path: string) => Promise<void>;
    removeFavorite: (path: string) => Promise<void>;
    clearRecents: () => Promise<void>;
    getIcons: (paths: string[]) => Promise<Record<string, string>>;
  };
  websites: {
    open: (url: string) => Promise<void>;
  };
  servers: {
    launch: (item: ServerItem) => Promise<boolean>;
    stop: (itemId: string) => Promise<void>;
    onLog: (cb: (e: ServerLogEvent) => void) => () => void;
  };
  system: {
    getInfo: () => Promise<SystemInfoData | null>;
    onPush: (cb: (info: SystemInfoData) => void) => () => void;
  };
  music: {
    state: () => Promise<MusicState>;
    control: (action: string, value?: number) => Promise<MusicState>;
    openPlayer: () => Promise<boolean>;
    lyrics: (title: string, artist: string) => Promise<LyricLine[]>;
  };
  plugins: {
    list: () => Promise<PluginRecord[]>;
    install: () => Promise<PluginRecord[]>;
    load: (id: string) => Promise<PluginRecord[]>;
    unload: (id: string) => Promise<PluginRecord[]>;
    remove: (id: string) => Promise<PluginRecord[]>;
    trust: (id: string) => Promise<string[]>;
    action: (pluginId: string, action: string, values?: Record<string, string>) => Promise<unknown>;
    ui: (id: string, values?: Record<string, string>, start?: boolean) => Promise<PluginUiDescriptor | null>;
    onChanged: (cb: (list: PluginRecord[]) => void) => () => void;
    onEvent: (cb: (e: { pluginId: string; type: string; params: Record<string, unknown> }) => void) => () => void;
  };
  /** T-05：AI 宠物对话（DeepSeek 驱动，含 Agent 工具闭环） */
  llm: {
    chat: (message: string) => Promise<ChatReply>;
    history: () => Promise<ChatMessage[]>;
    clear: () => Promise<void>;
    /** T-05：MCP 对外工具服务状态（宠物即 Agent 入口） */
    mcpStatus: () => Promise<{ running: boolean; port: number; token: string; error?: string }>;
  };
  /** T-05：语音输入 + 语音播报（Windows SAPI，免依赖） */
  voice: {
    /** 语音播报（TTS）；重复调用打断上一次播报 */
    speak: (text: string) => Promise<void>;
    /** 停止当前播报 */
    stop: () => Promise<void>;
    /** 语音输入（听写）：识别成功返回文本，无结果返回空串，语音组件缺失抛出可读错误 */
    dictate: (seconds?: number) => Promise<string>;
  };
  /** T-07：划词翻译 / 取词 OCR 悬浮条 */
  translateBar: {
    /** 当前悬浮条数据（悬浮窗拉取） */
    state: () => Promise<TranslateBarData>;
    /** 复制文本到剪贴板 */
    copy: (text: string) => Promise<void>;
    /** 朗读文本（TTS） */
    speak: (text: string) => Promise<void>;
    hide: () => void;
    /** WK-07：当前悬浮条可用动作（可配置动作条） */
    actions: () => Promise<ContextAction[]>;
    /** WK-07：执行动作条上的动作 */
    run: (id: string, text: string) => Promise<void>;
    onShow: (cb: (d: TranslateBarData) => void) => () => void;
  };
  /** T-06：AI 造插件（一句话需求 → 生成 → 预览 → 一键安装 → 发布市场） */
  forge: {
    generate: (prompt: string) => Promise<ForgeResult>;
    install: (result: ForgeResult) => Promise<PluginRecord[]>;
    /** 发布到插件市场源目录（生成 zip 包 + 更新 index.json），返回目录；取消返回 null */
    publish: (result: ForgeResult) => Promise<string | null>;
  };
  /** T-06：UGC 宠物/皮肤主题包（制作 / 导入 / 分享） */
  theme: {
    list: () => Promise<ThemePackInfo[]>;
    /** 弹选择器导入；用户取消返回 null；已存在同 id 时返回 `exists: true` */
    import: () => Promise<ThemeImportResult | null>;
    /** 覆盖确认导入（路径由主进程记忆，渲染层不传路径） */
    importConfirm: () => Promise<ThemeImportResult>;
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    /** 应用主题；applySkin=true 时同时应用包内界面皮肤（明暗/强调色） */
    apply: (id: string, applySkin?: boolean) => Promise<{ ok: boolean; error?: string }>;
    /** 校验包内资源是否齐全（用户手工删过文件时能提前发现） */
    verify: (id: string) => Promise<{ ok: boolean; missing: string[] }>;
    /** 把当前形象/动作帧打成主题包；取消保存返回 path: null */
    create: (draft: ThemeDraft) => Promise<ThemeExportResult | { error: string }>;
    /** 导出已安装主题包（分享用） */
    exportPack: (id: string) => Promise<ThemeExportResult | { error: string }>;
    /** 生成社区分享文案（Markdown） */
    shareText: (id: string) => Promise<string>;
    /** 导出制作模板（清单 + 默认形象 + 制作说明），返回保存路径 */
    template: () => Promise<string | null>;
    openFolder: (id?: string) => Promise<void>;
    builtinId: () => Promise<string>;
    root: () => Promise<string>;
  };
  pet: {
    clicked: () => void;
    doubleClicked: () => void;
    dragStart: () => void;
    dragMove: () => void;
    dragEnd: () => void;
    resize: (w: number, h: number) => void;
    getFrames: () => Promise<PetFrameSet>;
    onAction: (cb: (frames: string[]) => void) => () => void;
    onNotify: (cb: (text: string) => void) => () => void;
    /** T-05/T-09：播放宠物动作（nod/wave/blink/jump），如待办完成庆祝 */
    play: (action: 'nod' | 'wave' | 'blink' | 'jump') => Promise<void>;
    contextMenu: () => void;
  };
  boxes: {
    list: () => Promise<DesktopBox[]>;
    get: (id: string) => Promise<DesktopBox | null>;
    create: (partial?: Partial<DesktopBox>) => Promise<DesktopBox[]>;
    update: (id: string, patch: Partial<DesktopBox>) => Promise<DesktopBox[]>;
    remove: (id: string) => Promise<DesktopBox[]>;
    setVisible: (id: string, visible: boolean) => Promise<DesktopBox[]>;
    openPath: (path: string) => Promise<void>;
    removeItem: (boxId: string, path: string) => Promise<DesktopBox[]>;
    applyRules: () => Promise<{ boxId: string; added: number; moved: number }[]>;
    /** 扫描已安装软件并把全部应用填充进盒子（点开即启动），返回更新后的清单 */
    addApps: (boxId: string) => Promise<{ added: number; total: number }>;
    /** T-08：空格预览文件（检测到 QuickLook 用之，否则内置预览窗口） */
    preview: (path: string) => Promise<void>;
    /** T-08：内置预览数据（预览窗口拉取） */
    previewData: (path: string) => Promise<PreviewData>;
    /** T-08：文件叠放（stackName=null 取消叠放；仅索引不动原文件） */
    stack: (boxId: string, path: string, stackName: string | null) => Promise<DesktopBox[]>;
    /** T-08：自动归组叠放（按文件类型/扩展名聚成叠放组） */
    autoStack: (boxId: string) => Promise<DesktopBox[]>;
    /** T-08：胶囊模式（true 收起成胶囊并记忆完整尺寸；false 展开恢复） */
    setCapsule: (id: string, capsule: boolean) => Promise<DesktopBox[]>;
    /** T-08：胶囊悬停临时展开（mouseleave 收回） */
    capsuleHover: (id: string, hovering: boolean) => Promise<void>;
    onChanged: (cb: (list: DesktopBox[]) => void) => () => void;
  };
  palette: {
    search: (query: string) => Promise<PaletteResult[]>;
    execute: (result: PaletteResult, openFolder?: boolean) => Promise<void>;
    hide: () => void;
    onShown: (cb: () => void) => () => void;
    /** AL-02：可设置别名的目标清单 */
    targets: () => Promise<Array<{ id: string; label: string; type: string }>>;
    /** T-07：Windows 索引异步补全推送（查询仍是当前输入时才应替换结果） */
    onResults: (cb: (e: { query: string; list: PaletteResult[] }) => void) => () => void;
  };
  settings: {
    open: () => Promise<void>;
    close: () => Promise<void>;
    pickImage: () => Promise<string | undefined>;
    pickFrames: (action: string) => Promise<string[] | undefined>;
    pickFolder: () => Promise<string | undefined>;
    pickFile: () => Promise<string | undefined>;
    info: () => Promise<AppInfo>;
  };
  asset: {
    read: (path: string) => Promise<AssetData>;
    toUrl: (path: string) => Promise<string>;
  };
  todo: {
    onFired: (cb: (text: string) => void) => () => void;
  };
  weather: {
    get: () => Promise<WeatherData | null>;
  };
  deskboard: {
    hide: () => void;
    /** WK-01：主动抓取上下文（呼出时主进程也会推送） */
    captureContext: () => Promise<ContextPayload>;
    /** WK-02：列出某上下文下可用的动作 */
    contextActions: (payload: ContextPayload) => Promise<ContextAction[]>;
    /** WK-02：执行上下文动作 */
    runContextAction: (id: string, payload: ContextPayload) => Promise<{ ok: boolean; message?: string }>;
    /** WK-03：固定 / 取消固定动作（返回最新固定列表） */
    pinContextAction: (id: string, pinned: boolean) => Promise<string[]>;
    /** WK-01：主进程抓取完成后推送（payload + actions） */
    onContext: (cb: (e: ContextCaptureEvent) => void) => () => void;
    /** 渲染层挂载/重载时补齐最近一次上下文 */
    lastContext: () => Promise<ContextCaptureEvent>;
    /** WK-07：划词动作条可选动作清单（设置页用） */
    selectionCatalog: () => Promise<Array<{ id: string; label: string; icon: string; enabled: boolean; order: number }>>;
  };
  /** T-14：开发者工具百宝箱（DEV-d 独立小面板） */
  devtools: {
    open: (tab?: string) => Promise<void>;
    close: () => void;
  };
  /** T-14：指令别名（AL-01 ~ AL-03） */
  aliases: {
    list: () => Promise<Alias[]>;
    save: (a: Alias) => Promise<Alias[]>;
    remove: (id: string) => Promise<Alias[]>;
    /** 批量导入（返回冲突信息，成功为 null） */
    importJson: () => Promise<{ ok: boolean; message?: string; list: Alias[] }>;
    exportJson: () => Promise<string | null>;
  };
  /** T-14：检查更新（UPD-01） */
  update: {
    state: () => Promise<UpdateState>;
    check: (force?: boolean) => Promise<UpdateState>;
    open: () => Promise<void>;
    /** 主进程检查完成后的推送（UPD-01） */
    onState: (cb: (s: UpdateState) => void) => () => void;
  };
  clipboard: {
    /** 查询历史（搜索/筛选即输即显，CH-02） */
    list: (query?: ClipboardQuery) => Promise<ClipboardEntry[]>;
    /** 更新条目（置顶等） */
    update: (id: string, patch: Partial<ClipboardEntry>) => Promise<ClipboardEntry[]>;
    remove: (id: string) => Promise<ClipboardEntry[]>;
    /** 一键清空（keepPinned=true 保留置顶条目） */
    clear: (keepPinned?: boolean) => Promise<ClipboardEntry[]>;
    /** 写回剪贴板；paste=true 时向当前焦点窗口发送 Ctrl+V（CH-04） */
    copy: (id: string, paste?: boolean) => Promise<void>;
    /** 条目图片（full=true 原图，否则缩略图）；加密存储时由主进程解密返回 */
    image: (id: string, full?: boolean) => Promise<AssetData | null>;
    /** 直接写入文本到剪贴板（屏幕取色器复制 HEX/RGB 用） */
    setText: (text: string) => Promise<void>;
    /** CH-07 ~ CH-09：格式化粘贴（plain=纯文本 / json=JSON 格式化 / ocr=图片 OCR 转文字） */
    pasteAs: (id: string, mode: PasteMode) => Promise<{ ok: boolean; message?: string }>;
    /** CP-07：当前剪贴板意图（面板推荐动作 / 快捷入口用） */
    intent: () => Promise<ClipboardIntentInfo>;
    /** 隐藏浮动粘贴面板 */
    hide: () => void;
    onShown: (cb: () => void) => () => void;
    onChanged: (cb: (list: ClipboardEntry[]) => void) => () => void;
  };
  snippets: {
    list: () => Promise<Snippet[]>;
    /** 新建/更新片段（按 id upsert） */
    save: (s: Snippet) => Promise<Snippet[]>;
    remove: (id: string) => Promise<Snippet[]>;
    /** 缩写展开（CH-05）：写入展开内容并粘贴到当前输入框 */
    expand: (id: string, paste?: boolean) => Promise<void>;
    onChanged: (cb: (list: Snippet[]) => void) => () => void;
  };
  market: {
    fetch: () => Promise<MarketState>;
    install: (id: string) => Promise<MarketState>;
    upgrade: (id: string) => Promise<MarketState>;
    uninstall: (id: string) => Promise<MarketState>;
    /** T-11：加密留存的安装包信息（数量/体积/目录） */
    secureInfo: () => Promise<{ count: number; sizeMB: number; dir: string }>;
    /** T-11：清理全部加密留存安装包，返回清理数量 */
    clearSecure: () => Promise<number>;
  };
  /** T-10：资源占用可视化 */
  perf: {
    usage: () => Promise<PerfUsage>;
  };
  /** T-07：搜索后端诊断（设置页展示当前可用能力） */
  search: {
    backend: () => Promise<{ everything: boolean; windowsIndex: boolean }>;
  };
  hotkeys: {
    list: () => Promise<HotkeyInfo[]>;
    /** 修改热键并立即生效（SY-02）；冲突/被占用时抛出错误 */
    set: (action: HotkeyAction, accelerator: string) => Promise<HotkeyInfo[]>;
    /** 一键恢复默认（SY-02） */
    reset: () => Promise<HotkeyInfo[]>;
  };
  backup: {
    /** 导出设置备份（JSON），返回保存路径；取消返回 null（T-11） */
    exportSettings: () => Promise<string | null>;
    /** 导入设置备份并立即生效，返回合并后的设置；取消返回 null（T-11） */
    importSettings: () => Promise<AppSettings | null>;
    /** 导出脱敏诊断包（txt），返回保存路径；取消返回 null（T-11） */
    diag: () => Promise<string | null>;
  };
  capture: {
    /** 区域截图：全屏遮罩拖选 → 标注器（T-04） */
    region: () => Promise<void>;
    /** 全屏截图 → 标注器 */
    full: () => Promise<void>;
    /** 滚动长截图模式（T-04） */
    long: () => Promise<void>;
    /** 屏幕取色器（CH-06：复制 HEX/RGB） */
    colorPicker: () => Promise<void>;
    /** 贴图：把剪贴板图片钉到桌面置顶（T-04） */
    pinClipboard: () => Promise<void>;
    /** 贴图：把图片文件钉到桌面置顶 */
    pinFile: (path: string) => Promise<void>;
    // —— 截图工作流窗口（遮罩/标注器/贴图/长截图控制条）内部接口 ——
    onSurfaces: (cb: (surfaces: CaptureSurface[]) => void) => () => void;
    pickRegion: (rect: CaptureRect) => Promise<void>;
    cancel: () => void;
    cursorPos: () => Promise<{ x: number; y: number }>;
    onAnnotatePayload: (cb: (p: AnnotatePayload) => void) => () => void;
    copyImage: (dataUrl: string) => Promise<void>;
    saveImage: (dataUrl: string) => Promise<string | null>;
    pinImage: (dataUrl: string) => Promise<void>;
    onPinPayload: (cb: (p: PinPayload) => void) => () => void;
    /** 贴图窗口控制：close/copy/zoomIn/zoomOut/reset/opacity(value) */
    pinOp: (op: 'close' | 'copy' | 'zoomIn' | 'zoomOut' | 'reset' | 'opacity', value?: number) => Promise<void>;
    onLongPayload: (cb: (p: LongPayload) => void) => () => void;
    /** 长截图：捕获当前选区分段（autoScroll 时先向目标窗口发送 PgDn） */
    longStep: (autoScroll: boolean) => Promise<string | null>;
    longStop: () => void;
    /** 完成：进入标注器拼接 */
    longFinish: (segments: string[]) => Promise<void>;
    /** 关闭调用方自身窗口（标注器/长截图控制条） */
    selfClose: () => void;
  };
  onStore: (cb: (data: AppData) => void) => () => void;
}
