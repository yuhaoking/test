import { existsSync } from 'fs';
import { join } from 'path';
import { app, type BrowserWindow } from 'electron';
import { openExternalSafe } from '../utils/openExternalSafe';
import { logDebug, logWarn } from '../utils/log';

/**
 * 预加载脚本路径。
 *
 * 与 rendererFile 同理：主进程 bundle 不一定在 out/main 下（诊断/审计会把 entry 打到仓库根），
 * 此时 `../preload` 会解析到不存在的位置 —— 结果是 preload 静默失效、渲染层拿不到 window.api
 * （表现为页面"加载成功"但什么都不工作，是最难查的一类故障）。按"相对 → out/preload"依次探测。
 */
export function preloadPath(): string {
  const relative = join(__dirname, '../preload/index.js');
  if (existsSync(relative)) return relative;
  try {
    const fallback = join(app.getAppPath(), 'out', 'preload', 'index.js');
    if (existsSync(fallback)) return fallback;
  } catch {
    /* app 尚不可用时回落 */
  }
  return relative;
}

/**
 * 渲染产物目录。
 *
 * 正常布局：<root>/out/main/index.js → ../renderer。
 * 但主进程 bundle 不一定总在 out/main（例如把 entry 直接打包到仓库根做诊断/审计），
 * 此时 ../renderer 会解析成 <root>/../renderer 而 404。这里按"相对 → out/renderer"依次探测，
 * 让布局差异不再是"页面白屏"的隐性原因。
 */
function rendererFile(page: string): string {
  const relative = join(__dirname, `../renderer/${page}.html`);
  if (existsSync(relative)) return relative;
  try {
    return join(app.getAppPath(), 'out', 'renderer', `${page}.html`);
  } catch {
    return relative;
  }
}

/**
 * 常驻交互窗（GW-08 / OPT-02）：这些窗口"呼出即用、用完即隐"，但**隐藏不等于可以停帧**。
 *
 * 实机取证（deskboardWindow.ts:163-165 注释）：工作台一旦 `hide()`，其渲染进程立刻被后台节流/冻结，
 * 渲染端后续发出的 IPC（如 `api.sidebar.toggle()`）**根本发不出去** ——
 * 日志里只见 hideDeskboard、不见 toggle，用户感受是"点了没反应"。
 * 因此这些页面在 `webPreferences` 里显式 `backgroundThrottling: false`：
 * 隐藏期间照常跑帧与派发 IPC，隐藏语义完全由窗口显隐（以及置顶的撤除）承担。
 *
 * 省资源模式依旧有效：这类窗口在"节省资源"下会被**延迟销毁**（见 deskboardWindow 的 saverReclaim），
 * 那是"整窗回收"而不是"停帧"，两者不冲突。
 */
export const PERMANENT_INTERACTIVE_PAGES: ReadonlySet<string> = new Set([
  'deskboard',
  'palette',
  'index',
  'pet',
  'box',
  'clipboard',
  'translatebar'
]);

/** 该窗口是否为常驻交互窗（按已加载页面判定；取不到 URL 时按标题兜底为 false） */
export function isPermanentInteractiveWindow(win: BrowserWindow): boolean {
  if (!win || win.isDestroyed()) return false;
  try {
    const url = win.webContents.getURL().split('\\').join('/');
    const m = /(?:^|\/)([a-z0-9-]+)\.html(?:$|[?#])/i.exec(url);
    return Boolean(m && PERMANENT_INTERACTIVE_PAGES.has(m[1].toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * 窗口导航防护（SEC-002，审计判 High 阻断）
 *
 * 问题：全仓 15 个窗口**一个都没有**注册 `setWindowOpenHandler` / `will-navigate`。
 * 于是渲染层里任何一处 `<a target="_blank">`（如待办 markdown 的外链）或 `window.open`，
 * 都会由 Electron 默认行为**开出一个真实的子窗口**：它继承会话、可加载任意页面，
 * 而应用对此毫无记录与拦截——既是钓鱼/UI 伪装面，也是审计关注的"未受控导航"。
 *
 * 现在在每个窗口创建的统一入口（loadPage）注册两道闸：
 *   · `setWindowOpenHandler` → 一律 `deny`；只有 http/https/mailto 才转交系统浏览器
 *     （复用 `openExternalSafe` 的协议白名单，杜绝 `file:` / `search-ms:` 之类协议被当成外链打开）；
 *   · `will-navigate` → 同上。应用自身的页面切换都走 `loadURL`/`loadFile`（不触发本事件），
 *     所以"拦截一切"不会破坏任何内部跳转。
 *
 * 重复调用安全（幂等）：同一窗口只注册一次，避免热重载/多处调用叠加监听。
 */
const NAV_HARDENED = Symbol.for('xpt.navHardened');

export function hardenWindowNavigation(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  type Hardened = { [NAV_HARDENED]?: boolean };
  const wc = win.webContents as unknown as Hardened;
  if (wc[NAV_HARDENED]) return;
  wc[NAV_HARDENED] = true;

  /*
   * 应用内"页面切换"只有两种形态：启动时 `loadFile`/`loadURL`（不触发 will-navigate），
   * 以及路由内的 hash 变化（同样不触发 will-navigate）。因此 will-navigate 里出现的任何目标
   * 都值得拦截——**唯一**例外是 dev server 自身的原址刷新（HMR 重载）。
   * 明确不把 `file:` 放进白名单：放行 `file:///C:/evil.html` 等于白送一个任意本地页面入口。
   */
  const sameAppUrl = (url: string): boolean => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    return Boolean(devUrl && url.startsWith(devUrl));
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void openExternalSafe(url).catch((e: unknown) =>
        logWarn('[nav] 外部链接打开失败（已阻止应用内开窗）', url, (e as Error).message)
      );
    } else {
      logWarn('[nav] 已阻止窗口打开请求（协议不在白名单）', url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (sameAppUrl(url)) return;
    event.preventDefault();
    logWarn('[nav] 已拦截应用内导航（转系统浏览器或忽略）', url);
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void openExternalSafe(url).catch(() => undefined);
    }
  });
}

/**
 * 加载渲染页面；query 以查询参数注入（如收纳盒窗口 ?box=id）
 * dev / 生产两种模式均支持
 *
 * 这里是**全部 15 个窗口的唯一加载入口**，因此导航防护与常驻交互窗的节流策略都挂在这里，
 * 新增窗口不会再"忘记注册"（审计 SEC-002 的整改口径就是"统一入口"）。
 */
export function loadPage(win: BrowserWindow, page: string, query?: Record<string, string>): void {
  hardenWindowNavigation(win);
  if (PERMANENT_INTERACTIVE_PAGES.has(page)) {
    // GW-08 / OPT-02：常驻交互窗隐藏期间仍要跑帧与派发 IPC（详见上方常量说明）
    try {
      win.webContents.setBackgroundThrottling(false);
    } catch (e) {
      logDebug('[common] 常驻交互窗背景节流策略设置失败', (e as Error).message);
    }
  }
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const qs = query ? new URLSearchParams(query).toString() : '';
  if (devUrl) {
    win.loadURL(`${devUrl}/${page}.html${qs ? `?${qs}` : ''}`);
  } else {
    win.loadFile(rendererFile(page), query ? { query } : undefined);
  }
}
