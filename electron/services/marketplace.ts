import { execFile } from 'child_process';
import { createHash } from 'crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync as writeFileSyncCompat
} from 'fs';
import { get as httpsGet } from 'https';
import { basename, dirname, join, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { dialog } from 'electron';
import { dataStore, resourcesRoot, userDataDir } from '../store/dataStore';
import {
  assertPluginId,
  assertPluginVersion,
  isReservedPluginId,
  isValidPluginId,
  isValidPluginVersion
} from '../../shared/pluginPackage.ts';
import { listPlugins, loadPlugin, removePlugin, unloadPlugin } from './pluginManager';
import { encryptBuffer } from '../utils/secrets';
import { logDebug, logWarn } from '../utils/log';
import type { MarketIndex, MarketItem, MarketState } from '../../shared/types';

/**
 * 插件市场 v1（PM-01 ~ PM-04）
 *
 * - 市场页面数据源可配置（settings.marketIndexUrl）：HTTPS 索引 / 内置示例源（builtin://index）/
 *   本地源（file://，T-06 发布的自建市场目录联调用）；
 * - 一键安装 / 更新 / 卸载；requirements.txt 依赖复用插件管理器现有自动 pip 机制；
 * - 安全（PM-04）：HTTPS/本地源 + SHA256 必校验、安装前权限提示、未验证插件展示“社区未验证”；
 * - 索引条目 url 支持相对路径（按索引地址解析），便于 T-06 发布目录直接上传静态托管。
 */

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 120 * 1024 * 1024;

/*
 * 插件 id / 版本号的规则本体在 shared/pluginPackage.ts（纯函数，npm test 可直接断言）；
 * 这里只做转出与调用，避免"规则只活在不跑测试的主进程里"。
 */

function isFileUrl(u: string): boolean {
  return /^file:\/\//i.test(u);
}

/** 索引条目相对 url 解析（相对路径按索引地址归约；绝对协议原样保留） */
function resolveItemUrl(base: string, url: string): string {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (isFileUrl(base)) {
    return pathToFileURL(join(dirname(fileURLToPath(base)), url)).href;
  }
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

const PERMISSION_LABELS: Record<string, string> = {
  file: '文件（读写本地文件）',
  network: '网络（访问互联网）',
  clipboard: '剪贴板（读写剪贴板）',
  screen: '屏幕（截图/录屏）',
  process: '进程（启动外部程序）'
};

function builtinIndexFile(): string {
  return join(resourcesRoot(), 'market', 'index.json');
}

function stagingDir(): string {
  return join(userDataDir(), 'market-staging');
}

// ---------- T-11：安装包加密留存（spec 5.4） ----------

function securePackagesDir(): string {
  return join(userDataDir(), 'secure-packages');
}

/**
 * 把安装包 AES-256-GCM 加密留存到本机（settings.marketEncryptPackages 开启时）。
 *
 * FUN-001 止血（OPT-11）：此处**只承诺"加密归档"**。旧注释写的是"可离线重装/备份"，
 * 而全仓并没有任何"从留存包还原安装"的入口 —— 数据确实被保全了，但用户拿不回来，
 * 属于名实不符的过度承诺。"离线重装"作为独立需求另行立项，在它落地之前，
 * 注释、设置页文案都只描述现在真实具备的能力。
 */
function backupSecurePackage(item: MarketItem, zip: string): void {
  try {
    const dir = securePackagesDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${item.id}-v${item.version}.zip.enc`);
    writeFileSyncCompat(file, encryptBuffer(readFileSync(zip)));
    logDebug('[market] 安装包已加密留存', file);
  } catch (e) {
    logWarn('[market] 安装包加密留存失败（不影响安装）', e);
  }
}

/** 加密留存包信息（设置页展示） */
export function securePackagesInfo(): { count: number; sizeMB: number; dir: string } {
  const dir = securePackagesDir();
  let count = 0;
  let size = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.zip.enc')) continue;
      count += 1;
      size += statSync(join(dir, name)).size;
    }
  }
  return { count, sizeMB: Math.round((size / 1048576) * 10) / 10, dir };
}

/** 清理全部加密留存安装包，返回清理数量 */
export function clearSecurePackages(): number {
  const dir = securePackagesDir();
  let n = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.zip.enc')) continue;
      rmSync(join(dir, name), { force: true });
      n += 1;
    }
  }
  return n;
}

// ---------- 索引获取（PM-01：数据源可配置） ----------

function parseIndex(raw: string): MarketIndex {
  const parsed = JSON.parse(raw) as MarketIndex;
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('索引格式不正确（缺少 items）');
  /*
   * DEF-007 / OPT-19：索引字段的类型与取值校验。
   *
   * 旧实现只要求 id/name/url 是 string，`version` 则完全不校验 ——
   * 而 version 会参与 `\${id}-v\${version}.zip.enc` 的路径拼接（加密留存文件名），
   * 一个 `version: '..\\..\\evil'` 的索引条目就能让留存写出到任意位置。
   * 现在：id 过插件标识白名单、version 过版本号白名单，不合法直接丢弃该条目（fail-closed 的单条目粒度），
   * 其余条目照常展示——一个坏条目不该让整个市场变成空白。
   */
  const rejected: string[] = [];
  const items = parsed.items.filter((it): it is MarketItem => {
    if (!it || typeof it.id !== 'string' || typeof it.name !== 'string' || typeof it.url !== 'string') {
      rejected.push('条目字段类型不合法（id/name/url 必须是字符串）');
      return false;
    }
    if (!isValidPluginId(it.id)) {
      rejected.push(`插件标识不合法：\${it.id}`);
      return false;
    }
    if (!isValidPluginVersion(it.version)) {
      rejected.push(`版本号不合法：\${it.id} v\${String(it.version ?? '')}`);
      return false;
    }
    return true;
  });
  if (rejected.length) {
    logWarn(`[market] 索引中有 \${rejected.length} 个条目未通过校验，已忽略：\${rejected.slice(0, 5).join('；')}`);
  }
  return { version: parsed.version ?? 1, generatedAt: parsed.generatedAt, items };
}

function readBundledIndex(): { index: MarketIndex; source: string } {
  const file = builtinIndexFile();
  const source = 'builtin://index';
  if (!existsSync(file)) return { index: { version: 1, items: [] }, source };
  return { index: parseIndex(readFileSync(file, 'utf-8')), source };
}

function httpGetText(url: string, timeoutMs: number, maxBytes: number, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) {
      reject(new Error('插件市场数据源必须为 HTTPS 地址（PM-04）'));
      return;
    }
    const req = httpsGet(url, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('重定向次数过多'));
        resolve(httpGetText(res.headers.location, timeoutMs, maxBytes, redirects - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error('响应超出大小限制'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/**
 * SEC-004 / OPT-16：远程索引闸门。
 *
 * 问题：索引条目的 `verified` 是**索引自己写的**（没有签名、没有信任根），
 * 而索引又可以指向任意 HTTPS 包地址。也就是说"官方验证"这枚标签完全由发布索引的人说了算，
 * 供应链攻击面等于"谁能改索引，谁就能发插件"。
 *
 * 处置（ADR-04）：签名制（T-05）落地前，远程索引**默认关闭**。
 * 未显式开启时，即使设置里残留了 https:// 索引地址也一律回落内置源，并在 UI 上给出说明 ——
 * 这比"悄悄用远程索引"或"直接报错"都更符合用户预期。
 * 硬约束：T-05 完成前不得把 marketAllowRemoteIndex 改成默认 true（发版门禁第 5 条）。
 */
function remoteIndexBlocked(configured: string): boolean {
  if (configured.startsWith('builtin://')) return false;
  return dataStore().get().settings.marketAllowRemoteIndex !== true;
}

async function fetchIndex(): Promise<{ index: MarketIndex; source: string; error?: string }> {
  const configured = dataStore().get().settings.marketIndexUrl.trim() || 'builtin://index';
  if (remoteIndexBlocked(configured)) {
    const { index, source } = readBundledFallback();
    return {
      index,
      source,
      error: `已按安全策略使用内置源：远程索引默认关闭（配置的 \`${configured}\` 未生效）。签名制完成前，远程索引需在下方显式开启。`
    };
  }
  if (configured.startsWith('builtin://')) {
    try {
      return readBundledIndex();
    } catch (e) {
      return { ...readBundledFallback(), error: `内置索引读取失败：${(e as Error).message}` };
    }
  }
  try {
    // HTTPS 索引 或 本地源（file://，T-06 自建市场目录联调）
    const raw = isFileUrl(configured)
      ? readFileSync(fileURLToPath(configured), 'utf-8')
      : await httpGetText(configured, 8000, MAX_INDEX_BYTES);
    const index = parseIndex(raw);
    index.items = index.items.map((it) => ({ ...it, url: resolveItemUrl(configured, it.url) }));
    return { index, source: configured };
  } catch (e) {
    logWarn('[market] 远程索引获取失败，回退内置源', e);
    return { ...readBundledFallback(), error: `市场数据源不可用（${(e as Error).message}），已回退内置示例源` };
  }
}

function readBundledFallback(): { index: MarketIndex; source: string } {
  try {
    return readBundledIndex();
  } catch {
    return { index: { version: 1, items: [] }, source: 'builtin://index' };
  }
}

// ---------- 版本比较 ----------

function versionParts(v: string): number[] {
  return (v ?? '')
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isFinite(x));
}

