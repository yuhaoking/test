import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import { app, BrowserWindow, dialog, Notification } from 'electron';
import { dataStore, pluginsDirs, userDataDir } from '../store/dataStore';
import { normalizePluginManifest, resolvePluginDir } from '../../shared/pluginPackage.ts';
import { toggleSidebar } from '../windows/sidebarWindow';
import { createPinWindowFromFile } from './captureManager';
import { playRandomAction } from './petManager';
import { logDebug, logWarn } from '../utils/log';
import type { PluginJob, PluginManifest, PluginRecord, PluginUiDescriptor } from '../../shared/types';

interface PluginRuntime {
  record: PluginRecord;
  manifest: PluginManifest;
  dir: string;
  child: ChildProcess | null;
  /** 子进程已拉起（或确认失败）后 resolve，供 initPlugin 等待 */
  ready: Promise<void>;
  /** 当前是否持有并发槽位（防止 close/error 双释放） */
  slotHeld: boolean;
  /** 最近一次调用时间（毫秒）：用于空闲回收（规格 5.1 资源友好） */
  lastActiveAt: number;
  /** P1-5：在途调用计数（>0 时空闲回收器不得回收该进程） */
  inflight?: number;
  /** P1-5：插件已转入后台执行的保护期截止时间（如"录制中（600 秒）"），期间不回收 */
  busyUntil?: number;
  /** B：插件后台任务（jobId → 任务），仅内存态；存在 running 任务时绝不回收进程 */
  jobs: Map<string, PluginJob>;
  /** 启动失败后是否已触发一次依赖自愈（防止反复重装） */
  depRetried: boolean;
  /** 子进程 stderr 累积（截断 2KB，用于识别 No module named） */
  errLog: string;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  buffer: string;
  ui: PluginUiDescriptor | null;
  actions: string[];
}

const runtimes = new Map<string, PluginRuntime>();

/**
 * 计数信号量：限制同一时刻运行的 Python 子进程数量。
 * 规格 5.1：最多同时运行 5 个子进程，避免系统资源耗尽；
 * 超出限制时排队等待（不丢弃、不无界并发）。
 */
class Semaphore {
  private readonly max: number;
  private available: number;
  private waiting: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.available = Math.min(this.available + 1, this.max);
  }
}

/** 全局 Python 子进程槽位（插件进程与 pip 安装进程共用） */
const pythonSlots = new Semaphore(5);

/** 在信号量保护下执行异步操作（用于 pip 安装等临时子进程） */
async function withPythonSlot<T>(fn: () => Promise<T> | T): Promise<T> {
  await pythonSlots.acquire();
  try {
    return await fn();
  } finally {
    pythonSlots.release();
  }
}

/** 释放槽位（幂等，防止 close/error 双触发） */
function releaseSlot(runtime: PluginRuntime): void {
  if (!runtime.slotHeld) return;
  runtime.slotHeld = false;
  pythonSlots.release();
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * 读取插件清单（DEF-001 修复）。
 *
 * 旧实现直接把 `JSON.parse` 的结果当 `PluginManifest` 用，字段类型完全看第三方包的心情：
 * `icon` 写成数字时 `join(full, manifest.icon)` 抛 TypeError，**整个 `plugins:list` 一起挂掉**，
 * 用户看到"插件列表空白"却没有任何一条错误指向那个包。
 * 现在统一走 shared/pluginPackage.ts 的纯函数规则（逐字段 String() 归一 + 长度上限 + entry 白名单），
 * 任一字段不合法只影响这一个包，并在日志里留下可定位的原因。
 */
function readManifest(dir: string): PluginManifest | null {
  try {
    const raw = readFileSync(join(dir, 'manifest.json'), 'utf-8');
    const res = normalizePluginManifest(JSON.parse(raw));
    if (!res.ok) {
      logWarn('[plugin] 清单不合法，已跳过该目录：', dir, res.error);
      return null;
    }
    return res.manifest;
  } catch {
    return null;
  }
}

function persist(runtime: PluginRuntime): void {
  dataStore().update((d) => {
    const idx = d.plugins.findIndex((p) => p.id === runtime.record.id);
    /*
     * P2-10 修复：这里原来是"字段白名单 + 整行替换"，漏掉了 depsInstalled / depsPython，
     * 于是每次 persist（加载插件时必然发生）都会把「依赖已装」标记抹掉 ——
     * 表现为每次启动、每次重新加载都重跑一遍 pip（实测 6 插件并发加载卡满 150s 超时）。
     * 现在改为展开运行时记录（含全部字段），只覆盖需要即时落库的字段，避免以后再漏。
     */
    const rec: PluginRecord = {
      ...runtime.record,
      status: runtime.record.status,
      enabled: runtime.record.enabled,
      trusted: runtime.record.trusted,
      moduleId: runtime.record.moduleId
    };
    if (idx >= 0) d.plugins[idx] = rec;
    else d.plugins.push(rec);
  });
}

function statusOf(path: string): string {
  if (path.startsWith(userDataDir())) return 'user';
  return 'builtin';
}

/**
 * 内置核心插件类别：首次启动自动启用，用户双击 exe 即可使用（无需手动加载“后端”）。
 * 示例/宠物/工具类（DeepSeek 监控等）保持手动启用。
 */
const AUTO_ENABLE_CATEGORIES = ['截图', '录屏', '转换', '翻译'];

function shouldAutoEnable(rec: PluginRecord): boolean {
  return rec.status === 'builtin' && AUTO_ENABLE_CATEGORIES.includes(rec.category ?? '');
}

export function listPlugins(): PluginRecord[] {
  const store = dataStore().get();
  const found: PluginRecord[] = [];
  /*
   * SEC-005：同 id 多目录冲突显式化。
   *
   * 旧实现在这里"先到先得、静默取第一个"，于是 userData/plugins/com.foo 会**无声地顶替**
   * 内置的 plugins/office-foo（目录扫描顺序决定谁生效），用户看到的插件到底是哪一份全靠运气，
   * 出问题时也没有任何一条日志能回答"到底加载了哪个目录"。
   * 现在把冲突记下来：列表里标 conflict，日志里按 id 列出全部目录。
   */
  const dirsById = new Map<string, string[]>();
  const conflictIds = new Set<string>();
  for (const dir of pluginsDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        if (!existsSync(join(full, 'manifest.json'))) continue;
      } catch {
        continue;
      }
      const manifest = readManifest(full);
      if (!manifest) continue;
      const seen = dirsById.get(manifest.id) ?? [];
      seen.push(full);
      dirsById.set(manifest.id, seen);
      if (seen.length > 1) conflictIds.add(manifest.id);
      const saved = store.plugins.find((p) => p.id === manifest.id);
      const status = statusOf(full);
      found.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        category: manifest.category,
        type: manifest.type,
        icon: manifest.icon ? join(full, manifest.icon) : undefined,
        dir: full,
        // 内置核心插件默认启用（首次即开箱可用）；用户记录优先（手动关闭后不再强制）
        enabled: saved?.enabled ?? (status === 'builtin' && AUTO_ENABLE_CATEGORIES.includes(manifest.category ?? '')),
        moduleId: saved?.moduleId,
        trusted: saved?.trusted ?? false,
        depsInstalled: saved?.depsInstalled ?? false,
        depsPython: saved?.depsPython,
        // PM-03：命令声明进命令面板（兼容旧插件：无 commands 字段即为空）
        commands: manifest.commands,
        origin: saved?.origin,
        status
      });
    }
  }
  const merged: PluginRecord[] = [...found];
  for (const saved of store.plugins) {
    if (!merged.some((p) => p.id === saved.id)) merged.push(saved);
  }
  // SEC-005：同 id 多目录 → 显式标记 + 告警（不再静默取第一个）
  if (conflictIds.size) {
    for (const rec of merged) {
      if (conflictIds.has(rec.id)) rec.conflict = true;
    }
    for (const id of conflictIds) {
      logWarn(`[plugin] 插件标识冲突（同 id 出现在多个目录，仅第一个生效）：${id} → ${(dirsById.get(id) ?? []).join(' | ')}`);
    }
  }
  // B：把内存态的后台任务与运行期状态附到记录上（任务不落库：属运行期状态，重启即失效）
  for (const rec of merged) {
    const runtime = runtimes.get(rec.id);
    if (!runtime) continue;
    if (runtime.jobs.size) {
      rec.jobs = [...runtime.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    }
    /*
     * 运行期状态此前只写进 store.plugins，而 listPlugins() 对"磁盘上找得到"的插件一律用
     * statusOf() 的 builtin/user 覆盖 —— 于是「error: 缺少模块 X」「exited (1)」
     * 「空闲回收」「后台执行中」「超时」这些真正有用的信息，用户一条都看不到（P1-5 的隐性成因）。
     */
    if (runtime.record.status) rec.runtimeStatus = runtime.record.status;
  }
  return merged;
}

