import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { basename, join } from 'path';
import { pinyin } from 'pinyin-pro';
import { shell } from 'electron';
import { db } from '../store/db';
import { dataStore } from '../store/dataStore';
import { scanInstalledApps } from './appScanner';
import { openPath, quickFileSearch } from './fileSearch';
import { windowsIndexSearch } from './windowsSearch';
import { ensurePlugin, listPlugins, runPluginCommand } from './pluginManager';
import { copyClipboardEntry, listClipboard, setClipboardText } from './clipboardManager';
import { expandSnippet, listSnippets } from './snippets';
import {
  startColorPicker,
  startFullCapture,
  startLongCapture,
  startRegionCapture
} from './captureManager';
import { applyRules, listBoxes, setAllVisible } from './desktopBoxes';
import { readClipboardContext } from './contextCapture';
import { listContextActions, runContextAction } from './contextActions';
import { findAlias } from './aliases';
import { jsonFormat, looksLikeJson, jsonSummary } from '../../shared/devtools/json.ts';
import { explainTimeInput, parseTimeInput, timeKindLabel } from '../../shared/devtools/time.ts';
import { base64Auto, urlAuto } from '../../shared/devtools/codec.ts';
import { hashAll } from '../../shared/devtools/hash.ts';
import { uuidBatch, isUuid } from '../../shared/devtools/uuid.ts';
import { radixConvert, looksLikeRadixInput } from '../../shared/devtools/radix.ts';
import { cronNext, cronDescribe } from '../../shared/devtools/cron.ts';
import { inferClipboardIntent } from '../../shared/devtools/intent.ts';
import { toggleSidebar } from '../windows/sidebarWindow';
import { openSettingsWindow } from '../windows/settingsWindow';
import { hidePalette } from '../windows/paletteWindow';
import { toggleClipboardPanel } from '../windows/clipboardWindow';
import { BrowserWindow } from 'electron';
import { logDebug } from '../utils/log';
import { openExternalSafe } from '../utils/openExternalSafe';
import type { AppItem, Module, PaletteResult, PaletteSort } from '../../shared/types';

/**
 * 全局命令面板搜索（规格 CP-02 ~ CP-06）
 *
 * 搜索源：已安装应用、文件（Everything 首选 / Node.js 快速遍历备选，CP-03）、
 * 网站、内部功能、插件命令、待办；拼音/首字母模糊匹配（CP-04）。
 * 排序按设置（最常使用 / 最近使用 / 字母序，CP-06）。
 */

const MAX_RESULTS = 40;

const FUNCTIONS: PaletteResult[] = [
  {
    id: 'fn-settings',
    label: '打开设置',
    sublabel: '内部功能',
    category: 'function',
    action: { type: 'function', value: 'settings' }
  },
  {
    id: 'fn-sidebar',
    label: '切换侧边栏',
    sublabel: '内部功能',
    category: 'function',
    action: { type: 'function', value: 'sidebar' }
  },
  {
    id: 'fn-boxes',
    label: '显示 / 隐藏收纳盒',
    sublabel: '内部功能',
    category: 'function',
    action: { type: 'function', value: 'boxes' }
  },
  {
    id: 'fn-box-rules',
    label: '收纳盒分类整理',
    sublabel: '内部功能',
    category: 'function',
    action: { type: 'function', value: 'box-rules' }
  },
  // ---- T-01 / T-02 / T-04：剪贴板面板、截图线、插件市场 ----
  {
    id: 'fn-clipboard-panel',
    label: '剪贴板粘贴面板',
    sublabel: '内部功能 · CH-04',
    category: 'function',
    action: { type: 'function', value: 'clipboard-panel' }
  },
  {
    id: 'fn-capture-region',
    label: '区域截图',
    sublabel: '截图 · T-04',
    category: 'function',
    action: { type: 'function', value: 'capture-region' }
  },
  {
    id: 'fn-capture-full',
    label: '全屏截图',
    sublabel: '截图 · T-04',
    category: 'function',
    action: { type: 'function', value: 'capture-full' }
  },
  {
    id: 'fn-capture-long',
    label: '滚动长截图',
    sublabel: '截图 · T-04',
    category: 'function',
    action: { type: 'function', value: 'capture-long' }
  },
  {
    id: 'fn-color-picker',
    label: '屏幕取色器',
    sublabel: '增强工具 · CH-06',
    category: 'function',
    action: { type: 'function', value: 'color-picker' }
  },
  {
    id: 'fn-market',
    label: '打开插件市场',
    sublabel: '内部功能 · PM-01',
    category: 'function',
    action: { type: 'function', value: 'market' }
  },
  {
    id: 'fn-pet-chat',
    label: '与小鹏聊天',
    sublabel: 'AI 宠物 · T-05',
    category: 'function',
    action: { type: 'function', value: 'pet-chat' }
  },
  // ---- T-14：开发者工具百宝箱（DEV-d 独立小面板） ----
  {
    id: 'fn-devtools',
    label: '开发者工具箱',
    sublabel: '正则 / Diff / 二维码 / JSON / 时间戳 · T-14',
    category: 'function',
    action: { type: 'function', value: 'devtools' }
  },
  {
    id: 'fn-devtools-regex',
    label: '正则测试',
    sublabel: '开发者工具 · DEV-04',
    category: 'function',
    action: { type: 'function', value: 'devtools:regex' }
  },
  {
    id: 'fn-devtools-diff',
    label: '文本对比（diff）',
    sublabel: '开发者工具 · DEV-11',
    category: 'function',
    action: { type: 'function', value: 'devtools:diff' }
  },
  {
    id: 'fn-devtools-qr',
    label: '二维码生成 / 解码',
    sublabel: '开发者工具 · DEV-09',
    category: 'function',
    action: { type: 'function', value: 'devtools:qrcode' }
  },
  {
    id: 'fn-devtools-tools',
    label: '编解码 / 哈希 / 进制',
    sublabel: '开发者工具 · DEV-03/05/07',
    category: 'function',
    action: { type: 'function', value: 'devtools:tools' }
  }
];

