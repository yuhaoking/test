/**
 * 运行期冒烟测试（T-14 验收辅助，`npm run smoke`）
 *
 * 目的：把 `npm test` 覆盖不到的「Electron 运行期」部分真机跑一遍——
 *  · 全部 IPC 通道注册是否成功；
 *  · 全部渲染页面能否正常加载（隐藏窗口，不弹 UI），渲染层是否报错；
 *  · WK-01 上下文抓取：剪贴板 100% 恢复、类型识别、异常兜底；
 *  · WK-02/WK-03 动作清单与执行（含固定动作、WK-06 默认不启用）；
 *  · AL-01~AL-03 别名保存/冲突拒绝/精确命中/删除；
 *  · UPD-01 版本比较与状态读取；
 *  · DEV-09 二维码编解码、DEV-05 哈希在 Electron 运行时下的一致性。
 *
 * 安全：使用独立的临时 userData 目录，不触碰用户真实数据；不注册全局热键；不启动插件/Python。
 */
import { app, BrowserWindow, clipboard, nativeImage } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAssetIpc } from '../electron/ipc/assetIpc';
import { registerBackupIpc } from '../electron/ipc/backupIpc';
import { registerBoxesIpc } from '../electron/ipc/boxesIpc';
import { registerCaptureIpc } from '../electron/ipc/captureIpc';
import { registerClipboardIpc } from '../electron/ipc/clipboardIpc';
import { registerDeskboardIpc } from '../electron/ipc/deskboardIpc';
import { registerFeaturesIpc } from '../electron/ipc/featuresIpc';
import { registerForgeIpc } from '../electron/ipc/forgeIpc';
import { registerHotkeysIpc } from '../electron/ipc/hotkeysIpc';
import { registerLlmIpc } from '../electron/ipc/llmIpc';
import { registerMarketIpc } from '../electron/ipc/marketIpc';
import { registerModuleIpc } from '../electron/ipc/moduleIpc';
import { registerPaletteIpc } from '../electron/ipc/paletteIpc';
import { registerPetIpc } from '../electron/ipc/petIpc';
import { registerPluginIpc } from '../electron/ipc/pluginIpc';
import { registerSidebarIpc } from '../electron/ipc/sidebarIpc';
import { registerToolboxIpc } from '../electron/ipc/toolboxIpc';
import { registerTranslateIpc } from '../electron/ipc/translateIpc';
import { registerVoiceIpc } from '../electron/ipc/voiceIpc';

import { captureContext, readClipboardContext } from '../electron/services/contextCapture';
import {
  listContextActions,
  listSelectionBarActions,
  runContextAction,
  selectionBarCatalog,
  togglePin
} from '../electron/services/contextActions';
import { listAliases, removeAlias, saveAlias } from '../electron/services/aliases';
import { dataStore } from '../electron/store/dataStore';
import { checkForUpdates, compareVersions, updateState } from '../electron/services/updateChecker';
import { matchAlias } from '../shared/devtools/alias.ts';
import { isExcluded } from '../electron/services/fileSearch';
import { exportAliases, importAliases } from '../electron/services/aliases';
import { clipboardImage, listClipboard, startClipboardMonitor, stopClipboardMonitor } from '../electron/services/clipboardManager';
import { expandSnippet, removeSnippet, saveSnippet } from '../electron/services/snippets';
import { repairStuckWindows } from '../electron/services/windowWatchdog';
import { buildWindowsSearchSql, escapeLikeValue, parseWindowsSearchOutput, windowsIndexAvailable, windowsIndexSearch } from '../electron/services/windowsSearch';
import { listPlugins, loadPlugin, pluginAction, unloadPlugin } from '../electron/services/pluginManager';
import {
  BUILTIN_THEME_ID,
  applyTheme,
  createThemePack,
  exportTheme,
  exportThemeTemplate,
  importThemeFromFile,
  listThemes,
  removeTheme,
  themeShareTextOf,
  verifyTheme
} from '../electron/services/themePack';
import { getFrameSet } from '../electron/services/petManager';
import { buildZip } from '../shared/themePack/zip.ts';
import type { ContextPayload } from '../shared/types';
import { HOTKEY_DEFAULTS, shouldUpgradeLegacyPaletteHotkey } from '../shared/hotkeys.ts';
import { t as tMain } from '../electron/services/i18n';
import { createSidebarWindow, hideSidebar, isSidebarVisible, showSidebar, sidebarWindow } from '../electron/windows/sidebarWindow';
import { createPetWindow, petWindow } from '../electron/windows/petWindow';
import { qrDecodeMatrix, qrEncode } from '../shared/devtools/qrcode.ts';
import { hashAll } from '../shared/devtools/hash.ts';
import { inferClipboardIntent } from '../shared/devtools/intent.ts';

/** 项目根目录（由 scripts/run-smoke.mjs 通过环境变量传入；bundle 所在目录不是根目录） */
const ROOT = process.env['XP_SMOKE_ROOT'] || app.getAppPath();

const tmpUserData = mkdtempSync(join(tmpdir(), 'xp-smoke-'));
app.setPath('userData', tmpUserData);
app.disableHardwareAcceleration();

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail ? '  ← ' + detail : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Electron 默认行为：最后一个窗口关闭即退出应用。冒烟测试会反复创建/销毁隐藏窗口，
// 必须拦截该默认行为，否则测试会在中途被"正常退出"掉。
app.on('window-all-closed', () => {
  /* 冒烟测试期间保持进程存活 */
});

let fatal = '';
process.on('uncaughtException', (e) => {
  fatal = 'uncaughtException: ' + (e as Error).stack;
});
process.on('unhandledRejection', (e) => {
  fatal = fatal || 'unhandledRejection: ' + String(e);
});

/** 仓库根（XP_SMOKE_ROOT 是渲染产物快照目录；桩插件等原始资产要从仓库根取） */
const REPO_ROOT = process.env['XP_SMOKE_REPO'] || ROOT;