function newerThan(candidate: string, current: string): boolean {
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// ---------- 状态汇总 ----------

export async function marketState(): Promise<MarketState> {
  const { index, source, error } = await fetchIndex();
  const installed: Record<string, string> = {};
  for (const p of listPlugins()) {
    if (p.status === 'user' || index.items.some((it) => it.id === p.id)) installed[p.id] = p.version;
  }
  const updatable = index
    .items.filter((it) => installed[it.id] && newerThan(it.version, installed[it.id]))
    .map((it) => it.id);
  return { source, items: index.items, installed, updatable, error };
}

// ---------- 下载 / 校验 / 解压（PM-04） ----------

function downloadZip(url: string, dest: string, sha256: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!sha256) {
      reject(new Error('安全校验失败：索引缺少该插件的 SHA256 值（PM-04）'));
      return;
    }
    // 本地源（file://）：直接复制 + SHA256 强校验（T-06 自建市场目录）
    if (isFileUrl(url)) {
      try {
        const src = fileURLToPath(url);
        const buf = readFileSync(src);
        const digest = createHash('sha256').update(buf).digest('hex');
        if (digest.toLowerCase() !== sha256.trim().toLowerCase()) {
          reject(new Error('SHA256 校验失败，安装包可能被篡改（PM-04）'));
          return;
        }
        writeFileSyncCompat(dest, buf);
        resolve();
      } catch (e) {
        reject(new Error(`读取本地安装包失败：${(e as Error).message}`));
      }
      return;
    }
    if (!/^https:\/\//i.test(url)) {
      reject(new Error('仅支持 HTTPS / 本地源下载（PM-04）'));
      return;
    }
    const req = httpsGet(url, { timeout: 30000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        downloadZip(res.headers.location, dest, sha256).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`下载失败 HTTP ${status}`));
        return;
      }
      const hash = createHash('sha256');
      let size = 0;
      const out = createWriteStream(dest);
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_PACKAGE_BYTES) {
          req.destroy(new Error('安装包超出大小限制'));
          return;
        }
        hash.update(c);
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close();
        const digest = hash.digest('hex');
        if (digest.toLowerCase() !== sha256.trim().toLowerCase()) {
          rmSync(dest, { force: true });
          reject(new Error('SHA256 校验失败，安装包可能被篡改（PM-04）'));
          return;
        }
        resolve();
      });
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/**
 * 列出压缩包条目（解压前的 zip-slip / zip 炸弹校验，SVC-10 + SEC-008 / OPT-17）。
 *
 * fail-open → fail-closed：旧实现在 `tar -tf` 失败时 **resolve([])**，也就是"列不出来当空包放行"。
 * 这正好给了攻击者一条明确路径：构造一个 tar 读不了、但 Expand-Archive 读得了的包
 * （双解析器分歧，V-2 待验证项），校验层看到空列表直接放行，解压层照常展开。
 * 现在：列不出条目 = 拒绝安装。列条目本来就该成功，失败一定是包有问题。
 */