// ---------- 拼音匹配（CP-04） ----------

const keyCache = new Map<string, string[]>();

function keysOf(label: string, extra?: string[]): string[] {
  // P3 修复：缓存键包含 extra（此前只用 label，不同结果共用同一 label 时 extra 键互相串台）
  // 缓存键需包含 extra 且与大小写无关的处理一致（extra 会统一小写后参与匹配）
  const cacheKey = `${label}\u0000${(extra ?? []).join('\u0001')}`;
  let keys = keyCache.get(cacheKey);
  if (!keys) {
    const lower = label.toLowerCase();
    let full = lower;
    let first = lower;
    try {
      full = pinyin(label, { toneType: 'none', type: 'array' })
        .map((s) => s.toLowerCase())
        .join('');
      first = pinyin(label, { pattern: 'first', toneType: 'none', type: 'array' })
        .map((s) => s.toLowerCase())
        .join('');
    } catch {
      /* 非中文字符串 */
    }
    // P2-15 修复：附加匹配键（完整路径 / URL / 插件关键字）此前原样存入，而查询已 toLowerCase，
    // 于是"按路径片段搜索"（如输入 users 想命中 D:\Users\…）永远匹配不上。
    keys = [
      ...new Set([lower, full, first, ...(extra ?? []).filter(Boolean).map((k) => String(k).toLowerCase())])
    ];
    if (keyCache.size > 2000) keyCache.clear();
    keyCache.set(cacheKey, keys);
  }
  return keys;
}

function scoreOf(query: string, label: string, keys: string[]): number {
  if (!query) return 1;
  const lower = label.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1;
  if (keys.some((k) => k.startsWith(query))) return 2;
  if (lower.includes(query)) return 3;
  if (keys.some((k) => k.includes(query))) return 4;
  return -1;
}

// ---------- Everything（CP-03 首选） ----------

let everythingPath: string | null | undefined;

function detectEverything(): string | null {
  if (everythingPath !== undefined) return everythingPath;
  const candidates = [
    join(process.env['ProgramFiles'] ?? '', 'Everything', 'es.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Everything', 'es.exe')
  ];
  everythingPath = candidates.find((p) => p && existsSync(p)) ?? null;
  return everythingPath;
}

/** Everything 是否可用（设置页展示搜索后端用） */
export function everythingAvailable(): boolean {
  return detectEverything() !== null;
}

/** 调用 Everything 命令行（es.exe）搜索文件名，超时/失败返回空 */
function everythingSearch(query: string): Promise<PaletteResult[]> {
  return new Promise((resolve) => {
    const es = detectEverything();
    if (!es) return resolve([]);
    execFile(es, ['-n', '20', query], { timeout: 800, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const out = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20);
      resolve(
        out.map((p) => ({
          id: `file:${p}`,
          label: basename(p),
          sublabel: p,
          category: 'file' as const,
          action: { type: 'file' as const, value: p }
        }))
      );
    });
  });
}

// ---------- 候选收集 ----------

function usageOf(id: string): { weight: number; lastUsed: number } {
  try {
    const raw = db().get('palette_usage', id);
    if (!raw) return { weight: 0, lastUsed: 0 };
    const parsed = JSON.parse(raw) as { weight?: number; lastUsed?: number };
    return { weight: parsed.weight ?? 0, lastUsed: parsed.lastUsed ?? 0 };
  } catch {
    return { weight: 0, lastUsed: 0 };
  }
}

interface Candidate {
  result: PaletteResult;
  keys: string[];
  weight: number;
  lastUsed: number;
}

function toCandidate(result: PaletteResult, extraKeys?: string[]): Candidate {
  const usage = usageOf(result.id);
  return { result, keys: keysOf(result.label, extraKeys), weight: usage.weight, lastUsed: usage.lastUsed };
}

/**
 * 静态候选集短 TTL 缓存。
 *
 * 实测：一次 gatherStatic 约 180ms（应用清单 + 模块项 + 剪贴板 60 条 + 插件命令 + 拼音键），
 * 而命令面板是"输入即搜"—— 每个按键都重建一遍完全不必要，且会让首屏压到 200ms 上限边缘。
 * 这里缓存 1.5s：既覆盖连续输入的整段打字过程，又保证刚复制的内容/刚改的设置很快可见。
 */
const STATIC_TTL_MS = 1500;
let staticCache: { at: number; list: Candidate[] } | null = null;

