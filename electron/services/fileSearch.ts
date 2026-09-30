import { promises as fs } from 'fs';
import { shell } from 'electron';
import { dataStore } from '../store/dataStore';
import { windowsIndexSearch } from './windowsSearch';
import type { SearchResult } from '../../shared/types';

const MAX_RESULTS = 200;
const MAX_DEPTH = 10;

/**
 * 路径是否落入排除目录。
 *
 * P2-14 修复：旧实现是纯前缀匹配，`C:\windows` 会把同前缀的兄弟目录
 * `C:\WindowsApps` 一并排除（用户完全无法理解为什么搜不到）。现在要求
 * 「完全相等」或「后面紧跟路径分隔符」才算命中。
 */
export function isExcluded(p: string, excluded: string[]): boolean {
  const lower = p.toLowerCase().replace(/[\\/]+$/, '');
  return excluded.some((e) => {
    const dir = String(e ?? '')
      .toLowerCase()
      .replace(/[\\/]+$/, '');
    if (!dir) return false;
    return lower === dir || lower.startsWith(dir + '\\') || lower.startsWith(dir + '/');
  });
}

async function walk(
  dir: string,
  query: string,
  excluded: string[],
  depth: number,
  results: SearchResult[],
  deadline: number
): Promise<void> {
  if (results.length >= MAX_RESULTS || depth > MAX_DEPTH || Date.now() > deadline) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const q = query.toLowerCase();
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS || Date.now() > deadline) return;
    if (entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information')
      continue;
    const full = dir.endsWith('\\') ? dir + entry.name : `${dir}\\${entry.name}`;
    if (isExcluded(full, excluded)) continue;
    const isDir = entry.isDirectory();
    if (entry.name.toLowerCase().includes(q)) {
      // 目录无需 stat（无可靠 size/mtime 展示价值），仅文件需要，减少一半系统调用
      let size = 0;
      let mtime = 0;
      if (!isDir) {
        try {
          const st = await fs.stat(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          continue;
        }
      }
      results.push({ path: full, name: entry.name, isDir, size, mtime });
    }
    if (isDir) {
      await walk(full, query, excluded, depth + 1, results, deadline);
    }
  }
}

async function drives(): Promise<string[]> {
  const list: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try {
      await fs.access(drive);
      list.push(drive);
    } catch {
      /* not available */
    }
  }
  return list;
}

export async function getDrives(): Promise<string[]> {
  return drives();
}

/**
 * 命令面板专用快速搜索（CP-03 备用方案）：
 * 带时间预算与结果上限的递归遍历，保证首屏响应（≤200ms 规格）。
 */
export async function quickFileSearch(query: string, maxMs = 180, maxResults = 24): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const deadline = Date.now() + maxMs;
  const excluded = [
    ...dataStore().get().settings.excludedFolders,
    'C:\\windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData'
  ];
  const results: SearchResult[] = [];
  const disks = await drives();
  await Promise.all(disks.map((d) => walkQuick(d, trimmed.toLowerCase(), excluded, 0, results, deadline, maxResults)));
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/** 带截止时间的快速遍历：不 stat、限制深度，超时/超量立即停止 */
async function walkQuick(
  dir: string,
  query: string,
  excluded: string[],
  depth: number,
  results: SearchResult[],
  deadline: number,
  cap: number
): Promise<void> {
  if (Date.now() > deadline || results.length >= cap || depth > 8) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (Date.now() > deadline || results.length >= cap) return;
    if (entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information')
      continue;
    const full = dir.endsWith('\\') ? dir + entry.name : `${dir}\\${entry.name}`;
    if (isExcluded(full, excluded)) continue;
    if (entry.name.toLowerCase().includes(query)) {
      results.push({ path: full, name: entry.name, isDir: entry.isDirectory(), size: 0, mtime: 0 });
    }
    if (entry.isDirectory()) {
      await walkQuick(full, query, excluded, depth + 1, results, deadline, cap);
    }
  }
}