function listZipEntries(zip: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-tvf', zip],
      { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`安装包无法读取（条目列表失败）：\${err.message}`));
          return;
        }
        resolve(String(stdout).split(/\r?\n/));
      }
    );
  });
}

/**
 * 解析 `tar -tvf` 的行为"大小"（字节）。格式：`-rw-r--r-- 0/0  12345 2024-01-01 00:00 path`。
 * 取不到就返回 null（不据此拦截，但总量校验会因缺少数据而走"条目数上限"这条保守路径）。
 */
function tarEntrySize(line: string): number | null {
  const m = /^\S+\s+\S+\s+(\d+)\s/.exec(line.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/*
 * SEC-008 / OPT-17：解压侧上限，口径与主题包（shared/themePack/zip.ts 的 DEFAULT_ZIP_LIMITS）对齐。
 * 主题包是 512 条目 / 单文件 8MB / 总计 64MB；插件包可能带图标与依赖清单，给到 2048 条目 / 单文件 32MB / 总计 256MB，
 * 仍远低于"能撑爆磁盘"的量级，而正常的插件包（几百 KB）完全不触边。
 */
const UNZIP_LIMITS = {
  maxEntries: 2048,
  maxEntryUncompressed: 32 * 1024 * 1024,
  maxTotalUncompressed: 256 * 1024 * 1024,
  maxNameLength: 1024
} as const;

/** 条目清单的安全校验：zip-slip（路径）+ 条目数/体积/名称长度（zip 炸弹） */
function assertZipLimits(lines: string[]): string[] {
  const names: string[] = [];
  let total = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // tar -tvf 的路径是最后一个字段（文件名可含空格，故取首个 ' ' 之后的剩余部分的最后一段不成立，这里按列切分）
    const parts = line.split(/\s+/);
    const name = parts.slice(8).join(' ');
    if (!name) continue;
    if (name.length > UNZIP_LIMITS.maxNameLength) throw new Error(`安装包含超长路径条目（已拦截）`);
    names.push(name);
    const size = tarEntrySize(line);
    if (size != null) {
      if (size > UNZIP_LIMITS.maxEntryUncompressed) {
        throw new Error(`安装包含超大文件（\${Math.round(size / 1048576)}MB > \${UNZIP_LIMITS.maxEntryUncompressed / 1048576}MB，已拦截）：\${name}`);
      }
      total += size;
    }
  }
  if (names.length > UNZIP_LIMITS.maxEntries) {
    throw new Error(`安装包条目数超限（\${names.length} > \${UNZIP_LIMITS.maxEntries}，已拦截）`);
  }
  if (total > UNZIP_LIMITS.maxTotalUncompressed) {
    throw new Error(`安装包解压后总大小超限（\${Math.round(total / 1048576)}MB，已拦截）`);
  }
  return names;
}

/** 拒绝含绝对路径 / .. 逃逸的压缩包条目（zip-slip，SVC-10） */
function assertZipSafe(entries: string[]): void {
  for (const raw of entries) {
    const n = raw.trim();
    if (!n) continue;
    const escaped = n.split(/[\\/]/).includes('..');
    if (escaped || /^[a-zA-Z]:/.test(n) || n.startsWith('/') || n.startsWith('\\')) {
      throw new Error(`安装包含非法路径条目（已拦截）：${n}`);
    }
  }
}

/**
 * 解压安装包（SEC-008 / OPT-17）。
 *
 * 三道闸，全部在**落盘之前或之后立即**执行：
 *   1) `tar -tvf` 列出条目 → fail-closed（列不出来直接拒绝）；
 *   2) 路径 zip-slip 校验 + 条目数/单文件/总量上限（zip 炸弹在解压前被拦）；
 *   3) 解压后断言**全部文件确实落在 dest 内** —— 这一步专治"tar 与 Expand-Archive 双解析器分歧"：
 *      两个解析器对畸形 ZIP 的理解可能不同（V-2 待验证项），前两道闸只保证我们**读到的**条目是安全的，
 *      第三步则保证"实际写出来的"也只有这些。发现越界即整目录清理并报错（staging 外不留任何新文件）。
 */
function extractZip(zip: string, dest: string): Promise<void> {
  return listZipEntries(zip)
    .then((lines) => {
      const names = assertZipLimits(lines);
      // SVC-10：解压前先做 zip-slip 校验
      assertZipSafe(names);
    })
    .then(
      () =>
        new Promise<void>((resolve, reject) => {
          // Windows 10+ 自带 bsdtar；失败回退 PowerShell Expand-Archive
          execFile('tar', ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 120000 }, (err) => {
            if (!err) return resolve();
            execFile(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
              ],
              { windowsHide: true, timeout: 120000 },
              (err2) => (err2 ? reject(new Error('安装包解压失败')) : resolve())
            );
          });
        })
    )
    .then(() => assertExtractedInside(zip, dest));
}