/** 使候选集缓存失效（数据变更后调用，避免"改了却搜不到"） */
export function invalidatePaletteCache(): void {
  staticCache = null;
  queryCache.clear();
}

/** 汇总所有静态/缓存搜索源（app/网站/待办/插件/内部功能/最近文件），磁盘搜索按需走 quick 路径 */
async function gatherStatic(): Promise<Candidate[]> {
  if (staticCache && Date.now() - staticCache.at < STATIC_TTL_MS) {
    return staticCache.list.map((c) => ({ ...c }));
  }
  const built = await buildStatic();
  staticCache = { at: Date.now(), list: built };
  return built.map((c) => ({ ...c }));
}

async function buildStatic(): Promise<Candidate[]> {
  const list: Candidate[] = [];
  const data = dataStore().get();

  const apps = (await scanInstalledApps()) as AppItem[];
  for (const a of apps) {
    if (!a.name) continue;
    list.push(
      toCandidate({
        id: `app:${a.path}`,
        label: a.name,
        sublabel: a.path,
        category: 'app',
        icon: a.icon,
        action: { type: 'app', value: a.path }
      })
    );
  }

  for (const m of data.modules) {
    const items = (m.config.items ?? []) as unknown[];
    if (m.type === 'website_launcher') {
      for (const it of items as Array<{ id: string; name: string; url: string; icon?: string }>) {
        if (!it?.name || !it?.url) continue;
        list.push(
          toCandidate(
            {
              id: `web:${it.id}`,
              label: it.name,
              sublabel: it.url,
              category: 'website',
              icon: it.icon,
              action: { type: 'url', value: it.url }
            },
            [it.url]
          )
        );
      }
    } else if (m.type === 'todo_list') {
      for (const it of items as Array<{ id: string; text: string; done?: boolean }>) {
        if (!it?.text || it.done) continue;
        list.push(
          toCandidate({
            id: `todo:${it.id}`,
            label: it.text,
            sublabel: '待办事项',
            category: 'todo',
            action: { type: 'todo', value: it.text }
          })
        );
      }
    } else if (m.type === 'plugin') {
      const pid = String(m.config.pluginId ?? '');
      if (pid) {
        list.push(
          toCandidate({
            id: `plugin:${pid}`,
            label: m.name,
            sublabel: '插件命令',
            category: 'plugin',
            action: { type: 'plugin', value: pid }
          })
        );
      }
    }
  }

  for (const f of data.recentFiles) {
    list.push(
      toCandidate(
        {
          id: `recent:${f.path}`,
          label: basename(f.path),
          sublabel: f.path,
          category: 'file',
          action: { type: 'file', value: f.path }
        },
        [f.path]
      )
    );
  }
  for (const f of data.favoriteFiles) {
    list.push(
      toCandidate(
        {
          id: `fav:${f.path}`,
          label: basename(f.path),
          sublabel: `收藏 · ${f.path}`,
          category: 'file',
          action: { type: 'file', value: f.path }
        },
        [f.path]
      )
    );
  }

  // 片段库（CH-05）：任意场景快速插入
  for (const s of listSnippets()) {
    list.push(
      toCandidate(
        {
          id: `snippet:${s.id}`,
          label: s.name,
          sublabel: `片段${s.abbr ? ` · 缩写 ${s.abbr}` : ''}`,
          category: 'snippet',
          action: { type: 'snippet', value: s.id }
        },
        [s.abbr]
      )
    );
  }

  // 剪贴板历史（CH-02 / T-07：面板内搜索历史）
  for (const c of listClipboard({ limit: 60 })) {
    const label = c.kind === 'text' ? (c.text ?? '').slice(0, 60) || '（空文本）' : `图片 ${c.width ?? ''}×${c.height ?? ''}`;
    list.push(
      toCandidate(
        {
          id: `clip:${c.id}`,
          label,
          sublabel: `剪贴板${c.sourceApp ? ` · ${c.sourceApp}` : ''}`,
          category: 'clipboard',
          action: { type: 'clipboard', value: c.id }
        },
        [c.ocrText ?? '']
      )
    );
  }

  // 插件命令（PM-03：manifest.commands 注册进命令面板）
  for (const p of listPlugins()) {
    if (!p.enabled || !p.commands?.length) continue;
    for (const cmd of p.commands) {
      list.push(
        toCandidate(
          {
            id: `plugincmd:${p.id}:${cmd.id}`,
            label: cmd.title,
            sublabel: `${p.name} · 插件命令`,
            category: 'plugin',
            action: { type: 'plugin', value: `cmd:${p.id}:${cmd.id}` }
          },
          cmd.keywords
        )
      );
    }
  }

  for (const fn of FUNCTIONS) list.push(toCandidate(fn));
  return list;
}

