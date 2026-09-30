import { app, BrowserWindow } from 'electron';
import { dataStore } from '../store/dataStore';
import { isPermanentInteractiveWindow } from '../windows/common';
import { logDebug } from '../utils/log';

/**
 * 性能与资源治理（T-10）
 *
 * - 性能模式：均衡 / 节省资源 / 自定义（动画开关 + 闲置释放可分别控制）；
 * - 闲置释放：窗口隐藏/最小化时降帧率（setFrameRate(4)），恢复显示即还原，降低多窗口后台开销；
 * - 动画开关：`perf:anim` 广播到所有窗口（preload 统一写 `html[data-anim]`，CSS 禁用过渡/动画）；
 * - 资源占用可视化：进程 RSS/堆内存 + 窗口数（设置页展示，坦诚换信任）。
 */

export interface PerfUsage {
  rssMB: number;
  heapMB: number;
  externalMB: number;
  uptimeSec: number;
  windows: number;
  visibleWindows: number;
}

export interface PerfEffective {
  animations: boolean;
  idleRelease: boolean;
}

/** 按性能模式解析生效开关（均衡=动画开+闲置释放开；节省=动画关+闲置释放开；自定义=用户开关） */
export function perfEffective(): PerfEffective {
  const s = dataStore().get().settings;
  if (s.perfMode === 'saver') return { animations: false, idleRelease: true };
  if (s.perfMode === 'custom') return { animations: s.perfAnimations !== false, idleRelease: s.perfIdleRelease !== false };
  return { animations: true, idleRelease: true };
}

/**
 * 应用窗口的"闲置释放"策略（GW-02 / OPT-01）。
 *
 * 注意：这里**不能**用 webContents.setFrameRate 做"降帧"。Electron 文档明确：
 * 该 API 仅对离屏渲染生效，且只接受 1~240；对普通窗口传 0/4 属于契约之外（既无效也不安全）。
 * 闲置释放的正确做法是交给 Chromium 的后台节流。
 *
 * 【GW-02 修复】旧实现是 `setBackgroundThrottling(eff.idleRelease)`，即开启闲置释放时
 * **一律允许节流**。问题在于 Chromium 的"后台"判定包含它自己的遮挡/可见性推断：
 * 一张透明置顶窗被别的窗口压住一点点，就可能被判为后台 → 停止跑帧与合成，
 * 用户看到的是"窗口明明在屏幕上，但画面卡死 / 点了没反应"（幽灵窗口症状①）。
 *
 * 现在把判定权握在自己手里，只认**客观的窗口状态**：
 *   · 最小化 / 不可见 → 允许节流（省资源行为不回退，隐藏窗照样降耗）；
 *   · 可见（哪怕被别的窗口盖住）→ 满速，绝不因系统遮挡推断而停帧。
 * 常驻交互窗（工作台/命令面板/侧边栏…见 common.ts 的 PERMANENT_INTERACTIVE_PAGES）
 * 连隐藏期间都保持满速：它们的隐藏只是"收起"，渲染端仍要派发 IPC（GW-08 修复的同一根因）。
 */
function applyIdleFor(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const eff = perfEffective();
  try {
    if (isPermanentInteractiveWindow(win)) {
      win.webContents.setBackgroundThrottling(false);
      return;
    }
    const background = win.isMinimized() || !win.isVisible();
    win.webContents.setBackgroundThrottling(background ? eff.idleRelease : false);
  } catch (e) {
    logDebug('[perf] 窗口闲置策略应用失败', (e as Error).message);
  }
}

/** 性能模式/开关变更即时生效：广播动画开关并重放到所有窗口 */
export function applyPerfMode(): void {
  const eff = perfEffective();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('perf:anim', eff.animations);
    applyIdleFor(win);
  }
}

/** 资源占用可视化（T-10：设置页展示） */
export function perfUsage(): PerfUsage {
  const mem = process.memoryUsage();
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return {
    rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
    heapMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
    externalMB: Math.round(((mem.external + (mem.arrayBuffers ?? 0)) / 1048576) * 10) / 10,
    uptimeSec: Math.round(process.uptime()),
    windows: wins.length,
    visibleWindows: wins.filter((w) => w.isVisible() && !w.isMinimized()).length
  };
}

/** 安装窗口级性能守卫（启动早期调用）：新建窗口自动接入闲置释放 + 动画开关 */
export function installPerfWatchers(): void {
  app.on('browser-window-created', (_e, win) => {
    applyIdleFor(win);
    const refresh = (): void => applyIdleFor(win);
    win.on('show', refresh);
    win.on('hide', refresh);
    win.on('minimize', refresh);
    win.on('restore', refresh);
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('perf:anim', perfEffective().animations);
    });
  });
}
