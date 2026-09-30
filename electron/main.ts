import { join } from 'path';
import { app, globalShortcut, Notification } from 'electron';
import { dataStore } from './store/dataStore';
import { closeDb } from './store/db';
import { createPetWindow, notifyPet, petWindow } from './windows/petWindow';
import {
  createSidebarWindow,
  isSidebarVisible,
  sidebarWindow,
  startAutoCollapseWatch,
  toggleSidebar
} from './windows/sidebarWindow';
import { applyAutostart, applyGlobalHotkey, applyHideDesktopIcons, registerModuleIpc } from './ipc/moduleIpc';
import { registerSidebarIpc } from './ipc/sidebarIpc';
import { registerPetIpc } from './ipc/petIpc';
import { registerPluginIpc } from './ipc/pluginIpc';
import { registerAssetIpc } from './ipc/assetIpc';
import { registerFeaturesIpc } from './ipc/featuresIpc';
import { registerBoxesIpc } from './ipc/boxesIpc';
import { registerPaletteIpc } from './ipc/paletteIpc';
import { registerDeskboardIpc } from './ipc/deskboardIpc';
import { registerClipboardIpc } from './ipc/clipboardIpc';
import { registerMarketIpc } from './ipc/marketIpc';
import { registerHotkeysIpc } from './ipc/hotkeysIpc';
import { registerCaptureIpc } from './ipc/captureIpc';
import { registerBackupIpc } from './ipc/backupIpc';
import { registerLlmIpc } from './ipc/llmIpc';
import { registerVoiceIpc } from './ipc/voiceIpc';
import { registerTranslateIpc } from './ipc/translateIpc';
import { registerForgeIpc } from './ipc/forgeIpc';
import { registerThemeIpc } from './ipc/themeIpc';
import { registerToolboxIpc } from './ipc/toolboxIpc';
import {
  disposePlugins,
  startEnabledPlugins,
  startIdleReaper,
  startJobPoller,
  stopJobPoller
} from './services/pluginManager';
import { playAction, resolvePetImage } from './services/petManager';
import { getSystemInfo } from './services/systemInfo';
import { scanInstalledApps } from './services/appScanner';
import { applyBoxesEnabled } from './services/desktopBoxes';
import { applyClipboardMonitor, stopClipboardMonitor } from './services/clipboardManager';
import { applyCaptureHotkeys } from './services/captureManager';
import { applyTranslateHotkeys } from './services/translateBar';
import { applyTray } from './services/trayManager';
import { applyMcpServer, stopMcpServer } from './services/mcpServer';
import { applyPerfMode, installPerfWatchers } from './services/perf';
import { startUpdateCheck } from './services/updateChecker';
import {
  installLivenessProbe,
  installWindowWatchdog,
  isProcessElevated,
  isRendererLaunchBroken,
  renderHealthSummary
} from './services/windowWatchdog';
import { applyPaletteHotkey } from './windows/paletteWindow';
import { applyClipboardHotkey } from './windows/clipboardWindow';
import { applyDeskboardHotkey, applyDeskboardVisibility } from './windows/deskboardWindow';
import { destroyCaptureWindows } from './windows/captureWindows';
import { setQuitting } from './utils/quitState';
import { logDebug, logError, logWarn } from './utils/log';
import type { AppData, TodoItem } from '../shared/types';

app.setName('xiaopeng-toolbox');
app.setAppUserModelId('com.xiaopeng.toolbox');