/** AL-02：可设置别名的目标清单（内部功能 / 插件命令 / 网站 / 片段） */
export async function listAliasTargets(): Promise<Array<{ id: string; label: string; type: string }>> {
  try {
    const list = await gatherStatic();
    return list
      .filter((c) => ['function', 'plugin', 'website', 'snippet'].includes(c.result.category))
      // PaletteResult.category 的 'plugin' 需映射为别名目标类型 'pluginCommand'（否则保存时被判为非法类型）
      .map((c) => ({
        id: c.result.id,
        label: c.result.label,
        type: c.result.category === 'plugin' ? 'pluginCommand' : c.result.category
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label, 'zh-CN'));
  } catch (e) {
    logDebug('[palette] 别名目标清单获取失败', e);
    return [];
  }
}

export async function search(query: string): Promise<PaletteResult[]> {
  try {
    const raw = String(query ?? '').trim();
    const q = raw.toLowerCase();
    // CP-07：面板打开（空查询）时优先展示剪贴板推荐动作
    if (!q) {
      const cachedEmpty = queryCache.get('');
      if (cachedEmpty && Date.now() - cachedEmpty.at < 3000) return cachedEmpty.list.map((r) => ({ ...r }));
      const suggest = smartSuggestions();
      queryCache.set('', { at: Date.now(), list: suggest });
      return suggest;
    }
    // 相同查询的短时结果缓存：防抖期间重复按键不再重复扫描/启动 es.exe
    const cached = queryCache.get(q);
    if (cached && Date.now() - cached.at < 3000) return cached.list.map((r) => ({ ...r }));
    const settings = dataStore().get().settings;
    const list = await gatherStatic();

    // Everything 命中则优先；否则走时间预算内的快速遍历（CP-03）。
    // 1 字符查询走 Everything/最近文件即可，避免每个键触发全盘遍历。
    const everything = await everythingSearch(q);
    if (everything.length) {
      const skip = new Set(settings.paletteExcludeExts);
      for (const r of everything) {
        const ext = (r.action.value?.split('.').pop() ?? '').toLowerCase();
        if (skip.has(ext)) continue;
        list.push(toCandidate(r, [r.action.value ?? '']));
      }
    } else if (q.length >= 2) {
      /*
       * T-07 搜索内核增强：三级文件来源
       *   ① Everything（装了就用，最快最全）
       *   ② 内置快速遍历（时间预算 180ms，保住 CP-03「首屏 ≤ 200ms」）
       *   ③ Windows 搜索索引（SYSTEMINDEX）—— 仅当 ② 几乎没结果时补一轮
       *
       * 为什么③要放在"结果很少"时才用：索引查询要拉一次 PowerShell（冷启动 ~250ms + 查询 ~40ms），
       * 无条件串进去会把首屏从 180ms 拖到 300ms+，直接违反首屏预算。
       * 而"遍历找不到、其实文件在深层用户目录"恰恰是最需要它的场景 —— 花这 250ms 是值得的。
       */
      const files = await quickFileSearch(q, 180, 20);
      /*
       * ③ Windows 搜索索引：**异步补全**，绝不阻塞首屏。
       *
       * 实测教训：索引查询要拉一次 PowerShell（启动 250~400ms）+ 查询 30~220ms。把它同步串进来，
       * 命令面板首屏直接从 181ms 涨到 600ms(P50)/1150ms(P95) —— 被 npm run bench 当场抓出。
       * 现在的做法：先用 ② 的结果立刻出首屏（守住 CP-03 ≤ 200ms），同时在后台查索引，
       * 拿到后**推送**一次「结果已更新」，渲染层若还在同一查询上就用增强结果替换。
       */
      if (files.length < 4 && q.length >= 3 && settings.searchUseWindowsIndex !== false) {
        prefetchIndexResults(raw, q);
      }
      for (const f of files) {
        const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
        if (settings.paletteExcludeExts.includes(ext)) continue;
        list.push(
          toCandidate(
            {
              id: `file:${f.path}`,
              label: f.name,
              sublabel: f.path,
              category: 'file',
              action: { type: 'file', value: f.path }
            },
            [f.path]
          )
        );
      }
    }

    const scored: Candidate[] = [];
    for (const c of list) {
      const s = scoreOf(q, c.result.label, c.keys);
      if (s < 0) continue;
      scored.push({ ...c, score: s } as Candidate & { score: number });
    }
    scored.sort((a, b) =>
      compareCandidates(a as Candidate & { score: number }, b as Candidate & { score: number }, settings.paletteSort)
    );
    // AL-03：别名精确匹配置顶（优先于一切模糊匹配）
    // 注意：别名目标往往与输入毫无字面关系（如 fy → 中英互译），不能只在模糊命中集里找，
    // 必须在**全量候选**中按 id 取出目标，否则别名会"命中却不出结果"。
    const alias = findAlias(raw);
    let aliasResult: PaletteResult | null = null;
    if (alias) {
      const idx = scored.findIndex((c) => c.result.id === alias.targetId);
      if (idx >= 0) scored.splice(idx, 1);
      const hit = list.find((c) => c.result.id === alias.targetId);
      if (hit) {
        aliasResult = {
          ...hit.result,
          sublabel: ('别名 ' + alias.alias + (hit.result.sublabel ? ' · ' + hit.result.sublabel : '')).slice(0, 120)
        };
      }
    }
    let top = scored.slice(0, MAX_RESULTS).map((c) => c.result);
    // T-14（DEV-12）：开发者工具即时结果（形态识别 → 置顶）
    const dev = devInstantResults(raw);
    // T-07 万能入口：计算器 / 待办快记 等即时结果置顶
    const quick = quickResults(q);
    const instant = aliasResult ? dev : [...(quick ?? []), ...dev];
    top = [...(aliasResult ? [aliasResult] : []), ...instant, ...top].slice(0, MAX_RESULTS);
    if (queryCache.size > 60) queryCache.clear();
    queryCache.set(q, { at: Date.now(), list: top });
    return top;
  } catch (e) {
    logDebug('[palette] 搜索失败', e);
    return [];
  }
}

/** 查询结果短时缓存（3 秒，防抖窗口内复用；上限 60 条防内存增长） */
const queryCache = new Map<string, { at: number; list: PaletteResult[] }>();

// ---------- T-07：Windows 搜索索引的异步补全 ----------

/** 同一查询不重复发起索引查询（近期已查过就跳过） */
const indexQueried = new Map<string, number>();
/** 最近一次用户查询（只有它还"新鲜"时才推送补全结果，避免旧结果盖掉新输入） */
let lastQuery = '';
let lastQueryAt = 0;

/**
 * 后台查询 Windows 索引并推送增强结果。
 *
 * 推送通道用 `palette:results`：渲染层收到后只在「查询仍是当前输入」时替换，
 * 因此不会出现"打字打到一半被旧结果覆盖"的错乱。
 */
function prefetchIndexResults(raw: string, q: string): void {
  const now = Date.now();
  lastQuery = q;
  lastQueryAt = now;
  if (now - (indexQueried.get(q) ?? 0) < 10_000) return;
  indexQueried.set(q, now);
  if (indexQueried.size > 200) indexQueried.clear();
  void windowsIndexSearch(q, 20)
    .then((indexed) => {
      if (!indexed.length) return;
      // 用户已经改了输入：丢弃这次补全（宁可不推，也不能盖掉新结果）
      if (lastQuery !== q || Date.now() - lastQueryAt > 8000) return;
      const cached = queryCache.get(q);
      const skip = new Set(dataStore().get().settings.paletteExcludeExts);
      const merged = [...(cached?.list ?? [])];
      const seen = new Set(merged.map((r) => r.action.value?.toLowerCase() ?? ''));
      for (const f of indexed) {
        const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
        if (skip.has(ext)) continue;
        if (seen.has(f.path.toLowerCase())) continue;
        seen.add(f.path.toLowerCase());
        merged.push({
          id: `file:${f.path}`,
          label: f.name,
          sublabel: f.path + '（Windows 索引）',
          category: 'file',
          action: { type: 'file', value: f.path }
        });
      }
      const list = merged.slice(0, MAX_RESULTS);
      queryCache.set(q, { at: Date.now(), list });
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.isVisible()) win.webContents.send('palette:results', { query: raw, list });
      }
      logDebug('[palette] Windows 索引补全', q, indexed.length, '条');
    })
    .catch(() => undefined);
}

