import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { iconCacheDir } from '../store/dataStore';
import { logWarn } from '../utils/log';

/**
 * 文件系统图标提取（收纳盒内显示与资源管理器一致的图标）
 *
 * 规则：
 * - 文件夹 → imageres.dll 系统文件夹图标（ExtractIconEx 索引 3）；
 * - .lnk/.url 快捷方式 → 解析目标后提取目标程序的图标；
 * - 图片（png/jpg/...）→ 生成内容缩略图（与桌面显示一致）；
 * - 其他文件 → ExtractAssociatedIcon 类型图标；
 * - 缓存键 = MD5(版本 + 路径 + 修改时间)，文件变化自动刷新；
 *   版本号变化会使旧缓存全部失效（修复图标逻辑后强制全量重提取）；
 * - 批量请求合并为一次 PowerShell 调用（in-flight 合并，同一时刻至多一个子进程）。
 */

/** 图标提取版本：修复内容变更时 +1（旧缓存不再命中，自动重提取） */
const ICON_CACHE_VERSION = 2;

interface IconRequest {
  p: string;
  out: string;
}

interface PendingBatch {
  items: IconRequest[];
  resolve: (map: Record<string, string>) => void;
}

let pending: PendingBatch | null = null;
let running = false;

function cachePathFor(path: string, mtimeMs: number): string {
  const hash = createHash('md5').update(`v${ICON_CACHE_VERSION}|${path}|${mtimeMs}`).digest('hex');
  return join(iconCacheDir(), `${hash}.png`);
}

/** 批量获取文件系统图标：返回 path → 图标缓存文件路径（不存在的文件/失败项自动跳过） */
export function getFileIcons(paths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const missing: IconRequest[] = [];
  // P3 加固：入参上限，避免一次请求几万条路径阻塞主进程
  const list = (Array.isArray(paths) ? paths : []).slice(0, 2000);
  for (const p of list) {
    if (!p) continue;
    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      continue; // 路径已失效
    }
    const cache = cachePathFor(p, mtime);
    if (existsSync(cache)) result[p] = cache;
    else missing.push({ p, out: cache });
  }
  if (!missing.length) return Promise.resolve(result);
  return new Promise((resolve) => {
    if (pending) {
      const prev = pending;
      pending = {
        items: [...prev.items, ...missing],
        resolve: (map) => {
          prev.resolve(map);
          resolve(map);
        }
      };
    } else {
      pending = { items: missing, resolve };
    }
    void drain();
  });
}

/** 串行执行未完成的提取批次（同一时刻至多一个 PowerShell 进程） */
async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending) {
      const batch = pending;
      pending = null;
      const map = await runExtract(batch.items);
      batch.resolve(map);
    }
  } finally {
    running = false;
  }
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];

const SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$queueFile = $env:ICON_QUEUE
$cacheDir = $env:ICON_CACHE
$imageExts = @('${IMAGE_EXTS.join("', '")}')
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$items = [System.IO.File]::ReadAllText($queueFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public static class XpIconWin32 {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, int nIcons);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
}'
function Save-IcoToFile($icon, $outPath, $size) {
  $bmp = $icon.ToBitmap()
  $rs = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($rs)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($bmp, 0, 0, $size, $size)
  $rs.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $rs.Dispose(); $bmp.Dispose()
}
function Get-FolderIcon($outPath) {
  # 系统文件夹图标（imageres.dll 索引 3）
  $large = New-Object IntPtr[] 1
  $small = New-Object IntPtr[] 1
  $n = [XpIconWin32]::ExtractIconEx('C:\\Windows\\System32\\imageres.dll', 3, $large, $small, 1)
  if ($n -gt 0 -and $large[0] -ne [IntPtr]::Zero) {
    $icon = [System.Drawing.Icon]::FromHandle($large[0])
    Save-IcoToFile $icon $outPath 32
    $icon.Dispose()
    [XpIconWin32]::DestroyIcon($large[0])
    return $true
  }
  return $false
}
$res = @{}
foreach ($item in $items) {
  $p = [string]$item.p
  $out = [string]$item.out
  try {
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
    if ((Get-Item -LiteralPath $p).PSIsContainer) {
      if (Get-FolderIcon $out) { $res[$p] = $out }
      continue
    }
    $ext = [System.IO.Path]::GetExtension($p).ToLower().TrimStart('.')
    if ($ext -eq 'lnk' -or $ext -eq 'url') {
      # 快捷方式：解析目标后提取目标程序图标
      try {
        $shell = New-Object -ComObject WScript.Shell
        $target = $shell.CreateShortcut($p).TargetPath
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
        if ($target -and (Test-Path -LiteralPath $target)) {
          $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($target)
          if ($null -ne $ico) {
            Save-IcoToFile $ico $out 32
            $ico.Dispose()
            $res[$p] = $out
            continue
          }
        }
      } catch { }
    }
    if ($imageExts -contains $ext) {
      # 图片：内容缩略图
      $img = [System.Drawing.Image]::FromFile($p)
      $rs = New-Object System.Drawing.Bitmap 64, 64
      $g = [System.Drawing.Graphics]::FromImage($rs)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($img, 0, 0, 64, 64)
      $rs.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $rs.Dispose(); $img.Dispose()
      $res[$p] = $out
      continue
    }
    $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
    if ($null -ne $ico) {
      Save-IcoToFile $ico $out 32
      $ico.Dispose()
      $res[$p] = $out
    }
  } catch { }
}
[Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 3))
exit 0
`;

function runExtract(items: IconRequest[]): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const queueFile = join(iconCacheDir(), 'icon-queue.json');
    try {
      mkdirSync(iconCacheDir(), { recursive: true });
      writeFileSync(queueFile, JSON.stringify(items), 'utf-8');
    } catch (e) {
      logWarn('[fileIcons] 写入队列失败', e);
      return resolve({});
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        env: { ...process.env, ICON_QUEUE: queueFile, ICON_CACHE: iconCacheDir() },
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024
      },
      (err, stdout) => {
        if (err) return resolve({});
        try {
          const parsed = JSON.parse(stdout.trim()) as Record<string, string>;
          resolve(parsed ?? {});
        } catch {
          resolve({});
        }
      }
    );
  });
}
