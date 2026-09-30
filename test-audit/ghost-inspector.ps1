# 幽灵窗口现场检查器（出现「点不动/看不见窗口」时立刻运行）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File test-audit\ghost-inspector.ps1
#      powershell ... ghost-inspector.ps1 -Point 1234,567   # 指定「点不动」的屏幕坐标
#
# 输出三部分：
#   1) 小鹏工具箱全部顶层窗口的清单（标题/HWND/矩形/可见/置顶/cloaked/最小化）
#   2) 可疑窗口标记（可见但 cloaked、可见且置顶但整块透明、矩形在屏幕外）
#   3) 指定点的命中窗口 —— 鼠标点不动时，就是它在吃点击

param([string]$Point = '')

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Win32Ghost {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern uint GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }

  static string Info(IntPtr h, int px, int py, bool isPointOwner) {
    var cls = new StringBuilder(256); GetClassName(h, cls, 256);
    var txt = new StringBuilder(512); GetWindowText(h, txt, 512);
    RECT r; GetWindowRect(h, out r);
    int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); // DWMWA_CLOAKED
    var wp = new WINDOWPLACEMENT(); wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    GetWindowPlacement(h, ref wp);
    uint ex = GetWindowLong(h, -20); // GWL_EXSTYLE
    return string.Join("\t", new string[] {
      h.ToString(),
      txt.ToString(),
      cls.ToString(),
      r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top),
      IsWindowVisible(h) ? "visible" : "hidden",
      (ex & 0x8) != 0 ? "topmost" : "-",
      cloaked != 0 ? "cloaked" : "-",
      wp.showCmd.ToString(),
      IsWindowEnabled(h) ? "enabled" : "disabled",
      isPointOwner ? "POINT-OWNER" : ""
    });
  }

  public static List<string> Scan(int px, int py) {
    var outp = new List<string>();
    IntPtr owner = WindowFromPoint(new POINT { X = px, Y = py });
    IntPtr root = GetAncestor(owner, 2); // GA_ROOT
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var txt = new StringBuilder(512); GetWindowText(h, txt, 512);
      bool isElectron = cls.ToString() == "Chrome_WidgetWin_1";
      bool isOurs = txt.Length > 0 && (
        txt.ToString().Contains("小鹏") || txt.ToString().Contains("宠物") || txt.ToString().Contains("工作台") ||
        txt.ToString().Contains("收纳盒") || txt.ToString().Contains("命令面板") || txt.ToString().Contains("剪贴板") ||
        txt.ToString().Contains("截图") || txt.ToString().Contains("贴图") || txt.ToString().Contains("翻译") ||
        txt.ToString().Contains("预览") || txt.ToString().Contains("聊天") || txt.ToString().Contains("设置") ||
        txt.ToString().Contains("开发者工具"));
      if ((isElectron || isOurs || h == root) && (IsWindowVisible(h) || isOurs || h == root)) {
        outp.Add(Info(h, px, py, h == root || h == owner));
      }
      return true;
    }, IntPtr.Zero);
    return outp;
  }

  public static int[] Cursor() {
    POINT p; GetCursorPos(out p);
    return new int[] { p.X, p.Y };
  }
}
'@

if ($Point -match '^(\d+)\s*,\s*(\d+)$') {
  $px = [int]$Matches[1]; $py = [int]$Matches[2]
} else {
  $c = [Win32Ghost]::Cursor()
  $px = $c[0]; $py = $c[1]
}
Write-Host ("== 命中测试点：($px, $py) ==")
Write-Host ''
Write-Host '== 窗口清单（hwnd / title / class / rect / vis / topmost / cloak / showCmd / enabled / flag）=='
$rows = [Win32Ghost]::Scan($px, $py)
foreach ($r in $rows) { Write-Host ('  ' + $r) }
Write-Host ''

$displays = [System.Windows.Forms.Screen]::AllScreens
Write-Host '== 显示器工作区 =='
foreach ($d in $displays) {
  $b = $d.Bounds
  Write-Host ("  " + $d.DeviceName + " bounds=" + $b.X + "," + $b.Y + " " + $b.Width + "x" + $b.Height + " primary=" + $d.Primary)
}
Write-Host ''
Write-Host '== 可疑标记 =='
$sus = 0
foreach ($r in $rows) {
  $f = $r -split "	"
  $rect = $f[3]; $vis = $f[4]; $top = $f[5]; $cloak = $f[6]
  if ($rect -match '(-?\d+),(-?\d+) (\d+)x(\d+)') {
    $x = [int]$Matches[1]; $y = [int]$Matches[2]; $w = [int]$Matches[3]; $h = [int]$Matches[4]
    $onScreen = $false
    foreach ($d in $displays) {
      $b = $d.Bounds
      if ($x -lt ($b.X + $b.Width) -and ($x + $w) -gt $b.X -and $y -lt ($b.Y + $b.Height) -and ($y + $h) -gt $b.Y) { $onScreen = $true }
    }
    $showCmd = $f[7]
    $minimized = ($showCmd -eq '2' -or $showCmd -eq '6' -or $rect -like '-25600*')
    if ($vis -eq 'visible' -and $minimized) { Write-Host ("  [已最小化，不接受点击，无害] " + $f[1] + " @ " + $rect) }
    elseif ($vis -eq 'visible' -and $cloak -eq 'cloaked') { Write-Host ("  [DWM cloaked（系统隐藏/挂起），不接受点击，无害] " + $f[1] + " @ " + $rect) }
    elseif ($vis -eq 'visible' -and -not $onScreen) { Write-Host ("  [屏幕外但标记可见 —— 若它正是你要找的功能窗，即「无窗口显示」] " + $f[1] + " @ " + $rect); $sus++ }
    elseif ($vis -eq 'visible' -and $cloak -ne 'cloaked' -and $f[9] -eq 'POINT-OWNER') { Write-Host ("  [点击会落到它 —— 请用肉眼确认：看不见 = 幽灵窗口] " + $f[1] + " @ " + $rect); $sus++ }
  }
}
if ($sus -eq 0) { Write-Host '  （无自动可疑项 —— 请把上面的窗口清单与「POINT-OWNER」行发回分析）' }
Write-Host ''
Write-Host '（提示：POINT-OWNER 行 = 合成/真实点击会落到的窗口；若它标题为空/肉眼看不见，即为幽灵窗口）'