// ---------- T-14（CP-07）：粘贴智能匹配推荐 ----------

/**
 * 依据当前剪贴板内容推荐可一键执行的动作（CP-07）
 *
 * 与 WK-02 共用 ContextAction 定义（SPC 5.2），识别正确率依赖 inferClipboardIntent。
 * 可通过设置 paletteSmartSuggest 关闭。
 */
function smartSuggestions(): PaletteResult[] {
  const settings = dataStore().get().settings;
  if (settings.paletteSmartSuggest === false) return [];
  let payload;
  try {
    payload = readClipboardContext();
  } catch {
    return [];
  }
  if (payload.type === 'none') return [];
  const actions = listContextActions(payload);
  // CP-07：把"与该意图最相关"的动作提到最前（识别到 JSON 就首推 JSON 格式化，而不是通用文本动作）
  const priority: Record<string, string[]> = {
    path: ['file.archive', 'file.reveal', 'file.preview', 'file.copyPath'],
    url: ['url.open', 'url.copy', 'url.copyDomain'],
    json: ['json.format', 'json.minify', 'text.copy'],
    timestamp: ['time.convert', 'text.copy'],
    color: ['text.copy'],
    unknown: ['text.translate', 'text.webSearch', 'text.copy']
  };
  let intentKind = 'unknown';
  try {
    intentKind = inferClipboardIntent(payload.text ?? '').kind;
  } catch {
    /* 识别失败按 unknown 处理 */
  }
  const order = priority[intentKind] ?? priority.unknown;
  const ranked = actions
    .map((a, i) => ({ a, rank: order.indexOf(a.id) < 0 ? 100 + i : order.indexOf(a.id) }))
    .sort((x, y) => x.rank - y.rank)
    .map((x) => x.a);
  const out: PaletteResult[] = ranked.slice(0, 5).map((a) => ({
    id: 'suggest:' + a.id,
    label: a.label,
    sublabel: '推荐 · ' + (payload.detail ?? '当前剪贴板') + ' · ' + a.id,
    category: 'suggest' as const,
    action: { type: 'context' as const, value: a.id }
  }));
  return out;
}

// ---------- T-14（DEV-12）：命令面板即时结果 ----------

/** 即时结果统一动作：回车复制文本 */
function copyResult(id: string, label: string, sublabel: string, text: string): PaletteResult {
  return {
    id,
    label,
    sublabel,
    category: 'instant',
    action: { type: 'function', value: 'dev-copy:' + text }
  };
}

