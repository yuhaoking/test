import { execFile } from 'child_process';
import { logDebug, logWarn } from '../utils/log';
import type { SearchResult } from '../../shared/types';

/**
 * Windows 搜索索引（SYSTEMINDEX）查询 —— 无 Everything 时的**快速兜底**（T-07 增强）。
 *
 * 【为什么不直读 NTFS MFT】
 * Everything 那套"直读 $MFT"需要**管理员权限 + 原始卷访问**，与本产品"双击 exe 即用、
 * 不要求提权"的定位冲突（T-07 原文即写"NTFS MFT 索引思路待评估"）。评估结论：不采用。
 *
 * 【为什么用 Windows 索引】
 * Windows 自带 WSearch 服务已经维护了一份全量文件索引（默认覆盖用户目录/库/桌面，
 * 用户把盘加进索引后也覆盖）。通过 ADO 的 Search.CollatorDSO 提供程序查询它：
 *  · 零安装、零提权、零常驻内存；
 *  · 命中索引时是毫秒级（本机实测 40~46ms），远快于 Node 递归遍历；
 *  · 覆盖范围与"用户真正会找的文件"高度重合。
 * 未启用索引 / 服务被关 / 命中不到时静默回退到内置遍历，因此它是**增强而非依赖**。
 *
 * 实测（本机 Win11 + WSearch Running）：
 *  · CONTAINS(System.FileName, '"x"')  默认域可查（D 盘未入索引时查不到，属预期）
 *  · System.FileName LIKE '%x%'        同样走索引，40ms 级，且能查到用户目录下的深层文件
 * 这里用 LIKE 形态：它不依赖分词，对"文件名片段"（用户最常见的输入）更稳。
 */

/** 查询超时（毫秒）：超过即放弃并回退到内置遍历，绝不拖慢面板首屏（CP-03 ≤ 200ms 的兜底） */
const QUERY_TIMEOUT_MS = 1500;
/** 可用性探测结果缓存（服务/COM 情况在一次运行内不会变） */
let availabilityCache: boolean | null = null;
/**
 * 连续失败计数：索引偶发失败（索引正在重建、查询超时）会退化成一次数百毫秒的白等，
 * 若每个按键都重试，命令面板首屏直接崩掉（实测 181ms → 600ms）。
 * 连续 3 次失败即在本会话内停用该来源，只留调试日志。
 */
const MAX_CONSECUTIVE_FAILURES = 3;
let consecutiveFailures = 0;

/** 转义 LIKE 通配符与单引号（用户输入直接拼进 SQL，必须消毒） */
export function escapeLikeValue(input: string): string {
  return String(input ?? '')
    .replace(/'/g, "''")
    .replace(/[[\]]/g, (m) => '[' + m + ']')
    .replace(/%/g, '[%]')
    .replace(/_/g, '[_]');
}

/** 构造查询 SQL（纯函数，便于单测）；query 已由调用方 trim */
export function buildWindowsSearchSql(query: string, limit = 20): string {
  const safe = escapeLikeValue(query);
  const top = Math.max(1, Math.min(200, Math.round(limit)));
  // 只取展示需要的三列：路径 / 是否目录 / 大小；排序按修改时间倒序（越新越可能是要找的）
  return (
    'SELECT TOP ' +
    top +
    ' System.ItemPathDisplay, System.Size, System.DateModified, System.FileAttributes ' +
    'FROM SYSTEMINDEX WHERE System.FileName LIKE ' +
    "'%" + safe + "%' ORDER BY System.DateModified DESC"
  );
}

/** 解析 PowerShell 输出的 JSON 行 → SearchResult[]（纯函数，便于单测） */
export function parseWindowsSearchOutput(stdout: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const row = JSON.parse(text) as { path?: string; size?: number; mtime?: number; isDir?: boolean };
      const p = String(row.path ?? '').trim();
      if (!p) continue;
      const name = p.split(/[\\/]/).pop() ?? p;
      out.push({
        path: p,
        name,
        isDir: row.isDir === true,
        size: Number.isFinite(Number(row.size)) ? Number(row.size) : 0,
        mtime: Number.isFinite(Number(row.mtime)) ? Number(row.mtime) : 0
      });
    } catch {
      /* 非 JSON 行（PowerShell 警告等）忽略 */
    }
  }
  return out;
}

