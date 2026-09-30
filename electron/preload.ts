import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
  Alias,
  AnnotatePayload,
  Api,
  AppData,
  AppInfo,
  AppItem,
  AppSettings,
  AssetData,
  CaptureRect,
  CaptureSurface,
  ClipboardEntry,
  ClipboardIntentInfo,
  ClipboardQuery,
  ContextAction,
  ContextCaptureEvent,
  ContextPayload,
  DesktopBox,
  ForgeResult,
  HotkeyAction,
  HotkeyInfo,
  LongPayload,
  PasteMode,
  UpdateState,
  LyricLine,
  MarketState,
  PerfUsage,
  Module,
  MusicState,
  PaletteResult,
  PetFrameSet,
  PinPayload,
  PluginRecord,
  PluginUiDescriptor,
  PreviewData,
  SearchResult,
  ServerItem,
  ServerLogEvent,
  Snippet,
  SystemInfoData,
  ThemeDraft,
  ThemeExportResult,
  ThemeImportResult,
  ThemePackInfo,
  TranslateBarData,
  WeatherData
} from '../shared/types';

function sanitize(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'object') return JSON.parse(JSON.stringify(value));
  return value;
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args.map(sanitize));
const send = (channel: string, ...args: unknown[]): void => ipcRenderer.send(channel, ...args.map(sanitize));
const on = (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const api: Api = {
  store: {
    get: () => invoke<AppData>('store:get'),
    updateSettings: (patch: Partial<AppSettings>) => invoke<AppData>('store:update-settings', patch)
  },
  modules: {
    add: (m: Module) => invoke<Module[]>('module:add', m),
    update: (id: string, patch: Partial<Module>) => invoke<Module[]>('module:update', id, patch),
    remove: (id: string) => invoke<Module[]>('module:delete', id),
    reorder: (modules: Module[]) => invoke<Module[]>('module:reorder', modules)
  },
  sidebar: {
    toggle: () => invoke<void>('sidebar:toggle'),
    show: () => invoke<void>('sidebar:show'),
    hide: () => invoke<void>('sidebar:hide'),
    setWidth: (width: number) => invoke<void>('sidebar:set-width', width)
  },
  apps: {
    scan: (force?: boolean) => invoke<AppItem[]>('apps:scan', force),
    pick: () => invoke<AppItem | null>('apps:pick'),
    getIcon: (path: string) => invoke<string>('apps:get-icon', path)
  },
  files: {
    search: (query: string, fullDisk?: boolean, drives?: string[]) =>
      invoke<SearchResult[]>('files:search', query, Boolean(fullDisk), drives),
    getDrives: () => invoke<string[]>('files:get-drives'),
    open: (path: string) => invoke<void>('files:open', path),
    addFavorite: (path: string) => invoke<void>('files:add-favorite', path),
    removeFavorite: (path: string) => invoke<void>('files:remove-favorite', path),
    clearRecents: () => invoke<void>('files:clear-recents'),
    getIcons: (paths: string[]) => invoke<Record<string, string>>('files:get-icons', paths)
  },
  websites: {
    open: (url: string) => invoke<void>('websites:open', url)
  },
  servers: {
    launch: (item: ServerItem) => invoke<boolean>('servers:launch', item),
    stop: (itemId: string) => invoke<void>('servers:stop', itemId),
    onLog: (cb: (e: ServerLogEvent) => void) => on('server:log', (e) => cb(e as ServerLogEvent))
  },
  system: {
    getInfo: () => invoke<SystemInfoData | null>('system:info:get'),
    onPush: (cb: (info: SystemInfoData) => void) => on('system:info:push', (info) => cb(info as SystemInfoData))
  },
  music: {
    state: () => invoke<MusicState>('music:state'),
    control: (action: string, value = 0) => invoke<MusicState>('music:control', action, value),
    openPlayer: () => invoke<boolean>('music:open-player'),
    lyrics: (title: string, artist: string) => invoke<LyricLine[]>('music:lyrics', title, artist)
  },
  plugins: {
    list: () => invoke<PluginRecord[]>('plugins:list'),
    install: () => invoke<PluginRecord[]>('plugins:install'),
    load: (id: string) => invoke<PluginRecord[]>('plugins:load', id),
    unload: (id: string) => invoke<PluginRecord[]>('plugins:unload', id),
    remove: (id: string) => invoke<PluginRecord[]>('plugins:remove', id),
    trust: (id: string) => invoke<string[]>('plugins:trust', id),
    action: (pluginId: string, action: string, values?: Record<string, string>) =>
      invoke<unknown>('plugins:action', pluginId, action, values),
    ui: (id: string, values?: Record<string, string>, start?: boolean) =>
      invoke<PluginUiDescriptor | null>('plugins:ui', id, values, Boolean(start)),
    onChanged: (cb: (list: PluginRecord[]) => void) => on('plugins:changed', (list) => cb(list as PluginRecord[])),
    onEvent: (cb) => on('plugin:event', (e) => cb(e as never))
  },
  llm: {
    chat: (message: string) =>
      invoke<{ reply: string; trace: string[] }>('llm:chat', message),
    history: () =>
      invoke<Array<{ role: 'user' | 'assistant'; content: string; trace?: string[] }>>('llm:history'),
    clear: () => invoke<void>('llm:clear'),
    mcpStatus: () => invoke<{ running: boolean; port: number; token: string; error?: string }>('mcp:status')
  },
  voice: {
    speak: (text: string) => invoke<void>('voice:speak', text),
    stop: () => invoke<void>('voice:stop'),
    dictate: (seconds?: number) => invoke<string>('voice:dictate', seconds)
  },
  translateBar: {
    state: () => invoke<TranslateBarData>('translatebar:state'),
    copy: (text: string) => invoke<void>('translatebar:copy', text),
    speak: (text: string) => invoke<void>('voice:speak', text),
    hide: () => send('translatebar:hide'),
    actions: () => invoke<ContextAction[]>('translatebar:actions'),
    run: (id: string, text: string) => invoke<void>('translatebar:run', id, text),
    onShow: (cb: (d: TranslateBarData) => void) => on('translatebar:show', (d) => cb(d as TranslateBarData))
  },
  forge: {
    generate: (prompt: string) => invoke<ForgeResult>('forge:generate', prompt),
    install: (result: ForgeResult) => invoke<PluginRecord[]>('forge:install', result),
    publish: (result: ForgeResult) => invoke<string | null>('forge:publish', result)
  },
  /** T-06：UGC 宠物/皮肤主题包（制作 / 导入 / 分享；渲染层不传任何文件路径） */
  theme: {
    list: () => invoke<ThemePackInfo[]>('theme:list'),
    import: () => invoke<ThemeImportResult | null>('theme:import'),
    importConfirm: () => invoke<ThemeImportResult>('theme:import-confirm'),
    remove: (id: string) => invoke<{ ok: boolean; error?: string }>('theme:remove', id),
    apply: (id: string, applySkin?: boolean) => invoke<{ ok: boolean; error?: string }>('theme:apply', id, applySkin),
    verify: (id: string) => invoke<{ ok: boolean; missing: string[] }>('theme:verify', id),
    create: (draft: ThemeDraft) => invoke<ThemeExportResult | { error: string }>('theme:create', draft),
    exportPack: (id: string) => invoke<ThemeExportResult | { error: string }>('theme:export', id),
    shareText: (id: string) => invoke<string>('theme:share-text', id),
    template: () => invoke<string | null>('theme:template'),
    openFolder: (id?: string) => invoke<void>('theme:open-folder', id),
    builtinId: () => invoke<string>('theme:builtin-id'),
    root: () => invoke<string>('theme:root')
  },
  pet: {
    clicked: () => send('pet:clicked'),
    doubleClicked: () => send('pet:double-clicked'),
    dragStart: () => send('pet:drag-start'),
    dragMove: () => send('pet:drag-move'),
    dragEnd: () => send('pet:drag-end'),
    resize: (w: number, h: number) => send('pet:resize', w, h),
    getFrames: () => invoke<PetFrameSet>('pet:get-frames'),
    play: (action: 'nod' | 'wave' | 'blink' | 'jump') => invoke<void>('pet:play', action),
    onAction: (cb: (frames: string[]) => void) => on('pet:action', (frames) => cb(frames as string[])),
    onNotify: (cb: (text: string) => void) => on('pet:notify', (text) => cb(text as string)),
    contextMenu: () => send('pet:context-menu')
  },
  boxes: {
    list: () => invoke<DesktopBox[]>('boxes:list'),
    get: (id: string) => invoke<DesktopBox | null>('boxes:get', id),
    create: (partial?: Partial<DesktopBox>) => invoke<DesktopBox[]>('boxes:create', partial),
    update: (id: string, patch: Partial<DesktopBox>) => invoke<DesktopBox[]>('boxes:update', id, patch),
    remove: (id: string) => invoke<DesktopBox[]>('boxes:remove', id),
    setVisible: (id: string, visible: boolean) => invoke<DesktopBox[]>('boxes:set-visible', id, visible),
    openPath: (path: string) => invoke<void>('boxes:open-path', path),
    removeItem: (boxId: string, path: string) => invoke<DesktopBox[]>('boxes:remove-item', boxId, path),
    applyRules: () => invoke<Array<{ boxId: string; added: number; moved: number }>>('boxes:apply-rules'),
    addApps: (boxId: string) => invoke<{ added: number; total: number }>('boxes:add-apps', boxId),
    preview: (path: string) => invoke<void>('boxes:preview', path),
    previewData: (path: string) => invoke<PreviewData>('boxes:preview-data', path),
    stack: (boxId: string, path: string, stackName: string | null) =>
      invoke<DesktopBox[]>('boxes:stack', boxId, path, stackName),
    autoStack: (boxId: string) => invoke<DesktopBox[]>('boxes:auto-stack', boxId),
    setCapsule: (id: string, capsule: boolean) => invoke<DesktopBox[]>('boxes:set-capsule', id, Boolean(capsule)),
    capsuleHover: (id: string, hovering: boolean) => {
      send('boxes:capsule-hover', id, Boolean(hovering));
      return Promise.resolve();
    },
    onChanged: (cb: (list: DesktopBox[]) => void) => on('boxes:changed', (list) => cb(list as DesktopBox[]))
  },
  palette: {
    search: (query: string) => invoke<PaletteResult[]>('palette:search', query),
    execute: (result: PaletteResult, openFolder?: boolean) =>
      invoke<void>('palette:execute', result, Boolean(openFolder)),
    hide: () => send('palette:hide'),
    onShown: (cb: () => void) => on('palette:shown', () => cb()),
    targets: () => invoke<Array<{ id: string; label: string; type: string }>>('palette:targets'),
    onResults: (cb: (e: { query: string; list: PaletteResult[] }) => void) =>
      on('palette:results', (e) => cb(e as { query: string; list: PaletteResult[] }))
  },
  settings: {
    open: () => invoke<void>('settings:open'),
    close: () => invoke<void>('settings:close'),
    pickImage: () => invoke<string | undefined>('settings:pick-image'),
    pickFrames: (action: string) => invoke<string[] | undefined>('settings:pick-frames', action),
    pickFolder: () => invoke<string | undefined>('settings:pick-folder'),
    pickFile: () => invoke<string | undefined>('settings:pick-file'),
    info: () => invoke<AppInfo>('app:info')
  },
  asset: {
    read: (path: string) => invoke<AssetData>('asset:read', path),
    toUrl: (path: string) => invoke<string>('asset:to-url', path)
  },
  todo: {
    onFired: (cb: (text: string) => void) => on('todo:fired', (text) => cb(text as string))
  },
  weather: {
    get: () => invoke<WeatherData | null>('weather:get')
  },
  deskboard: {
    hide: () => send('deskboard:hide'),
    captureContext: () => invoke<ContextPayload>('deskboard:capture-context', true),
    contextActions: (payload: ContextPayload) => invoke<ContextAction[]>('deskboard:context-actions', payload),
    runContextAction: (id: string, payload: ContextPayload) =>
      invoke<{ ok: boolean; message?: string }>('deskboard:run-action', id, payload),
    pinContextAction: (id: string, pinned: boolean) => invoke<string[]>('deskboard:pin-action', id, Boolean(pinned)),
    onContext: (cb: (e: ContextCaptureEvent) => void) =>
      on('deskboard:context', (e) => cb(e as ContextCaptureEvent)),
    lastContext: () => invoke<ContextCaptureEvent>('deskboard:last-context'),
    selectionCatalog: () =>
      invoke<Array<{ id: string; label: string; icon: string; enabled: boolean; order: number }>>(
        'deskboard:selection-catalog'
      )
  },
  // T-14：开发者工具百宝箱独立面板
  devtools: {
    open: (tab?: string) => invoke<void>('devtools:open', tab),
    close: () => send('devtools:close')
  },
  // T-14：指令别名
  aliases: {
    list: () => invoke<Alias[]>('aliases:list'),
    save: (a: Alias) => invoke<Alias[]>('aliases:save', a),
    remove: (id: string) => invoke<Alias[]>('aliases:remove', id),
    importJson: () => invoke<{ ok: boolean; message?: string; list: Alias[] }>('aliases:import'),
    exportJson: () => invoke<string | null>('aliases:export')
  },
  // T-14：检查更新（UPD-01）
  update: {
    state: () => invoke<UpdateState>('update:state'),
    check: (force?: boolean) => invoke<UpdateState>('update:check', Boolean(force)),
    open: () => invoke<void>('update:open'),
    onState: (cb: (s: UpdateState) => void) => on('update:state', (s) => cb(s as UpdateState))
  },
  clipboard: {
    list: (query?: ClipboardQuery) => invoke<ClipboardEntry[]>('clipboard:list', query),
    update: (id: string, patch: Partial<ClipboardEntry>) => invoke<ClipboardEntry[]>('clipboard:update', id, patch),
    remove: (id: string) => invoke<ClipboardEntry[]>('clipboard:remove', id),
    clear: (keepPinned?: boolean) => invoke<ClipboardEntry[]>('clipboard:clear', Boolean(keepPinned)),
    copy: (id: string, paste?: boolean) => invoke<void>('clipboard:copy', id, Boolean(paste)),
    image: (id: string, full?: boolean) => invoke<AssetData | null>('clipboard:image', id, Boolean(full)),
    setText: (text: string) => invoke<void>('clipboard:set-text', text),
    pasteAs: (id: string, mode: PasteMode) =>
      invoke<{ ok: boolean; message?: string }>('clipboard:paste-as', id, mode),
    intent: () => invoke<ClipboardIntentInfo>('clipboard:intent'),
    hide: () => send('clipboard:hide'),
    onShown: (cb: () => void) => on('clipboard:shown', () => cb()),
    onChanged: (cb: (list: ClipboardEntry[]) => void) =>
      on('clipboard:changed', (list) => cb(list as ClipboardEntry[]))
  },
  snippets: {
    list: () => invoke<Snippet[]>('snippets:list'),
    save: (s: Snippet) => invoke<Snippet[]>('snippets:save', s),
    remove: (id: string) => invoke<Snippet[]>('snippets:remove', id),
    expand: (id: string, paste?: boolean) => invoke<void>('snippets:expand', id, Boolean(paste)),
    onChanged: (cb: (list: Snippet[]) => void) => on('snippets:changed', (list) => cb(list as Snippet[]))
  },
  market: {
    fetch: () => invoke<MarketState>('market:fetch'),
    install: (id: string) => invoke<MarketState>('market:install', id),
    upgrade: (id: string) => invoke<MarketState>('market:upgrade', id),
    uninstall: (id: string) => invoke<MarketState>('market:uninstall', id),
    // T-11：安装包加密留存（AES-256-GCM）
    secureInfo: () => invoke<{ count: number; sizeMB: number; dir: string }>('market:secure-info'),
    clearSecure: () => invoke<number>('market:secure-clear')
  },
  // T-10：资源占用可视化
  perf: {
    usage: () => invoke<PerfUsage>('perf:usage')
  },
  // T-07：搜索后端诊断
  search: {
    backend: () => invoke<{ everything: boolean; windowsIndex: boolean }>('search:backend')
  },
  hotkeys: {
    list: () => invoke<HotkeyInfo[]>('hotkeys:list'),
    set: (action: HotkeyAction, accelerator: string) => invoke<HotkeyInfo[]>('hotkeys:set', action, accelerator),
    reset: () => invoke<HotkeyInfo[]>('hotkeys:reset')
  },
  backup: {
    exportSettings: () => invoke<string | null>('backup:export-settings'),
    importSettings: () => invoke<AppSettings | null>('backup:import-settings'),
    diag: () => invoke<string | null>('backup:diag')
  },
  capture: {
    region: () => invoke<void>('capture:region'),
    full: () => invoke<void>('capture:full'),
    long: () => invoke<void>('capture:long'),
    colorPicker: () => invoke<void>('capture:color-picker'),
    pinClipboard: () => invoke<void>('capture:pin-clipboard'),
    pinFile: (path: string) => invoke<void>('capture:pin-file', path),
    onSurfaces: (cb: (surfaces: CaptureSurface[]) => void) =>
      on('capture:begin', (surfaces) => cb(surfaces as CaptureSurface[])),
    pickRegion: (rect: CaptureRect) => invoke<void>('capture:pick-region', rect),
    cancel: () => send('capture:cancel'),
    cursorPos: () => invoke<{ x: number; y: number }>('capture:cursor'),
    onAnnotatePayload: (cb: (p: AnnotatePayload) => void) =>
      on('capture:annotate-payload', (p) => cb(p as AnnotatePayload)),
    copyImage: (dataUrl: string) => invoke<void>('capture:copy-image', dataUrl),
    saveImage: (dataUrl: string) => invoke<string | null>('capture:save-image', dataUrl),
    pinImage: (dataUrl: string) => invoke<void>('capture:pin-image', dataUrl),
    onPinPayload: (cb: (p: PinPayload) => void) => on('capture:pin-payload', (p) => cb(p as PinPayload)),
    pinOp: (op, value?: number) => invoke<void>('capture:pin-op', op, value),
    onLongPayload: (cb: (p: LongPayload) => void) => on('capture:long-payload', (p) => cb(p as LongPayload)),
    longStep: (autoScroll: boolean) => invoke<string | null>('capture:long-step', Boolean(autoScroll)),
    longStop: () => send('capture:long-stop'),
    longFinish: (segments: string[]) => invoke<void>('capture:long-finish', segments),
    selfClose: () => send('capture:self-close')
  },
  onStore: (cb: (data: AppData) => void) => on('store:changed', (data) => cb(data as AppData))
};

/**
 * 拖放桥（DR-02：拖拽桌面文件到收纳盒）：
 * Electron 32+ 移除了 File.path，必须通过 webUtils.getPathForFile 获取真实路径。
 * 预加载脚本运行在隔离上下文中，但监听的是同一个 DOM 文档，主世界的拖放事件同样命中。
 */
window.addEventListener(
  'dragover',
  (e: DragEvent) => {
    e.preventDefault();
  },
  true
);
window.addEventListener(
  'drop',
  (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return;
    const paths: string[] = [];
    for (const f of files) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      } catch {
        /* 非本地文件，忽略 */
      }
    }
    if (paths.length) ipcRenderer.send('boxes:drop', paths);
  },
  true
);

// T-10：全局动画开关（性能模式广播；所有窗口共用本 preload）
// 统一写 html[data-anim] 并注入兜底样式（不依赖各窗口 CSS 引入）
const PERF_ANIM_CSS = `html[data-anim='off'] *,html[data-anim='off'] *::before,html[data-anim='off'] *::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}`;

function setPerfAnim(on: unknown): void {
  try {
    const root = document.documentElement;
    root.dataset.anim = on === false ? 'off' : 'on';
    if (!document.getElementById('perf-anim-style')) {
      const style = document.createElement('style');
      style.id = 'perf-anim-style';
      style.textContent = PERF_ANIM_CSS;
      document.head.appendChild(style);
    }
  } catch {
    /* document 未就绪时忽略 */
  }
}

ipcRenderer.on('perf:anim', (_e, on: unknown) => setPerfAnim(on));
// 兜底初始态：主进程 did-finish-load 广播为主，此处默认开启动画
setPerfAnim(true);

contextBridge.exposeInMainWorld('api', api);