/** 开发者工具即时结果（DEV-12：JSON / 时间戳 / Base64 / URL / 哈希 / UUID / 进制 / cron） */
export function devInstantResults(input: string): PaletteResult[] {
  const t = input.trim();
  if (!t) return [];
  const out: PaletteResult[] = [];
  const m = /^(json|ts|uuid|md5|sha1|sha256|hash|b64|base64|url|radix|cron)\s+([\s\S]+)$/i.exec(t);

  // 1) JSON：json {…} 前缀，或直接粘贴 {…} / […]
  const jsonBody = m && /^(json|fmt)$/i.test(m[1]) ? m[2] : looksLikeJson(t) ? t : '';
  if (jsonBody) {
    const r = jsonFormat(jsonBody);
    if (r.ok) {
      const summary = (() => {
        try {
          return jsonSummary(JSON.parse(jsonBody));
        } catch {
          return '';
        }
      })();
      out.push(copyResult('dev-json', 'JSON 格式化结果', '即时结果 · ' + summary + ' · 回车复制', r.out));
      const min = jsonFormat(jsonBody, 0);
      if (min.ok && min.out !== r.out) {
        out.push(copyResult('dev-json-min', 'JSON 压缩结果（单行）', '即时结果 · 回车复制', min.out));
      }
    } else {
      out.push({
        id: 'dev-json-err',
        label: 'JSON 语法错误：第 ' + r.line + ' 行第 ' + r.column + ' 列',
        sublabel: r.message,
        category: 'instant',
        action: { type: 'function', value: 'dev-noop' }
      });
    }
  }

  // 2) 时间戳：ts <值> 或纯 10/13/16 位数字
  const tsInput = m && /^ts$/i.test(m[1]) ? m[2] : /^\d{10}$|^\d{13}$|^\d{16}$/.test(t) ? t : '';
  if (tsInput) {
    const p = parseTimeInput(tsInput);
    if (p) {
      out.push(copyResult('dev-ts-local', p.local, '即时结果 · ' + timeKindLabel(p.kind) + ' · ' + p.relative, p.local));
      out.push(copyResult('dev-ts-iso', p.iso, '即时结果 · ISO 8601（UTC）', p.iso));
      out.push(copyResult('dev-ts-sec', String(Math.floor(p.epochMs / 1000)), '即时结果 · 10 位秒级时间戳', String(Math.floor(p.epochMs / 1000))));
      out.push(copyResult('dev-ts-ms', String(p.epochMs), '即时结果 · 13 位毫秒时间戳', String(p.epochMs)));
    } else {
      // 形如日期但越界时给出准确原因（P2-12 配套），而不是静默什么都不显示
      const why = explainTimeInput(tsInput);
      if (why) {
        out.push({
          id: 'dev-ts-err',
          label: why,
          sublabel: '即时结果 · 该日期不存在，请检查月/日/时/分/秒',
          category: 'instant',
          action: { type: 'function', value: 'dev-noop' }
        });
      }
    }
  }

  // 3) UUID
  if (/^uuid/i.test(t) || /^uuid$/i.test(t)) {
    for (const [i, id] of uuidBatch(4).entries()) {
      out.push(copyResult('dev-uuid-' + i, id, '即时结果 · UUID v4 · 回车复制', id));
    }
  } else if (isUuid(t) && !m) {
    out.push(copyResult('dev-uuid-echo', t.toLowerCase(), '即时结果 · 已是 UUID（回车复制）', t.toLowerCase()));
  }

  // 4) 哈希：md5 <文本> / sha256 <文本> / hash <文本>
  if (m && /^(md5|sha1|sha256|hash)$/i.test(m[1])) {
    const h = hashAll(m[2]);
    out.push(copyResult('dev-md5', 'MD5    ' + h.md5, '即时结果 · 回车复制 MD5', h.md5));
    out.push(copyResult('dev-sha1', 'SHA1   ' + h.sha1, '即时结果 · 回车复制 SHA1', h.sha1));
    out.push(copyResult('dev-sha256', 'SHA256 ' + h.sha256, '即时结果 · 回车复制 SHA256', h.sha256));
  }

  // 5) Base64 / URL 编解码
  if (m && /^(b64|base64)$/i.test(m[1])) {
    const r = base64Auto(m[2]);
    if (r) {
      out.push(
        copyResult('dev-b64', r.out, r.mode === 'decode' ? '即时结果 · Base64 解码 · 回车复制' : '即时结果 · Base64 编码 · 回车复制', r.out)
      );
    }
  }
  if (m && /^url$/i.test(m[1])) {
    const r = urlAuto(m[2]);
    if (r) {
      out.push(
        copyResult('dev-url', r.out, r.mode === 'decode' ? '即时结果 · URL 解码 · 回车复制' : '即时结果 · URL 编码 · 回车复制', r.out)
      );
    }
  }

  // 6) 进制：radix <值>，或 0x / 0b / 0o 前缀
  const radixInput = m && /^radix$/i.test(m[1]) ? m[2] : looksLikeRadixInput(t) ? t : '';
  if (radixInput) {
    const r = radixConvert(radixInput);
    if (r.ok) {
      out.push(copyResult('dev-radix-10', 'DEC ' + r.values['10'], '即时结果 · 十进制 · 回车复制', r.values['10']));
      out.push(copyResult('dev-radix-16', 'HEX ' + r.values['16'], '即时结果 · 十六进制 · 回车复制', r.values['16']));
      out.push(copyResult('dev-radix-2', 'BIN ' + r.values['2'], '即时结果 · 二进制 · 回车复制', r.values['2']));
      out.push(copyResult('dev-radix-8', 'OCT ' + r.values['8'], '即时结果 · 八进制 · 回车复制', r.values['8']));
    }
  }

  // 7) cron：cron <表达式>（未来 5 次触发）
  if (m && /^cron$/i.test(m[1])) {
    const expr = m[2].trim();
    const next = cronNext(expr, 5);
    const desc = cronDescribe(expr);
    if (next.length) {
      out.push({
        id: 'dev-cron-desc',
        label: desc,
        sublabel: '即时结果 · cron 语义（' + expr + '）',
        category: 'instant',
        action: { type: 'function', value: 'dev-noop' }
      });
      for (const [i, d] of next.entries()) {
        const text = d.toLocaleString('zh-CN', { hour12: false });
        out.push(copyResult('dev-cron-' + i, '第 ' + (i + 1) + ' 次：' + text, '即时结果 · 回车复制', text));
      }
    } else {
      out.push({
        id: 'dev-cron-err',
        label: 'cron 表达式无法解析',
        sublabel: desc,
        category: 'instant',
        action: { type: 'function', value: 'dev-noop' }
      });
    }
  }

  return out;
}