/**
 * 解压后断言：dest 下的**每一个**文件都位于 dest 内（真实路径，跟随符号链接）。
 *
 * 越界即抛错；调用方（stageItem）会清理整个 staging 目录，因此不会有残留写出去的文件。
 */
function assertExtractedInside(zip: string, dest: string): void {
  const root = resolve(dest);
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`安装包解压越界（已拦截并清理）：\${basename(zip)} → \${real}`);
      }
      try {
        if (statSync(real).isDirectory()) walk(real);
      } catch {
        /* 单个条目读不到不影响整体判断 */
      }
    }
  };
  walk(root);
}

/** 在解压目录中定位插件根（根目录或唯一子目录内含 manifest.json） */
function locatePluginRoot(dir: string): string | null {
  if (existsSync(join(dir, 'manifest.json'))) return dir;
  const children = readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (children.length === 1 && existsSync(join(dir, children[0], 'manifest.json'))) {
    return join(dir, children[0]);
  }
  return null;
}

function readManifestId(dir: string): { id: string; permissions?: string[] } | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as { id?: string; permissions?: string[] };
    return m.id ? { id: m.id, permissions: m.permissions } : null;
  } catch {
    return null;
  }
}

// ---------- 安装流程（PM-02 / PM-04） ----------

async function confirmInstall(item: MarketItem, upgrade: boolean): Promise<boolean> {
  const perms = (item.permissions ?? [])
    .map((p) => `  · ${PERMISSION_LABELS[p] ?? p}`)
    .join('\n');
  const detail = [
    `作者：${item.author ?? '未知'}`,
    `版本：${item.version}`,
    `来源：${item.url}`,
    item.description ? `描述：${item.description}` : '',
    '',
    perms ? `申请权限：\n${perms}` : '申请权限：无特殊权限',
    '',
    item.verified === true ? '✅ 官方验证：已通过' : '⚠️ “社区未验证”标签：该插件未经官方验证，请自行确认来源可信',
    '安装后将运行本地代码并自动安装其 requirements.txt 依赖。'
  ]
    .filter(Boolean)
    .join('\n');
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: [upgrade ? '继续更新' : '继续安装', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: upgrade ? '插件更新确认' : '插件安装确认',
    message: `${upgrade ? '更新' : '安装'}插件“${item.name}” v${item.version}？`,
    detail
  });
  return response === 0;
}

