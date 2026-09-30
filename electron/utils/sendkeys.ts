import { execFile } from 'child_process';
import { logWarn } from './log';

/**
 * 向当前焦点窗口发送按键（CH-04 浮动面板粘贴、T-04 长截图翻页）。
 *
 * 通过 PowerShell SendKeys 一次性发送（非驻留进程，调用完即退出）：
 * - '^v' = Ctrl+V；'{PGDN}' = PageDown；
 * - delayMs：延迟发送（先把焦点还给目标窗口再发按键）。
 */
export function sendKeys(keys: string, delayMs = 120): void {
  const escaped = keys.replace(/'/g, "''");
  const script = `Start-Sleep -Milliseconds ${Math.max(0, Math.round(delayMs))}; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 8000 },
    (err) => {
      if (err) logWarn('[sendkeys] 按键发送失败', err.message);
    }
  );
}
