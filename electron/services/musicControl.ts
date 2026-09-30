import { execFile } from 'child_process';
import { logDebug, logWarn } from '../utils/log';
import type { LyricLine, MusicState } from '../../shared/types';

const EMPTY: MusicState = {
  hasSession: false,
  title: '',
  artist: '',
  album: '',
  albumArt: '',
  appId: '',
  playing: false,
  positionMs: 0,
  durationMs: 0
};

/**
 * 轮询节流参数（单位 ms）：
 * - 每次 SMTC 状态查询都需要启动一个 PowerShell 子进程，代价较高；
 * - 轮询基础间隔 1500ms，状态不变时按 2 倍退避，最长 5000ms；
 * - 播放中 positionMs 持续变化，退避不会生效，保证进度条 1.5~2s 内更新。
 */
const POLL_TTL_BASE = 1500;
const POLL_TTL_MAX = 5000;
/** 封面/歌词查询结果缓存上限，防止长时间运行导致内存无限增长 */
const MAX_CACHE_SIZE = 200;

const SMTC_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$action = $env:SMTC_ACTION
$value = $env:SMTC_VALUE
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
} catch {
  [Console]::Out.WriteLine('{"hasSession":false,"title":"","artist":"","album":"","albumArt":"","appId":"","playing":false,"positionMs":0,"durationMs":0}')
  exit 1
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $manager.GetCurrentSession()
if ($null -eq $session) {
  [Console]::Out.WriteLine('{"hasSession":false,"title":"","artist":"","album":"","albumArt":"","appId":"","playing":false,"positionMs":0,"durationMs":0}')
  exit 0
}
switch ($action) {
  'play'   { $null = Await ($session.TryPlayAsync()) ([bool]) }
  'pause'  { $null = Await ($session.TryPauseAsync()) ([bool]) }
  'toggle' { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
  'next'   { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
  'prev'   { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
  'seek'   { $null = Await ($session.TryChangePlaybackPositionAsync([int64]$value)) ([bool]) }
}
$props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$info = $session.GetPlaybackInfo()
$tl = $session.GetTimelineProperties()
$playing = ($info.PlaybackStatus -eq 4)
$pos = 0; $dur = 0
try { $pos = [int64]$tl.Position.TotalMilliseconds; $dur = [int64]($tl.EndTime - $tl.StartTime).TotalMilliseconds } catch {}
$art = ''
try { if ($props.AlbumArtUri) { $art = [string]$props.AlbumArtUri } } catch {}
[pscustomobject]@{
  hasSession = $true
  title = [string]$props.Title
  artist = [string]$props.Artist
  album = [string]$props.AlbumTitle
  albumArt = $art
  appId = [string]$session.SourceAppUserModelId
  playing = $playing
  positionMs = $pos
  durationMs = $dur
} | ConvertTo-Json -Compress
exit 0
`;

function parseState(stdout: string): MusicState {
  try {
    const obj = JSON.parse(stdout.trim()) as Partial<MusicState>;
    return { ...EMPTY, ...obj };
  } catch {
    return EMPTY;
  }
}

function sameState(a: MusicState, b: MusicState): boolean {
  return (
    a.hasSession === b.hasSession &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.appId === b.appId &&
    a.playing === b.playing &&
    a.positionMs === b.positionMs &&
    a.durationMs === b.durationMs
  );
}

let lastKnown: MusicState | null = null;
const coverCache = new Map<string, string>();
const songmidCache = new Map<string, string>();

/** 带上限的 Map 写入（近似 LRU：命中时刷新插入顺序，超限时淘汰最旧项） */
function cacheSet(map: Map<string, string>, key: string, value: string): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHE_SIZE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function withLastKnown(state: MusicState): MusicState {
  if (state.hasSession || !lastKnown) return state;
  const { title, artist, album, albumArt, appId } = lastKnown;
  return { ...EMPTY, ...state, title, artist, album, albumArt, appId };
}

async function lookupCover(state: MusicState): Promise<MusicState> {
  if (!state.hasSession || state.albumArt || (!state.title && !state.artist)) return state;
  const key = `${state.title}|${state.artist}`;
  if (coverCache.has(key)) {
    return { ...state, albumArt: coverCache.get(key)! };
  }
  if (!/QQMusic|qq/i.test(state.appId)) return state;
  try {
    const query = encodeURIComponent(`${state.title} ${state.artist}`.trim());
    const res = await fetch(
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=1&p=1&w=${query}&cr=1&aggr=1&platform=yqq.json&needNewCode=0`,
      { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    const json = (await res.json()) as { data?: { song?: { list?: { albummid?: string; songmid?: string }[] } } };
    const song = json.data?.song?.list?.[0];
    if (song?.albummid) {
      const url = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`;
      cacheSet(coverCache, key, url);
      if (song.songmid) cacheSet(songmidCache, key, song.songmid);
      return { ...state, albumArt: url };
    }
  } catch {
    /* 保持空封面 */
  }
  cacheSet(coverCache, key, '');
  return state;
}

export async function getLyrics(title: string, artist: string): Promise<LyricLine[]> {
  const key = `${title}|${artist}`;
  if (!title) return [];
  let songmid = songmidCache.get(key);
  if (!songmid) {
    try {
      const query = encodeURIComponent(`${title} ${artist}`.trim());
      const res = await fetch(
        `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=1&p=1&w=${query}&cr=1&aggr=1&platform=yqq.json&needNewCode=0`,
        { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
      );
      const json = (await res.json()) as { data?: { song?: { list?: { songmid?: string }[] } } };
      songmid = json.data?.song?.list?.[0]?.songmid;
      if (songmid) cacheSet(songmidCache, key, songmid);
    } catch {
      return [];
    }
  }
  if (!songmid) return [];
  try {
    const res = await fetch(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songmid}&format=json&nobase64=1`,
      { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
    );
    const json = (await res.json()) as { lyric?: string };
    return parseLrc(json.lyric ?? '');
  } catch {
    return [];
  }
}

function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const timeTag = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    const texts: string[] = [];
    let match: RegExpExecArray | null;
    timeTag.lastIndex = 0;
    let lastEnd = -1;
    while ((match = timeTag.exec(raw)) !== null) {
      const m = parseInt(match[1], 10);
      const s = parseInt(match[2], 10);
      const frac = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
      texts.push(`${m * 60 + s}.${frac}`);
      lastEnd = timeTag.lastIndex;
    }
    const text = lastEnd >= 0 ? raw.slice(lastEnd).trim() : '';
    if (!text || text.startsWith('[')) continue;
    for (const t of texts) {
      const [sec, ms] = t.split('.');
      lines.push({ t: parseInt(sec, 10) * 1000 + parseInt(ms || '0', 10), text });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** 统一执行 PowerShell 脚本（异步，绝不阻塞主进程）；失败时抛出，由调用方兜底 */
function runPowershell(script: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: { ...process.env, ...env },
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

/** 请求 SMTC 状态/执行控制指令，返回合并了上次播放信息的完整状态；
 * 失败时按 30 秒节流输出警告，避免轮询失败导致日志刷屏 */
let lastWarnAt = 0;

function smtcRun(action: string, value = 0): Promise<MusicState> {
  return runPowershell(SMTC_SCRIPT, { SMTC_ACTION: action, SMTC_VALUE: String(value) })
    .then((stdout) => withLastKnown(parseState(stdout)))
    .catch((err: Error) => {
      if (Date.now() - lastWarnAt > 30_000) {
        lastWarnAt = Date.now();
        logWarn(`[musicControl] SMTC 调用失败 (${action})`, err.message);
      }
      return withLastKnown(EMPTY);
    });
}

// ---------- 状态缓存：合并并发、按变化自适应降频 ----------

let lastState: MusicState = EMPTY;
let lastFetchAt = 0;
let pollTtl = POLL_TTL_BASE;
let inflight: Promise<MusicState> | null = null;

function applySnapshot(next: MusicState): MusicState {
  const now = Date.now();
  // 状态未变化时退避轮询频率；恢复变化（播放/切歌）时立即回到基础频率
  pollTtl = sameState(next, lastState) ? Math.min(pollTtl * 2, POLL_TTL_MAX) : POLL_TTL_BASE;
  lastState = next;
  lastFetchAt = now;
  if (next.hasSession) lastKnown = next;
  return next;
}

async function pollState(): Promise<MusicState> {
  const raw = await smtcRun('state');
  return applySnapshot(await lookupCover(raw));
}

function startPoll(): Promise<MusicState> {
  if (!inflight) {
    inflight = pollState().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function getMusicState(): Promise<MusicState> {
  const now = Date.now();
  if (inflight) return inflight;
  // 命中缓存：直接返回上次快照，避免频繁启动 PowerShell 子进程
  if (lastFetchAt > 0 && now - lastFetchAt < pollTtl) return Promise.resolve(lastState);
  return startPoll();
}

/** 控制指令串行队列：用户快速连点（切歌/暂停）时保证同一时刻至多一个 PowerShell 进程，且不丢失 inflight 引用 */
let controlQueue: Promise<unknown> = Promise.resolve();

export function controlMusic(action: string, value = 0): Promise<MusicState> {
  // 控制指令不命中缓存；先等待进行中的轮询结束，再串行执行
  const run = async (): Promise<MusicState> => {
    if (inflight) await inflight.catch(() => undefined);
    inflight = smtcRun(action, value)
      .then(applySnapshot)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  controlQueue = controlQueue.then(run, run);
  return controlQueue as Promise<MusicState>;
}

const PLAYERS: Record<string, string> = {
  qq: 'QQMusic',
  netease: 'cloudmusic',
  spotify: 'Spotify',
  kugou: 'KGMusic'
};

const APP_TARGETS: Array<{ id: string; proc: string; display: string }> = [
  { id: 'qqmusic', proc: 'QQMusic', display: 'QQ音乐' },
  { id: 'cloudmusic', proc: 'cloudmusic', display: '网易云音乐' },
  { id: 'netease', proc: 'cloudmusic', display: '网易云音乐' },
  { id: 'spotify', proc: 'Spotify', display: 'Spotify' },
  { id: 'kgmusic', proc: 'KGMusic', display: '酷狗音乐' },
  { id: 'kugou', proc: 'KGMusic', display: '酷狗音乐' }
];

/** 按 SMTC 会话 appId 决定应打开的播放器目标；未知返回 null */
function targetFromAppId(appId: string): { proc: string; display: string } | null {
  if (!appId) return null;
  const a = appId.toLowerCase();
  for (const t of APP_TARGETS) {
    if (a.includes(t.id)) return { proc: t.proc, display: t.display };
  }
  return null;
}

export async function openPlayer(platform: string): Promise<boolean> {
  // 1) 优先打开"当前正在播放"的应用（SMTC 会话 appId），其次设置里的 platform
  let target: { proc: string; display: string } | null = null;
  try {
    const st = await getMusicState();
    target = targetFromAppId(st.appId);
  } catch {
    /* fall through */
  }
  if (!target) {
    const proc = PLAYERS[platform] ?? 'QQMusic';
    const disp = proc === 'QQMusic' ? 'QQ音乐' : proc === 'cloudmusic' ? '网易云音乐' : proc;
    target = { proc, display: disp };
  }
  const { proc: procName, display: dispName } = target;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$procName = '${procName}'
$dispName = '${dispName}'
$proc = Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -First 1
$exe = ''
if ($proc) { $exe = [string]$proc.Path }
# 1) 已有主窗口 -> 激活
$main = Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($main) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.Interaction]::AppActivate($main.Id)
  [Console]::Out.WriteLine('1')
  exit 0
}
# 2) 进程在运行但窗口被隐藏（最小化/托盘化）-> Win32 恢复主窗口
if ($proc) {
  try {
    Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public static class XpWin32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}'
    $script:restored = $false
    $cb = [XpWin32+EnumProc]{ param($h, $l)
      $p2 = 0
      [XpWin32]::GetWindowThreadProcessId($h, [ref]$p2) | Out-Null
      if ($p2 -eq $proc.Id) {
        [XpWin32]::ShowWindow($h, 9) | Out-Null
        [XpWin32]::SetForegroundWindow($h) | Out-Null
        $script:restored = $true
      }
      return $true
    }
    [XpWin32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    if ($script:restored) { [Console]::Out.WriteLine('1'); exit 0 }
  } catch {}
  if ($exe -and (Test-Path -LiteralPath $exe)) {
    Start-Process -FilePath $exe
    [Console]::Out.WriteLine('1')
    exit 0
  }
}
# 3) 未安装/未运行 -> 注册表精确匹配目标应用后启动
$exe = ''
foreach ($key in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) {
  Get-ItemProperty -Path $key | Where-Object { $_.DisplayName -eq $dispName -and $_.DisplayIcon } | Select-Object -First 1 | ForEach-Object {
    $di = [string]$_.DisplayIcon
    if ($di -match '^(?<p>[^,]+)') { $exe = $Matches.p }
  }
  if ($exe) { break }
}
if ($exe -and (Test-Path -LiteralPath $exe)) {
  Start-Process -FilePath $exe
  [Console]::Out.WriteLine('1')
} else {
  [Console]::Out.WriteLine('0')
}
`;
  try {
    const out = await runPowershell(script);
    return out.includes('1');
  } catch (err) {
    logDebug('[musicControl] openPlayer 失败', (err as Error).message);
    return false;
  }
}
