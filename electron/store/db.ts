import { app } from 'electron';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logDebug, logError, logWarn } from '../utils/log';
import type Database from 'better-sqlite3';

/**
 * 数据存储后端（规格 4 / SY-01：SQLite（better-sqlite3））
 *
 * 统一为“表 + 键 + JSON 值”的通用接口，规格要求的物理表在 SQLite 建表时落库：
 * settings / shortcuts(预留) / modules / plugins / recent_files / favorite_files /
 * desktop_boxes / palette_usage / move_log / clipboard / fragments / search_index（后续迭代）。
 *
 * 运行时优先加载 better-sqlite3（Electron ABI 预编译二进制）；
 * 若本机缺失（如未获取到对应 ABI 的预编译包、无编译工具链），
 * 自动回退到 JSON 文件后端 —— 接口语义完全一致，功能不受影响。
 */

export type DbTable =
  | 'settings'
  | 'modules'
  | 'plugins'
  | 'desktop_boxes'
  | 'palette_usage'
  | 'pet_memory'
  | 'move_log'
  | 'clipboard'
  | 'fragments'
  // T-14（AL-01）：指令别名专表
  | 'aliases';

export interface DbRow {
  key: string;
  value: string;
}

export interface DbBackend {
  readonly engine: 'sqlite' | 'json';
  get(table: DbTable, key: string): string | null;
  set(table: DbTable, key: string, value: string): void;
  delete(table: DbTable, key: string): void;
  all(table: DbTable): DbRow[];
  close(): void;
}

// ---------- SQLite 后端（better-sqlite3，规格主选） ----------

/**
 * 物理表建表 DDL。
 * P0-1 修复：所有表统一为 (key, value) 两列，与通用读写方法的 SQL 完全一致
 * （此前 modules/plugins/desktop_boxes/clipboard/fragments 建表为 (id, data)，
 *   读写却用 (key, value)，SQLite 后端一旦启用即崩溃）。
 */
const SQLITE_TABLES: Record<DbTable, string> = {
  settings: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  modules: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  plugins: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  desktop_boxes: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  palette_usage: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  pet_memory: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  move_log: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  // CH-01 / CH-05：剪贴板历史 + 片段库（规格已预留的物理表）
  clipboard: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  fragments: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  // T-14（AL-01）：指令别名（SPC 5.1：key=id, value=JSON）
  aliases: 'key TEXT PRIMARY KEY, value TEXT NOT NULL'
};

export { SQLITE_TABLES };

class SqliteBackend implements DbBackend {
  readonly engine = 'sqlite' as const;
  private db: Database.Database;