/*
 * GW-02 修复（幽灵窗口症状①「鼠标点不动」）：禁用 Chromium 原生遮挡计算。
 *
 * Windows 上 Chromium 会不断地把窗口矩形相互比对、推断"谁被遮挡了"，据此决定
 * 被遮挡的窗口是否停止绘制与合成。我们的主体窗口是**透明 + 无边框 + 置顶**的（宠物 / 侧边栏 /
 * 工作台 / 收纳盒 / 命令面板），而这类窗口的可见区域是"逐像素"的：一张透明的大窗口
 * 在 Windows 眼里会与下面的窗口"互相遮挡"，于是**视觉上完全可见的窗口被判为遮挡 → 停止合成**，
 * 用户看到的就是"画面卡住 / 点了没反应"。
 *
 * 关闭该项的代价只是少一份系统级的**优化**提示（不影响窗口功能与内存策略），
 * 而"可见窗口必须继续绘制"是硬需求 —— 这也是 Electron 社区针对透明置顶窗闪烁/冻结的通行做法。
 * 幂等：本模块被加载一次即执行一次；重复设置同一开关不会叠加副作用。
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/*
 * ============ RUN-001 头号嫌疑：清除继承来的 Windows 兼容层 ============
 *
 * 【证据】用户侧两次失败运行的环境快照都是：
 *     __COMPAT_LAYER = DetectorsAppHealth DetectorsAdminProtection Installer
 * 而审计环境该变量为空。这几个都是 **Windows 兼容性引擎（Application Compatibility）**
 * 注入的 shim 名：
 *   · Installer / DetectorsAdminProtection —— 负责"安装程序检测 / 静默提权判断"，
 *     其实现方式是在**进程创建路径上挂钩**；
 *   · DetectorsAppHealth —— 应用健康检测。
 * 它们由**父进程通过环境变量继承**进来（本机注册表里没有针对本应用的兼容性设置，
 * 也不是全局环境变量），因此是"某个启动它的人/工具"带进来的。
 *
 * 【为什么正好打中我们】Chromium 创建渲染子进程要降低令牌、建作业对象、设置沙箱，
 * 走的正是被这些 shim 挂钩的同一条 CreateProcess 路径。
 * 一旦挂钩与沙箱初始化冲突，子进程就创建失败 —— 而 Chromium 只会给出一个结果码
 * （render-process-gone: launch-failed, exitCode=18），表现得就是"主进程一切正常、
 * 所有窗口一片空白"。这解释了为什么 Electron 33 与 39 表现完全一致。
 *
 * 【处置】在**创建任何子进程之前**把这个继承来的兼容层清掉。
 * 只删我们进程自己的环境变量副本，不改注册表、不影响其它程序；
 * 且只在真的含有这几个 shim 时才动手，并在日志里留痕（禁止静默修改环境）。
 */
const compatLayer = process.env['__COMPAT_LAYER'] ?? '';
const COMPAT_SHIMS = /Installer|DetectorsAdminProtection|DetectorsAppHealth/i;
if (compatLayer && COMPAT_SHIMS.test(compatLayer)) {
  delete process.env['__COMPAT_LAYER'];
  logWarn(
    `[main] 已清除继承来的 Windows 兼容层：__COMPAT_LAYER="${compatLayer}"。` +
      '这些 shim（Installer / DetectorsAdminProtection）会挂钩进程创建路径，' +
      '是渲染子进程启动失败（launch-failed）的头号嫌疑；清除只影响本进程，不改系统设置。'
  );
}

/*
 * 渲染进程启动失败的兜底：`XP_NO_SANDBOX=1` 时关闭 Chromium 沙箱。
 *
 * 【为什么需要】实机取证：某些 Windows 环境下渲染子进程**根本创建不起来**，
 * Electron 只报 `render-process-gone(reason=launch-failed, exitCode=18)`——
 * 主进程一切正常（托盘/日志都在），但所有窗口都是空白、界面永远出不来。
 * 已排除：Electron 版本（33 与 39 表现一致）、管理员身份、杀软拦截、文件损坏、权限。
 * 剩下最可能的一环就是**沙箱**：Chromium 要为每个渲染进程降低令牌/设置作业对象，
 * 一旦系统策略或某个安全组件挡住这一步，子进程就创建失败。
 *
 * 【安全代价，必须如实说明】关掉沙箱会削弱渲染层隔离：渲染进程不再被限制在受限令牌里。
 * 对本应用而言风险可控——渲染层只加载**本机打包的页面**，且 SEC-002 已把窗口导航
 * 全部锁死（setWindowOpenHandler 一律 deny + will-navigate 拦截 + 外链只走协议白名单），
 * 不存在"加载任意外部网页"的路径。但它终究是降级，因此**默认不开启**：
 * 只在用户显式设置环境变量时生效，且在日志里留痕。
 */
