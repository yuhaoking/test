import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { iconCacheDir } from '../store/dataStore';
import type { AppItem } from '../../shared/types';

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$cacheRoot = $env:ICON_CACHE
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
Add-Type -AssemblyName System.Drawing
function Get-IconFile($path) {
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
    if ($null -eq $ico) { return $null }
    $hash = [System.BitConverter]::ToString([System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$path))).Replace('-','')
    $out = Join-Path $cacheRoot ($hash + '.png')
    if (-not (Test-Path -LiteralPath $out)) {
      $bmp = $ico.ToBitmap()
      $resized = New-Object System.Drawing.Bitmap 32, 32
      $g = [System.Drawing.Graphics]::FromImage($resized)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($bmp, 0, 0, 32, 32)
      $resized.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $resized.Dispose(); $bmp.Dispose()
    }
    $ico.Dispose()
    return $out
  } catch { return $null }
}
$apps = @{}
function Add-App($name, $path) {
  if (-not $name -or -not $path) { return }
  if ($apps.ContainsKey($path)) { return }
  $icon = Get-IconFile $path
  $apps[$path] = @{ name = [string]$name; path = [string]$path; icon = $icon }
}
$uninstallKeys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($key in $uninstallKeys) {
  Get-ItemProperty -Path $key | Where-Object {
    $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName -and -not $_.ReleaseType
  } | ForEach-Object {
    $exe = $null
    if ($_.DisplayIcon) {
      $di = [string]$_.DisplayIcon
      if ($di -match '^"(?<p>[^"]+)"') { $exe = $Matches.p }
      elseif ($di -match '^(?<p>[^,]+)') { $exe = $Matches.p }
    }
    if ($exe -and $exe -match '\\.(exe|bat|cmd)$' -and (Test-Path -LiteralPath $exe)) {
      Add-App $_.DisplayName $exe
    }
  }
}
$shell = $null
try { $shell = New-Object -ComObject WScript.Shell } catch {}
if ($null -ne $shell) {
  $lnkRoots = @(
    Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs',
    Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'
  )
  foreach ($root in $lnkRoots) {
    Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $t = $shell.CreateShortcut($_.FullName).TargetPath
        if ($t -and $t -match '\\.(exe|bat|cmd)$' -and (Test-Path -LiteralPath $t)) {
          Add-App $_.BaseName $t
        }
      } catch {}
    }
  }
  [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
}
$result = @($apps.Values)
if ($result.Count -eq 0) {
  [Console]::Out.WriteLine('[]')
} elseif ($result.Count -eq 1) {
  $one = $result[0] | ConvertTo-Json -Compress
  [Console]::Out.WriteLine('[' + $one + ']')
} else {
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 3))
}
`;

const ICON_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:ICON_PATH
$out = $env:ICON_OUT
if (-not (Test-Path -LiteralPath $p)) { exit 1 }
Add-Type -AssemblyName System.Drawing
$ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
if ($null -eq $ico) { exit 1 }
$bmp = $ico.ToBitmap()
$resized = New-Object System.Drawing.Bitmap 64, 64
$g = [System.Drawing.Graphics]::FromImage($resized)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($bmp, 0, 0, 64, 64)
$resized.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $resized.Dispose(); $bmp.Dispose()
`;

/** 扫描结果缓存时长：应用列表变化缓慢，10 分钟内复用，避免重复启动 PowerShell */
const SCAN_TTL = 10 * 60_000;

let scanCache: AppItem[] | null = null;
let scanCacheAt = 0;

function runScan(): Promise<AppItem[]> {
  return new Promise((resolve) => {
    mkdirSync(iconCacheDir(), { recursive: true });
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        env: { ...process.env, ICON_CACHE: iconCacheDir() },
        windowsHide: true,
        // SVC-4 修复：扫描子进程加超时，避免网络快捷方式导致 PowerShell 挂起并堆积
        timeout: 45000,
        maxBuffer: 64 * 1024 * 1024
      },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

export function scanInstalledApps(force = false): Promise<AppItem[]> {
  if (!force && scanCache && Date.now() - scanCacheAt < SCAN_TTL) return Promise.resolve(scanCache);
  return runScan().then((result) => {
    scanCache = result;
    scanCacheAt = Date.now();
    return result;
  });
}

function iconCachePath(path: string): string {
  const hash = createHash('md5').update(path).digest('hex');
  return `${iconCacheDir()}\\${hash}.png`;
}

export function extractAppIcon(path: string): Promise<string> {
  return new Promise((resolve) => {
    if (!path) return resolve('');
    const out = iconCachePath(path);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ICON_SCRIPT],
      {
        env: { ...process.env, ICON_PATH: path, ICON_OUT: out },
        windowsHide: true,
        timeout: 30000
      },
      (err) => resolve(err ? '' : out)
    );
  });
}
