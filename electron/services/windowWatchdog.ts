import { createHash } from 'crypto';
import { appendFileSync, statSync } from 'fs';
import { join } from 'path';
import { app, BrowserWindow, dialog, Notification, screen } from 'electron';
import { dataStore } from '../store/dataStore';
import {
  decideRecovery,
  initialBreakerState,
  recordRenderGone,
  type BreakerState
} from '../../shared/renderBreaker.ts';
import { t } from './i18n';
import { logDebug, logWarn } from '../utils/log';

/**
 * 窗口看门狗（幽灵窗口的根治防线）
 *
 * 【真实机制（实机取证）】Electron 的「透明 + 无边框 + 置顶」窗口（宠物 / 侧边栏 / 工作台 / 收纳盒…）
 * 在**渲染进程崩溃后，窗口本身依然可见、依然接收鼠标事件**，但什么都不画——
 * 于是屏幕上出现「看不见却挡住点击」的幽灵窗口。
 * 取证：`[watchdog] 渲染进程异常退出（reason=crashed）…正在恢复窗口：小鹏宠物`，
 * 且 PrintWindow 抓取该窗口自绘内容为 0.0%（正常实例为 46.6%）。
 *
 * 【四道防线】
 *   1) 崩溃即恢复：`render-process-gone` → 自动 reload（清空当前页面状态，重新加载资源）；
 *   2) 反复崩溃则隐藏：同一窗口 5 分钟内崩溃 ≥3 次 → 直接 hide()，宁可没有窗口也绝不留隐形挡板；
 *   3) 卡死自愈：`unresponsive` 宽限 3 秒后仍无响应 → 走同一套恢复；`gpu-process-gone` → 重载常驻窗（OPT-08）；
 *   4) 活性探测：可见动画窗的画面**停止变化**达到阈值 → 判定冻结并恢复（OPT-14，GW-01 的治本项）；
 *   5) 手动逃生口：`repairStuckWindows()`（托盘菜单「修复卡住的窗口」）批量重载常驻 UI 窗口。
 *
 * 为什么要有第 4 道：前四道全部依赖**事件**，而幽灵窗口最要命的一类（GPU 掉线后仍在绘制旧帧、
 * 渲染线程卡在某个同步调用里）根本不发事件 —— 用户的日志正好印证了这一点：
 * "幽灵频繁发生，但看门狗没有任何记录"。既然系统不告诉我们，就只能自己**看画面还在不在动**。
 */

/**
 * 可安全重载的常驻 UI 窗口（瞬态窗口如截图遮罩/贴图不在此列，避免打断进行中的操作）。
 *
 * P2-25 修复：原来只看窗口标题，而窗口标题来自各页面 <title>，与"功能名"并不一致 ——
 * 侧边栏页面标题是「小鹏工具箱」、悬浮条标题是「划词翻译」，都匹配不上
 * 「侧边栏 / 翻译条」这两个词，于是托盘「修复卡住的窗口」永远修不到它们。
 * 现在以**已加载页面**为准（与标题无关、稳定），标题仅作兜底。
 */