  constructor(file: string) {
    // 动态加载：二进制不匹配（ABI/平台）时抛出，由上层回退 JSON 后端
    const BetterSqlite3 = loadSqliteModule();
    if (!BetterSqlite3) throw new Error('better-sqlite3 原生模块不可用');
    this.db = new BetterSqlite3(file);
    this.db.pragma('journal_mode = WAL');
    for (const [table, ddl] of Object.entries(SQLITE_TABLES)) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${ddl})`);
    }
  }

  get(table: DbTable, key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  set(table: DbTable, key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  delete(table: DbTable, key: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
  }

  all(table: DbTable): DbRow[] {
    const rows = this.db.prepare(`SELECT key, value FROM ${table}`).all() as Array<{ key: string; value: string }>;
    return rows;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* noop */
    }
  }
}

/** 动态加载 better-sqlite3（返回构造函数）；加载失败返回 null */
function loadSqliteModule(): typeof Database | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('better-sqlite3') as typeof Database;
  } catch {
    return null;
  }
}

/**
 * 探针：验证 better-sqlite3 原生二进制与当前运行时（Electron 的 Node-API 版本）是否兼容。
 *
 * 背景（第 2 轮审计 + 专项调查实测）：better-sqlite3@13 的预编译二进制声明 **Node-API v10**，
 * 而 Electron 33 只提供 **Node-API v9**。二者不匹配时，`require` 或首次构造 Database
 * 会**在原生层直接崩溃**（实测退出码 0xFFFF7003），JS 的 try/catch 完全拦不住，
 * 会拖垮主进程。因此必须用「同 ABI 的 Electron-as-Node 子进程」做隔离探针。
 *
 * 本次修正（可诊断性）：旧实现 `stdio:'ignore'` + 只看退出码，导致
 *   · 真正的失败原因（崩溃/缺符号/spawn 失败）被整段丢掉；
 *   · spawn 本身失败（r.error/r.signal）会被误报成"ABI 不兼容"。
 * 现在改成"**成功标记 + 退出码**"双条件，并把 stderr 摘要记进日志。
 * 这样下次再出问题，日志里直接就有答案，不必再开一轮专项调查。
 */
function sqliteBinaryCompatible(): { ok: boolean; detail: string } {
  if (!process.versions.electron) return { ok: true, detail: '纯 Node 环境，跳过探针' };
  const OK_MARK = 'XP_SQLITE_PROBE_OK';
  const script = [
    'try {',
    "  const D = require('better-sqlite3');",
    "  const db = new D(':memory:');",
    "  db.pragma('journal_mode = WAL');",
    '  db.close();',
    `  process.stdout.write('${OK_MARK}');`,
    '  process.exit(0);',
    '} catch (e) {',
    "  process.stderr.write('PROBE_ERROR: ' + (e && e.message ? e.message : String(e)));",
    '  process.exit(1);',
    '}'
  ].join('\n');
  let r: ReturnType<typeof spawnSync> | null = null;
  try {
    r = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: app.getAppPath(),
      windowsHide: true,
      timeout: 8000,
      // 必须捕获 stdout/stderr：旧实现用 ignore，把唯一的失败线索丢了
      encoding: 'utf-8'
    });
  } catch (e) {
    return { ok: false, detail: `探针启动异常：${(e as Error).message}` };
  }

  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '').trim();
  const markOk = stdout.includes(OK_MARK);
  const nodeApi = process.versions.napi ?? '未知';

  // 子进程压根没起来（被策略拦、可执行文件缺失等）：这与"二进制不兼容"是两回事，必须分开报
  if (r.error) {
    return { ok: false, detail: `探针子进程未能启动（${r.error.message}）—— 这不是 ABI 问题` };
  }
  if (r.signal) {
    return { ok: false, detail: `探针子进程被信号终止（${r.signal}）` };
  }
  if (r.status === 0 && markOk) {
    return { ok: true, detail: `探针通过（Node-API ${nodeApi}）` };
  }
  // 退出码是个很大的无符号数（0xFFFF7003 之类）= 原生层崩溃，这是"版本门槛"最典型的表现
  const code = r.status == null ? 'null' : String(r.status);
  const hex = r.status != null && r.status !== 0 ? `0x${(r.status >>> 0).toString(16).toUpperCase()}` : '';
  const hints = [
    `退出码=${code}${hex ? `(${hex})` : ''}`,
    `Node-API=${nodeApi}`,
    stderr ? `stderr=${stderr.slice(0, 200)}` : 'stderr=(空)'
  ].join('，');
  return {
    ok: false,
    detail:
      `${hints}。` +
      `该二进制要求 Node-API v10（Node ≥22.14 / Electron ≥35），而当前 Electron 提供 Node-API ${nodeApi}`
  };
}

/** JSON 后端落盘失败的最大重试次数（P2-17） */
const MAX_FLUSH_RETRY = 5;

// ---------- JSON 文件后端（无本地二进制时的回退） ----------

class JsonBackend implements DbBackend {
  readonly engine = 'json' as const;
  private readonly file: string;
  private tables: Record<DbTable, Record<string, string>>;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  /** 连续落盘失败次数（P2-17：失败不再静默丢弃，按退避重试） */
  private failures = 0;

  constructor(file: string) {
    this.file = file;
    this.tables = {
      settings: {},
      modules: {},
      plugins: {},
      desktop_boxes: {},
      palette_usage: {},
      pet_memory: {},
      move_log: {},
      clipboard: {},
      fragments: {},
      aliases: {}
    };
    try {
      if (existsSync(file)) {
        // 数据安全修复：先剥离 UTF-8 BOM（记事本/编辑器另存、外部脚本写入都可能带上），
        // 否则 JSON.parse 抛错会被当成"文件损坏"，导致**整个用户数据静默丢失**（回退空库）。
        const text = readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
        const raw = JSON.parse(text) as Partial<Record<DbTable, Record<string, string>>>;
        for (const table of Object.keys(this.tables) as DbTable[]) {
          if (raw[table]) this.tables[table] = raw[table]!;
        }
      }
    } catch (e) {
      // 真的解析不了时：备份原文件再启用空库，避免用户数据被无声抹掉，便于事后恢复
      const backup = `${file}.corrupt-${Date.now()}.bak`;
      try {
        renameSync(file, backup);
        logWarn('[db] JSON 数据文件解析失败，已备份为', backup, e);
      } catch (backupErr) {
        logWarn('[db] JSON 后端数据文件损坏，使用空库', e, backupErr);
      }
    }
  }

  get(table: DbTable, key: string): string | null {
    return this.tables[table][key] ?? null;
  }

  set(table: DbTable, key: string, value: string): void {
    this.tables[table][key] = value;
    this.scheduleFlush();
  }

  delete(table: DbTable, key: string): void {
    if (key in this.tables[table]) {
      delete this.tables[table][key];
      this.scheduleFlush();
    }
  }

  all(table: DbTable): DbRow[] {
    return Object.entries(this.tables[table]).map(([key, value]) => ({ key, value }));
  }

  close(): void {
    this.flushNow();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    // 批量落盘：100ms 内多次写入合并为一次
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, 100);
  }

  /**
   * 落盘。
   *
   * P2-17 修复：旧实现先把 dirty 置 false 再写盘，写失败（磁盘满 / 文件被占用 / 杀软锁文件）
   * 之后没有任何重试，close() 也因 dirty=false 直接返回 —— 用户最后一次修改**静默丢失**。
   * 现在：失败时保留 dirty 并按退避重排一次落盘（最多 5 次），仍失败则升级为错误日志，
   * 让"存不下来"这件事至少是可诊断的。
   */
  private flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.tables), 'utf-8');
      renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
      this.failures = 0;
    } catch (e) {
      this.failures++;
      if (this.failures <= MAX_FLUSH_RETRY) {
        logWarn(`[db] JSON 后端保存失败（第 ${this.failures} 次，将重试）`, e);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flushNow();
        }, 500 * this.failures);
      } else {
        logError('[db] JSON 后端保存连续失败，已停止重试（本次运行的数据可能未落盘）', e);
      }
    }
  }
}

// ---------- 单例 ----------

let backend: DbBackend | null = null;
let backendFile: string | null = null;

export function dbFile(): string {
  return backendFile ?? '';
}

/** 获取存储后端（进程内单例）。
 * 环境变量 XP_DB=json 可强制 JSON 后端（诊断 / 无兼容原生二进制的场景）；默认自动探测。 */
export function db(): DbBackend {
  if (backend) return backend;
  if (process.env['XP_DB'] === 'json') {
    backendFile = join(app.getPath('userData'), 'data-v2.json');
    backend = new JsonBackend(backendFile);
    logWarn('[db] 环境变量强制使用 JSON 后端');
    return backend;
  }
  backendFile = join(app.getPath('userData'), 'xiaopeng-v2.db');
  const probe = sqliteBinaryCompatible();
  if (!probe.ok) {
    logWarn(`[db] better-sqlite3 不可用，回退 JSON 后端。原因：${probe.detail}`);
    backendFile = join(app.getPath('userData'), 'data-v2.json');
    backend = new JsonBackend(backendFile);
    return backend;
  }
  try {
    backend = new SqliteBackend(backendFile);
    // 数据安全：空库 + 存在 JSON 历史数据 → 先一次性导入，避免升级后"看起来数据全丢了"
    migrateJsonIntoEmptySqlite(backend);
    logDebug('[db] 使用 SQLite 后端', backendFile);
  } catch (e) {
    logWarn('[db] SQLite 后端不可用，回退 JSON 文件存储', (e as Error).message);
    backendFile = join(app.getPath('userData'), 'data-v2.json');
    backend = new JsonBackend(backendFile);
  }
  return backend;
}

/**
 * 一次性迁移：SQLite 库是**空的**，但 JSON 后端里有数据时，把 JSON 全量导入 SQLite。
 *
 * 为什么必须有（数据安全）：探针是按"当前运行时能不能加载原生二进制"判定的，
 * 而 better-sqlite3@13 的预编译二进制要求 **Node-API v10**（Node ≥ 22.14 / Electron ≥ 35）。
 * 于是这个应用会经历这样一条轨迹：
 *   · 在 Electron 33（Node-API 9）上跑 → 探针失败 → 数据全部落在 data-v2.json；
 *   · 将来升级到 Electron ≥35 → 探针**突然通过** → SqliteBackend 新建一个**空库** →
 *     用户看到的是"设置没了、别名没了、剪贴板历史没了"（数据其实还在 JSON 里，只是没人读）。
 * 这类"升级即丢数据"是静默的，用户第一反应是软件坏了。
 *
 * 因此：**空库 + 存在 JSON 数据 = 判定为首次启用 SQLite，先导入再对外服务**。
 * 判定条件刻意保守 —— 只要 SQLite 库里已经有任何一行数据就完全不动它，
 * 保证"迁移最多发生一次"，绝不会用旧 JSON 覆盖用户后来在 SQLite 上的新数据。
 */
function migrateJsonIntoEmptySqlite(sqlite: DbBackend): void {
  try {
    const jsonFile = join(app.getPath('userData'), 'data-v2.json');
    if (!existsSync(jsonFile)) return;
    // 空库判定：连一行 settings 都没有（SQLite 后端首次创建时必然是空的）
    if (sqlite.all('settings').length > 0) return;

    const text = readFileSync(jsonFile, 'utf-8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text) as Partial<Record<DbTable, Record<string, string>>>;
    const tables = Object.keys(SQLITE_TABLES) as DbTable[];
    let rows = 0;
    for (const table of tables) {
      const bucket = raw[table];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const [key, value] of Object.entries(bucket)) {
        if (typeof value !== 'string') continue;
        sqlite.set(table, key, value);
        rows += 1;
      }
    }
    if (rows > 0) {
      logWarn(`[db] 检测到 JSON 后端中的历史数据（${rows} 行），已一次性导入 SQLite 空库：${jsonFile}`);
      // 源文件保留不删：迁移若在后续版本被证伪，用户数据仍可回溯
    }
  } catch (e) {
    // 迁移失败不影响主流程：SQLite 空库照常可用，JSON 文件也原样保留
    logWarn('[db] JSON → SQLite 一次性迁移失败（不影响启动，原文件保留）', e);
  }
}

/** 应用退出前落盘 */
export function closeDb(): void {
  if (backend) {
    backend.close();
    backend = null;
  }
}
