import { execFile, type ChildProcess } from 'child_process';
import { dataStore } from '../store/dataStore';
import { logError, logWarn } from '../utils/log';

/**
 * 语音输入 + 语音播报（T-05）
 *
 * 基于 Windows 自带 .NET System.Speech（SAPI），零第三方依赖：
 * - TTS 播报：`speak()` 进程级串行，新播报打断上一次（桌宠气泡/聊天回复/用量管家播报共用）；
 * - STT 听写：`dictate()` 单次识别（默认 8 秒），返回识别文本；
 * - 语音组件/麦克风缺失时抛出可读中文错误，由 UI 呈现（规格 6：禁止静默失败）。
 */

const TTS_SCRIPT = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = [int]$env:TTS_RATE
$s.Speak([string]$env:TTS_TEXT)`;

const STT_SCRIPT = `try {
  # SVC-7 修复：显式声明控制台输出编码，否则中文听写结果在 GBK 系统下乱码
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Add-Type -AssemblyName System.Speech
  $cul = [System.Threading.Thread]::CurrentThread.CurrentCulture
  $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine($cul)
  $g = New-Object System.Speech.Recognition.DictationGrammar
  $e.LoadGrammar($g)
  $e.SetInputToDefaultAudioDevice()
  $r = $e.Recognize([TimeSpan]::FromSeconds([double]$env:STT_SECS))
  if ($r) { [Console]::Out.Write($r.Text) }
} catch { [Console]::Error.Write(('STT_ERROR: ' + $_.Exception.Message)) }`;

let speaking: ChildProcess | null = null;

function clampRate(rate: number): number {
  const n = Math.round(Number(rate) || 0);
  return Math.max(-5, Math.min(5, n));
}

/** 语音播报（TTS）：重复调用打断上一次播报；文本为空时仅停止 */
export function speak(text: string): void {
  stopSpeak();
  const t = String(text ?? '').trim();
  if (!t) return;
  const rate = clampRate(dataStore().get().settings.petVoiceRate);
  const child = execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', TTS_SCRIPT],
    {
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, TTS_TEXT: t.slice(0, 600), TTS_RATE: String(rate) }
    },
    (err) => {
      if (err && child.killed) return; // 主动停止，忽略
      if (err) logWarn('[voice] TTS 播报失败', err.message);
    }
  );
  speaking = child;
  child.on('close', () => {
    if (speaking === child) speaking = null;
  });
}

/** 停止当前播报 */
export function stopSpeak(): void {
  if (speaking && !speaking.killed) {
    try {
      speaking.kill();
    } catch (e) {
      logWarn('[voice] 停止播报失败', e);
    }
  }
  speaking = null;
}

/**
 * 语音输入（听写）：识别成功返回文本；无语音返回空串。
 * 语音组件缺失/麦克风不可用时抛出可读错误。
 */
export function dictate(seconds = 8): Promise<string> {
  const secs = Math.max(2, Math.min(20, Math.round(Number(seconds) || 8)));
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', STT_SCRIPT],
      { windowsHide: true, timeout: (secs + 15) * 1000, env: { ...process.env, STT_SECS: String(secs) } },
      (err, stdout, stderr) => {
        const text = String(stdout ?? '').trim();
        if (text) {
          resolve(text);
          return;
        }
        const errText = String(stderr ?? '');
        const m = errText.match(/STT_ERROR:\s*([\s\S]*)/);
        if (m) {
          logWarn('[voice] 听写失败', m[1].trim());
          reject(new Error(`语音输入不可用：${m[1].trim()}`));
          return;
        }
        if (err) {
          logError('[voice] 听写进程失败', err);
          reject(new Error(`语音输入失败：${err.message}`));
          return;
        }
        resolve(''); // 8 秒内没有识别到语音
      }
    );
  });
}
