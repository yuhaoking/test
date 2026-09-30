<#
  给本项目的构建产物目录添加 Windows Defender 排除项。

  为什么要做：
    SmartScreen 按**文件哈希**判定信誉。每次重新打包都会生成新哈希，
    于是每个新产物都是"从未见过的程序"，被拦截提示"已保护你的电脑"。
    本机自用、且产物由你本机构建，把产物目录加入排除项是常规做法。

  影响范围（请务必知悉）：
    · 仅排除 D:\mimo小鹏工具箱\dist\win-unpacked（打包产物目录）；
    · 该目录下文件不再被 Defender 实时扫描；
    · 不影响系统其它任何目录，不影响 SmartScreen 的其它判定。

  如何撤销：
    Remove-MpPreference -ExclusionPath 'D:\mimo小鹏工具箱\dist\win-unpacked'
    （脚本执行完也会再次打印这条命令）

  发版提醒：
    这是**开发机自用**措施。对外分发前应撤销，改为使用代码签名证书。
#>

$ErrorActionPreference = 'Stop'
$target = 'D:\mimo小鹏工具箱\dist\win-unpacked'

# —— 自我提权 ——
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限，正在请求提权（请在弹出窗口选择"是"）...' -ForegroundColor Yellow
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $PSCommandPath)
  } catch {
    Write-Host "提权被取消或失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '你也可以手动以管理员身份运行本脚本。'
    Start-Sleep -Seconds 6
  }
  exit
}

Write-Host '=== 小鹏工具箱 · 添加 Defender 排除项 ===' -ForegroundColor Cyan
Write-Host "  目标目录: $target"
Write-Host ''

if (-not (Test-Path -LiteralPath $target)) {
  Write-Host "[警告] 目录不存在：$target" -ForegroundColor Yellow
  Write-Host '       请先执行一次打包（npm run build && electron-builder --dir）再运行本脚本。'
} else {
  Write-Host '[1/3] 目录已确认存在'
}

Write-Host '[2/3] 添加排除项...'
$added = $false
try {
  $existing = (Get-MpPreference).ExclusionPath
  if ($existing -contains $target) {
    Write-Host '      已存在该排除项，无需重复添加。' -ForegroundColor Green
    $added = $true
  } else {
    Add-MpPreference -ExclusionPath $target
    Write-Host '      已添加。' -ForegroundColor Green
    $added = $true
  }
} catch {
  Write-Host "      添加失败：$($_.Exception.Message)" -ForegroundColor Red
}

Write-Host '[3/3] 校验...'
if ($added) {
  $now = (Get-MpPreference).ExclusionPath
  if ($now -contains $target) {
    Write-Host '      ✓ 校验通过：排除项已生效' -ForegroundColor Green
  } else {
    Write-Host '      ✗ 校验未通过，请手动检查' -ForegroundColor Red
  }
  Write-Host ''
  Write-Host '当前全部路径排除项：'
  $now | ForEach-Object { Write-Host "  · $_" }
}

Write-Host ''
Write-Host '—— 撤销命令（复制保存，需要时以管理员运行）——' -ForegroundColor Cyan
Write-Host "Remove-MpPreference -ExclusionPath '$target'"
Write-Host ''
Write-Host '完成后请双击项目根目录的「小鹏工具箱.lnk」验证是否还会弹出拦截。'
Write-Host '若仍弹出 SmartScreen（它与 Defender 排除项是两套机制），告诉我，我再给一条只关"应用信誉检查"的命令。'
Write-Host ''
Read-Host '按回车键关闭'