/*
 * 触发方式有两条，缺一不可：
 *   · 环境变量 XP_NO_SANDBOX=1  —— 给"快捷方式里加环境变量"或脚本用；
 *   · 命令行 --no-sandbox       —— 给"以兼容模式重启"用（app.relaunch 只能追加参数，
 *     而 Windows 上无法给已启动的进程注入环境变量）。
 * 少了第二条，看门狗那个"以兼容模式重启"按钮就会点了没反应。
 */
const sandboxDisabledByEnv = process.env['XP_NO_SANDBOX'] === '1';
const sandboxDisabledByArg = process.argv.includes('--no-sandbox');
/*
 * 【为什么这里**不再**做"检测到提权就自动关沙箱" —— 一次被证据推翻的处置】
 *
 * 2026-09-30 曾加过这段自动降级，理由是"提权进程无法创建沙箱渲染子进程"，
 * 并把它当成界面出不来的根因。**该结论已被推翻**：
 *   · 实机日志：同一个 exe 在提权 + 沙箱开启下也能把 6 个窗口全部渲染出来
 *     （`启动自检：提权运行=是，窗口=6，渲染异常=0`）；
 *   · 而此前所有"正常"的运行，其实都是被这段自动降级**悄悄关掉了沙箱**，
 *     于是"沙箱开启是否可行"根本没被验证过 —— 自动降级把真实行为掩盖了。
 *
 * 结论：提权与沙箱都不是根因。**未经证实的降级必须撤掉** ——
 * 它削弱了渲染层隔离，却换不来任何确定性收益，还让排查失去对照。
 *
 * 现在只保留**用户显式选择**的两条降级路径（快捷方式/命令行/环境变量），
 * 并明确记录是谁让它降级的，便于事后归因：
 *   · 环境变量 XP_NO_SANDBOX=1 —— 给脚本或带环境变量的快捷方式用；
 *   · 命令行 --no-sandbox       —— 给"以兼容模式重启"与兼容模式启动器用
 *     （app.relaunch 只能追加参数，Windows 无法给已启动进程注入环境变量）。
 */
if (sandboxDisabledByEnv || sandboxDisabledByArg) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  logWarn(
    `[main] 已按用户选择关闭 Chromium 沙箱（${sandboxDisabledByEnv ? 'XP_NO_SANDBOX=1' : '--no-sandbox'}）` +
      '：渲染层隔离被削弱（页面全部来自本机安装包，窗口导航已锁死）'
  );
}

// 幽灵窗口排查开关：渲染进程反复崩溃时，用户可在 设置 → 性能与资源 禁用硬件加速（需重启）
try {
  if (dataStore().get().settings.disableGpuAccel) {
    app.disableHardwareAcceleration();
    logWarn('[main] 已按设置禁用硬件加速（渲染进程崩溃排查）');
  }
} catch (e) {
  logWarn('[main] 读取硬件加速设置失败（按默认启用）', e);
}