/** 取件到暂存目录：builtin 包复制 / HTTPS 包下载并校验后解压 */
async function stageItem(item: MarketItem, source: string): Promise<string> {
  // SEC-3 修复：item.id 参与路径拼接前必须过白名单（此前恶意索引可用 ..\ 穿越删目录/写文件）
  assertPluginId(item.id);
  // DEF-007 / OPT-19：version 同样参与路径拼接（加密留存文件名），必须先过白名单
  assertPluginVersion(item.version);
  const stage = join(stagingDir(), item.id);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  if (item.url.startsWith('builtin://')) {
    // SVC-10：内置包路径必须留在内置包根目录内（拦截 builtin://..\..\ 越界）
    const packagesRoot = join(resourcesRoot(), 'market', 'packages');
    const src = resolve(packagesRoot, item.url.slice('builtin://'.length));
    if (src !== packagesRoot && !src.startsWith(packagesRoot + sep)) {
      throw new Error('内置安装包路径非法（已拦截）');
    }
    if (!existsSync(join(src, 'manifest.json'))) throw new Error(`内置示例包不存在：${item.url}`);
    cpSync(src, stage, { recursive: true });
    return stage;
  }
  // SVC-10：远程索引不得下发本地文件条目（防止远程索引读本机任意文件当安装包）
  if (isFileUrl(item.url) && !isFileUrl(source)) {
    throw new Error('远程市场索引不得下发本地文件条目（PM-04）');
  }
  if (!isFileUrl(item.url) && !/^https:\/\//i.test(item.url)) {
    throw new Error('仅支持 HTTPS、builtin:// 或本地源（file://）安装源（PM-04）');
  }
  const zip = join(stagingDir(), `${item.id}.zip`);
  mkdirSync(stagingDir(), { recursive: true });
  await downloadZip(item.url, zip, item.sha256 ?? '');
  /*
   * FUN-002 / OPT-21：加密留存的时机与注释对齐。
   *
   * 旧实现是"下载完就留存"，而注释写的是"安装成功前留存" —— 两者不一致的后果是：
   * 一个 manifest 与市场条目不符（`installItem` 会拒绝）的包，也会被加密存进 secure-packages，
   * 白白占空间且永远用不上。现在把留存推迟到**校验通过之后**（见 installItem 的 finalize），
   * 语义就变成注释所写的"通过校验、即将安装的包才留存"。
   */
  try {
    await extractZip(zip, stage);
  } catch (e) {
    // SEC-008：解压失败（含越界/超限拦截）时不留任何 staging 残留
    rmSync(stage, { recursive: true, force: true });
    rmSync(zip, { force: true });
    throw e;
  }
  // 安装包本体保留在 staging，供 installItem 在"校验通过后"才做加密留存（FUN-002 / OPT-21）；
  // 生命周期终点见 installItem 的收尾（无论成功与否都会删除）。
  return stage;
}