export function runtimeOf(pluginId: string): PluginRuntime | null {
  return runtimes.get(pluginId) ?? null;
}

function enginesDir(): string {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'engines') : join(app.getAppPath(), 'engines'),
    app.isPackaged
      ? join(process.resourcesPath, 'resources', 'engines')
      : join(app.getAppPath(), 'resources', 'engines'),
    join(userDataDir(), 'engines')
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return '';
}

/**
 * Python 解释器解析：
 * 1) 环境变量 XP_PYTHON（开发/特殊环境覆盖）；
 * 2) 随包分发的嵌入式 Python（engines/python/python.exe，npm run setup-python 生成）；
 * 3) 系统 PATH 中的 python（需用户自装 Python 3.10+）。
 */
function resolvePython(): string {
  const fromEnv = (process.env['XP_PYTHON'] ?? '').trim();
  if (fromEnv) return fromEnv;
  const embedded = join(enginesDir(), 'python', 'python.exe');
  if (existsSync(embedded)) return embedded;
  return 'python';
}

/** 运行环境诊断（设置页展示）：实际 Python 解释器与 tkinter 可用性 */
export function runtimeInfo(): { python: string; tkinterOk: boolean } {
  const python = resolvePython();
  const engine = enginesDir();
  const tkinterOk =
    existsSync(join(engine, 'python', 'Lib', 'tkinter')) &&
    existsSync(join(engine, 'python', 'Lib', 'site-packages', '_tkinter.pyd'));
  return { python, tkinterOk };
}

/** 持久化插件记录的独立字段（启用状态/依赖安装标记），供自动启用与自动装依赖使用 */
function persistRecord(rec: PluginRecord): void {
  dataStore().update((d) => {
    const idx = d.plugins.findIndex((p) => p.id === rec.id);
    const row: PluginRecord = {
      ...(idx >= 0 ? d.plugins[idx] : rec),
      enabled: rec.enabled,
      depsInstalled: rec.depsInstalled,
      depsPython: rec.depsPython
    };
    if (idx >= 0) d.plugins[idx] = row;
    else d.plugins.push(row);
  });
}