/**
 * 执行查询（PowerShell + ADODB）。
 *
 * 注意用 -EncodedCommand 会引入 base64 依赖，这里直接把 SQL 作为环境变量传入，
 * 避免任何引号/转义层面的坑（SQL 里必然带单引号与 % 号）。
 */
export function windowsIndexSearch(query: string, limit = 20): Promise<SearchResult[]> {
  const q = String(query ?? '').trim();
  if (!q) return Promise.resolve([]);
  // 已知不可用 / 已连续失败到阈值：直接返回空，**一次 PowerShell 都不拉**（首屏预算优先）
  if (availabilityCache === false || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return Promise.resolve([]);
  const sql = buildWindowsSearchSql(q, limit);
  /*
   * 逐列取值必须防 DBNull —— 这是实测踩到的坑：
   * 目录在索引里没有 System.Size（值为 DBNull），直接 `[double]` 转换会抛
   * "对象不能从 DBNull 转换为其他类型"，导致**整段脚本失败**、查询退化成一次 550ms 的白等。
   * 现在统一走 GetVal 取值 + 逐项兜底。
   */
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'function GetVal($row, $name) {',
    '  try { $v = $row.Fields.Item($name).Value; if ($v -is [System.DBNull]) { return $null } return $v } catch { return $null }',
    '}',
    '$conn = New-Object -ComObject ADODB.Connection',
    '$conn.CommandTimeout = 5',
    '$conn.Open("Provider=Search.CollatorDSO;Extended Properties=\'Application=Windows\';")',
    '$rs = $conn.Execute($env:XP_WS_SQL)',
    'while (-not $rs.EOF) {',
    '  $p = GetVal $rs "System.ItemPathDisplay"',
    '  if ($p) {',
    '    $sz = GetVal $rs "System.Size"; if ($null -eq $sz) { $sz = 0 }',
    '    $mt = 0',
    '    $d = GetVal $rs "System.DateModified"',
    '    if ($d) { try { $mt = ([datetime]$d).ToUniversalTime().Subtract([datetime]::UnixEpoch).TotalMilliseconds } catch {} }',
    '    $isDir = $false',
    '    $attr = GetVal $rs "System.FileAttributes"',
    '    if ($null -ne $attr) { try { $isDir = (([int]$attr) -band 16) -ne 0 } catch {} }',
    '    Write-Output (ConvertTo-Json ([ordered]@{ path = [string]$p; size = [double]$sz; mtime = [double]$mt; isDir = $isDir }) -Compress)',
    '  }',
    '  $rs.MoveNext()',
    '}',
    '$rs.Close(); $conn.Close()'
  ].join('\n');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: QUERY_TIMEOUT_MS + 1500,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, XP_WS_SQL: sql }
      },
      (err, stdout) => {
        if (err) {
          // 索引不可用是常见情况（服务关闭/精简版系统），降级为调试日志，不刷警告
          consecutiveFailures++;
          logDebug('[winsearch] 查询失败（第 ' + consecutiveFailures + ' 次），回退内置遍历', err.message);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logWarn('[winsearch] 连续失败达上限，本会话停用 Windows 搜索索引，改用内置遍历');
            availabilityCache = false;
          }
          resolve([]);
          return;
        }
        consecutiveFailures = 0;
        const list = parseWindowsSearchOutput(stdout);
        logDebug('[winsearch] 命中', list.length, '条');
        resolve(list);
      }
    );
  });
}

/** 索引是否可用（探测一次并缓存；服务关闭/无 COM 时返回 false） */
export function windowsIndexAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return Promise.resolve(availabilityCache);
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$s = Get-Service WSearch -ErrorAction Stop',
    'if ($s.Status -ne "Running") { exit 3 }',
    '$conn = New-Object -ComObject ADODB.Connection',
    '$conn.Open("Provider=Search.CollatorDSO;Extended Properties=\'Application=Windows\';")',
    '$conn.Close()',
    'exit 0'
  ].join('\n');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 6000 },
      (err) => {
        availabilityCache = !err;
        if (!availabilityCache) logDebug('[winsearch] Windows 搜索索引不可用，使用内置遍历');
        resolve(availabilityCache);
      }
    );
  });
}

/** 供设置页/诊断展示当前搜索后端 */
export async function searchBackendInfo(): Promise<{ windowsIndex: boolean }> {
  try {
    return { windowsIndex: await windowsIndexAvailable() };
  } catch (e) {
    logWarn('[winsearch] 探测异常', e);
    return { windowsIndex: false };
  }
}