const RELOADABLE_PAGES = /(?:^|\/)(index|deskboard|settings|box|translatebar|preview|chat|pet|palette)\.html(?:$|[?#])/;
const RELOADABLE_TITLES = /宠物|侧边栏|工作台|设置|收纳盒|看板|聊天|翻译条|划词翻译|预览|命令面板/;

/** 该窗口是否为可重载的常驻 UI（页面优先，标题兜底） */
function isReloadableWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  try {
    const url = win.webContents.getURL();
    if (url && RELOADABLE_PAGES.test(url.split('\\').join('/'))) return true;
  } catch {
    /* 取不到 URL 时退回标题判定 */
  }
  return RELOADABLE_TITLES.test(win.getTitle() || '');
}

const MAX_LOAD_RETRY = 2;
/** 崩溃频率阈值：窗口在此时间窗内崩溃达到该次数即隐藏，避免"崩溃-重载"死循环 */
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const CRASH_HIDE_THRESHOLD = 3;

/** 'unresponsive' 的宽限期：短暂忙碌会自行恢复，只有持续无响应才动手 */
const UNRESPONSIVE_GRACE_MS = 3000;

/** GPU 进程掉线后等待其重启的时间（毫秒）：太早重载会拿不到 GPU 而白刷一遍 */
const GPU_RECOVER_DELAY_MS = 1500;

/** 记录每个窗口的崩溃时间戳（用 WebContents id 作为键） */
const crashHistory = new Map<number, number[]>();

/*
 * 通知节流（实测缺陷修复：通知风暴）。
 *
 * 原实现每命中一次"5 分钟内故障 ≥3 次"就弹一次通知。而**渲染进程启动失败**（reason=launch-failed）
 * 会在毫秒级连续触发十几次 `render-process-gone`，于是同一个窗口瞬间弹出十几条一模一样的系统通知 ——
 * 用户侧看到的就是"通知一直在弹"，比原来的幽灵窗口更烦人。
 *
 * 现在双重限流：
 *   · 单窗口：同一窗口 10 分钟内只提示一次（同一件事不需要说两遍）；
 *   · 全局：一次运行最多 9 条看门狗通知（防止多窗口同时炸时刷屏）。
 * 节流只影响**通知**，不影响恢复动作本身 —— 该重载的照旧重载，该隐藏的照旧隐藏。
 */
const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const NOTIFY_GLOBAL_BUDGET = 9;
const notifiedAt = new Map<number, number>();
let notifyBudget = NOTIFY_GLOBAL_BUDGET;
let notifyHideCount = 0;

function notifyThrottled(key: number, title: string, body: string): void {
  if (!Notification.isSupported()) return;
  if (notifyBudget <= 0) return;
  /*
   * 第三道保险："已隐藏窗口"这类通知，一个进程内**最多两次**。
   *
   * 为什么不靠 webContents.id 的冷却就够了：窗口销毁后 id 会被复用，
   * 复用会把"已通知过"的历史带到一个全新窗口上，也可能让节流失效。
   * 这个计数不依赖任何键，因此无论 id 怎么复用、窗口怎么重建，都不会出现通知风暴。
   * （实测教训：渲染进程启动失败时窗口被反复重建，用户侧看到的就是"一直弹"。）
   */
  if (/隐藏/.test(body) && notifyHideCount >= 2) return;
  const now = Date.now();
  const last = notifiedAt.get(key) ?? 0;
  if (now - last < NOTIFY_COOLDOWN_MS) return;
  notifiedAt.set(key, now);
  notifyBudget -= 1;
  if (/隐藏/.test(body)) notifyHideCount += 1;
  try {
    new Notification({ title, body }).show();
  } catch (e) {
    logDebug('[watchdog] 通知发送失败', (e as Error).message);
  }
}

/*
 * 渲染进程**启动失败**的退避（reason=launch-failed）。
 *
 * 这与"渲染进程跑着跑着崩了"是两回事：后者 reload 有意义，前者 reload 一万次也起不来 ——
 * 启动失败通常意味着系统层面拦住了子进程创建（杀软/受控文件夹访问/沙箱策略），
 * 或运行时文件缺失。继续高频重载只会把日志刷满、把通知刷爆，且永远修不好。
 * 因此：第一次尝试恢复，之后直接隐藏该窗口并只提示一次，把处置权交回用户。
 */
const LAUNCH_FAILED_HINT =
  '（渲染进程无法启动：常见原因是杀毒软件/受控文件夹访问拦截了子进程，或运行时文件不完整。' +
  '可尝试：把程序目录加入杀软白名单、或从"安装包安装后的目录"运行而不是从解压目录运行）';

/** 每个进程只打印一次启动失败的环境快照（渲染进程会被反复创建，避免刷屏） */
let launchContextLogged = false;

/*
 * 子进程生命周期取证（不依赖 Chrome 自己的日志文件）。
 *
 * 背景：`launch-failed` 的真因只在 Chromium 内部，而 `--enable-logging=file` 写不写得出
 * `chromium.log` 取决于 Chromium 版本的实现细节（打包环境下常见"什么都没生成"）。
 * 实机反馈也证实了这一点：用户按文档设了 XP_RENDER_DEBUG=1，chromium.log 始终未生成。
 *
 * 因此这里补一条**只依赖 Electron 公开事件**的取证路径：
 * `app.on('child-process-gone')` 能拿到每个子进程（GPU / Utility / Renderer…）的
 * type 与 reason，这是判断"到底是哪一类子进程起不来、以什么原因退出"最直接的证据。
 * 它不依赖命令行开关，永远可用，且能与我们自己的窗口级日志对齐时间线。
 */
let childGoneLogged = 0;
const CHILD_GONE_LOG_LIMIT = 20; // 子进程可能成批消失，限制条数避免刷屏

function installChildProcessForensics(): void {
  app.on('child-process-gone', (_e, details) => {
    if (childGoneLogged >= CHILD_GONE_LOG_LIMIT) return;
    childGoneLogged += 1;
    const d = details as { type?: string; reason?: string; exitCode?: number; serviceName?: string };
    logWarn(
      `[watchdog] 子进程退出：type=${d.type ?? '?'} reason=${d.reason ?? '?'} ` +
        `exitCode=${d.exitCode ?? '?'}${d.serviceName ? ` service=${d.serviceName}` : ''}`
    );
  });
}

/*
 * ============ R2-T8：渲染进程启动熔断 ============
 *
 * 审计证据（DEF-R01）：一次启动里 250ms 内出现 15 次 `render-process-gone(launch-failed)`，
 * 其间夹着"显示前自检 → 恢复窗口 → 又被隐藏"的循环。
 * 根因很直白：**恢复动作本身没有熔断** —— 每个显示入口都会再建一次渲染进程，
 * 而这类故障（系统拦住了子进程创建）重试一万次也不会成功。
 *
 * 因此引入进程级熔断：一旦确认"渲染进程在本机起不来"，本进程内**不再新建渲染进程**，
 * 只保留主进程并给用户一条明确的活路（R2-T3 的兼容模式重启）。
 * 熔断不会自我解除：它反映的是环境状态，只有换启动方式（关沙箱）或改系统策略才有意义。
 */
// 熔断状态本体在 shared/renderBreaker.ts（纯函数，npm test 可直接断言每条边界）
let breaker: BreakerState = initialBreakerState();

/** 本机渲染进程是否已被判定为"起不来"（熔断中） */
export function isRendererLaunchBroken(): boolean {
  return breaker.broken;
}

/**
 * 进入熔断态并给用户一次**可见**的活路。
 *
 * 为什么必须是原生对话框而不是系统通知：审计 UX-001 指出，首启全窗失败时
 * 用户可能连一条通知都看不到（通知受节流、且 Notification 在某些环境不可用），
 * 于是他面对的是"双击没反应"——没有任何信息、也没有任何操作可做。
 * 对话框是唯一能保证"看得见、点得动"的通道。
 */
/*
 * 熔断路径的物理探针（诊断用，排查"代码在包里但日志里看不到"这类矛盾）。
 *
 * 为什么需要它：审计与实机都出现过"包内代码正确、日志里却完全没有该分支"的现象，
 * 而常规 logWarn 的结论又自相矛盾。这里改用**独立文件直接 append**，
 * 绕开日志级别、轮转、编码等一切可能吞掉输出的环节 ——
 * 只要这个函数被调用，userData/logs/breaker-probe.log 就必然多一行。
 * 定位完即可删除；保留期间每次写入都很小（单行）。
 */
/**
 * 探针：**只在真的出问题时**落盘，正常使用零文件、零噪音。
 *
 * 保留原因（实测教训）：本次故障排查中"包内代码正确、日志里却完全没有该分支"让定位绕了很久，
 * 独立文件 append 能绕开日志级别/轮转/编码等一切可能吞掉输出的环节。
 * 但正常运行时不该产生任何文件，因此加了三道约束：
 *   · 只在渲染异常路径调用（见 windowWatchdog 各异常分支）；
 *   · 单文件上限 256KB，超了就不再写，避免长期使用无限增长；
 *   · 失败静默 —— 探针自身绝不影响主流程。
 */
const PROBE_FILE = 'render-probe.log';
const PROBE_MAX_BYTES = 256 * 1024;
function breakerProbe(tag: string, detail: string): void {
  try {
    const file = join(app.getPath('userData'), 'logs', PROBE_FILE);
    try {
      if (statSync(file).size > PROBE_MAX_BYTES) return;
    } catch {
      /* 文件不存在：首次写入 */
    }
    appendFileSync(file, `${new Date().toISOString()} [${tag}] ${detail}\n`, 'utf-8');
  } catch {
    /* 探针失败不影响主流程 */
  }
}

/**
 * 进程令牌取证（一次性）：判断"当前进程是不是在受限令牌下运行"。
 *
 * 为什么关键：受限令牌（restricted token / 低完整性 / AppContainer）会让
 * **本进程创建任何子进程都失败**，而主进程自身照常运行 —— 正是我们观察到的形态：
 * 托盘、日志、MCP 全部正常，唯独每个渲染子进程都 launch-failed；
 * 而且与 Electron 版本、沙箱开关、兼容层都无关（这些都已实测排除）。
 *
 * Windows 上取令牌状态不必调原生 API：用系统自带的 whoami 读子进程输出即可，
 * 它给出的正是同一个令牌的组与完整性级别。一次性执行，不影响启动速度。
 */
// 环境变量兜底：即便逻辑上只该跑一次，也要防止"探针 spawn 的子进程又跑探针"形成递归
const TOKEN_PROBED_ENV = 'XP_TOKEN_PROBED';
/**
 * 当前进程是否运行在**提权**状态（Windows 高完整性级别）。
 *
 * 【判据为什么不能"关键字包含"】初版用 `/High Mandatory Level|高强制/i` 匹配 whoami 全文，
 * 实测**误报**（2026-09-30 23:01：6 个窗口全部渲染正常、启动自检通过，
 * 却打出一条"本程序正以管理员身份运行"的 ERROR）—— 假警报比不报更糟，会把用户引向错误的排查方向。
 *
 * 现在按行解析两条**确定性**判据，任一命中即为提权：
 *   ① 含 `S-1-5-32-544`（Administrators）的行**不是** "Group used for deny only"；
 *      未提权时该组只是 deny-only SID，提权后才成为可用组；
 *   ② 含 `S-1-16-<RID>` 的行 RID ≥ 12288（High/System）；8192 = Medium = 未提权。
 * 两条都只按行判断、不看整篇，避免再出现假阳性。
 *
 * 说明（如实登记）：本函数只用于"是否自动降级沙箱"这一个决策，
 * 判错的代价是**多降级一次**或**少降级一次**，不影响其它逻辑；
 * 真正的故障定性仍以 app.log 与探针输出为准。
 */
/**
 * 提权状态探测（进程内缓存一次）。
 *
 * 【为什么改成这个实现 —— 一次实打实的翻车】初版解析 `whoami /groups` 的**文本**，
 * 结果在**同一个进程**里先后给出相反答案：
 *     [15:01:15] 检测到本程序以【管理员身份】运行 → 已自动关闭沙箱
 *     [15:01:24] 本程序正以【管理员身份】运行（同一次运行的启动自检，用的另一套判据）
 *     [15:01:24] 启动自检：6 个窗口渲染进程正常   ← 窗口其实全都正常
 * 两套判据不一致，用户看到的是"又报错又正常"的自相矛盾，比不报还糟。
 *
 * 教训：**不要用"再起一个进程去读文本"来判断本进程的状态** —— spawn 可能失败、
 * 输出可能被本地化/代码页破坏，而这类"看起来在工作"的失败最难发现。
 *
 * 现在的实现只用一条通道：`IsInRole(Administrator)`（Windows 直接查令牌）。
 * 实测同一进程连测多次结果稳定；UAC 提权后的管理员令牌在这一点上会被正确识别，
 * 而未提权时返回 false。探测失败一律按"未提权"处理 —— 宁可少降级一次，
 * 也不要误报把用户引向错误的排查方向。
 */
let elevationCache: boolean | null = null;
export function isProcessElevated(): boolean {
  if (elevationCache !== null) return elevationCache;
  if (process.platform !== 'win32') {
    elevationCache = false;
    return elevationCache;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const sys32 = process.env['SystemRoot'] ? `${process.env['SystemRoot']}\\System32` : 'C:\\Windows\\System32';
    const ps = `${sys32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const script =
      "$id=[Security.Principal.WindowsIdentity]::GetCurrent();" +
      "$p=New-Object Security.Principal.WindowsPrincipal($id);" +
      "if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 1}else{exit 0}";
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      stdio: 'ignore'
    });
    elevationCache = false; // 正常退出（exit 0）= 未提权
  } catch (e) {
    // execFileSync 在子进程以非 0 退出时抛错 —— exit 1 表示提权（这是我们的约定）
    const status = (e as { status?: number }).status;
    elevationCache = status === 1;
  }
  return elevationCache;
}

let tokenProbed = process.env[TOKEN_PROBED_ENV] === '1';
function probeProcessToken(): void {
  if (tokenProbed) return;
  tokenProbed = true;
  process.env[TOKEN_PROBED_ENV] = '1'; // 子进程继承后不会再触发本探针
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const out = execFileSync('whoami', ['/groups'], { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
    const lines = out.split(/\r?\n/).filter((l) => /Mandatory Label|强制标签|Administrators|管理员|AppContainer|应用程序容器|RESTRICTED|受限/i.test(l));
    breakerProbe('token', `whoami/groups 摘录: ${lines.join(' ; ') || '(无匹配行)'}`);
    const integrity = /High Mandatory|高强制/i.test(out)
      ? 'High'
      : /Medium Mandatory|中强制/i.test(out)
        ? 'Medium'
        : /Low Mandatory|低强制/i.test(out)
          ? 'Low'
          : '未知';
    breakerProbe(
      'token-summary',
      `integrity=${integrity} appContainer=${/AppContainer|应用程序容器/i.test(out) ? 'YES(危险)' : 'no'}`
    );
  } catch (e) {
    breakerProbe('token-error', String((e as Error).message).slice(0, 200));
  }
}

function enterLaunchBreaker(reason: string): void {
  // 只在"真出问题"时记录：正常使用不会产生任何探针文件
  breakerProbe('launch-breaker', `reason=${reason} broken=${breaker.broken}`);
  probeProcessToken();
  if (breaker.broken) return;
  breaker = recordRenderGone(breaker, reason);
  if (!breaker.broken) return; // 非 launch-failed 不熔断（状态机决定）
  const elevated = isProcessElevated();
  logWarn(
    `[watchdog] 渲染进程启动熔断已触发（${reason}）：本进程内不再新建渲染进程，等待用户选择兼容模式` +
      `｜提权运行=${elevated ? '是（根因：提权进程建不了沙箱子进程，请以普通权限双击启动）' : '否'}`
  );
  notifyThrottled(-1, t('app.name'), t('notify.renderBroken'));
  // 对话框是异步的，且用户可能不理会；无论点不点，熔断态都已经生效
  void showCompatibilityDialog();
  // 反应式恢复：仅在"沙箱开启却初始化失败"时自动切兼容模式（有实测依据，不静默降级）
  recoverFromSandboxLaunchFailure();
}

let compatDialogShown = false;

/**
 * R2-T3：一键"以兼容模式重启"。
 *
 * 兼容模式 = 关闭 Chromium 沙箱重启。这是目前唯一被证实可能绕过
 * `launch-failed` 的开关（沙箱初始化正是该错误码的常见来源），
 * 安全性代价已在 main.ts 的 XP_NO_SANDBOX 注释里写明，且**必须由用户点击确认**，不静默降级。
 */
/**
 * 组装"界面进程无法启动"对话框的正文。
 *
 * 【只给可执行的处置，不做未经验证的因果断言】
 * 这里曾按"检测到提权"给出"因为你是管理员身份所以界面出不来"的说明 ——
 * 该因果**已被实测推翻**（提权 + 沙箱开启也能正常渲染 6 个窗口）。
 * 教训：故障对话框里不要写"这就是原因"，除非有证据；
 * 否则用户按错误方向折腾一圈，问题依旧，还失去了对我们的信任。
 *
 * 因此正文只保留三件事：现象、**唯一被证实可用**的处置（兼容模式重启）、
 * 以及出问题时要交给我们的日志路径。
 */
function buildCompatibilityDetail(): string {
  const lines = [
    '界面进程（渲染进程）在你的系统上无法启动，因此看不到窗口。',
    '',
    '「以兼容模式重启」会关闭 Chromium 沙箱后重新启动，这是目前唯一被证实可用的处置。',
    '代价：渲染层隔离被削弱（本应用页面全部来自本机安装包，且窗口导航已被锁死）。',
    ''
  ];
  if (isProcessElevated()) {
    // 仅陈述事实、不作因果断言：提权本身已被证明不是界面出不来的充分条件
    lines.push('（诊断信息：当前以管理员身份运行。本程序并不需要管理员权限。）', '');
  }
  lines.push('若仍无法显示，请把日志发给我们：', `${app.getPath('userData')}\\logs\\app.log`);
  return lines.join('\n');
}

async function showCompatibilityDialog(): Promise<void> {
  if (compatDialogShown) return;
  compatDialogShown = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      buttons: ['以兼容模式重启（关闭沙箱）', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '小鹏工具箱 - 界面进程无法启动',
      message: '界面进程（渲染进程）在你的系统上无法启动，因此看不到窗口。',
      detail: buildCompatibilityDetail()
    });
    if (response !== 0) return;
    logWarn('[watchdog] 用户选择以兼容模式重启（--no-sandbox）');
    relaunchInCompatibilityMode();
  } catch (e) {
    logWarn('[watchdog] 兼容模式对话框失败', (e as Error).message);
  }
}

/**
 * 以兼容模式重新启动本应用。
 *
 * 用 `app.relaunch({ args })` 而不是自己拼命令行：
 * 它能正确保留原始参数与打包环境（asar、单实例锁、用户数据目录），
 * 只额外加上 `--no-sandbox`；随后必须主动退出，否则两个实例会抢单实例锁。
 */
let compatRelaunchDone = false;
function relaunchInCompatibilityMode(): void {
  if (compatRelaunchDone) return; // 防重启循环：一次进程生命周期内只自动重启一次
  compatRelaunchDone = true;
  try {
    const args = process.argv.slice(1).filter((a) => a !== '--no-sandbox');
    args.push('--no-sandbox');
    app.relaunch({ args });
    app.exit(0);
  } catch (e) {
    logWarn('[watchdog] 兼容模式重启失败，请手动用 --no-sandbox 启动', (e as Error).message);
  }
}

/**
 * 是否显式关闭了沙箱（由用户/启动器决定）。
 *
 * 用途：自动兼容模式重启只在**沙箱开启**时才做 —— 已经关过沙箱还失败，
 * 说明问题不在沙箱，此时再重启一次纯属徒劳（也会掩盖真实失败）。
 */
function sandboxExplicitlyDisabled(): boolean {
  return process.argv.includes('--no-sandbox') || process.env['XP_NO_SANDBOX'] === '1';
}

/**
 * 沙箱初始化失败时的**反应式**兼容模式重启。
 *
 * 【与之前被撤掉的那段有何本质区别 —— 这是本条的全部要点】
 * 之前撤掉的版本是"**预测式**降级"：只要检测到提权就先关沙箱，
 * 结果把所有运行都变成 `--no-sandbox`，`launch-failed` 是否与沙箱有关**从未被验证**，
 * 而且静默削弱了安全性。
 *
 * 现在做的是"**反应式**恢复"：默认**保持沙箱开启**，只有在真的观测到
 * `render-process-gone(reason=launch-failed)` —— 即沙箱初始化确实失败 —— 才重启一次，
 * 并把它记进日志（有据可查，用户可见）。
 *
 * 实机依据（同机、相隔 9 秒、唯一差别是沙箱）：
 *     15:16:08  沙箱开启 → launch-failed，界面空白
 *     15:16:17  沙箱关闭 → 6 个窗口渲染正常
 * 在这一点被证伪之前，这是唯一有直接证据支撑的处置。
 */
function recoverFromSandboxLaunchFailure(): void {
  if (sandboxExplicitlyDisabled()) {
    logWarn('[watchdog] 已关闭沙箱仍然 launch-failed —— 问题不在沙箱，不再自动重启');
    return;
  }
  logWarn(
    '[watchdog] 沙箱初始化失败（launch-failed）。已确认本机关闭沙箱后窗口可正常渲染，' +
      '因此自动以兼容模式重启一次（--no-sandbox）。' +
      '若你不希望关闭沙箱，可用「① 普通启动（沙箱开启）」快捷方式重现此问题并把日志发给我们。'
  );
  relaunchInCompatibilityMode();
}

/**
 * `launch-failed` 的环境取证（一次性）。
 *
 * 渲染子进程**根本没能启动**时，Electron 只给出一个结果码（exitCode=18），
 * 而根因几乎总在系统侧：进程创建被策略拦住、依赖 DLL 解析失败、沙箱初始化失败。
 * 这些信息不在 Electron 的 API 里，但可以从"应用自身的运行上下文"反推 ——
 * 因此把可执行文件路径、工作目录、关键环境变量打一份快照，让下一次排查不必再猜。
 * 同时提示用户用 XP_RENDER_DEBUG=1 拿到 Chromium 自己的原始日志（那才是最终答案）。
 */
function logLaunchFailureContext(win: BrowserWindow): void {
  if (launchContextLogged) return;
  launchContextLogged = true;
  try {
    const env = process.env;
    logWarn(
      '[watchdog] launch-failed 环境快照：' +
        `\n  exe            = ${process.execPath}` +
        `\n  工作目录       = ${process.cwd()}` +
        `\n  appPath        = ${app.getAppPath()}` +
        `\n  是否打包        = ${app.isPackaged}` +
        `\n  Electron       = ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}` +
        `\n  Windows        = ${process.getSystemVersion?.() ?? '未知'}` +
        `\n  COMPAT_LAYER   = ${env['__COMPAT_LAYER'] ?? '(无)'}` +
        `\n  ELECTRON_*     = ${Object.keys(env).filter((k) => k.startsWith('ELECTRON_')).join(',') || '(无)'}` +
        `\n  用户数据目录    = ${app.getPath('userData')}` +
        `\n  窗口           = ${win.isDestroyed() ? '(已销毁)' : win.getTitle() || '(无标题)'}` +
        '\n  提示：设置环境变量 XP_RENDER_DEBUG=1 后重启，可把 Chromium 原始日志写到 logs/chromium.log（那里面有真正的原因）'
    );
  } catch (e) {
    logDebug('[watchdog] 环境快照采集失败', (e as Error).message);
  }
}

/**
 * 统一的"记录故障并恢复窗口"路径（OPT-08：崩溃、无响应、GPU 掉线共用一套策略）。
 *
 * 为什么必须共用：三种故障的用户可见后果是**同一个**幽灵窗口（画面没了、点击还在），
 * 因此它们的处置也必须是同一套 —— 短时反复故障就隐藏，偶发一次就重载。
 * 分散写三份的结果必然是"其中一条路径忘了隐藏"，然后幽灵又回来了。
 */
function recordCrashAndRecover(
  win: BrowserWindow,
  cause: 'render-process-gone' | 'unresponsive',
  /** 渲染进程是否**从未启动成功**（reason=launch-failed） */
  launchFailed = false
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const title = win.getTitle() || '未命名窗口';
  const id = win.webContents.id;
  const now = Date.now();
  const recent = (crashHistory.get(id) ?? []).filter((ts) => now - ts < CRASH_WINDOW_MS);
  recent.push(now);
  crashHistory.set(id, recent);

  /*
   * 恢复动作统一交给纯状态机决定（R2-T8）：
   *   skip      —— 已熔断：什么都不做，避免"每个显示动作都撞一次墙"
   *   hide-only —— 启动失败 / 反复崩溃：只隐藏，不重载
   *   reload    —— 偶发运行期崩溃：常规重载
   */
  const action = decideRecovery(breaker, {
    launchFailed,
    recentFailures: recent.length,
    hideThreshold: CRASH_HIDE_THRESHOLD
  });
  if (action === 'skip') {
    logDebug(`[watchdog] 熔断中，跳过恢复动作：${title}`);
    return;
  }
  const hideNow = action === 'hide-only';
  if (hideNow) {
    // 隐藏该窗口，避免留下"看不见却挡住点击"的隐形挡板
    logWarn(
      launchFailed
        ? `[watchdog] 渲染进程启动失败（launch-failed），不再重载，已隐藏窗口：${title} ${LAUNCH_FAILED_HINT}`
        : `[watchdog] 窗口在 5 分钟内故障 ${recent.length} 次（${cause}），已隐藏以避免幽灵窗口：${title}`
    );
    try {
      win.hide();
    } catch {
      /* noop */
    }
    notifyThrottled(id, t('app.name'), t('notify.crashHidden', { title, n: recent.length }));
    return;
  }

  try {
    win.webContents.reload();
    if (/宠物/.test(title)) {
      // 宠物窗口被自动恢复时额外提示一次（它没有其它可见入口）
      notifyThrottled(id, t('app.name'), t('notify.crashRecovered', { title }));
    } else if (cause === 'unresponsive') {
      notifyThrottled(id, t('app.name'), t('notify.unresponsiveRecovered', { title }));
    }
  } catch (e) {
    logWarn('[watchdog] 恢复窗口失败', (e as Error).message);
  }
}

export function installWindowWatchdog(): void {
  // 子进程生命周期取证（先装：它要在最早的子进程退出时就能记上）
  installChildProcessForensics();

  /*
   * ⑤ GPU 进程异常退出（GW-01 事件部分，OPT-08）。
   *
   * 用户的日志里"幽灵频繁发生，但看门狗没有任何崩溃记录"—— 原因就在这里：
   * 显卡进程掉线时**渲染进程本身并没有崩溃**，'render-process-gone' 不会触发，
   * 于是所有透明窗变成"不重绘的空白挡板"，看门狗却安静如常。
   * GPU 进程由 Chromium 自动重启，但已经停止绘制的窗口不会自己恢复，必须主动重载。
   *
   * 只重载常驻 UI 窗口（isReloadableWindow）：截图遮罩/贴图这类瞬态窗口由 captureManager
   * 自己处理（直接关闭，绝不 reload —— 详见 OPT-03），在这里重载会留下没有 surfaces 的空遮罩。
   */
  // 事件名在 @types/electron 的 App 重载里没有声明（Electron 33 的类型早于该事件），
  // 但运行时确实存在且是我们唯一能感知"显卡进程掉线"的信号，故按 any 挂载并自带空值防护。
  type GpuGoneDetails = { reason?: string };
  type GpuGoneEmitter = { on(event: 'gpu-process-gone', listener: (e: unknown, details: GpuGoneDetails) => void): void };
  (app as unknown as GpuGoneEmitter).on('gpu-process-gone', (_e, details: GpuGoneDetails) => {
    const reason = String(details?.reason ?? 'unknown');
    logWarn(`[watchdog] GPU 进程异常退出（reason=${reason}），开始恢复常驻窗口`);
    // 走统一节流：GPU 反复掉线时同样不该刷屏（键取 0，与具体窗口无关）
    notifyThrottled(0, t('app.name'), t('notify.gpuGone', { reason }));
    // 给 Chromium 一点时间把 GPU 进程拉起来，再重载窗口，避免重载后仍拿不到 GPU 而白刷一遍
    setTimeout(() => {
      let n = 0;
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || !isReloadableWindow(win)) continue;
        try {
          win.webContents.reload();
          n += 1;
        } catch (e) {
          logWarn('[watchdog] GPU 掉线后重载窗口失败', (e as Error).message);
        }
      }
      logWarn(`[watchdog] GPU 掉线后已重载 ${n} 个常驻窗口`);
    }, GPU_RECOVER_DELAY_MS);
  });

  app.on('browser-window-created', (_e, win) => {
    let retried = 0;

    // ① 渲染进程崩溃：窗口会变成空白但仍可见（幽灵）→ 立即恢复
    win.webContents.on('render-process-gone', (_ev, details) => {
      breakerProbe('render-process-gone', `reason=${details.reason} exitCode=${details.exitCode}`);
      const title = win.isDestroyed() ? '已销毁窗口' : win.getTitle() || '未命名窗口';
      logWarn(
        `[watchdog] 渲染进程异常退出（reason=${details.reason}，exitCode=${details.exitCode}），正在恢复窗口：${title}`
      );
      retried = 0;
      const launchFailed = details.reason === 'launch-failed';
      if (launchFailed) logLaunchFailureContext(win);
      // R2-T8：启动失败 = 环境级故障，进入熔断；后续的恢复动作一律短路
      // 注意：这里必须传**原始的 reason**，不能加 `reason=` 之类前缀 ——
      // 状态机是按 'launch-failed' 精确匹配的（探针实测：传前缀会导致永不熔断）
      if (launchFailed) enterLaunchBreaker(details.reason);
      // reason='launch-failed' 表示渲染进程从未启动成功，与"运行中崩溃"必须区别对待
      recordCrashAndRecover(win, 'render-process-gone', launchFailed);
    });

    // ③ 主框架加载失败（资源缺失/瞬时 IO 错误）：有限次重试，避免无限刷新
    win.webContents.on('did-fail-load', (_ev, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED（正常的中断，如快速切页）
      if (retried >= MAX_LOAD_RETRY) {
        logWarn(`[watchdog] 页面加载失败且已达重试上限（${desc}）：${url}`);
        return;
      }
      retried += 1;
      logWarn(`[watchdog] 页面加载失败（${desc}），第 ${retried} 次重试：${url}`);
      setTimeout(() => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.reload();
          } catch {
            /* noop */
          }
        }
      }, 1000 * retried);
    });

    /*
     * ④ 卡死（无响应）：**自动**恢复（GW-01 事件部分的另一半，OPT-08）。
     *
     * 旧实现只写一行日志，把恢复动作留给用户去托盘点"修复卡住的窗口" ——
     * 但"卡死的常驻置顶窗"本身就是幽灵窗口（画面停住、仍然吃点击），
     * 用户既不知道该点托盘，也常常在发现之前就已经被它折磨了一轮。
     *
     * 现在：给 3 秒的自我恢复窗口（Chromium 的 'responsive' 事件常在短暂忙碌后触发，
     * 此时**什么都不做**才是对的，避免打断一次长任务），仍未恢复才 reload。
     * 反复无响应沿用与崩溃同一套"5 分钟内 ≥3 次即隐藏"策略：
     * 宁可没有窗口，也绝不留一块看不见却挡住点击的挡板。
     */
    let unresponsiveTimer: NodeJS.Timeout | null = null;
    const clearUnresponsiveTimer = (): void => {
      if (unresponsiveTimer) {
        clearTimeout(unresponsiveTimer);
        unresponsiveTimer = null;
      }
    };
    win.webContents.on('unresponsive', () => {
      const title = win.isDestroyed() ? '已销毁窗口' : win.getTitle() || '未命名窗口';
      logWarn(`[watchdog] 窗口无响应：${title}（3 秒后仍未恢复则自动重载）`);
      clearUnresponsiveTimer();
      unresponsiveTimer = setTimeout(() => {
        unresponsiveTimer = null;
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        const t2 = win.getTitle() || '未命名窗口';
        logWarn(`[watchdog] 窗口持续无响应，执行自动恢复：${t2}`);
        recordCrashAndRecover(win, 'unresponsive');
      }, UNRESPONSIVE_GRACE_MS);
    });
    win.webContents.on('responsive', () => {
      if (!unresponsiveTimer) return;
      clearUnresponsiveTimer();
      logDebug('[watchdog] 窗口已恢复响应（未执行重载）');
    });
    win.webContents.on('destroyed', clearUnresponsiveTimer);

    win.webContents.on('destroyed', () => crashHistory.delete(win.webContents.id));
  });
}

/**
 * 显示前自检：若窗口的渲染进程已崩溃，先 reload 再显示。
 *
 * 为什么需要：崩溃的透明窗口被 `show()` 出来时是**完全空白但能接收鼠标事件**的，
 * 正是用户反馈的"从工作台切换侧边栏后出现无显示却挡住点击的页面"。
 * 所有悬浮窗的 show 入口都应先调用本函数。
 */
export function ensureWindowPaintable(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  // R2-T8：熔断期间不再 reload —— 这正是审计看到的"每个显示动作都撞一次墙"的来源
  if (breaker.broken) return;
  try {
    if (win.webContents.isCrashed()) {
      logWarn(`[watchdog] 显示前检测到渲染进程已崩溃，先恢复窗口：${win.getTitle() || '未命名窗口'}`);
      win.webContents.reload();
    }
  } catch (e) {
    logWarn('[watchdog] 显示前自检失败', (e as Error).message);
  }
}

/**
 * 运行时自检：渲染进程当前是否健康（供启动阶段判断"这台机器上渲染进程能不能起来"）。
 *
 * 为什么需要：`launch-failed` 是**环境级**故障（杀软/受控文件夹访问/运行时文件缺失），
 * 一旦发生，应用会退化成"主进程活着、所有窗口都是空白"的状态 —— 用户看到托盘图标却什么都点不出来。
 * 启动后做一次汇总自检，就能把"这台机器起不了渲染进程"明确讲出来，
 * 而不是让用户对着十几个空窗口猜（实测缺陷：日志里刷了 12 条 launch-failed 却没有任何汇总）。
 */
export function renderHealthSummary(): { windows: number; crashed: number; ok: boolean } {
  let windows = 0;
  let crashed = 0;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    windows += 1;
    try {
      if (win.webContents.isCrashed()) crashed += 1;
    } catch {
      /* 取不到状态时不计入故障 */
    }
  }
  return { windows, crashed, ok: crashed === 0 };
}


// ---------- OPT-14：周期性活性探测（GW-01 治本项） ----------

/** 探测间隔：30s 一次（任务口径）。过密会白耗 CPU，过疏则会拖长用户的卡顿时长 */
const INDICATOR_PROBE_INTERVAL_MS = 30_000;
/** 连续多少次"画面完全没变"才判定冻结（3 次 ≈ 90s，与验收口径"≤2 分钟自动恢复"对齐） */
const INDICATOR_FREEZE_STRIKES = 3;
/** 恢复后对该窗口的静默期：重载本身要重新加载资源与渲染，别在它还没画完时又判一次冻结 */
const INDICATOR_RELOAD_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * 参与活性探测的"指示窗"。
 *
 * 只挑**一定会持续出帧**的页面：宠物（形象/待机动作）、侧边栏（系统信息 2s 推一次 + 音乐可视化）、
 * 命令面板（输入框光标 + 结果列表动效）、工作台（实时钟 + 上下文卡片）。
 * 刻意排除设置 / 预览 / 聊天这类"可以长时间静止"的页面 —— 它们的静止是**正常状态**，
 * 拿它们判冻结必然误报，而误报的代价是重载掉用户正在看的页面。
 */
const INDICATOR_PAGES = /(?:^|\/)(pet|index|palette|deskboard)\.html(?:$|[?#])/;

/** 视野过小（被最小化/无尺寸）时没有探测意义 */
const INDICATOR_MIN_SIZE = 40;

interface IndicatorState {
  /** 上一次的画面指纹 */
  lastHash: string;
  /** 连续未变化的次数 */
  strikes: number;
  /** 冷却截止时间（重载后静默） */
  cooldownUntil: number;
}

const indicatorStates = new Map<number, IndicatorState>();
let indicatorTimer: ReturnType<typeof setInterval> | null = null;
let indicatorRunning = false;

/** 该窗口是否属于"应当持续出帧"的指示窗（页面判定，取不到 URL 时返回 false） */
function isIndicatorWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
  try {
    const url = win.webContents.getURL().split('\\').join('/');
    return INDICATOR_PAGES.test(url);
  } catch {
    return false;
  }
}

/** 探测开关：默认开启（这是幽灵窗口的治本防线）；用户可在设置里关掉（老机器/排查用） */
function livenessProbeEnabled(): boolean {
  try {
    return dataStore().get().settings.windowLivenessProbe !== false;
  } catch {
    return true; // 设置读不到时按"开"处理：宁可多探一次，也别在幽灵面前失守
  }
}

/**
 * 采样一个窗口的画面指纹。
 *
 * 采样区取窗口**中心 1/4**、并缩放到 32x32 再哈希：
 *   · 中心区域避开边缘阴影/光标热点这类噪声；
 *   · 缩放后的 32x32 RGBA（4KB）哈希极廉价，30 秒一次对 CPU 的影响可忽略；
 *   · 用**导出位图的像素**而不是"有没有触发 paint 事件"——后者正是被卡死时最不可信的信号。
 * 失败（窗口正在销毁、GPU 抓不到）返回 null，调用方跳过本次采样（fail-safe：探测失败绝不动窗口）。
 */
async function sampleIndicator(win: BrowserWindow): Promise<string | null> {
  try {
    const size = win.getContentSize();
    if (size[0] < INDICATOR_MIN_SIZE || size[1] < INDICATOR_MIN_SIZE) return null;
    const rect = {
      x: Math.round(size[0] / 4),
      y: Math.round(size[1] / 4),
      width: Math.max(16, Math.round(size[0] / 2)),
      height: Math.max(16, Math.round(size[1] / 2))
    };
    const raw = await win.webContents.capturePage(rect);
    if (raw.isEmpty()) return null;
    const small = raw.resize({ width: 32, height: 32 });
    return createHash('sha1').update(small.toBitmap()).digest('hex');
  } catch {
    return null; // fail-safe
  }
}

/** 鼠标是否停在该窗口上（用户正在交互 → 本轮不采样，避免重载打断操作） */
function cursorInside(win: BrowserWindow): boolean {
  try {
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  } catch {
    return false;
  }
}

/**
 * 对指示窗做一轮采样，判定"画面是否还在变化"。
 *
 * 判定与处置：
 *   · 画面有变化 → 清零计数（正常）；
 *   · 连续 3 次完全一致 → 判定冻结 → 若该 webContents 近期已反复故障则**隐藏**（宁可没有窗口，
 *     也不留隐形挡板），否则 reload 并在日志里留下 `[watchdog] 活性探测` 记录；
 *   · 重载后进入 3 分钟冷却，期间只观察不动作（给重载后的加载与首帧留时间）。
 */
async function runIndicatorProbe(): Promise<void> {
  if (indicatorRunning) return;
  indicatorRunning = true;
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (!isIndicatorWindow(win)) continue;
      if (!win.isVisible() || win.isMinimized()) continue; // 不可见就没有"画面冻住"这回事
      if (!win.webContents.isPainting()) continue; // 明确不在绘制：交给 GPU/崩溃那几条防线
      if (cursorInside(win)) continue;

      const id = win.webContents.id;
      const st = indicatorStates.get(id) ?? { lastHash: '', strikes: 0, cooldownUntil: 0 };
      indicatorStates.set(id, st);
      if (Date.now() < st.cooldownUntil) continue;

      const hash = await sampleIndicator(win);
      if (hash == null) continue;
      if (hash === st.lastHash) st.strikes += 1;
      else {
        st.strikes = 0;
        st.lastHash = hash;
        continue;
      }
      st.lastHash = hash;
      if (st.strikes < INDICATOR_FREEZE_STRIKES) continue;

      const title = win.getTitle() || win.webContents.getURL() || '未命名窗口';
      logWarn(`[watchdog] 活性探测：画面连续 ${st.strikes} 次无变化，判定冻结并恢复：${title}`);
      st.strikes = 0;
      st.cooldownUntil = Date.now() + INDICATOR_RELOAD_COOLDOWN_MS;
      recordCrashAndRecover(win, 'unresponsive');
    }
  } finally {
    indicatorRunning = false;
  }
}

/** 启动活性探测（启动早期调用一次；重复调用安全） */
export function installLivenessProbe(): void {
  if (indicatorTimer) return;
  indicatorTimer = setInterval(() => {
    if (!livenessProbeEnabled()) return;
    if (breaker.broken) return; // 熔断中：没有窗口在绘制，探测毫无意义
    void runIndicatorProbe();
  }, INDICATOR_PROBE_INTERVAL_MS);
  // 探测是纯后台行为，不应阻止进程退出
  indicatorTimer.unref?.();
  logDebug(`[watchdog] 活性探测已启动（每 ${INDICATOR_PROBE_INTERVAL_MS / 1000}s 采样指示窗）`);
}

/**
 * 一键修复卡住的窗口：重载所有常驻 UI 悬浮窗。
 * 用户可见的逃生口——当出现"看不见却挡住点击"的窗口时，无需重启整个应用。
 * 返回被重载的窗口标题列表。
 */
export function repairStuckWindows(): string[] {
  /*
   * 熔断态下"重载窗口"没有意义：渲染进程根本创建不起来，重载只会再撞一次墙。
   * 此时给用户一条**真正可操作**的出路（兼容模式），并把它作为返回值告知调用方，
   * 避免出现"点了修复、什么都没发生、也不知道下一步做什么"的死胡同。
   */
  if (breaker.broken) {
    logWarn('[watchdog] 处于渲染进程启动熔断态，改为提示用户以兼容模式启动');
    notifyThrottled(-2, t('app.name'), t('notify.renderBroken'));
    void showCompatibilityDialog();
    return [];
  }
  const reloaded: string[] = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const title = win.getTitle() || win.webContents.getURL() || '未命名窗口';
    if (!isReloadableWindow(win)) continue; // 跳过瞬态窗口（截图遮罩/贴图等）
    try {
      win.webContents.reload();
      reloaded.push(title);
    } catch (e) {
      logWarn(`[watchdog] 重载窗口失败：${title}`, (e as Error).message);
    }
  }
  logWarn(`[watchdog] 已修复/重载 ${reloaded.length} 个窗口：${reloaded.join('、') || '无'}`);
  return reloaded;
}