function spawnPlugin(record: PluginRecord): PluginRuntime {
  // P3-3 修复：manifest 缺失/损坏不再做非空断言（避免 TypeError 被兜底吞掉、状态卡死）；
  // 以哨兵 entry 构造错误态 runtime，走“缺少入口文件”分支并持久化错误状态
  const manifest = readManifest(record.dir);
  const runtime: PluginRuntime = {
    record,
    manifest: manifest ?? {
      id: record.id,
      name: record.id,
      version: '0.0.0',
      type: 'module',
      entry: '__manifest_missing__'
    },
    dir: record.dir,
    child: null,
    ready: new Promise<void>(() => undefined), // 占位，随后被下方真正的 ready Promise 替换
    slotHeld: false,
    lastActiveAt: Date.now(),
    depRetried: false,
    errLog: '',
    pending: new Map(),
    nextId: 1,
    buffer: '',
    ui: null,
    actions: [],
    jobs: new Map<string, PluginJob>()
  };
  let resolveReady!: () => void;
  runtime.ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  runtimes.set(record.id, runtime);
  /*
   * P2-23 纵深防御：入口路径解析后必须仍位于插件目录内。
   * 插件可能来自市场（zip 内的 manifest 可被伪造），安装侧的校验（pluginForge）只覆盖
   * AI 造插件入口；这里在真正 spawn 之前再兜一层，杜绝 `entry: '..\\..\\evil.py'` 这类越界执行。
   */
  const entry = resolve(record.dir, runtime.manifest.entry ?? '');
  const dirResolved = resolve(record.dir);
  if (entry !== dirResolved && !entry.startsWith(dirResolved + sep)) {
    runtime.record.status = 'error: 入口路径越界（已拦截）';
    logWarn('[plugin] 入口路径越界，拒绝加载：', runtime.manifest.entry, '→', entry);
    persist(runtime);
    resolveReady();
    return runtime;
  }
  if (!existsSync(entry)) {
    runtime.record.status = 'error: 缺少入口文件';
    persist(runtime);
    resolveReady();
    return runtime;
  }
  // 排队获取并发槽位：异步拉起子进程，不阻塞调用方（runtime.ready 在拉起/失败后 resolve）
  runtime.record.status = '等待并发槽位…';
  void pythonSlots.acquire().then(() => {
    // P1-1 修复：拿到槽位立即标记持有，保证任何分支（含放弃）都能正确归还，
    // 否则 releaseSlot 因 slotHeld=false 空转导致槽位泄漏，5 次后插件系统死锁
    runtime.slotHeld = true;
    // 等待期间可能已被卸载或重新拉起，放弃已取得的槽位
    if (runtime.child || runtimes.get(record.id) !== runtime) {
      releaseSlot(runtime);
      resolveReady();
      return;
    }
    spawnChild(runtime, entry);
    resolveReady();
  });
  return runtime;
}

/** 同步拉起子进程并挂载所有事件处理器；失败时记录状态并释放槽位 */
function spawnChild(runtime: PluginRuntime, entry: string): void {
  let child: ChildProcessWithoutNullStreams;
  try {
    // 优先使用随包分发的嵌入式 Python（打开 exe 即用），其次系统 Python
    child = spawn(resolvePython(), [entry], {
      cwd: runtime.dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PLUGIN_SAVE_DIR: dataStore().get().settings.saveDir || '',
        ENGINES_ROOT: enginesDir(),
        DEEPSEEK_API_KEY: dataStore().get().settings.deepseekApiKey || ''
      }
    });
  } catch (e) {
    releaseSlot(runtime);
    runtime.record.status = `error: ${(e as Error).message}`;
    persist(runtime);
    return;
  }
  runtime.child = child;
  child.on('error', (err) => {
    releaseSlot(runtime);
    runtime.record.status = `error: ${err.message}`;
    persist(runtime);
    broadcast('plugins:changed', listPlugins());
  });
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    runtime.buffer += chunk;
    let idx: number;
    while ((idx = runtime.buffer.indexOf('\n')) >= 0) {
      const line = runtime.buffer.slice(0, idx).trim();
      runtime.buffer = runtime.buffer.slice(idx + 1);
      if (line) handleLine(runtime, line);
    }
  });
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trim();
    if (text) {
      runtime.errLog = (runtime.errLog + text).slice(-2048);
      logDebug(`[plugin:${runtime.record.id}]`, text);
    }
  });
  child.on('close', (code) => {
    releaseSlot(runtime);
    runtime.child = null;
    for (const { reject } of runtime.pending.values()) reject(new Error('plugin process exited'));
    runtime.pending.clear();
    // B：进程退出即任务不可能再完成 —— 明确标记失败，避免 UI 上永远显示"进行中"。
    // 保留这些失败记录（由 JOB_KEEP_DONE 定时清理），用户才看得到"为什么没结果"。
    for (const job of [...runtime.jobs.values()]) {
      if (job.status === 'running') {
        upsertJob(runtime, { id: job.id, status: 'error', message: '插件进程已退出，任务未完成' });
      }
    }
    // 识别缺失模块（No module named xxx）并直观呈现（自愈机制会重装依赖）
    const modMatch = runtime.errLog.match(/No module named\s+['"]?([\w.]+)/);
    runtime.record.status = modMatch
      ? `error: 缺少模块 ${modMatch[1]}（已自动重装依赖，请再点一次启动）`
      : `exited (${code})`;
    persist(runtime);
    broadcast('plugins:changed', listPlugins());
  });
}

/** 后台任务保护窗口：每轮轮询都会续期，任务结束后自然失效（B） */
const JOB_GRACE_MS = 10 * 60 * 1000;
/** 完成任务在 UI 上的保留时长（让用户看到"已完成"再消失） */
const JOB_KEEP_DONE_MS = 60_000;
/** 任务轮询间隔（宿主主动问插件要进度；插件未实现 plugin.jobs 时静默跳过） */
const JOB_POLL_INTERVAL_MS = 2000;

/**
 * 登记 / 更新一个后台任务（B 异步任务模型）。
 *
 * 三件事一起做，缺一不可：
 *  1) 写进 runtime.jobs → UI 卡片显示进度；
 *  2) 续期 busyUntil 与 lastActiveAt → **空闲回收器不会杀掉正在跑任务的插件**（P1-5 的根因）；
 *  3) running → done/error 时弹系统通知（原来只有插件自己发 show_notification 才有反馈）。
 */
function upsertJob(runtime: PluginRuntime, input: Partial<PluginJob> & { id: string }): void {
  if (!input.id) return;
  const now = Date.now();
  const prev = runtime.jobs.get(input.id);
  const job: PluginJob = {
    id: input.id,
    title: input.title ?? prev?.title ?? runtime.record.name,
    // 已完成/失败的任务不允许被后续 running 事件改回去（乱序事件保护）
    status: prev && prev.status !== 'running' && input.status === 'running' ? prev.status : input.status ?? prev?.status ?? 'running',
    progress: input.progress ?? prev?.progress,
    message: input.message ?? prev?.message,
    result: input.result ?? prev?.result,
    startedAt: prev?.startedAt ?? now,
    updatedAt: now
  };
  const justFinished = prev?.status === 'running' && job.status !== 'running';
  runtime.jobs.set(job.id, job);
  runtime.lastActiveAt = now;
  if (job.status === 'running') runtime.busyUntil = now + JOB_GRACE_MS;
  persist(runtime);
  broadcast('plugins:changed', listPlugins());
  logDebug('[plugin] job', job.status, runtime.record.id, job.id, job.progress ?? '-');

  if (justFinished) {
    const ok = job.status === 'done';
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: '小鹏工具箱 · ' + runtime.record.name,
          body: `${job.title}${ok ? '已完成' : '失败'}${job.result ? '：' + job.result : job.message ? '：' + job.message : ''}`
        }).show();
      }
    } catch {
      /* 通知不可用时忽略（UI 仍会显示） */
    }
    // 完成态保留一会儿再清理，用户能看到结果
    setTimeout(() => {
      const cur = runtime.jobs.get(job.id);
      if (cur && cur.status !== 'running' && Date.now() - cur.updatedAt >= JOB_KEEP_DONE_MS - 1000) {
        runtime.jobs.delete(job.id);
        broadcast('plugins:changed', listPlugins());
      }
    }, JOB_KEEP_DONE_MS);
  }
}