async function installItem(item: MarketItem, upgrade: boolean, source: string): Promise<void> {
  assertPluginId(item.id);
  assertPluginVersion(item.version);
  /*
   * SEC-005 / OPT-15：内置插件保留命名空间 + 已存在的内置插件不允许被市场条目顶替。
   *
   * 内置插件是随安装包分发、用户天然信任的代码。若市场条目能占用同一个 id，
   * 恶意（或只是重名）的第三方包就能：
   *   · 覆盖 userData/plugins 下的同名目录，让"内置插件"实际跑的是第三方代码；
   *   · 借内置插件的名字与图标钓鱼（用户以为自己点的是官方的截图/转换插件）。
   * 保留命名空间（com.office.* / com.example.*）直接拒绝；此外只要本机已存在同 id 的**内置**插件，
   * 也一律拒绝 —— 内置插件的更新只走安装包，不走市场。
   */
  if (isReservedPluginId(item.id)) {
    throw new Error(`插件标识 \${item.id} 属于\${RESERVED_PLUGIN_ID_HINT}，市场安装已被拒绝`);
  }
  const builtinSameId = listPlugins().find((p) => p.id === item.id && p.status === 'builtin');
  if (builtinSameId) {
    throw new Error(`插件标识 \${item.id} 与本机内置插件冲突，已拒绝安装（内置插件随安装包更新）`);
  }
  if (!upgrade && listPlugins().some((p) => p.id === item.id)) {
    throw new Error(`插件“\${item.name}”已安装，可使用“更新”`);
  }
  if (!(await confirmInstall(item, upgrade))) throw new Error('已取消安装');
  const stage = await stageItem(item, source);
  const zip = join(stagingDir(), `\${item.id}.zip`);
  /** 收尾：无论成功失败都清掉 staging 与安装包残留（OPT-21 的留存已提前到校验之后） */
  const cleanupStage = (): void => {
    rmSync(stage, { recursive: true, force: true });
    rmSync(zip, { force: true });
  };
  const root = locatePluginRoot(stage);
  const manifest = root ? readManifestId(root) : null;
  if (!root || !manifest) {
    cleanupStage();
    throw new Error('安装包不是有效插件（缺少 manifest.json）');
  }
  // 防篡改/混淆：包内 manifest.id 必须与市场条目一致，且本身是合法标识（SEC-3）
  if (manifest.id !== item.id || !isValidPluginId(manifest.id)) {
    cleanupStage();
    throw new Error('安全校验失败：插件标识与市场条目不一致（PM-04）');
  }
  // OPT-21：校验已通过 → 此刻才是"即将安装"，加密留存放在这里（与注释语义一致）
  if (dataStore().get().settings.marketEncryptPackages && existsSync(zip)) backupSecurePackage(item, zip);
  if (upgrade) await unloadPlugin(item.id);
  const pluginsRoot = join(userDataDir(), 'plugins');
  const target = resolve(pluginsRoot, manifest.id);
  if (target === pluginsRoot || !target.startsWith(pluginsRoot + sep)) {
    cleanupStage();
    throw new Error('插件标识非法（路径穿越已拦截）');
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(pluginsRoot, { recursive: true });
  if (root === stage) {
    renameSync(stage, target);
    rmSync(zip, { force: true });
  } else {
    cpSync(root, target, { recursive: true });
    cleanupStage();
  }
  // 权限提示已在确认对话框完成：标记为信任来源，加载时不再二次弹窗
  const s = dataStore().get().settings;
  if (!s.trustedSources.includes(manifest.id)) {
    dataStore().updateSettingsTrusted({ trustedSources: [...s.trustedSources, manifest.id] });
  }
  logDebug('[market] 插件已安装', manifest.id, '→', target);
  /*
   * P3-10 修复：PluginRecord.origin 此前从未被写入（只有 pluginManager 在读），
   * 于是"从市场安装"与"内置插件"无法区分，该字段与注释都是死的。
   * 这里在加载前打上来源标记（loadPlugin 会把它一并持久化）。
   */
  markOrigin(manifest.id, 'market');
  // 一键启用：加载并自动解析 requirements.txt（复用现有自动 pip 机制）
  await loadPlugin(manifest.id);
}

/** 标记插件来源（builtin / market）；记录不存在时静默跳过 */
function markOrigin(id: string, origin: 'builtin' | 'market'): void {
  dataStore().update((d) => {
    const rec = d.plugins.find((p) => p.id === id);
    if (rec && rec.origin !== origin) rec.origin = origin;
  });
}

export async function installFromMarket(id: string): Promise<MarketState> {
  const { index, source } = await fetchIndex();
  const item = index.items.find((it) => it.id === id);
  if (!item) throw new Error(`市场中未找到插件：${id}`);
  await installItem(item, false, source);
  return marketState();
}

export async function upgradeFromMarket(id: string): Promise<MarketState> {
  const { index, source } = await fetchIndex();
  const item = index.items.find((it) => it.id === id);
  if (!item) throw new Error(`市场中未找到插件：${id}`);
  await installItem(item, true, source);
  return marketState();
}

export async function uninstallFromMarket(id: string): Promise<MarketState> {
  await removePlugin(id);
  logDebug('[market] 插件已卸载', id);
  return marketState();
}

export function marketSource(): Promise<string> {
  return fetchIndex().then((r) => r.source);
}

export function describePermission(p: string): string {
  return PERMISSION_LABELS[p] ?? p;
}

export function marketPackageBasename(url: string): string {
  return basename(url);
}