// 全局兜底：任何未捕获异常都记录到 stderr，便于定位启动失败（规格 6：禁止静默失败）
process.on('uncaughtException', (err) => {
  logError('[main] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logError('[main] unhandledRejection', reason);
});

if (!app.requestSingleInstanceLock()) {
  logWarn('[main] 单实例锁已被占用（存在其他运行中的小鹏工具箱实例），本实例退出');
  app.quit();
} else {
  app
    .whenReady()
    .then(() => {
      logDebug('[main] app ready，开始初始化…');
      dataStore();
      // T-10：性能守卫（窗口闲置释放 + 动画开关）需在创建窗口前接入
      installPerfWatchers();
      // 幽灵窗口防线：渲染进程崩溃/加载失败自动恢复 + 托盘“修复卡住的窗口”
      installWindowWatchdog();
      // GW-01 / OPT-14：周期性活性探测（事件不发火的冻结只能靠"看画面还在不在动"发现）
      installLivenessProbe();
      registerAssetIpc();
      registerSidebarIpc();
      registerPetIpc();
      registerModuleIpc();
      registerPluginIpc();
      registerFeaturesIpc();
      registerBoxesIpc();
      registerPaletteIpc();
      registerDeskboardIpc();
      registerClipboardIpc();
      registerMarketIpc();
      registerHotkeysIpc();
      registerCaptureIpc();
      registerBackupIpc();
      registerLlmIpc();
      registerVoiceIpc();
      registerTranslateIpc();
      registerForgeIpc();
      // T-06：UGC 宠物/皮肤主题包（制作 / 导入 / 分享）
      registerThemeIpc();
      // T-14：开发者工具面板 / 指令别名 / 检查更新
      registerToolboxIpc();
      createPetWindow();
      createSidebarWindow();
      startAutoCollapseWatch();
      applyAutostart();
      applyGlobalHotkey();
      // v2.0：桌面收纳 / 命令面板（默认关闭，规格 8）
      applyBoxesEnabled();
      applyPaletteHotkey();
      // 桌面工作台（DeskBox 式主面板）：启动即显示，热键 Ctrl+Shift+D
      applyDeskboardHotkey();
      applyDeskboardVisibility();
      // P0（T-01 / T-03 / T-04）：剪贴板监听 + 粘贴面板热键 + 托盘常驻 + 截图热键
      applyClipboardMonitor();
      applyClipboardHotkey();
      applyTray();
      applyCaptureHotkeys();
      // T-07：划词翻译 / 取词 OCR 热键（pot 模式悬浮条）
      applyTranslateHotkeys();
      // T-05：MCP 对外工具服务（设置 → 桌面宠物，默认关闭）
      applyMcpServer();
      // T-10：性能模式（动画开关 / 闲置释放）
      applyPerfMode();
      // T-14（UPD-01）：启动后延迟检查更新（≤1 次/天，失败静默，不自动下载）
      startUpdateCheck();
      // 诊断：启动时打印宠物形象的解析结果（幽灵窗口排查用；脏配置会在此被自愈清理）
      const rawPetImage = JSON.stringify(String(dataStore().get().settings.petImage ?? '').slice(0, 60));
      const resolvedPetImage = resolvePetImage();
      logDebug(`[pet] 形象解析：${resolvedPetImage}（修复前内存配置值=${rawPetImage}）`);
      if (dataStore().get().settings.hideDesktopIcons) applyHideDesktopIcons();
      // 预热应用扫描：工作台应用网格/命令面板避免首次等待 PowerShell 扫描
      void scanInstalledApps().catch(() => undefined);
      startEnabledPlugins();
      startIdleReaper();
      // B（PM-03 异步任务模型）：轮询插件后台任务进度，兼作长任务心跳
      startJobPoller();
      startReminderTimer();
      startSystemInfoPush();
      // 启动后自检：渲染进程若在本机起不来（launch-failed），必须明确告诉用户原因与处置办法，
      // 否则表现是"托盘有图标、所有窗口空白"，用户只能反复重启（实测缺陷：日志刷 12 条却无汇总）。
      setTimeout(() => checkRenderHealthAtStartup(), RENDER_HEALTH_CHECK_DELAY_MS);
    })
    .catch((e: unknown) => logError('[main] whenReady 初始化失败', e));

  app.on('second-instance', () => toggleSidebar());
  // SY-03 托盘常驻：托盘开启时关闭所有窗口不退出（主窗口已最小化到托盘）
  app.on('window-all-closed', () => {
    if (!dataStore().get().settings.trayEnabled) app.quit();
  });
  app.on('before-quit', () => {
    setQuitting();
    stopJobPoller();
    disposePlugins();
    stopClipboardMonitor();
    stopMcpServer();
    destroyCaptureWindows();
    globalShortcut.unregisterAll();
    // P2-3 修复：退出前立即落盘最后一次修改（防抖定时器不会再复活已关闭的库）
    dataStore().flush();
    closeDb();
  });
}

/** 待办提醒检查间隔（毫秒）：10 秒一次，频繁度足以满足提醒体验且开销极低 */
const REMINDER_INTERVAL = 10_000;
/** 启动自检延迟：给所有窗口一点时间完成首帧，再判断"渲染进程到底起来没有" */
const RENDER_HEALTH_CHECK_DELAY_MS = 8000;

/*
 * 渲染进程排查开关：`XP_RENDER_DEBUG=1`（或命令行 `--render-debug`）时，
 * 把 Chromium 的原始日志落到 app.log 同级目录。
 *
 * 为什么必须有：`render-process-gone(reason=launch-failed)` 意味着渲染子进程**根本没被创建起来**，
 * Electron 只给一个结果码（exitCode=18），真正的原因（沙箱初始化失败 / CreateProcess 被拦 /
 * 依赖 DLL 解析失败）只在 Chromium 自己的 stderr 里。没有这份原始日志，就只能靠猜。
 *
 * 两条触发路径都保留的原因：
 *   · 环境变量 —— 用户按文档操作时最直观（但 Windows 无法给已启动进程注入环境变量）；
 *   · 命令行   —— 让"一键重启"与快捷方式也能带上（见 R2-T3 的兼容模式重启）。
 *
 * 默认不开（会显著增大日志体积），只在需要排查时显式启用。
 */
const renderDebugEnabled =
  process.env['XP_RENDER_DEBUG'] === '1' || process.argv.includes('--render-debug');
if (renderDebugEnabled) {
  const chromiumLog = join(app.getPath('userData'), 'logs', 'chromium.log');
  app.commandLine.appendSwitch('enable-logging', 'file');
  app.commandLine.appendSwitch('log-file', chromiumLog);
  // 只开到 v=1：再高会把每帧日志都写出来，几十兆的噪音反而盖住真正的失败原因
  app.commandLine.appendSwitch('v', '1');
  logWarn(`[main] 已启用渲染进程排查日志 → ${chromiumLog}`);
}

/**
 * 启动自检：本机渲染进程集体起不来时，一次性说清楚（而不是让看门狗刷日志、刷通知）。
 *
 * 触发场景（实测）：Windows 上渲染子进程被拦（杀毒软件 / 受控文件夹访问 / 沙箱策略），
 * Electron 报 `render-process-gone(reason=launch-failed, exitCode=18)`，主进程一切正常但没有任何界面。
 * 这类故障**重载修不好**，因此这里只做两件事：日志里给出汇总与指引 + 一条用户可见的通知。
 */
function checkRenderHealthAtStartup(): void {
  try {
    const h = renderHealthSummary();
    const elevated = isProcessElevated();
    /*
     * 只把提权当作**诊断信息**，不再据此报警。
     *
     * 教训（2026-09-30）：先前把"提权"直接当成"界面出不来的根因"并打 ERROR，
     * 结果实测出现过"同一进程既报提权、窗口又全部正常"的自相矛盾 —— 假警报比不报更糟。
     * 现在只有当**渲染进程真的异常**时，才把提权作为可疑因素一并列出；
     * 窗口正常时最多留一行 DEBUG，不打扰用户。
     */
    logDebug(`[main] 启动自检：提权运行=${elevated ? '是' : '否'}，窗口=${h.windows}，渲染异常=${h.crashed}`);
    if (h.ok) {
      logDebug(`[main] 启动自检：${h.windows} 个窗口渲染进程正常`);
      return;
    }
    logError(
      `[main] 启动自检失败：${h.crashed}/${h.windows} 个窗口的渲染进程未启动成功（launch-failed）。` +
        `提权运行=${isProcessElevated() ? '是（提权进程可能无法创建沙箱子进程，可作为可疑因素）' : '否'}。` +
        '看门狗已进入熔断态；若未弹出"以兼容模式重启"对话框，请用程序目录下的「启动-兼容模式(关沙箱).bat」启动。'
    );
    // 熔断已负责弹原生对话框（那比通知更可靠），这里只在**熔断未触发**时补一条通知兜底
    if (h.crashed === h.windows && !isRendererLaunchBroken() && Notification.isSupported()) {
      new Notification({
        title: '小鹏工具箱',
        body: '界面进程无法启动。请查看弹出的对话框，或手动用 --no-sandbox 参数重启；详见日志 logs/app.log。'
      }).show();
    }
  } catch (e) {
    logWarn('[main] 启动自检异常（忽略）', e);
  }
}
/** 系统信息推送间隔（毫秒）：与需求文档一致为 2 秒，且仅在侧边栏可见时触发 */
const SYSTEM_INFO_PUSH_INTERVAL = 2_000;

function startReminderTimer(): void {
  setTimeout(checkReminders, 3000);
  setInterval(checkReminders, REMINDER_INTERVAL);
}

let pushingSystemInfo = false;

function startSystemInfoPush(): void {
  setInterval(() => {
    // 侧边栏隐藏时跳过采集，避免 wmic/PowerShell 子进程空转
    if (pushingSystemInfo || !isSidebarVisible()) return;
    pushingSystemInfo = true;
    getSystemInfo()
      .then((info) => {
        if (info) sidebarWindow()?.webContents.send('system:info:push', info);
      })
      .catch((e: unknown) => logWarn('[main] 系统信息推送失败', e))
      .finally(() => {
        pushingSystemInfo = false;
      });
  }, SYSTEM_INFO_PUSH_INTERVAL);
}

function checkReminders(): void {
  const now = Date.now();
  const fired: TodoItem[] = [];
  /*
   * P3-6 修复：只有"真的有提醒触发"时才写库。
   *
   * 旧实现无条件调用 dataStore().update()，而 update() = 全量 persistAll()（先删后插整表）
   * + 向所有窗口广播整个 AppData —— 每 10 秒一次，纯属空转；
   * 更糟的是设置页正在编辑、尚未失焦的输入框会被这次广播"回滚"成已保存值。
   * 现在先只读扫描，命中后再走一次 update。
   */
  const collect = (d: AppData): TodoItem[] => {
    const hit: TodoItem[] = [];
    for (const m of d.modules) {
      if (m.type !== 'todo_list') continue;
      const items = (m.config.items ?? []) as TodoItem[];
      for (const item of items) {
        if (!item.reminderAt || item.done || item.notified || item.reminderAt > now) continue;
        hit.push({ ...item });
      }
    }
    return hit;
  };
  const pending = collect(dataStore().get());
  if (!pending.length) return;
  const ids = new Set(pending.map((t) => t.id));
  dataStore().update((d) => {
    for (const m of d.modules) {
      if (m.type !== 'todo_list') continue;
      const items = (m.config.items ?? []) as TodoItem[];
      for (const item of items) {
        if (ids.has(item.id)) {
          item.notified = true;
          fired.push({ ...item });
        }
      }
    }
  });
  for (const item of fired) {
    if (item.remindType === 'pet') {
      playAction('nod');
      notifyPet(`待办提醒：${item.text}`);
      if (!petWindow()?.isVisible()) {
        new Notification({ title: '小鹏工具箱', body: `待办提醒：${item.text}` }).show();
      }
    }
    sidebarWindow()?.webContents.send('todo:fired', item.text);
  }
}