/** 该插件是否有进行中的后台任务（空闲回收器据此放行） */
function hasRunningJob(runtime: PluginRuntime): boolean {
  for (const j of runtime.jobs.values()) if (j.status === 'running') return true;
  return false;
}

/**
 * 轮询插件后台任务（B）。
 *
 * 为什么是"轮询"而不是"全靠插件推送"：现有插件协议只有单向 event，
 * 插件若在 C 扩展/子进程里忙住就可能来不及发事件；宿主每 2s 问一次 `plugin.jobs`
 * 既能兜住进度，也顺带成了**心跳**（续期保护窗口）。
 * 插件未实现该方法是正常情况（返回 unknown-method / 报错）—— 静默跳过，完全向后兼容。
 */
let jobPollTimer: NodeJS.Timeout | null = null;

export function startJobPoller(): void {
  if (jobPollTimer) return;
  jobPollTimer = setInterval(() => {
    void (async () => {
      for (const runtime of runtimes.values()) {
        if (!runtime.child || !hasRunningJob(runtime)) continue;
        try {
          const res = (await callPlugin(runtime.record.id, 'plugin.jobs', {}, 3000)) as
            | { jobs?: Array<Partial<PluginJob> & { id?: string }> }
            | null;
          const list = res && Array.isArray(res.jobs) ? res.jobs : null;
          if (!list) continue;
          for (const item of list) {
            const id = String(item.id ?? '');
            if (!id) continue;
            upsertJob(runtime, {
              id,
              title: item.title,
              status: (item.status as PluginJob['status']) ?? 'running',
              progress: typeof item.progress === 'number' ? item.progress : undefined,
              message: item.message,
              result: item.result
            });
          }
        } catch {
          /* 插件未实现 plugin.jobs：正常情况，静默跳过 */
        }
      }
    })();
  }, JOB_POLL_INTERVAL_MS);
}

export function stopJobPoller(): void {
  if (jobPollTimer) {
    clearInterval(jobPollTimer);
    jobPollTimer = null;
  }
}

function handleLine(runtime: PluginRuntime, line: string): void {
  let msg: { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  /*
   * P1-5 心跳：插件只要发回**任何**消息（结果 / 事件 / 进度通知），就说明它还活着、还在干活。
   * 据此刷新活跃时间并解除"后台任务"保护窗口，空闲回收器不会误杀。
   */
  runtime.lastActiveAt = Date.now();
  runtime.busyUntil = 0;
  if (msg.id != null) {
    const p = runtime.pending.get(msg.id);
    if (!p) return;
    runtime.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(typeof msg.error === 'object' ? JSON.stringify(msg.error) : String(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'event') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const type = String(params.type ?? '');
    if (type === 'show_notification') {
      new Notification({
        title: String(params.title ?? runtime.record.name),
        body: String(params.message ?? '')
      }).show();
    } else if (type === 'pet_notify') {
      // T-05：插件消息转宠物气泡播报（函数级动态 import 防循环）
      const text = String(params.message ?? '');
      void import('../windows/petWindow').then((m) => m.notifyPet(text));
    } else if (type === 'toggle_sidebar') {
      toggleSidebar();
    } else if (type === 'pet.clicked') {
      playRandomAction();
    } else if (type === 'pet.double_clicked') {
      toggleSidebar();
    } else if (type === 'pin.capture') {
      // T-04 与截图插件联动：插件把截图结果“贴到桌面”
      const path = String(params.path ?? '');
      if (path) createPinWindowFromFile(path);
    } else if (type === 'job') {
      // B：插件主动上报后台任务进度（异步任务模型）
      upsertJob(runtime, {
        id: String(params.jobId ?? params.id ?? ''),
        title: String(params.title ?? runtime.record.name),
        status: (String(params.status ?? 'running') as PluginJob['status']) ?? 'running',
        progress: typeof params.progress === 'number' ? params.progress : undefined,
        message: params.message == null ? undefined : String(params.message),
        result: params.result == null ? undefined : String(params.result)
      });
    } else if (type) {
      broadcast('plugin:event', { pluginId: runtime.record.id, type, params });
    }
  }
}

/** 动作类调用的默认超时：与插件内部允许的最长任务（录屏/大文件转换 600s）对齐（P1-5） */
export const ACTION_TIMEOUT_MS = 600_000;

export function callPlugin(pluginId: string, method: string, params: unknown, timeout = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const runtime = runtimes.get(pluginId);
    if (!runtime || !runtime.child) {
      reject(new Error('插件未运行'));
      return;
    }
    const stdin = runtime.child.stdin;
    if (!stdin) {
      reject(new Error('插件输入流不可用'));
      return;
    }
    /*
     * P1-5 修复（一）：把"有在途调用"与"最近活跃"绑在一起。
     * 旧实现只在调用发起时更新 lastActiveAt，且空闲回收器只看时间差 —— 于是
     * 一个跑了 3 分钟以上的长任务（录屏、几百页 PDF 转换）会被回收器直接 kill，
     * 表现为"MP4 缺 moov / 转换被丢弃 + 卡片显示 exited"。
     * 现在标记 inflight，回收器遇到在途调用一律跳过。
     */
    runtime.lastActiveAt = Date.now();
    runtime.inflight = (runtime.inflight ?? 0) + 1;
    const id = runtime.nextId++;
    const done = (): void => {
      runtime.inflight = Math.max(0, (runtime.inflight ?? 1) - 1);
      runtime.lastActiveAt = Date.now();
    };
    const timer = setTimeout(() => {
      runtime.pending.delete(id);
      done();
      /*
       * P1-5 修复（二）：超时不再等于"这次调用没发生"。
       * 插件侧可能仍在跑并稍后写出产物，因此：
       *  · 保留 lastActiveAt 的更新（避免刚超时就被回收）；
       *  · 状态里注明"仍在后台执行"，让用户知道产物可能稍后出现，而不是白等一场。
       */
      runtime.record.status = `超时（${Math.round(timeout / 1000)}s）：插件可能仍在后台执行，产物稍后可能出现`;
      persist(runtime);
      broadcast('plugins:changed', listPlugins());
      reject(new Error(`插件调用超时: ${method}（${Math.round(timeout / 1000)}s）—— 插件可能仍在后台执行`));
    }, timeout);
    runtime.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        done();
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        done();
        reject(e);
      }
    });
    try {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (e) {
      runtime.pending.delete(id);
      clearTimeout(timer);
      done();
      reject(e as Error);
    }
  });
}