// ---------- T-07 万能入口：面板内计算器 / 待办快记 ----------

/** 计算器结果 + 待办快记（即时结果，置顶展示；失败返回 null 不影响常规搜索） */
function quickResults(query: string): PaletteResult[] | null {
  const t = query.trim();
  if (!t) return null;
  const calc = tryCalc(t);
  if (calc !== null) {
    const out = formatNum(calc);
    return [
      {
        id: `calc:${t}`,
        label: `${t} = ${out}`,
        sublabel: '计算结果 · 回车复制',
        category: 'function',
        action: { type: 'function', value: `calc-copy:${out}` }
      }
    ];
  }
  const m = /^(?:todo|待办)[：:\s]+(.+)$/i.exec(t);
  if (m) {
    const text = m[1].trim();
    return [
      {
        id: `todo-quick:${text}`,
        label: `记一条待办：${text}`,
        sublabel: '待办快记 · 回车写入待办列表',
        category: 'todo',
        action: { type: 'function', value: `todo-quick:${text}` }
      }
    ];
  }
  return null;
}

/** 仅当输入形如算式（数字 + 运算符）时计算，避免误判普通搜索词 */
function tryCalc(input: string): number | null {
  if (!/^[0-9+\-*/%^().\s]+$/.test(input)) return null;
  if (!/[0-9]/.test(input) || !/[+\-*/%^]/.test(input)) return null;
  try {
    const v = evalMath(input);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function formatNum(v: number): string {
  return String(Math.round(v * 1e10) / 1e10);
}

/** 四则运算递归下降求值（+ - * / % ^ 与括号、小数、一元正负；不使用 eval） */
function evalMath(s: string): number {
  let i = 0;
  const skip = (): void => {
    while (s[i] === ' ') i++;
  };
  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      skip();
      if (s[i] === '+') {
        i++;
        v += parseTerm();
      } else if (s[i] === '-') {
        i++;
        v -= parseTerm();
      } else return v;
    }
  }
  function parseTerm(): number {
    let v = parseUnary();
    for (;;) {
      skip();
      if (s[i] === '*') {
        i++;
        v *= parseUnary();
      } else if (s[i] === '/') {
        i++;
        const d = parseUnary();
        if (d === 0) throw new Error('div0');
        v /= d;
      } else if (s[i] === '%') {
        i++;
        const d = parseUnary();
        if (d === 0) throw new Error('div0');
        v %= d;
      } else return v;
    }
  }
  function parseUnary(): number {
    skip();
    if (s[i] === '+') {
      i++;
      return parseUnary();
    }
    if (s[i] === '-') {
      i++;
      return -parseUnary();
    }
    return parsePow();
  }
  function parsePow(): number {
    const base = parseAtom();
    skip();
    if (s[i] === '^') {
      i++;
      return Math.pow(base, parseUnary());
    }
    return base;
  }
  function parseAtom(): number {
    skip();
    if (s[i] === '(') {
      i++;
      const v = parseExpr();
      skip();
      if (s[i] !== ')') throw new Error('paren');
      i++;
      return v;
    }
    const m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i));
    if (!m) throw new Error('token');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  const v = parseExpr();
  skip();
  if (i < s.length) throw new Error('tail');
  return v;
}

/** T-07 待办快记：把面板输入直接写入待办模块（todo_list）并广播 */
export function addTodoQuick(text: string): void {
  if (!text) return;
  invalidatePaletteCache();
  dataStore().update((d) => {
    let mod = d.modules.find((m) => m.type === 'todo_list');
    if (!mod) {
      const m: Module = {
        id: `mod-${randomUUID()}`,
        type: 'todo_list',
        name: '待办事项',
        fixed: false,
        pinned: false,
        order: d.modules.reduce((max, x) => Math.max(max, x.order), -1) + 1,
        config: { items: [] }
      };
      d.modules.push(m);
      mod = m;
    }
    const items = (mod.config.items ?? []) as Array<{ id: string; text: string; done: boolean }>;
    mod.config = { ...mod.config, items: [...items, { id: `todo-${Date.now()}`, text, done: false }] };
  });
  logDebug('[palette] 待办快记已写入', text);
}