export async function searchFiles(
  query: string,
  fullDisk: boolean,
  selectedDrives?: string[]
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const data = dataStore().get();
  if (!fullDisk) {
    const sources = [...data.recentFiles.map((f) => f.path), ...data.favoriteFiles.map((f) => f.path)];
    const q = trimmed.toLowerCase();
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const p of sources) {
      if (results.length >= MAX_RESULTS || seen.has(p)) continue;
      const name = p.split(/[\\/]/).pop() ?? p;
      if (name.toLowerCase().includes(q)) {
        seen.add(p);
        try {
          const st = await fs.stat(p);
          results.push({ path: p, name, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
    return results;
  }
  const excluded = [
    ...data.settings.excludedFolders,
    'C:\\windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData'
  ];
  const results: SearchResult[] = [];
  // P3 修复：全盘搜索加时间预算（此前只有结果上限与深度上限，慢盘可长时间占用 IO/主进程）
  const FULL_DISK_BUDGET_MS = 20_000;
  const deadline = Date.now() + FULL_DISK_BUDGET_MS;
  // P3 加固：selectedDrives 只接受真实存在的盘符根（不再允许任意目录树被扫描）
  const requested = (selectedDrives ?? []).filter((d) => /^[A-Za-z]:\\?$/.test(String(d ?? '').trim()));
  const disks = requested.length ? requested.map((d) => (d.endsWith('\\') ? d : d + '\\')) : await drives();
  /*
   * T-07：全盘搜索并发跑「Windows 搜索索引」与「内置遍历」，合并去重后返回。
   * 这里是用户显式发起的全盘搜索（没有首屏 200ms 约束），索引能覆盖遍历因深度/时间预算
   * 到不了的深层目录，两者互补；索引不可用时它就是空数组，行为与改造前一致。
   */
  const indexedPromise =
    data.settings.searchUseWindowsIndex === false ? Promise.resolve([] as SearchResult[]) : windowsIndexSearch(trimmed, MAX_RESULTS);
  // 多盘符并行遍历，单盘内部保持串行，避免磁盘抖动并显著缩短首屏等待
  await Promise.all(disks.map((d) => walk(d, trimmed, excluded, 0, results, deadline)));
  const indexed = await indexedPromise;
  if (indexed.length) {
    const seen = new Set(results.map((r) => r.path.toLowerCase()));
    for (const r of indexed) {
      if (seen.has(r.path.toLowerCase())) continue;
      if (isExcluded(r.path, excluded)) continue;
      results.push(r);
    }
  }
  // 并行写入后按路径排序，保证结果稳定可预期
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

export async function openPath(path: string): Promise<void> {
  // P3 加固：先校验路径存在，避免无效路径进“最近记录”，并给出可读错误
  const target = String(path ?? '').trim();
  if (!target) throw new Error('路径为空');
  try {
    await fs.stat(target);
  } catch {
    throw new Error(`路径不存在或不可访问：${target}`);
  }
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
  const data = dataStore().get();
  const excluded = data.settings.excludedFolders;
  if (!isExcluded(path, excluded)) {
    dataStore().update((d) => {
      d.recentFiles = [{ path, lastOpened: Date.now() }, ...d.recentFiles.filter((f) => f.path !== path)].slice(0, 100);
    });
  }
}

export async function addFavorite(path: string): Promise<void> {
  dataStore().update((d) => {
    if (!d.favoriteFiles.some((f) => f.path === path)) {
      d.favoriteFiles.push({ path, addedAt: Date.now() });
    }
  });
}

export async function removeFavorite(path: string): Promise<void> {
  dataStore().update((d) => {
    d.favoriteFiles = d.favoriteFiles.filter((f) => f.path !== path);
  });
}

export async function clearRecents(): Promise<void> {
  dataStore().update((d) => {
    d.recentFiles = [];
  });
}