async function initPlugin(pluginId: string): Promise<void> {
  const runtime = runtimes.get(pluginId);
  if (!runtime) return;
  // 等待并发槽位：子进程实际拉起（或确认失败）后再初始化
  await runtime.ready;
  if (runtimes.get(pluginId) !== runtime || !runtime.child) return;
  try {
    await callPlugin(pluginId, 'plugin.init', { config: {} }, 15000);
    runtime.record.status = 'running';
    if (runtime.record.type === 'module') {
      const ui = await callPlugin(pluginId, 'plugin.get_ui', {});
      runtime.ui = (ui as PluginUiDescriptor) ?? null;
    } else {
      const actions = await callPlugin(pluginId, 'pet.get_actions', {});
      runtime.actions = Array.isArray(actions) ? (actions as string[]) : [];
    }
  } catch (e) {
    runtime.record.status = `error: ${(e as Error).message}`;
    try {
      runtime.child?.kill();
    } catch {
      /* noop */
    }
    // 自愈：启动失败（多为 No module named）时清掉依赖指纹并后台重装，
    // 下次拉起插件（点击卡片/执行动作）前会先重新安装依赖（ensurePlugin 保证）。
    selfHealMissingDeps(runtime);
  }
  persist(runtime);
  broadcast('plugins:changed', listPlugins());
}

/** 启动失败自愈：清依赖指纹 + 后台重装（幂等，仅一次），状态提示用户再次点击即可恢复 */
function selfHealMissingDeps(runtime: PluginRuntime): void {
  if (runtime.depRetried) return;
  runtime.depRetried = true;
  const rec = runtime.record;
  if (!existsSync(join(rec.dir, 'requirements.txt'))) {
    // 无 requirements 的缺模块（如嵌入式 Python 缺少 tkinter 等标准库组件）：
    // 明确提示升级安装包或使用系统 Python
    rec.status = 'error: 嵌入式 Python 缺少模块（请使用最新版安装包，或安装 Python 3.10+ 后设置 XP_PYTHON）';
    persist(runtime);
    return;
  }
  rec.depsInstalled = false;
  rec.depsPython = '';
  depsReady.delete(rec.id);
  persistRecord(rec);
  rec.status = '依赖重建中（请再点一次启动）…';
  persist(runtime);
  void withPythonSlot(() => installDependencies(rec));
}

export async function loadPlugin(pluginId: string): Promise<PluginRecord[]> {
  const rec = listPlugins().find((p) => p.id === pluginId);
  if (!rec) throw new Error(`未找到插件: ${pluginId}`);
  const trusted = dataStore().get().settings.trustedSources.includes(pluginId);
  // 内置插件视为可信来源（规格 PM-04 的安全确认面向社区插件），免确认直接加载
  if (!trusted && rec.status !== 'builtin') {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['确认加载', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '加载插件确认',
      message: `是否加载插件“${rec.name}” v${rec.version}？`,
      detail: `来源：${rec.dir}\n作者：${rec.author ?? '未知'}\n描述：${rec.description ?? '无'}\n\n插件将运行本地代码，请确认来源可信。`
    });
    if (response !== 0) return listPlugins();
  }
  const ex = runtimes.get(pluginId);
  if (ex && ex.child) return listPlugins();
  // pip 安装也占用并发槽位，避免与插件进程叠加超出上限
  await withPythonSlot(() => installDependencies(rec));
  const runtime = spawnPlugin(rec);
  rec.enabled = true;
  await initPlugin(pluginId);
  // 模块插件：不再“每插件一卡”，而是维护一张聚合卡（需求 2）
  if (runtime.record.type === 'module') {
    ensurePluginAggregateModule();
  }
  persist(runtime);
  broadcast('plugins:changed', listPlugins());
  return listPlugins();
}

/** 本会话已确认依赖就绪的插件集合（避免重复 pip 检查） */
const depsReady = new Set<string>();

/** 是否需要（重新）安装依赖：无 requirements / 本会话已装 / 与当前解释器匹配则跳过 */
function depsNeedInstall(rec: PluginRecord): boolean {
  const req = join(rec.dir, 'requirements.txt');
  if (!existsSync(req) || depsReady.has(rec.id)) return false;
  const py = resolvePython();
  return !(rec.depsInstalled && rec.depsPython === py);
}