type ScoredCandidate = Candidate & { score: number };

function compareCandidates(a: ScoredCandidate, b: ScoredCandidate, sort: PaletteSort): number {
  if (a.score !== b.score) return a.score - b.score;
  if (sort === 'usage' && a.weight !== b.weight) return b.weight - a.weight;
  if (sort === 'recent' && a.lastUsed !== b.lastUsed) return b.lastUsed - a.lastUsed;
  return a.result.label.localeCompare(b.result.label, 'zh-CN');
}

/** 记录使用频次（供“最常使用/最近使用”排序，CP-06） */
function recordUsage(id: string): void {
  try {
    const u = usageOf(id);
    db().set('palette_usage', id, JSON.stringify({ weight: u.weight + 1, lastUsed: Date.now() }));
  } catch (e) {
    logDebug('[palette] 记录使用失败', e);
  }
}

export async function executeResult(result: PaletteResult, openFolder = false): Promise<void> {
  hidePalette();
  recordUsage(result.id);
  const a = result.action;
  try {
    switch (a.type) {
      case 'app':
      case 'file': {
        const path = a.value ?? '';
        if (!path) return;
        if (openFolder) shell.showItemInFolder(path);
        else await openPath(path);
        break;
      }
      case 'url':
        // SEC-5 修复：仅允许安全协议
        await openExternalSafe(a.value ?? '');
        break;
      case 'function': {
        switch (a.value) {
          case 'settings':
            openSettingsWindow();
            break;
          case 'sidebar':
            toggleSidebar();
            break;
          case 'boxes': {
            const anyVisible = listBoxes().some((b) => b.visible);
            setAllVisible(!anyVisible);
            break;
          }
          case 'box-rules': {
            const summary = applyRules();
            // 规则扫描结果通过 boxes:changed 广播回界面
            logDebug('[palette] 自动分类完成', JSON.stringify(summary));
            break;
          }
          case 'clipboard-panel':
            toggleClipboardPanel();
            break;
          case 'capture-region':
            void startRegionCapture();
            break;
          case 'capture-full':
            void startFullCapture();
            break;
          case 'capture-long':
            void startLongCapture();
            break;
          case 'color-picker':
            void startColorPicker();
            break;
          case 'market':
            openSettingsWindow('market');
            break;
          case 'pet-chat': {
            // T-05：打开 AI 宠物对话面板（函数级动态 import 防循环）
            const m = await import('../windows/chatWindow');
            m.toggleChatWindow();
            break;
          }
          case 'devtools': {
            // T-14（DEV-d）：打开开发者工具箱
            const m = await import('../windows/devtoolsWindow');
            m.openDevtoolsWindow();
            break;
          }
          default: {
            // T-07：计算器复制结果 / 待办快记；T-14：开发者工具即时结果 / 面板分页
            const v = a.value ?? '';
            if (v.startsWith('calc-copy:')) {
              await setClipboardText(v.slice('calc-copy:'.length));
            } else if (v.startsWith('todo-quick:')) {
              addTodoQuick(v.slice('todo-quick:'.length));
            } else if (v.startsWith('dev-copy:')) {
              await setClipboardText(v.slice('dev-copy:'.length));
            } else if (v.startsWith('devtools:')) {
              const m = await import('../windows/devtoolsWindow');
              m.openDevtoolsWindow(v.slice('devtools:'.length));
            } else if (v === 'dev-noop') {
              /* 提示性结果：不执行任何动作 */
            }
            break;
          }
        }
        break;
      }
      case 'plugin': {
        const id = a.value ?? '';
        if (id.startsWith('cmd:')) {
          // PM-03：执行插件命令（plugin.handle_command）
          const [, pluginId, command] = id.split(':');
          try {
            const res = (await runPluginCommand(pluginId, command)) as { message?: string } | null;
            if (res?.message) logDebug('[palette] 插件命令结果', res.message);
          } catch (err) {
            logDebug('[palette] 插件命令执行失败', err);
          }
          break;
        }
        if (id) {
          try {
            await ensurePlugin(id);
          } catch {
            /* 插件不可用时退回打开侧边栏 */
          }
          toggleSidebar();
        }
        break;
      }
      case 'clipboard': {
        const id = a.value ?? '';
        if (id) copyClipboardEntry(id, true);
        break;
      }
      case 'snippet': {
        const id = a.value ?? '';
        if (id) expandSnippet(id, true);
        break;
      }
      case 'todo':
        toggleSidebar();
        break;
      case 'context': {
        // T-14（CP-07）：执行推荐动作（载荷按当前剪贴板现场重建，避免过期上下文）
        const id = a.value ?? '';
        if (!id) break;
        const payload = readClipboardContext();
        const r = await runContextAction(id, payload);
        if (!r.ok && r.message) logDebug('[palette] 推荐动作未完成：', r.message);
        break;
      }
    }
  } catch (e) {
    logDebug('[palette] 执行失败', e);
  }
}
