import { app, BrowserWindow, screen } from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 幽灵窗口机制探测器（只读测试，不改动被测代码）
 *
 * 在屏幕上造一组与生产一致的窗口形态（透明+无边框+置顶 vs 不透明目标窗），
 * 分阶段测量四件事，用来区分用户报告的三种症状：
 *   1) 透明像素是否吞点击（症状：鼠标无法点击）；
 *   2) 渲染进程崩溃后窗口是否仍可见且挡点击（症状：看不见但挡鼠标）；
 *   3) 被遮挡（occlusion）时渲染是否被冻结、窗口是否还在（症状：无窗口显示）；
 *   4) hide() 之后是否真的不挡点击（症状：已隐藏仍能被点击）。
 *
 * 状态每 500ms 写入 test-audit/.ghost-probe/state.json，外部点击器按时间戳对账。
 */

const ROOT = process.env.XP_AUDIT_ROOT || process.cwd();
const OUT = join(ROOT, 'test-audit', '.ghost-probe');
mkdirSync(OUT, { recursive: true });
const STATE = join(OUT, 'state.json');
const CLICKLOG = join(OUT, 'clicks.jsonl');

// 注意：screen 模块必须在 app ready 之后才能用（在 ready 前调用会抛未捕获异常 → 0x80000003 退出）
const W = 400;
const H = 300;
let X = 60;
let Y = 60;

type Stats = { clicks: { t: number; x: number; y: number }[]; frames: number };

const phaseLog: { t: number; phase: string }[] = [];
let phase = 'starting';

function html(label: string, bg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:${bg};font:13px/1.6 system-ui,sans-serif;color:#111;overflow:hidden;user-select:none}
    .box{position:absolute;left:0;top:0;padding:6px 10px;background:rgba(255,255,255,.85);border:1px solid #888}
    .dot{position:absolute;left:0;top:0;width:40px;height:40px;background:#d33;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center}
  </style></head><body>
    <div class="dot">DOT</div>
    <div class="box">${label}</div>
    <script>
      window.__stats = { clicks: [], frames: 0 };
      document.addEventListener('mousedown', function (e) {
        window.__stats.clicks.push({ t: Date.now(), x: e.screenX, y: e.screenY });
      }, true);
      (function tick() { window.__stats.frames++; requestAnimationFrame(tick); })();
    </script>
  </body></html>`;
}

function dump(win: BrowserWindow | null, name: string, out: Record<string, unknown>[]): void {
  if (!win || win.isDestroyed()) {
    out.push({ name, destroyed: true });
    return;
  }
  const b = win.getBounds();
  out.push({
    name,
    hwnd: win.getNativeWindowHandle().readUInt32LE(0) || win.getNativeWindowHandle().toString('hex'),
    bounds: b,
    visible: win.isVisible(),
    focused: win.isFocused(),
    minimized: win.isMinimized(),
    alwaysOnTop: win.isAlwaysOnTop()
  });
}

async function statsOf(win: BrowserWindow | null): Promise<Stats | 'dead-or-busy'> {
  if (!win || win.isDestroyed()) return 'dead-or-busy';
  try {
    const raw = (await win.webContents.executeJavaScript('JSON.stringify(window.__stats)', true)) as string;
    return JSON.parse(raw) as Stats;
  } catch {
    return 'dead-or-busy';
  }
}

let target!: BrowserWindow;
let ghost!: BrowserWindow;
let occluder: BrowserWindow | null = null;
const t0 = Date.now();

function setPhase(p: string): void {
  phase = p;
  phaseLog.push({ t: Date.now() - t0, phase: p });
  console.log('[probe] phase ->', p);
}

app.whenReady().then(async () => {
  const wa = screen.getPrimaryDisplay().workArea;
  X = wa.x + 60;
  Y = wa.y + 60;
  // 目标窗：不透明、普通层级 —— 模拟“用户想点的那个窗口”
  target = new BrowserWindow({
    x: X, y: Y, width: W, height: H, frame: false, transparent: false,
    alwaysOnTop: false, skipTaskbar: true, title: 'TARGET',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  // 幽灵窗：与生产一致的透明+无边框+置顶形态，恰好盖住目标窗
  ghost = new BrowserWindow({
    x: X, y: Y, width: W, height: H, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, title: 'GHOST',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  ghost.setAlwaysOnTop(true, 'floating');
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html('TARGET 目标窗（黄色面）', 'rgba(240,210,80,.92)')));
  await ghost.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html('GHOST 幽灵形态窗（透明）', 'transparent')));
  setPhase('normal');

  // 阶段推进
  setTimeout(() => {
    setPhase('crashed');
    ghost.webContents.forcefullyCrashRenderer();
  }, 6000);
  setTimeout(() => {
    setPhase('recovered');
    ghost.webContents.reload();
  }, 14000);
  setTimeout(() => {
    setPhase('occluded');
    occluder = new BrowserWindow({
      x: X - 30, y: Y - 30, width: W + 60, height: H + 60, frame: false,
      transparent: false, alwaysOnTop: true, skipTaskbar: true, title: 'OCCLUDER',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    occluder.setAlwaysOnTop(true, 'screen-saver');
    void occluder.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html('OCCLUDER 全遮挡窗', 'rgba(60,60,60,.98)')));
  }, 20000);
  setTimeout(() => {
    setPhase('unoccluded');
    if (occluder && !occluder.isDestroyed()) occluder.destroy();
  }, 28000);
  setTimeout(() => {
    setPhase('ghost-hidden');
    ghost.hide();
  }, 33000);

  // 状态轮询
  const poll = async (): Promise<void> => {
    const windows: Record<string, unknown>[] = [];
    dump(target, 'target', windows);
    dump(ghost, 'ghost', windows);
    dump(occluder, 'occluder', windows);
    const state = {
      t: Date.now() - t0,
      wallClock: Date.now(),
      phase,
      rect: { X, Y, W, H },
      phaseLog,
      windows,
      stats: {
        target: await statsOf(target),
        ghost: await statsOf(ghost),
        occluder: await statsOf(occluder)
      }
    };
    try {
      writeFileSync(STATE, JSON.stringify(state, null, 2));
      // 追加历史：分析器按阶段算帧率/点击归属（state.json 会被覆盖，history 是时间序列）
      appendFileSync(
        join(OUT, 'history.jsonl'),
        JSON.stringify({ t: state.t, wallClock: state.wallClock, phase, windows, stats: state.stats }) + '\n'
      );
    } catch {
      /* noop */
    }
    if (Date.now() - t0 < 38500) setTimeout(() => void poll(), 500);
    else {
      writeFileSync(join(OUT, 'state.final.json'), JSON.stringify(state, null, 2));
      console.log('[probe] done');
      app.exit(0);
    }
  };
  void poll();
});