/**
 * 安装插件依赖（requirements.txt）。
 * 使用同一 Python 解释器（嵌入式优先）；成功后在插件记录中持久化
 * depsInstalled + depsPython（解释器指纹），下次启动 / 换解释器时正确跳过或重装。
 * 失败不抛异常，以 status 呈现。
 */
function installDependencies(rec: PluginRecord): Promise<void> {
  if (!depsNeedInstall(rec)) {
    rec.depsInstalled = true;
    rec.depsPython = resolvePython();
    return Promise.resolve();
  }
  rec.status = '正在安装依赖…';
  broadcast('plugins:changed', listPlugins());
  return new Promise((resolve) => {
    const child = spawn(
      resolvePython(),
      [
        '-m',
        'pip',
        'install',
        'setuptools',
        'wheel',
        '-r',
        join(rec.dir, 'requirements.txt'),
        '--disable-pip-version-check'
      ],
      {
        cwd: rec.dir,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1' }
      }
    );
    child.on('error', (e) => {
      // P3-2 修复：子进程启动失败也要落状态并广播，避免永久停留在“正在安装依赖…”
      rec.status = `依赖安装失败：${(e as Error).message.slice(0, 80)}`;
      persistRecord(rec);
      broadcast('plugins:changed', listPlugins());
      resolve();
    });
    child.on('close', (code) => {
      if (code === 0) {
        rec.status = '依赖就绪';
        rec.depsInstalled = true;
        rec.depsPython = resolvePython();
        depsReady.add(rec.id);
        persistRecord(rec);
      } else {
        rec.status = `依赖安装失败 (code=${code})`;
        persistRecord(rec);
      }
      if (depTimer) clearTimeout(depTimer);
      broadcast('plugins:changed', listPlugins());
      resolve();
    });
    const depTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
      if (rec.status === '正在安装依赖…') {
        rec.status = '依赖安装超时';
        persistRecord(rec);
        broadcast('plugins:changed', listPlugins());
        resolve();
      }
    }, 300000);
  });
}

// ---------------------------------------------------------------------------
// 插件聚合卡（需求 2）：一卡承载全部插件，默认沉底、可置顶到第一
// ---------------------------------------------------------------------------

/** 插件聚合模块卡 ID */
const PLUGIN_AGG_MODULE_ID = 'plugin-mod-aggregate';

/**
 * 确保存在唯一的“插件聚合卡”（需求 2）：
 * - 只保留一张 type='plugin' 的聚合卡（config.pluginAggregate=true）；
 * - 迁移旧版“每插件一卡”：移除所有带 pluginId 的旧单插件卡；
 * - 默认 order=MAX_SAFE_INTEGER（沉底）、pinned=false、fixed=false（可置顶到第一）。
 */
export function ensurePluginAggregateModule(): void {
  dataStore().update((d) => {
    // 1) 移除旧版单插件卡（config.pluginId 存在即旧格式）与非聚合 plugin 卡
    d.modules = d.modules.filter((m) => !(m.type === 'plugin' && !(m.config.pluginAggregate === true)));
    // 2) 确保聚合卡存在（仅当有已启用 module 插件时才有意义，但保持一张也无需强制为空）
    const hasAgg = d.modules.some((m) => m.type === 'plugin' && m.config.pluginAggregate === true);
    // 有已启用的 module 插件才保留聚合卡；全空则移除（避免空卡占位）
    const hasEnabledModule = d.plugins.some((p) => p.enabled && p.type === 'module');
    if (hasEnabledModule && !hasAgg) {
      d.modules.push({
        id: PLUGIN_AGG_MODULE_ID,
        type: 'plugin',
        name: '插件',
        fixed: false,
        pinned: false,
        order: Number.MAX_SAFE_INTEGER,
        config: { pluginAggregate: true, pluginName: '插件' }
      });
    }
    // 排序更新：把聚合卡放回末尾（除非用户已置顶）
    const agg = d.modules.find((m) => m.id === PLUGIN_AGG_MODULE_ID);
    if (agg && !agg.pinned && agg.order !== Number.MAX_SAFE_INTEGER) {
      agg.order = Number.MAX_SAFE_INTEGER;
    }
  });
}

export async function unloadPlugin(pluginId: string): Promise<PluginRecord[]> {
  const runtime = runtimes.get(pluginId);
  if (runtime) {
    try {
      runtime.child?.stdin?.end();
      runtime.child?.kill();
    } catch {
      /* noop */
    }
    runtimes.delete(pluginId);
  }
  dataStore().update((d) => {
    const saved = d.plugins.find((p) => p.id === pluginId);
    const moduleId = saved?.moduleId;
    if (saved) {
      saved.enabled = false;
      saved.moduleId = undefined;
    }
    // 聚合卡：不删除卡片本身，仅在下一次 ensure 时按需移除（无已启用 module 插件则回收）
    // 旧版单插件卡：仍按 moduleId / config.pluginId 移除（向后兼容清理）
    if (moduleId && moduleId !== 'plugin-mod-aggregate' && d.modules.some((m) => m.id === moduleId)) {
      d.modules = d.modules.filter((m) => m.id !== moduleId);
    }
    d.modules = d.modules.filter(
      (m) => !(m.type === 'plugin' && !(m.config.pluginAggregate === true) && m.config.pluginId === pluginId)
    );
  });
  // 移除后重算聚合卡（若最后一张 module 插件被卸载，回收空聚合卡）
  ensurePluginAggregateModule();
  broadcast('plugins:changed', listPlugins());
  return listPlugins();
}

export async function removePlugin(pluginId: string): Promise<PluginRecord[]> {
  await unloadPlugin(pluginId);
  const rec = listPlugins().find((p) => p.id === pluginId);
  if (rec && rec.status === 'user') {
    rmSync(rec.dir, { recursive: true, force: true });
    dataStore().update((d) => {
      d.plugins = d.plugins.filter((p) => p.id !== pluginId);
    });
  }
  broadcast('plugins:changed', listPlugins());
  return listPlugins();
}