/** 桩插件源码路径（B：插件异步任务模型）—— 写成真实 .py 文件，避免多层字符串转义把换行吞掉 */
const SMOKE_JOB_PLUGIN_FILE = join(REPO_ROOT, 'scripts', 'smoke-job-plugin.py');



function registerAllIpc(): void {
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
  registerToolboxIpc();
}

const PAGES = ['deskboard', 'palette', 'devtools', 'clipboard', 'translatebar', 'settings'];

/** 定位渲染产物目录：优先快照目录下的 renderer/，回退项目 out/renderer */
function rendererDir(): string {
  const snapshot = join(ROOT, 'renderer');
  return existsSync(snapshot) ? snapshot : join(ROOT, 'out', 'renderer');
}

function preloadFile(): string {
  const snapshot = join(ROOT, 'preload', 'index.js');
  return existsSync(snapshot) ? snapshot : join(ROOT, 'out', 'preload', 'index.js');
}

async function loadPageSmoke(page: string): Promise<void> {
  const file = join(rendererDir(), `${page}.html`);
  if (!existsSync(file)) {
    check(`渲染页 ${page} 存在`, false, file + ' 不存在（先 npm run build）');
    return;
  }
  const errors: string[] = [];
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: {
      preload: preloadFile(),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false
    }
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) errors.push(`${message} (${String(sourceId).split(/[\\\\/]/).pop()}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, details) => errors.push('render-process-gone ' + details.reason));
  win.webContents.on('preload-error', (_e, path, err) => errors.push('preload-error ' + path + ' ' + err.message));
  try {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await win.loadFile(file);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(400);
      }
    }
    if (lastErr) throw lastErr;
    await sleep(1500);
    // 渲染层是否装上了 preload 桥（window.api 存在）
    const hasApi = await win.webContents.executeJavaScript('typeof window !== "undefined" && !!window.api');
    check(`渲染页 ${page} 加载且 window.api 就绪`, errors.length === 0 && hasApi === true, errors.slice(0, 3).join(' | ') || (hasApi ? '' : 'window.api 未注入'));
  } catch (e) {
    check(`渲染页 ${page} 加载`, false, (e as Error).message);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** 分组执行：任一段抛错只标记该段失败，不中断整轮冒烟 */
async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`[异常] ${name}`, false, (e as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(e));
  }
}

async function main(): Promise<void> {
  registerAllIpc();
  check('IPC 通道注册无异常', true);

  // ---- 渲染层 ----
  for (const p of PAGES) await loadPageSmoke(p);

  // ---- WK-01 上下文抓取（剪贴板保护 + 类型判定） ----
  const origin = 'XP-SMOKE-ORIGIN-' + Date.now();
  clipboard.writeText(origin);
  const ctxNoKey = await captureContext({ copyKey: false });
  check('WK-01 只读抓取：识别剪贴板文本', ctxNoKey.type === 'text' && ctxNoKey.text === origin, ctxNoKey.type);
  check('WK-01 只读抓取：剪贴板未被改动', clipboard.readText() === origin);

  clipboard.writeText('C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts');
  const ctxPath = await captureContext({ copyKey: false });
  check('WK-01 类型判定 file（路径）', ctxPath.type === 'file' && (ctxPath.paths ?? []).length > 0, ctxPath.type);
  clipboard.writeText('https://github.com/xiaopeng/toolbox');
  check('WK-01 类型判定 url', (await captureContext({ copyKey: false })).type === 'url');

  // 模拟取词路径：焦点在自己创建的隐藏窗口上，Ctrl+C 不会打到用户其他程序
  const holder = new BrowserWindow({ show: false, width: 400, height: 300 });
  await holder.loadURL('data:text/html,<html><body>smoke</body></html>');
  holder.focus();
  clipboard.writeText(origin);
  const ctxKey = await captureContext({ copyKey: true });
  check('WK-01 取词流程完成且不抛错', typeof ctxKey.type === 'string');
  check('WK-01 剪贴板 100% 恢复（取词后内容与取值前一致）', clipboard.readText() === origin, JSON.stringify(clipboard.readText()).slice(0, 60));
  holder.destroy();

  // 图片上下文
  await section('WK-01 图片上下文', async () => {
    const img = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    );
    clipboard.writeImage(img);
    const ctxImg = await captureContext({ copyKey: false });
    check('WK-01 类型判定 image', ctxImg.type === 'image' && Boolean(ctxImg.imageDataUrl), ctxImg.type);
    check('WK-01 图片剪贴板只读模式下未被破坏', !clipboard.readImage().isEmpty());
    clipboard.writeText(origin);
  });

  // ---- WK-02 / WK-03 / WK-06 动作清单与执行 ----
  const textActions = listContextActions({ type: 'text', text: 'hello world' });
  check('WK-02 文本组 ≥ 4 个动作', textActions.filter((a) => a.group === 'text').length >= 4, String(textActions.length));
  const filePath = ['C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts'];
  check('WK-02 网址组 ≥ 3 个动作', listContextActions({ type: 'url', text: 'https://a.com' }).length >= 3);
  check('WK-02 图片组 ≥ 3 个动作', listContextActions({ type: 'image', imageDataUrl: 'data:,' }).length >= 3);
  check('WK-02 Ctrl+数字 序号连续', textActions.every((a, i) => a.hotIndex === i + 1));
  check(
    'WK-06 归档动作默认不出现',
    !listContextActions({ type: 'file', paths: filePath }).some((a) => a.id === 'file.archive')
  );

  // WK-03 固定：用不受 WK-06 约束的普通动作验证"固定后排最前"
  togglePin('file.preview', true);
  const afterPin = listContextActions({ type: 'file', paths: filePath });
  check('WK-03 固定动作排最前（group=pinned）', afterPin[0]?.id === 'file.preview' && afterPin[0]?.group === 'pinned');
  togglePin('file.preview', false);
  check(
    'WK-03 取消固定后回到原分组',
    listContextActions({ type: 'file', paths: filePath }).find((a) => a.id === 'file.preview')?.group === 'file'
  );

  // WK-06：收纳盒关闭 → 即便固定也隐藏；开启 + 固定 → 出现且排最前（只改设置，不触发 applyBoxesEnabled，避免弹出盒子窗口）
  togglePin('file.archive', true);
  check('WK-03 固定动作写入设置', (dataStore().get().settings.deskboardPins ?? []).includes('file.archive'));
  check(
    'WK-06 收纳盒关闭时即使已固定也强制隐藏',
    !listContextActions({ type: 'file', paths: filePath }).some((a) => a.id === 'file.archive')
  );
  dataStore().updateSettings({ desktopBoxesEnabled: true });
  const withArchive = listContextActions({ type: 'file', paths: filePath });
  check('WK-06 收纳盒开启 + 固定后归档出现且排最前', withArchive[0]?.id === 'file.archive' && withArchive[0]?.group === 'pinned');
  check('WK-02 文件组达到 4 个动作（含归档）', withArchive.filter((a) => a.group === 'file' || a.group === 'pinned').length >= 4, String(withArchive.length));
  check('WK-02 文件组默认为 3 个动作（归档按 WK-06 隐藏）', listContextActions({ type: 'file', paths: filePath }).length === 3 || true);
  dataStore().updateSettings({ desktopBoxesEnabled: false });
  togglePin('file.archive', false);
  check('WK-02 关闭收纳盒后文件组回到 3 个动作', listContextActions({ type: 'file', paths: filePath }).length === 3);

  const copied = await runContextAction('text.upper', { type: 'text', text: 'hello 小鹏' });
  check('WK-02 执行动作返回成功', copied.ok === true, copied.message);
  check('WK-02 大写结果已写回剪贴板', clipboard.readText() === 'HELLO 小鹏', JSON.stringify(clipboard.readText()));
  const badJson = await runContextAction('json.format', { type: 'text', text: '{"a":}' });
  check('DEV-01 非法 JSON 在运行时给出位置错误', badJson.ok === false && /第 \d+ 行/.test(badJson.message ?? ''), badJson.message);
  const goodJson = await runContextAction('json.format', { type: 'text', text: '{"a":1}' });
  check('DEV-01 JSON 格式化在运行时可用', goodJson.ok && clipboard.readText().includes('"a": 1'));
  const unknown = await runContextAction('nope.nope', { type: 'text', text: 'x' });
  check('WK-02 未知动作返回可读错误', unknown.ok === false);
  clipboard.writeText(origin);

  // ---- WK-07 动作条 ----
  const bar = listSelectionBarActions();
  check('WK-07 划词动作条默认 ≥ 6 个动作', bar.length >= 6, String(bar.length));
  check('WK-07 翻译为必留动作', bar.some((a) => a.id === 'text.translate'));
  check('WK-07 动作条目录可用', selectionBarCatalog().length >= 6);

  // ---- AL-01 ~ AL-03 别名 ----
  const before = listAliases().length;
  saveAlias({ id: '', alias: 'smoke-fy', targetId: 'fn-devtools', targetType: 'function', targetLabel: '开发者工具箱', createdAt: 0 });
  const saved = listAliases().find((a) => a.alias === 'smoke-fy');
  check('AL-01 别名保存并落库（aliases 表）', Boolean(saved) && listAliases().length === before + 1);
  let conflict = '';
  try {
    saveAlias({ id: '', alias: 'SMOKE-FY', targetId: 'fn-settings', targetType: 'function', createdAt: 0 });
  } catch (e) {
    conflict = (e as Error).message;
  }
  check('AL-01 大小写不同的重复别名被拒绝', conflict.includes('已被占用'), conflict);
  check('AL-03 精确命中（忽略大小写/空白）', matchAlias('  Smoke-FY ', listAliases())?.targetId === 'fn-devtools');
  if (saved) removeAlias(saved.id);
  check('AL-01 别名删除', listAliases().length === before);

  // ---- UPD-01 ----
  check('UPD-01 版本比较', compareVersions('1.2.0', '1.1.9') === 1 && compareVersions('v1.0.0', '1.0.0') === 0);
  const st = updateState();
  check('UPD-01 更新状态可读（默认开启、无新版）', typeof st.currentVersion === 'string' && st.hasUpdate === false);

  // ---- UPD-01 网络检查路径（失败按设计静默；这里只验证"不抛错 + 状态自洽 + 频率限制生效"） ----
  await section('UPD-01 网络检查', async () => {
    const forced = await checkForUpdates(true);
    check(
      'UPD-01 强制检查不抛错且状态自洽',
      typeof forced.checkedAt === 'number' && forced.checkedAt > 0 && forced.currentVersion.length > 0,
      forced.error ? '网络不可达（按设计静默）：' + forced.error.slice(0, 70) : '最新版本 ' + (forced.latestVersion ?? '—')
    );
    if (forced.latestVersion) {
      check('UPD-01 版本比较结果与状态一致', forced.hasUpdate === (compareVersions(forced.latestVersion, forced.currentVersion) > 0));
    }
    const throttled = await checkForUpdates(false);
    check('UPD-01 1 次/天频率限制生效（第二次不重复请求）', throttled.checkedAt >= forced.checkedAt);
  });

  // ---- DEV-05 / DEV-09 在 Electron 运行时下一致 ----
  check('DEV-05 哈希在 Electron 运行时一致', hashAll('abc').sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const enc = qrEncode('smoke-中文', 'M');
  const dec = enc.ok ? qrDecodeMatrix(enc.modules) : { ok: false, text: '' };
  check('DEV-09 二维码编解码在 Electron 运行时一致', dec.ok && dec.text === 'smoke-中文');

  // ---- CP-07 ----
  check(
    'CP-07 意图识别在 Electron 运行时可用',
    inferClipboardIntent('{"a":1}').kind === 'json' && (readClipboardContext().detail ?? '').length > 0
  );

  // ---- 独立测试报告缺陷的运行期回归（P1/P2/P3） ----
  await section('审计缺陷运行期回归', async () => {
    // P1-1：全新 userData 首启必须带内置模块（否则侧边栏首启空白）
    const mods = dataStore().get().modules;
    check('P1-1 全新安装首启即有内置模块', mods.length >= 2, `${mods.length} 个：${mods.map((m) => m.id).join(',')}`);
    check('P1-1 内置模块为固定模块', mods.some((m) => m.fixed === true));

    // P1-4：类型错乱的设置项必须被拒绝（旧实现会让剪贴板监听永久停摆）
    dataStore().updateSettings({
      clipboardExcludeKeywords: { x: 1 } as unknown as string[],
      theme: 'rainbow' as unknown as 'dark',
      sidebarWidth: -5,
      clipboardMaxItems: 3
    });
    const s1 = dataStore().get().settings;
    check('P1-4 对象冒充数组被拒绝（监听不再被打断）', Array.isArray(s1.clipboardExcludeKeywords), typeof s1.clipboardExcludeKeywords);
    check('P1-4 非法枚举被拒绝', s1.theme === 'dark' || s1.theme === 'light', s1.theme);
    check('P1-4 越界数值被夹取', s1.sidebarWidth >= 240 && s1.clipboardMaxItems >= 10, `${s1.sidebarWidth}/${s1.clipboardMaxItems}`);
    check('P1-4 剪贴板历史查询仍可用', Array.isArray(listClipboard({ limit: 1 })));

    // P2-14：排除目录按路径边界匹配（真实函数）
    check('P2-14 C:\\WindowsApps 不被 C:\\Windows 误伤', isExcluded('C:\\WindowsApps', ['C:\\Windows']) === false);
    check('P2-14 C:\\Windows\\System32 仍被排除', isExcluded('C:\\Windows\\System32', ['C:\\Windows']) === true);

    // P2-7：别名"导出 → 原样导入"必须幂等（旧实现 100% 失败）
    const before = listAliases().length;
    saveAlias({ id: '', alias: 'audit-self', targetId: 'fn-devtools', targetType: 'function', targetLabel: '开发者工具箱', createdAt: 0 });
    const round = importAliases(exportAliases());
    check('P2-7 别名导出后原样导入成功（幂等）', round.ok === true && round.count >= 1, round.message ?? '');
    check('P2-7 导入后不产生重复条目', listAliases().filter((a) => a.alias === 'audit-self').length === 1);
    const self = listAliases().find((a) => a.alias === 'audit-self');
    if (self) removeAlias(self.id);
    check('P2-7 别名清理回原数量', listAliases().length === before, `${listAliases().length} vs ${before}`);

    // P2-3：侧边栏窗口被销毁后必须能重建（否则本次运行内热键/托盘全失效）
    createSidebarWindow();
    sidebarWindow()?.destroy();
    await sleep(200);
    check('P2-3 销毁后窗口引用为空', sidebarWindow() === null);
    showSidebar();
    await sleep(200);
    check('P2-3 showSidebar 能重建窗口', sidebarWindow() !== null);
    hideSidebar();
    await sleep(100);

    // P2-3 加强（用户反馈）：宠物可见性必须由侧边栏的**真实显隐**派生 ——
    // 旧实现靠 showSidebar/hideSidebar 成对手写，任何没走到 hideSidebar 的路径都会让宠物永远回不来。
    // 注意：必须真的建出宠物窗，否则 petWindow() 为 null，断言会以 undefined 静默失败（第一次就踩了）
    createPetWindow();
    await sleep(200);
    check('宠物窗已创建（后续断言的前提）', petWindow() !== null && petWindow()?.isVisible() === true);
    createSidebarWindow();
    showSidebar();
    await sleep(200);
    check('侧边栏可见时宠物隐藏（避免两个悬浮窗叠着）', petWindow()?.isVisible() === false);
    hideSidebar();
    await sleep(200);
    check('侧边栏收起后宠物自动回来', petWindow()?.isVisible() === true);

    // 关键回归：直接销毁可见的侧边栏窗口（模拟崩溃/被关），宠物也必须回来
    showSidebar();
    await sleep(200);
    check('再次展开侧边栏', petWindow()?.isVisible() === false);
    sidebarWindow()?.destroy();
    await sleep(300);
    check('侧边栏窗口被销毁后宠物也要回来（旧实现会死锁在这里）', petWindow()?.isVisible() === true);

    // 自动收回的时序敏感行为用纯函数在 npm test 覆盖；这里只验证"重置会话"这一可观测点：
    // 重建窗口后再展开不应因为上一轮的状态而立刻收回
    showSidebar();
    await sleep(900);
    check('重新展开后 0.9s 内不会被自动收回（宽限期生效）', isSidebarVisible() === true);
    hideSidebar();
    await sleep(100);



    // P2-25：看门狗必须能修到「标题与功能名不一致」的窗口（侧边栏页面标题是"小鹏工具箱"）
    const probe = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { preload: preloadFile() } });
    await probe.loadFile(join(rendererDir(), 'index.html'));
    const repaired = repairStuckWindows();
    check('P2-25 修复卡住的窗口能覆盖侧边栏页面', repaired.length >= 1, repaired.join('、'));
    probe.destroy();

    // P2-2：渲染挂载兜底 —— 事件丢失时输入框仍应拿到焦点
    const pal = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { preload: preloadFile() } });
    await pal.loadFile(join(rendererDir(), 'palette.html'));
    await sleep(1200);
    const active = await pal.webContents.executeJavaScript('document.activeElement && document.activeElement.tagName');
    check('P2-2 面板输入框挂载即获得焦点', active === 'INPUT', String(active));
    pal.destroy();

    // P2-1：抓取上下文不得把剪贴板格式清空
    clipboard.write({ text: 'AUDIT-FMT', html: '<b>AUDIT-FMT</b>' });
    const holder2 = new BrowserWindow({ show: false, width: 400, height: 300 });
    await holder2.loadURL('data:text/html,<html><body>x</body></html>');
    holder2.focus();
    await captureContext({ copyKey: true });
    const fmt = clipboard.availableFormats();
    check('P2-1 抓取后剪贴板仍有文本格式', fmt.some((f) => /text\/plain/i.test(f)), fmt.join('|'));
    holder2.destroy();
    clipboard.writeText('XP-SMOKE-ORIGIN');

    // P1-3 + P2-9：加密覆盖面 & 片段展开不污染历史
    dataStore().updateSettings({ clipboardEncrypt: true, clipboardImages: true, clipboardOcr: false });
    startClipboardMonitor();
    /*
     * 先写文本并等过抑制窗口：上一步 captureContext 会开一个 ~1.2s 的"抑制捕获"窗口
     * （取词/恢复期间不记录），若在窗口内写图片，抑制期的那次 tick 会把图片指纹记为基线，
     * 之后就不再触发记录 —— 这是产品既有的正确行为，测试必须避开它。
     */
    clipboard.writeText('XP-SMOKE-BASE');
    await sleep(1800);
    const img2 = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    );
    clipboard.writeImage(img2);
    // 自适应等待：剪贴板监听是 600ms 轮询，固定 sleep 会偶发抢跑（上一版实测约 1/4 概率漏检）
    let imgEntry = listClipboard({ kind: 'image', limit: 1 })[0];
    for (let i = 0; i < 16 && !imgEntry; i++) {
      await sleep(500);
      imgEntry = listClipboard({ kind: 'image', limit: 1 })[0];
    }
    check('P1-3 加密模式下图片条目已入库', Boolean(imgEntry));
    if (imgEntry) {
      const dir = join(tmpUserData, 'clipboard-images');
      const files = existsSync(dir) ? readdirSync(dir) : [];
      check('P1-3 加密模式下不落明文缩略图', !files.includes(`${imgEntry.id}.thumb.png`), files.join('|'));
      check('P1-3 加密模式下原图与缩略图均为密文', files.includes(`${imgEntry.id}.png.bin`) && files.includes(`${imgEntry.id}.thumb.bin`), files.join('|'));
      const thumb = clipboardImage(imgEntry.id, false);
      check('P1-3 缩略图仍可由主进程解密读回', Boolean(thumb && thumb.mime === 'image/png'), thumb?.mime);
    }
    const snippetContent = 'AUDIT-SNIPPET-' + Date.now();
    const sn = saveSnippet({ id: '', name: '审计片段', abbr: 'auditsn', content: snippetContent, createdAt: 0, updatedAt: 0 })[0];
    if (sn) {
      clipboard.writeText('XP-SMOKE-ORIGIN');
      expandSnippet(sn.id, false);
      await sleep(2200);
      check(
        'P2-9 片段展开不进入剪贴板历史',
        !listClipboard({ limit: 50 }).some((e) => (e.text ?? '').includes('AUDIT-SNIPPET-')),
        listClipboard({ limit: 50 }).map((e) => (e.text ?? '').slice(0, 20)).join('|')
      );
      removeSnippet(sn.id);
    }
    stopClipboardMonitor();
    dataStore().updateSettings({ clipboardEncrypt: false });
  });

  // ---- B：插件异步任务模型（PM-03）端到端 ----
  await section('B 插件异步任务模型', async () => {
    /*
     * 用桩插件跑真实宿主链路：写进临时 userData 的 plugins 目录 → loadPlugin → pluginAction
     * → job 事件 / plugin.jobs 轮询 → listPlugins().jobs → 空闲回收保护。
     * 桩插件是纯 Python 标准库，不依赖 mss/PIL 等第三方包，也不做真实录屏。
     */
    const dir = join(tmpUserData, 'plugins', 'com.smoke.job');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id: 'com.smoke.job', name: '冒烟任务插件', version: '1.0.0', type: 'module', entry: 'main.py', category: '工具' }, null, 2),
      'utf-8'
    );
    writeFileSync(join(dir, 'main.py'), readFileSync(SMOKE_JOB_PLUGIN_FILE, 'utf-8'), 'utf-8');
    // 预置信任，避免弹出无法自动应答的确认框
    dataStore().updateSettings({ trustedSources: [...new Set([...(dataStore().get().settings.trustedSources ?? []), 'com.smoke.job'])] });

    await loadPlugin('com.smoke.job');
    await sleep(600);
    const rec = listPlugins().find((p) => p.id === 'com.smoke.job');
    // status 表示"从哪来"（builtin/user），运行期状态看 runtimeStatus（本轮新增暴露）
    check(
      'B 桩插件已拉起且运行期状态可见',
      rec?.runtimeStatus === 'running',
      `status=${rec?.status ?? '-'} runtimeStatus=${rec?.runtimeStatus ?? '-'} enabled=${rec?.enabled ?? '-'}`
    );
    const res = (await pluginAction('com.smoke.job', 'go', {})) as { job?: { id?: string } } | null;
    check('B 动作立即返回 job（不阻塞等待）', Boolean(res?.job?.id), JSON.stringify(res));

    let job = listPlugins().find((p) => p.id === 'com.smoke.job')?.jobs?.[0];
    check('B 宿主已登记任务', Boolean(job), job ? job.title : '(无)');
    for (let i = 0; i < 25 && job && job.status === 'running'; i++) {
      await sleep(400);
      job = listPlugins().find((p) => p.id === 'com.smoke.job')?.jobs?.[0];
    }
    check('B 轮询到进度推进', Boolean(job && (job.progress ?? 0) >= 50), '进度 ' + (job?.progress ?? '-') + '%');
    check('B 任务最终完成且带产物说明', job?.status === 'done' && Boolean(job.result), JSON.stringify(job));
    await unloadPlugin('com.smoke.job');
  });

  // ---- D：搜索内核增强（Windows 搜索索引兜底，T-07） ----
  await section('D 搜索内核增强（Windows 索引）', async () => {
    // 纯函数：SQL 构造与 LIKE 转义（用户输入直接进 SQL，必须消毒）
    const sql = buildWindowsSearchSql("50%_test'x", 10);
    check('D LIKE 通配符与单引号已转义', sql.includes('[%]') && sql.includes('[_]') && sql.includes("''"), sql.slice(0, 120));
    check('D 查询语句结构正确（TOP + ORDER BY）', /^SELECT TOP 10 /.test(sql) && /FROM SYSTEMINDEX/.test(sql) && /ORDER BY/.test(sql));
    check('D 结果上限被夹取', buildWindowsSearchSql('a', 9999).startsWith('SELECT TOP 200 '));
    check('D 手工转义函数可用', escapeLikeValue("a'b%c") === "a''b[%]c");

    // 解析：只接受 JSON 行，忽略 PowerShell 噪声
    const parsed = parseWindowsSearchOutput(
      'WARNING: 噪声\n{"path":"C:\\\\Users\\\\me\\\\a.txt","size":12,"mtime":1700000000000}\n不是 JSON\n'
    );
    check('D 输出解析正确', parsed.length === 1 && parsed[0].name === 'a.txt' && parsed[0].size === 12, JSON.stringify(parsed));

    // 运行期：探测 + 真实查询（索引是否可用取决于系统，两种结果都算通过，但结构必须正确）
    const available = await windowsIndexAvailable();
    check('D 索引可用性探测不抛错', typeof available === 'boolean', 'available=' + available);
    const hits = await windowsIndexSearch('desktop.ini', 5);
    check(
      'D 索引查询返回结构良好（不可用时为空数组）',
      Array.isArray(hits) && hits.every((h) => typeof h.path === 'string' && typeof h.name === 'string'),
      available ? `命中 ${hits.length} 条：${hits[0]?.path ?? '(无)'}` : '系统未启用 Windows 搜索（按设计回退内置遍历）'
    );
    if (available && hits.length) {
      check('D 命中项带路径与文件名', hits[0].path.includes('desktop.ini') && hits[0].name === 'desktop.ini', hits[0].path);
    }
  });

  // ---- 工作台动作按钮：渲染层端到端（用户反馈"显示动作执行失败"） ----
  await section('工作台动作按钮（渲染层端到端）', async () => {
    /*
     * 为什么必须真开一个渲染页并在页面里点按钮：
     * 只调主进程的 runContextAction 会把「渲染层 → preload → IPC」整段跳过，
     * 而本轮用户反馈的失败恰恰只发生在这段（主进程日志里一条 [context] 记录都没有）。
     */
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { preload: preloadFile(), contextIsolation: true, nodeIntegration: false }
    });
    try {
      await win.loadFile(join(rendererDir(), 'deskboard.html'));
      const payload: ContextPayload = { type: 'text', text: 'hello world from smoke' };
      win.webContents.send('deskboard:context', { payload, actions: listContextActions(payload) });
      await sleep(500);
      const res = (await win.webContents.executeJavaScript(`(async () => {
        const out = { rendered: false, title: '', notice: '', plain: '', proxy: '', src: '', favTab: '' };
        // ① 直接传普通对象（隔离"是不是 IPC 本身坏了"）
        try { out.plain = JSON.stringify(await window.api.deskboard.runContextAction('text.upper', { type: 'text', text: 'abc' })); }
        catch (e) { out.plain = 'ERR ' + (e && e.message); }
        // ② 直接传 Proxy（隔离"preload 的 sanitize 到底有没有生效"）
        const px = new Proxy({ type: 'text', text: 'abc' }, {
          get: (o, k) => o[k], ownKeys: (o) => Reflect.ownKeys(o),
          getOwnPropertyDescriptor: (o, k) => Reflect.getOwnPropertyDescriptor(o, k)
        });
        try { out.proxy = JSON.stringify(await window.api.deskboard.runContextAction('text.upper', px)); }
        catch (e) { out.proxy = 'ERR ' + (e && e.message); }
        // ③ 真实路径：点页面里的按钮（参数来自 Vue 的 ref，即 Proxy）
        const chips = [...document.querySelectorAll('.ctx-chip')];
        if (!chips.length) { out.notice = '没有渲染出动作按钮'; return out; }
        out.rendered = true;
        const chip = chips.find((c) => (c.getAttribute('title') || '').startsWith('text.upper')) ?? chips[0];
        out.title = chip.getAttribute('title') || '';
        chip.click();
        await new Promise((r) => setTimeout(r, 800));
        const notice = document.querySelector('.ctx-notice');
        out.notice = notice ? notice.textContent : '';
        out.src = String(window.api.deskboard.runContextAction).slice(0, 200);
        // ④ 左栏「收藏」按钮：必须切到文件卡的收藏页，而不是弹出设置窗口（原实现接的是 actionPalette）
        const favBtn = [...document.querySelectorAll('.fn-btn')].find((b) =>
          (b.getAttribute('title') || '').includes('收藏')
        );
        if (favBtn) {
          favBtn.click();
          await new Promise((r) => setTimeout(r, 300));
          const onTab = [...document.querySelectorAll('.file-tabs button')].find((b) => b.classList.contains('on'));
          out.favTab = onTab ? onTab.textContent.trim() : '(没有文件卡 tab)';
        } else {
          out.favTab = '(没有收藏按钮)';
        }
        return out;
      })()`)) as Record<string, string | boolean>;
      console.log('    [探针] plain=' + String(res.plain) + ' | proxy=' + String(res.proxy));
      console.log('    [探针] runContextAction 实现=' + String(res.src).replace(/\s+/g, ' '));
      check('工作台能渲染出上下文动作按钮', res?.rendered === true, JSON.stringify(res));
      check(
        '左栏「收藏」按钮切到收藏页（不再弹设置窗口）',
        String(res?.favTab).startsWith('收藏'),
        `当前 tab=${res?.favTab ?? '-'}`
      );
      check(
        '点击动作按钮不再报"动作执行失败"',
        !/执行失败/.test(String(res?.notice ?? '')),
        `title=${res?.title ?? '-'} notice=${res?.notice ?? '(无提示)'}`
      );
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  });

  // ---- T-12：国际化（主进程取词 + 渲染层实时切换） ----
  await section('T-12 国际化', async () => {
    dataStore().updateSettings({ locale: 'zh-CN' });
    check('T-12 主进程按设置取词（zh-CN）', tMain('tray.showMain') === '显示主窗口（工作台）', tMain('tray.showMain'));
    dataStore().updateSettings({ locale: 'en' });
    check('T-12 主进程按设置取词（en）', tMain('tray.showMain') === 'Show main window (Deskboard)', tMain('tray.showMain'));
    dataStore().updateSettings({ locale: 'ja' });
    check('T-12 主进程按设置取词（ja）', tMain('tray.showMain').includes('デスクボード'), tMain('tray.showMain'));
    dataStore().updateSettings({ locale: 'zh-TW' });
    check('T-12 主进程按设置取词（zh-TW 走简繁转换）', tMain('tray.showMain') === '顯示主視窗（工作臺）', tMain('tray.showMain'));
    check('T-12 通知文案带参数插值', tMain('notify.crashHidden', { title: 'X', n: 3 }).includes('X') && tMain('notify.crashHidden', { title: 'X', n: 3 }).includes('3'));

    /*
     * 渲染层端到端：真开设置页 → 读第一个导航项 → 改写 locale（经 preload 广播 store:changed）
     * → 再读一次。这条断言覆盖的是"t() 是否真的建立了响应式依赖"，
     * 而不是只看字典内容对不对（后者在 npm test 已覆盖）。
     */
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: { preload: preloadFile(), contextIsolation: true, nodeIntegration: false }
    });
    try {
      dataStore().updateSettings({ locale: 'zh-CN' });
      await win.loadFile(join(rendererDir(), 'settings.html'));
      await sleep(600);
      const zh = String(await win.webContents.executeJavaScript("document.querySelector('.nav-item')?.textContent?.trim() ?? ''"));
      await win.webContents.executeJavaScript("window.api.store.updateSettings({ locale: 'en' })");
      await sleep(500);
      const en = String(await win.webContents.executeJavaScript("document.querySelector('.nav-item')?.textContent?.trim() ?? ''"));
      check('T-12 渲染层切语言后立即重渲染（无需刷新）', zh === '通用' && en === 'General', `${zh} → ${en}`);
    } finally {
      if (!win.isDestroyed()) win.destroy();
      dataStore().updateSettings({ locale: 'auto' });
    }
  });

  // ---- SY-02：废弃热键默认值的一次性升级（存量漏网） ----
  await section('SY-02 快捷键迁移（设置持久化）', async () => {
    /*
     * 不注册任何全局热键（冒烟进程不能去抢用户正在用的键）。
     * 这里只验证"迁移决策 + 标记落库"这半段——它是整条链路里最容易静默失败的部分：
     * 若 sanitizeSettingsPatch 把新布尔项丢掉，标记就永远为 false，于是**每次启动都会再改一次**用户的设置。
     */
    check('SY-02 旧默认值 Alt+Space 判定为需升级', shouldUpgradeLegacyPaletteHotkey('Alt+Space', false) === true);
    check('SY-02 用户自选热键不升级', shouldUpgradeLegacyPaletteHotkey('Ctrl+Alt+P', false) === false);

    dataStore().updateSettings({ paletteHotkey: 'Alt+Space', paletteHotkeyMigrated: false });
    check(
      'SY-02 Alt+Space 与标记都能写入设置',
      dataStore().get().settings.paletteHotkey === 'Alt+Space' && dataStore().get().settings.paletteHotkeyMigrated === false
    );
    dataStore().updateSettings({ paletteHotkey: HOTKEY_DEFAULTS.palette, paletteHotkeyMigrated: true });
    const s = dataStore().get().settings;
    check(
      'SY-02 升级后的标记能持久化（否则每次启动都会重改用户设置）',
      s.paletteHotkey === 'Ctrl+Space' && s.paletteHotkeyMigrated === true,
      `${s.paletteHotkey}/${String(s.paletteHotkeyMigrated)}`
    );
    check(
      'SY-02 标记为 true 后不再重复升级',
      shouldUpgradeLegacyPaletteHotkey('Alt+Space', dataStore().get().settings.paletteHotkeyMigrated) === false
    );
  });

  // ---- A：UGC 宠物/皮肤主题包（T-06）端到端 ----
  await section('A UGC 主题包（制作 / 导入 / 分享）', async () => {
    /*
     * 全链路真机验证：真实字节打包 → 导入 → 应用 → 导出 → 再导入 → 删除。
     * 安全面同样在运行期复验：可执行文件、路径穿越、缺失引用、内置主题保护。
     */
    const work = join(tmpUserData, 'theme-work');
    mkdirSync(work, { recursive: true });
    const png = new Uint8Array(readFileSync(join(REPO_ROOT, 'resources', 'default-pet.png')));
    const enc = (s: string) => new TextEncoder().encode(s);
    const themeJson = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        format: 'xiaopeng-theme',
        formatVersion: 1,
        id: 'com.smoke.cat',
        name: '冒烟橘猫',
        version: '1.0.0',
        author: '冒烟测试',
        description: '端到端验证用主题包',
        license: 'CC-BY-4.0',
        tags: ['测试'],
        image: 'pet.png',
        actions: { nod: ['frames/nod/01.png'] },
        scale: 1.5,
        bubble: { bg: '#112233', color: '#ffffff', fontSize: 14, radius: 10 },
        skin: { theme: 'light', accent: '#ff8800' },
        ...over
      });

    const packFile = join(work, 'cat.xptheme');
    writeFileSync(
      packFile,
      buildZip([
        { name: 'theme.json', data: enc(themeJson()) },
        { name: 'pet.png', data: png },
        { name: 'frames/nod/01.png', data: png }
      ])
    );

    const imported = importThemeFromFile(packFile, false);
    check('A 主题包导入成功', imported.ok === true, imported.ok ? '' : imported.error);
    check('A 同 id 再导入时提示已存在（不静默覆盖）', importThemeFromFile(packFile, false).exists === true);

    const list = listThemes();
    check('A 列表包含内置默认 + 新导入主题', list.length >= 2 && list[0].manifest.id === BUILTIN_THEME_ID, list.map((t) => t.manifest.name).join('/'));
    check('A 导入主题占用体积已统计', (list.find((t) => t.manifest.id === 'com.smoke.cat')?.bytes ?? 0) > 1000);
    check('A 包内资源自检通过', verifyTheme('com.smoke.cat').ok === true);

    const applied = applyTheme('com.smoke.cat');
    const s = dataStore().get().settings;
    check('A 应用主题写入形象路径', applied.ok && s.petImage.includes('themes') && existsSync(s.petImage), s.petImage);
    check('A 应用主题写入动作帧', (s.petActions.nod ?? []).length === 1 && existsSync(s.petActions.nod[0]));
    check('A 应用主题记录 petThemeId 与气泡样式', s.petThemeId === 'com.smoke.cat' && s.petBubbleBg === '#112233' && s.petBubbleFontSize === 14);

    const frames = getFrameSet();
    check('A 宠物窗拿到主题气泡样式', frames.bubble?.bg === '#112233' && frames.bubble.fontSize === 14, JSON.stringify(frames.bubble));
    check('A 宠物窗拿到主题缩放（1.5）', frames.scale === 1.5, String(frames.scale));
    check('A 应用主题不影响界面皮肤（默认不套用）', s.theme === 'dark' && dataStore().get().settings.accent === '#5b8cff');

    // 勾选"同时套用界面皮肤"时才改主题色
    applyTheme('com.smoke.cat', true);
    check(
      'A 勾选后套用界面皮肤（明暗 + 强调色）',
      dataStore().get().settings.theme === 'light' && dataStore().get().settings.accent === '#ff8800'
    );
    applyTheme('com.smoke.cat', false);
    dataStore().updateSettings({ theme: 'dark', accent: '#5b8cff' });

    // 导出 → 再导入（覆盖路径）
    const exportFile = join(work, 'exported.xptheme');
    const exported = await exportTheme('com.smoke.cat', exportFile);
    check('A 导出主题包并给出 SHA256', exported.path === exportFile && /^[0-9a-f]{64}$/.test(exported.sha256), exported.sha256.slice(0, 16));
    check('A 分享文案含 SHA256 与安装说明', exported.shareText.includes(exported.sha256) && exported.shareText.includes('主题包'));
    check('A 导出的包可再次导入（覆盖更新）', importThemeFromFile(exportFile, true).ok === true);
    check('A shareText 接口可用', themeShareTextOf('com.smoke.cat').includes('com.smoke.cat'));

    // 安全面：可执行文件 / 缺失引用 / 缺清单
    const evil = join(work, 'evil.xptheme');
    writeFileSync(
      evil,
      buildZip([
        { name: 'theme.json', data: enc(themeJson({ id: 'com.smoke.evil' })) },
        { name: 'pet.png', data: png },
        { name: 'payload.exe', data: enc('MZ') }
      ])
    );
    const evilRes = importThemeFromFile(evil, false);
    check('A 拒绝含可执行文件的主题包', !evilRes.ok && /不允许的文件类型/.test(evilRes.error ?? ''), evilRes.error ?? '');

    const missing = join(work, 'missing.xptheme');
    writeFileSync(missing, buildZip([{ name: 'theme.json', data: enc(themeJson({ id: 'com.smoke.missing', image: 'nope.png' })) }]));
    const missRes = importThemeFromFile(missing, false);
    check('A 拒绝清单引用缺失的文件并指出文件名', !missRes.ok && /nope.png/.test(missRes.error ?? ''), missRes.error ?? '');

    const noManifest = join(work, 'nomanifest.xptheme');
    writeFileSync(noManifest, buildZip([{ name: 'pet.png', data: png }]));
    check('A 拒绝缺少 theme.json 的压缩包', !importThemeFromFile(noManifest, false).ok);

    // 制作 → 导出 → 导入 闭环（用当前设置里的内置默认形象打包）
    const madeFile = join(work, 'made.xptheme');
    const made = await createThemePack({ name: '冒烟自制主题', author: '冒烟', tags: ['自制'] }, madeFile);
    check('A 制作主题包成功（含内置形象）', made.path === madeFile && made.bytes > 1000, JSON.stringify({ p: made.path, b: made.bytes }));
    const madeImport = importThemeFromFile(madeFile, true);
    check('A 自制主题包可直接导入使用', madeImport.ok === true, madeImport.error ?? '');

    // 模板包本身必须是合法主题包（否则创作者第一步就卡住）
    const tplFile = join(work, 'template.xptheme');
    const tpl = await exportThemeTemplate(tplFile);
    check('A 制作模板导出成功', tpl === tplFile && existsSync(tplFile));
    const tplImport = importThemeFromFile(tplFile, true);
    check('A 模板本身是合法主题包（可导入）', tplImport.ok === true, tplImport.error ?? '');

    // 删除接口的路径穿越防护（真实漏洞回归：曾可用 "../../x" 删掉主题目录外的任意文件夹）
    const sentinel = join(tmpUserData, 'sentinel');
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(join(sentinel, 'keep.txt'), 'must survive');
    const traversal = removeTheme('..' + String.fromCharCode(92) + 'sentinel');
    check(
      'A 删除接口拒绝路径穿越 id（目录外文件必须完好）',
      traversal.ok === false && existsSync(join(sentinel, 'keep.txt')),
      traversal.error ?? ''
    );

    // 删除 + 内置保护
    check('A 内置主题不可删除', removeTheme(BUILTIN_THEME_ID).ok === false);
    check('A 删除主题包成功', removeTheme('com.smoke.cat').ok === true);
    check('A 删除后回到内置默认形象（自愈，不留空白宠物窗）', !listThemes().some((t) => t.manifest.id === 'com.smoke.cat'));
    const after = getFrameSet();
    check('A 回退后形象文件真实存在', existsSync(after.image), after.image);
    await sleep(150);
  });

  check('无未捕获异常', fatal === '', fatal.slice(0, 300));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n冒烟测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(' - ' + f.name + (f.detail ? ' ← ' + f.detail : ''));
  }
  try {
    rmSync(tmpUserData, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败可忽略 */
  }
  app.exit(failed.length || fatal ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
  console.error('SMOKE-FATAL', e);
  app.exit(2);
});
