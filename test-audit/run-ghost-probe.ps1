# 幽灵窗口机制实验（一键运行）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File test-audit\run-ghost-probe.ps1
# 原理：在屏幕左上摆出「透明置顶窗 + 不透明目标窗」，分四阶段（正常/渲染崩溃/被遮挡/已隐藏），
#       由合成点击器在测试窗口矩形内点击，最后按时间戳判定：点击到底被谁吃掉。
# 注意：运行约 45 秒，期间鼠标会被自动移动/点击（只在测试窗口 400x300 矩形内）。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$probeDir = Join-Path $PSScriptRoot '.ghost-probe'
if (Test-Path $probeDir) { Remove-Item $probeDir -Recurse -Force }
New-Item -ItemType Directory -Force $probeDir | Out-Null

Write-Host '[1/3] 启动探测器（Electron 测试窗口）...'
$probeOut = Join-Path $probeDir 'probe-console.log'
$proc = Start-Process -FilePath 'node' -ArgumentList 'test-audit/run-runtime.mjs', 'main', 'ghost-probe' `
  -WorkingDirectory $root -PassThru -RedirectStandardOutput $probeOut -RedirectStandardError (Join-Path $probeDir 'probe-console.err.log')

$state = Join-Path $probeDir 'state.json'
$deadline = (Get-Date).AddSeconds(40)
while (-not (Test-Path $state) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
if (-not (Test-Path $state)) {
  Write-Host '探测器未能启动（state.json 未出现）。请查看 .ghost-probe/probe-console*.log'
  Get-Content (Join-Path $probeDir 'probe-console.err.log') -ErrorAction SilentlyContinue
  exit 1
}
$s = Get-Content $state -Raw | ConvertFrom-Json
$X = [int]$s.rect.X; $Y = [int]$s.rect.Y
Write-Host ("[2/3] 探测器就绪，测试矩形 ($X,$Y) 400x300，开始合成点击...")

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Clicker {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
'@
$log = Join-Path $probeDir 'clicks.jsonl'
$points = @(@{ name = 'transparent'; x = $X + 300; y = $Y + 200 }, @{ name = 'dot'; x = $X + 20; y = $Y + 20 })
$end = (Get-Date).AddSeconds(42)
$i = 0
while ((Get-Date) -lt $end -and -not $proc.HasExited) {
  $p = $points[$i % 2]; $i++
  try { $cur = Get-Content $state -Raw | ConvertFrom-Json } catch { $cur = $null }
  $phase = if ($cur) { [string]$cur.phase } else { '?' }
  [void][Clicker]::SetCursorPos([int]$p.x, [int]$p.y)
  Start-Sleep -Milliseconds 80
  [void][Clicker]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [void][Clicker]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Add-Content -Path $log -Value ('{"t":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"phase":"' + $phase + '","point":"' + $p.name + '"}')
  Start-Sleep -Milliseconds 1100
}
if (-not $proc.HasExited) { Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue }

Write-Host '[3/3] 分析结果...'
node (Join-Path $PSScriptRoot 'analyze-ghost-probe.mjs') $probeDir