/**
 * 从本地目录安装插件（设置 → 插件 → 安装）。
 *
 * 【SEC-001 修复：数据破坏链】旧实现是 `join(parent, manifest.id)` 直接拼路径，
 * 而 `manifest.id` 来自**待安装目录里的第三方文件**：
 *   · `id = ".."`     → target = <userData>，随后 `rmSync(target, {recursive:true, force:true})`
 *                        把整个用户数据目录（数据库、剪贴板历史、已装插件、密钥）删干净；
 *   · `id = "../../.."` → 同理可删 userData 之外的任意目录（权限允许范围内）。
 * 而删除**发生在任何校验之前**、且用户只点了一次"选择目录"——没有二次确认、没有回滚。
 *
 * 现在三道闸：
 *   1) `resolvePluginDir`：id 必须过反向域名白名单，且解析结果严格位于 <userData>/plugins 内；
 *   2) 覆盖已有插件目录前弹确认框（列出将被删除的目录）——破坏性操作必须可见；
 *   3) 复制失败时不留半截目录（失败即清理，保持"要么装上要么没装"）。
 */
export async function installPlugin(): Promise<PluginRecord[]> {
  const parent = join(userDataDir(), 'plugins');
  mkdirSync(parent, { recursive: true });
  const res = await dialog.showOpenDialog({
    title: '选择插件目录（包含 manifest.json）',
    properties: ['openDirectory']
  });
  const dir = res.filePaths[0];
  if (dir) {
    const manifest = readManifest(dir);
    if (!manifest) throw new Error('所选目录不是有效插件（缺少 manifest.json 或清单字段不合法）');
    // ① 路径 containment：id 白名单 + 断言目标仍在插件根内（SEC-001）
    const target = resolvePluginDir(parent, manifest.id);
    if (!target) {
      logWarn('[plugin] 安装被拒：插件标识非法或路径越界', manifest.id);
      throw new Error(`插件标识不合法，已拒绝安装：${manifest.id}`);
    }
    if (existsSync(target)) {
      // ② 破坏性操作二次确认（列出真实路径，避免"哪个目录被删了"靠猜）
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['覆盖安装', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '覆盖已有插件确认',
        message: `已存在插件“${manifest.name}” v${manifest.version}，是否覆盖？`,
        detail: `将被删除的目录：\n${target}\n\n来源目录：\n${dir}\n\n该操作不可撤销。`
      });
      if (response !== 0) return listPlugins();
      rmSync(target, { recursive: true, force: true });
    }
    // ③ 失败不留半截目录
    try {
      cpSync(dir, target, { recursive: true });
    } catch (e) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(`插件复制失败（已清理残留）：${(e as Error).message}`);
    }
    logDebug('[plugin] 插件已从本地目录安装', manifest.id, '→', target);
  }
  broadcast('plugins:changed', listPlugins());
  return listPlugins();
}

export function trustPlugin(pluginId: string): string[] {
  const data = dataStore().get();
  const sources = data.settings.trustedSources.includes(pluginId)
    ? data.settings.trustedSources.filter((s) => s !== pluginId)
    : [...data.settings.trustedSources, pluginId];
  dataStore().updateSettingsTrusted({ trustedSources: sources });
  broadcast('plugins:changed', listPlugins());
  return sources;
}

/**
 * P1-5：识别"插件已转入后台执行"的返回（如"录制中（600 秒），完成后面板会通知"），
 * 据此给该插件一个保护窗口 —— 否则 handle_action 立即返回后，
 * 空闲回收器会在 180s 时把仍在录制/转换的 Python 进程杀掉（产物损坏、无完成通知）。
 */
const BACKGROUND_TASK_RE = /录制中|处理中|进行中|后台|请稍候|转码|下载中|started|processing|in background/i;
const BACKGROUND_DEFAULT_MS = 30 * 60 * 1000;
/** 保护窗口的安全余量（插件上报的时长可能不含收尾写盘时间） */
const BACKGROUND_MARGIN_MS = 60 * 1000;

function markBackgroundIfNeeded(pluginId: string, result: unknown): void {
  const rec = result as { message?: unknown } | null;
  const msg = rec && typeof rec === 'object' && 'message' in rec ? String(rec.message ?? '') : '';
  if (!msg || !BACKGROUND_TASK_RE.test(msg)) return;
  const runtime = runtimes.get(pluginId);
  if (!runtime) return;
  const sec = /(\d+)\s*秒/.exec(msg);
  const min = /(\d+)\s*分/.exec(msg);
  const span = sec
    ? Number(sec[1]) * 1000 + BACKGROUND_MARGIN_MS
    : min
      ? Number(min[1]) * 60_000 + BACKGROUND_MARGIN_MS
      : BACKGROUND_DEFAULT_MS;
  runtime.busyUntil = Date.now() + span;
  runtime.record.status = '后台执行中：' + msg.slice(0, 40);
  persist(runtime);
  broadcast('plugins:changed', listPlugins());
  logDebug('[plugin] 已进入后台保护窗口', pluginId, Math.round(span / 1000) + 's');
}

export async function pluginAction(
  pluginId: string,
  action: string,
  values?: Record<string, string>
): Promise<unknown> {
  await ensurePlugin(pluginId);
  // P1-5：动作类调用给足时间（插件内部允许 600s 的录屏/大文件转换），旧值 30s 会让长任务必然"超时"
  const result = await callPlugin(pluginId, 'plugin.handle_action', { action, values: values ?? {} }, ACTION_TIMEOUT_MS);
  markBackgroundIfNeeded(pluginId, result);
  registerJobFromResult(pluginId, result);
  return result;
}

/**
 * B：动作返回里直接带 `job` 时登记为后台任务。
 *
 * 约定（对插件最友好的一种写法，无需额外事件往返）：
 *   {'message': '录制中（60 秒）', 'job': {'id': 'rec-1', 'title': '全屏录制', 'progress': 0}}
 */
function registerJobFromResult(pluginId: string, result: unknown): void {
  const runtime = runtimes.get(pluginId);
  if (!runtime) return;
  const rec = result as { job?: Partial<PluginJob> & { id?: string } } | null;
  const job = rec && typeof rec === 'object' ? rec.job : undefined;
  if (!job || typeof job !== 'object') return;
  const id = String(job.id ?? '');
  if (!id) return;
  upsertJob(runtime, {
    id,
    title: job.title,
    status: (job.status as PluginJob['status']) ?? 'running',
    progress: typeof job.progress === 'number' ? job.progress : undefined,
    message: job.message,
    result: job.result
  });
}

/**
 * 执行插件命令（PM-03：manifest.commands 声明的命令经全局命令面板触发）。
 * 插件侧实现 `plugin.handle_command`（params: { command }）。
 */
export async function runPluginCommand(pluginId: string, command: string, text?: string): Promise<unknown> {
  await ensurePlugin(pluginId);
  return callPlugin(pluginId, 'plugin.handle_command', { command, text }, ACTION_TIMEOUT_MS);
}

export async function pluginUi(
  pluginId: string,
  values?: Record<string, string>,
  start = false
): Promise<PluginUiDescriptor | null> {
  const runtime = runtimes.get(pluginId);
  // 懒启动：默认不拉起进程（卡片挂载/轮询不产生开销）；
  // 仅当用户显式点击“启动插件”（start=true）或已有进程时请求 UI。
  if (!runtime || !runtime.child) {
    if (!start) return null;
    await ensurePlugin(pluginId);
  }
  const current = runtimes.get(pluginId);
  if (!current) return null;
  if (!current.child) {
    throw new Error('插件未运行');
  }
  try {
    const ui = await callPlugin(pluginId, 'plugin.get_ui', { values: values ?? {} }, 8000);
    current.ui = (ui as PluginUiDescriptor) ?? null;
    return current.ui;
  } catch (e) {
    if (current.ui) return current.ui;
    throw e;
  }
}

export async function ensurePlugin(pluginId: string): Promise<void> {
  if (runtimes.get(pluginId)?.child) return;
  const rec = listPlugins().find((p) => p.id === pluginId);
  if (!rec) return;
  const saved = dataStore()
    .get()
    .plugins.find((p) => p.id === pluginId);
  if (!(saved?.enabled ?? rec.enabled)) return;
  // 按需启动同样保证依赖就绪（pip 走并发槽位，已装好时零等待）
  await withPythonSlot(() => installDependencies(rec));
  spawnPlugin(rec);
  rec.enabled = true;
  await initPlugin(pluginId).catch(() => undefined);
}

export function petPluginClicked(): void {
  for (const runtime of runtimes.values()) {
    if (runtime.record.type !== 'pet' || !runtime.child) continue;
    if (!runtime.actions.length) continue;
    const action = runtime.actions[Math.floor(Math.random() * runtime.actions.length)];
    callPlugin(runtime.record.id, 'pet.play_action', { action, context: 'clicked' }).catch(() => undefined);
  }
}

export function disposePlugins(): void {
  for (const runtime of runtimes.values()) {
    try {
      runtime.child?.kill();
      runtime.child?.stdin?.end();
    } catch {
      /* noop */
    }
  }
  runtimes.clear();
}

/**
 * 启动初始化（“打开 exe 即用”核心，规格 5.1 资源友好）：
 * - 内置核心插件自动启用（首次写入持久化记录，用户手动关闭后尊重）；
 * - 为已启用插件补齐侧边栏卡片；
 * - 后台按需自动安装缺失依赖（内置插件免确认）；
 * - 插件进程改为“按需拉起 + 空闲回收”，避免启动即拉起十几个 Python 进程。
 */
export async function startEnabledPlugins(): Promise<void> {
  const records = listPlugins().filter((p) => p.enabled);
  for (const rec of records) {
    // 首次启动：内置核心插件持久化为启用状态
    if (
      shouldAutoEnable(rec) &&
      !dataStore()
        .get()
        .plugins.some((p) => p.id === rec.id)
    ) {
      persistRecord(rec);
    }
  }
  // 补齐侧边栏插件聚合卡（需求 2）：一次性确保存在（迁移旧“每插件一卡”）
  if (records.some((p) => p.type === 'module')) {
    ensurePluginAggregateModule();
  }
  // 后台自动安装依赖；不阻塞启动，也不并发超限（信号量保护）
  void (async () => {
    for (const rec of records) {
      if (existsSync(join(rec.dir, 'requirements.txt')) && !rec.depsInstalled) {
        await withPythonSlot(() => installDependencies(rec));
      } else {
        depsReady.add(rec.id);
      }
    }
    broadcast('plugins:changed', listPlugins());
  })();
  broadcast('plugins:changed', listPlugins());
}

/** 插件进程空闲回收间隔（毫秒） */
const IDLE_REAP_INTERVAL = 60_000;
/** 插件进程多久无调用后回收（毫秒）；点击卡片会自动重启，用户无感 */
const IDLE_KILL_MS = 180_000;

/** 启动空闲回收器：防止大量插件进程常驻占用资源（规格 5.1） */
export function startIdleReaper(): void {
  setInterval(() => {
    const now = Date.now();
    for (const runtime of runtimes.values()) {
      /*
       * P1-5 修复（三）：有在途调用时绝不回收。
       * 录屏这类插件 handle_action 会立即返回、由后台线程继续录制，光看 lastActiveAt
       * 会在 180s 后把正在录制的 Python 进程 kill 掉（产物损坏且无完成通知）。
       */
      if (runtime.inflight && runtime.inflight > 0) continue;
      // B：有进行中的后台任务时绝不回收（轮询会持续续期 busyUntil，这里是双保险）
      if (hasRunningJob(runtime)) continue;
      // P1-5：插件已声明"转入后台执行"（如录屏），保护期内不回收，否则会杀掉正在写产物的进程
      if (runtime.busyUntil && now < runtime.busyUntil) continue;
      if (!runtime.child || now - runtime.lastActiveAt < IDLE_KILL_MS) continue;
      try {
        runtime.child.stdin?.end();
        runtime.child.kill();
      } catch {
        /* noop */
      }
      runtime.record.status = '空闲回收（点击卡片自动重启）';
      persist(runtime);
      broadcast('plugins:changed', listPlugins());
    }
  }, IDLE_REAP_INTERVAL);
}
