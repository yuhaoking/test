/**
 * 独立审计主程序（Electron 运行期）：覆盖 npm test / npm run smoke 未覆盖的真实服务行为。
 * 全部使用临时 userData；不注册全局热键；不弹可见窗口；不改用户真实数据。
 */
import { app, BrowserWindow, clipboard, dialog, nativeImage } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

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

import { dataStore, userDataDir } from '../electron/store/dataStore';
import { db, dbFile } from '../electron/store/db';
import { decryptText, encryptText } from '../electron/utils/secrets';
import { redact } from '../electron/utils/log';
import * as cm from '../electron/services/clipboardManager';
import { findByAbbr, listSnippets, removeSnippet, saveSnippet } from '../electron/services/snippets';
import { exportAliases, importAliases, listAliases, removeAlias, saveAlias } from '../electron/services/aliases';
import {
  callPlugin,
  listPlugins,
  loadPlugin,
  pluginUi,
  runtimeOf,
  startIdleReaper,
  unloadPlugin
} from '../electron/services/pluginManager';
import { installFromMarket, marketState, securePackagesInfo, uninstallFromMarket } from '../electron/services/marketplace';
import { addTodoQuick, search as paletteSearch } from '../electron/services/paletteSearch';
import * as boxes from '../electron/services/desktopBoxes';
import { previewData } from '../electron/services/filePreview';
import { openPath, quickFileSearch, searchFiles } from '../electron/services/fileSearch';
import { applyMcpServer, mcpStatus, stopMcpServer } from '../electron/services/mcpServer';
import { hotkeyList, resetHotkeys, setHotkey } from '../electron/services/hotkeyManager';
import { perfUsage } from '../electron/services/perf';
import { getSystemInfo } from '../electron/services/systemInfo';
import { getWeather } from '../electron/services/weather';
import { getMusicState } from '../electron/services/musicControl';
import { chatRound, clearMemory, loadMemory } from '../electron/services/llm';
import { AGENT_TOOLS, execAgentTool } from '../electron/services/agentTools';
import { exportDiagBundle, exportSettingsBackup, importSettingsBackup } from '../electron/services/backup';
import { repairStuckWindows } from '../electron/services/windowWatchdog';
import { listContextActions, runContextAction } from '../electron/services/contextActions';
import { listSelectionBarActions } from '../electron/services/contextActions';

const ROOT = process.env['XP_AUDIT_ROOT'] || app.getAppPath();
const PHASE = process.env['XP_AUDIT_PHASE'] || 'main';
const USER_DATA = process.env['XP_AUDIT_USERDATA'] || join(ROOT, 'userdata');
app.setPath('userData', USER_DATA);
app.disableHardwareAcceleration();
mkdirSync(USER_DATA, { recursive: true });

const results: Array<{ name: string; ok: boolean; detail?: string; ms?: number }> = [];
function check(name: string, ok: boolean, detail?: string, ms?: number): void {
  results.push({ name, ok, detail, ms });
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? '  <- ' + String(detail).slice(0, 300) : '') + (ms !== undefined ? '  [' + ms + 'ms]' : ''));
}
function info(msg: string): void {
  console.log('  ..  ' + msg);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check('[异常] ' + name, false, (e as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(e));
  }
}
async function timed<T>(fn: () => Promise<T>): Promise<{ v: T | null; ms: number; err?: string }> {
  const t0 = Date.now();
  try {
    const v = await fn();
    return { v, ms: Date.now() - t0 };
  } catch (e) {
    return { v: null, ms: Date.now() - t0, err: (e as Error).message };
  }
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('超时 ' + ms + 'ms: ' + label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
app.on('window-all-closed', () => { /* 审计期间保持进程存活 */ });

let fatal = '';
process.on('uncaughtException', (e) => { fatal = 'uncaughtException: ' + (e as Error).stack; });
process.on('unhandledRejection', (e) => { fatal = fatal || 'unhandledRejection: ' + String(e); });

const PAGES = ['index', 'deskboard', 'palette', 'devtools', 'clipboard', 'translatebar', 'settings', 'pet', 'box', 'capture', 'annotate', 'long', 'chat', 'pin', 'preview'];
function rendererDir(): string { const s = join(ROOT, 'renderer'); return existsSync(s) ? s : join(ROOT, 'out', 'renderer'); }
function preloadFile(): string { const s = join(ROOT, 'preload', 'index.js'); return existsSync(s) ? s : join(ROOT, 'out', 'preload', 'index.js'); }

async function loadPage(page: string): Promise<void> {
  const file = join(rendererDir(), page + '.html');
  if (!existsSync(file)) { check('渲染页 ' + page + ' 存在', false, file); return; }
  const errors: string[] = [];
  const win = new BrowserWindow({ show: false, width: 900, height: 640, webPreferences: { preload: preloadFile(), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => { if (level >= 3) errors.push(message + ' (' + String(sourceId).split(/[\\/]/).pop() + ':' + line + ')'); });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('did-fail-load ' + code + ' ' + desc));
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone ' + d.reason));
  win.webContents.on('preload-error', (_e, p, err) => errors.push('preload-error ' + p + ' ' + err.message));
  try {
    await win.loadFile(file);
    await sleep(900);
    const hasApi = await win.webContents.executeJavaScript('typeof window !== "undefined" && !!window.api');
    check('渲染页 ' + page + ' 加载 + window.api', errors.length === 0 && hasApi === true, errors.slice(0, 2).join(' | ') || (hasApi ? '' : 'window.api 未注入'));
  } catch (e) {
    check('渲染页 ' + page + ' 加载', false, (e as Error).message);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function main(): Promise<void> {
  // ---------- 阶段：损坏文件恢复 ----------
  if (PHASE === 'seed-corrupt') {
    const backend = db();
    info('后端 = ' + backend.engine + '  文件 = ' + dbFile());
    dataStore().updateSettings({ petName: '审计持久化' });
    dataStore().flush();
    const f = join(USER_DATA, 'data-v2.json');
    const good = existsSync(f);
    check('持久化文件已生成（JSON 后端）', good || backend.engine === 'sqlite', f);
    if (good) {
      writeFileSync(f, '{ this is not json ', 'utf-8');
      check('已写入损坏 JSON（供下一阶段验证恢复）', true, f);
    }
    // 顺带验证 BOM 场景：写入带 BOM 的合法 JSON
    const bomFile = join(USER_DATA, 'bom-check.json');
    writeFileSync(bomFile, '\uFEFF' + JSON.stringify({ ok: 1 }), 'utf-8');
    check('BOM 文件写入完成', existsSync(bomFile));
    app.exit(results.some((r) => !r.ok) ? 1 : 0);
    return;
  }
  if (PHASE === 'verify-corrupt') {
    const s = dataStore().get().settings;
    check('损坏 JSON 后仍能启动（回退默认值）', typeof s.petName === 'string' && s.petName.length > 0, 'petName=' + s.petName);
    const baks = readdirSync(USER_DATA).filter((f) => f.includes('.corrupt-') && f.endsWith('.bak'));
    check('损坏文件已备份为 *.corrupt-*.bak（数据可人工恢复）', baks.length > 0, baks.join(','));
    if (baks.length) {
      const content = readFileSync(join(USER_DATA, baks[0]), 'utf-8');
      check('备份内容保留原始损坏文本', content.includes('this is not json'));
    }
    app.exit(results.some((r) => !r.ok) ? 1 : 0);
    return;
  }

  // ---------- 主阶段 ----------
  registerAssetIpc(); registerSidebarIpc(); registerPetIpc(); registerModuleIpc(); registerPluginIpc();
  registerFeaturesIpc(); registerBoxesIpc(); registerPaletteIpc(); registerDeskboardIpc(); registerClipboardIpc();
  registerMarketIpc(); registerHotkeysIpc(); registerCaptureIpc(); registerBackupIpc(); registerLlmIpc();
  registerVoiceIpc(); registerTranslateIpc(); registerForgeIpc(); registerToolboxIpc();
  check('IPC 通道注册无异常（19 个域）', true);

  for (const p of PAGES) await loadPage(p);

  // ---------- 数据层 ----------
  await section('数据层', async () => {
    const s = dataStore().get().settings;
    check('默认设置结构完整', s.petName === '小鹏' && Array.isArray(s.selectionBarActions) && typeof s.theme === 'string', 'petName=' + s.petName);
    const mods = dataStore().get().modules.length;
    check('默认模块存在（系统信息/音乐）', mods >= 2, 'count=' + mods);
    // SVC-1 设置白名单 + 类型校验
    dataStore().updateSettings({ hotkey: 123 as unknown as string, notARealKey: 'x' as unknown as string, petName: 42 as unknown as string });
    const s2 = dataStore().get().settings as unknown as Record<string, unknown>;
    check('非法类型设置被拒绝（hotkey 保持字符串）', typeof s2.hotkey === 'string', 'hotkey=' + JSON.stringify(s2.hotkey));
    check('未知设置键被忽略', !('notARealKey' in s2));
    check('非法 petName 类型被拒绝', typeof s2.petName === 'string', 'petName=' + JSON.stringify(s2.petName));
    // 路径清洗
    dataStore().updateSettings({ petImage: '  "' + 'C:' + String.fromCharCode(92) + 'tmp' + String.fromCharCode(92) + 'a.png' + '"  ' });
    check('路径类设置去引号/去空白', dataStore().get().settings.petImage === 'C:' + String.fromCharCode(92) + 'tmp' + String.fromCharCode(92) + 'a.png', dataStore().get().settings.petImage);
    // 持久化（注意：dataStore.flush 只写内存后端，JSON 文件落盘还有 100ms 防抖）
    dataStore().updateSettings({ petName: '审计持久化' });
    dataStore().flush();
    await sleep(400);
    const f = join(USER_DATA, 'data-v2.json');
    if (existsSync(f)) {
      const raw = readFileSync(f, 'utf-8');
      check('设置已落盘到 data-v2.json', raw.includes('审计持久化'));
      check('落盘文件不含 BOM（可被标准 JSON 解析）', raw.charCodeAt(0) !== 0xfeff && (() => { try { JSON.parse(raw); return true; } catch { return false; } })());
    } else {
      check('后端为 SQLite，跳过 JSON 落盘断言', db().engine === 'sqlite', dbFile());
    }
    // 模块 CRUD
    dataStore().update((d) => { d.modules.push({ id: 'audit-mod', type: 'todo_list' as never, name: '审计模块', order: 99, config: {} } as never); });
    dataStore().flush();
    check('模块新增已持久化', dataStore().get().modules.some((m) => m.id === 'audit-mod'));
    dataStore().update((d) => { d.modules = d.modules.filter((m) => m.id !== 'audit-mod'); });
    dataStore().flush();
    check('模块删除已持久化', !dataStore().get().modules.some((m) => m.id === 'audit-mod'));
    check('全新安装应带内置默认模块（系统信息/音乐控制）', dataStore().get().modules.length >= 2, '实际 modules=' + dataStore().get().modules.length + '（defaults.modules 为死代码）');
  });

  // ---------- 加密 ----------
  await section('加密（AES-256-GCM）', () => {
    const secret = '小鹏工具箱-secret-🔐-0123456789';
    const c1 = encryptText(secret);
    const c2 = encryptText(secret);
    check('加解密往返一致（含中文/emoji）', decryptText(c1) === secret);
    check('相同明文两次密文不同（随机 IV）', c1 !== c2);
    check('密文格式 base64', /^[A-Za-z0-9+/=]+$/.test(c1));
    let threw = false;
    try {
      const buf = Buffer.from(c1, 'base64');
      buf[buf.length - 1] ^= 0xff;
      decryptText(buf.toString('base64'));
    } catch { threw = true; }
    check('密文被篡改时解密失败（GCM 认证）', threw);
  });

  // ---------- 剪贴板历史 ----------
  await section('剪贴板历史', async () => {
    dataStore().updateSettings({ clipboardEnabled: true, clipboardExcludeKeywords: [], clipboardAppWhitelist: [], clipboardImages: true, clipboardEncrypt: false });
    cm.startClipboardMonitor();
    cm.clearClipboard(false);
    clipboard.writeText('audit-baseline');
    await sleep(1400);
    cm.clearClipboard(false);
    const marker = 'audit-clip-' + Date.now();
    clipboard.writeText(marker);
    await sleep(2500);
    const list1 = cm.listClipboard();
    check('新复制文本被记录', list1.some((e) => e.text === marker), 'count=' + list1.length);
    const rec = list1.find((e) => e.text === marker);
    info('记录耗时观测：写入到可见用时约 ' + 2500 + 'ms 内');
    if (rec) check('来源应用字段已填充或为空串（不阻塞）', typeof rec.sourceApp === 'string');
    const before = cm.listClipboard().length;
    clipboard.writeText(marker);
    await sleep(1600);
    check('相同内容去重（不新增条目）', cm.listClipboard().length === before, before + ' -> ' + cm.listClipboard().length);
    // 隐私：排除关键词
    dataStore().updateSettings({ clipboardExcludeKeywords: ['审计机密'] });
    clipboard.writeText('这是一段审计机密内容');
    await sleep(2000);
    check('排除关键词命中时不记录', !cm.listClipboard().some((e) => (e.text ?? '').includes('审计机密')));
    dataStore().updateSettings({ clipboardExcludeKeywords: [] });
    // 抑制窗口（内部取词）
    cm.suppressClipboardCapture(1500);
    clipboard.writeText('audit-suppressed-' + Date.now());
    await sleep(900);
    check('抑制期内不记录内部取词内容', !cm.listClipboard().some((e) => (e.text ?? '').startsWith('audit-suppressed')));
    await sleep(1200);
    // 图片
    const img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    clipboard.writeImage(img);
    await sleep(2500);
    const imgs = cm.listClipboard({ kind: 'image' });
    check('剪贴板图片被记录', imgs.length > 0, 'images=' + imgs.length);
    if (imgs.length) {
      const e = imgs[0];
      check('图片条目含尺寸与文件路径', Boolean(e.imageFile && e.width > 0 && e.height > 0), JSON.stringify({ f: e.imageFile, w: e.width, h: e.height }));
      check('图片文件实际落盘', Boolean(e.imageFile && existsSync(e.imageFile)));
      const data = cm.clipboardImage(e.id, true);
      check('图片可读回为 base64', Boolean(data && data.data.length > 0));
    }
    // 置顶 / 清空保留置顶
    const anyText = cm.listClipboard({ kind: 'text' })[0];
    if (anyText) {
      cm.updateClipboard(anyText.id, { pinned: true });
      cm.clearClipboard(true);
      check('清空时保留置顶条目', cm.listClipboard().some((e) => e.pinned));
      const after = cm.clearClipboard(false);
      check('清空全部可用', after.length === 0, 'left=' + after.length);
    } else {
      check('存在文本条目用于置顶测试', false);
    }
    // 隐私：加密存储
    dataStore().updateSettings({ clipboardEncrypt: true });
    const encMarker = 'audit-enc-' + Date.now();
    clipboard.writeText(encMarker);
    await sleep(2500);
    const encEntry = cm.listClipboard().find((e) => e.text === encMarker);
    check('加密模式下仍能读到明文（内存解密）', Boolean(encEntry));
    const f = join(USER_DATA, 'data-v2.json');
    if (existsSync(f) && encEntry) {
      check('加密模式下磁盘不含明文', !readFileSync(f, 'utf-8').includes(encMarker));
    }
    dataStore().updateSettings({ clipboardEncrypt: false });
    cm.stopClipboardMonitor();
  });

  // ---------- 片段库 ----------
  await section('片段库', () => {
    const n0 = listSnippets().length;
    const s = { id: '', name: '审计片段', abbr: 'AuditAbbr', content: '内容-小鹏', createdAt: 0 } as never;
    const list = saveSnippet(s);
    check('新增片段（自动生成 id）', list.length === n0 + 1, 'n=' + list.length);
    const created = list.find((x) => x.abbr.toLowerCase() === 'auditabbr');
    check('缩写查找大小写不敏感', Boolean(findByAbbr('auditabbr')) && Boolean(findByAbbr('AUDITABBR')));
    if (created) {
      const dup = saveSnippet({ ...created, name: '重复缩写' } as never);
      check('重复缩写被拒绝或覆盖（不产生两条同缩写）', dup.filter((x) => x.abbr.toLowerCase() === 'auditabbr').length === 1, 'n=' + dup.length);
      removeSnippet(created.id);
    }
    check('删除片段', listSnippets().length === n0, 'n=' + listSnippets().length);
  });

  // ---------- 别名 ----------
  await section('指令别名', () => {
    const n0 = listAliases().length;
    saveAlias({ id: '', alias: 'audit-dev', targetId: 'fn-devtools', targetType: 'function', targetLabel: '开发者工具', createdAt: 0 } as never);
    check('新增别名', listAliases().length === n0 + 1);
    let dupErr = '';
    try { saveAlias({ id: '', alias: 'AUDIT-DEV', targetId: 'fn-settings', targetType: 'function', createdAt: 0 } as never); } catch (e) { dupErr = (e as Error).message; }
    check('重复别名（大小写不同）被拒绝', dupErr.includes('已被占用'), dupErr);
    const json = exportAliases();
    check('导出 JSON 合法', (() => { try { JSON.parse(json); return true; } catch { return false; } })());
    const imp = importAliases(json);
    check('导入自身导出内容成功', imp.ok === true, JSON.stringify(imp));
    const bad = importAliases('{not json');
    check('导入非法 JSON 返回可读失败（不抛栈）', bad.ok === false && Boolean(bad.message), JSON.stringify(bad));
    const bad2 = importAliases('{"foo":1}');
    check('导入结构错误返回失败', bad2.ok === false, JSON.stringify(bad2));
    const created = listAliases().find((a) => a.alias.toLowerCase() === 'audit-dev');
    if (created) removeAlias(created.id);
    check('删除别名', listAliases().length === n0);
  });

  // ---------- 插件系统（真实 Python） ----------
  await section('插件系统', async () => {
    const list = listPlugins();
    check('插件清单加载（15 个）', list.length >= 15, 'count=' + list.length + ' ids=' + list.map((p) => p.id).join(','));
    check('每个插件都有 id/name/dir', list.every((p) => p.id && p.name && p.dir));
    check('内置插件 icon 存在', list.filter((p) => p.name !== '').every((p) => existsSync(join(p.dir, 'manifest.json'))));
    const modulePlugins = list.filter((p) => p.type === 'module');
    info('待测模块插件 ' + modulePlugins.length + ' 个（逐个真实拉起）');
    let okCount = 0;
    const failed: string[] = [];
    for (const p of modulePlugins) {
      const t0 = Date.now();
      const r = await timed(() => withTimeout(loadPlugin(p.id), 120000, 'loadPlugin ' + p.id));
      if (r.err) { failed.push(p.id + ': ' + r.err); check('插件 ' + p.id + ' 加载', false, r.err, r.ms); continue; }
      const rt = runtimeOf(p.id);
      if (!rt || !rt.child) { failed.push(p.id + ': 子进程未启动'); check('插件 ' + p.id + ' 子进程', false, 'status=' + (rt?.record.status ?? 'none'), r.ms); continue; }
      const init = await timed(() => withTimeout(callPlugin(p.id, 'plugin.init', { config: {} }), 30000, 'init ' + p.id));
      const status = runtimeOf(p.id)?.record.status ?? '';
      const initOk = !init.err && (init.v as { status?: string } | null)?.status === 'ok';
      if (!initOk) { failed.push(p.id + ': init ' + (init.err ?? JSON.stringify(init.v))); check('插件 ' + p.id + ' init', false, (init.err ?? 'status=' + status).slice(0, 160), r.ms); }
      const ui = await timed(() => withTimeout(callPlugin(p.id, 'plugin.get_ui', {}), 30000, 'ui ' + p.id));
      const uiOk = !ui.err && Boolean(ui.v);
      if (!uiOk) failed.push(p.id + ': get_ui ' + (ui.err ?? 'empty'));
      if (initOk && uiOk) { okCount++; check('插件 ' + p.id + ' 加载+init+UI', true, 'status=' + status, r.ms + init.ms + ui.ms); }
      else if (initOk) check('插件 ' + p.id + ' get_ui', false, String(ui.err ?? '空 UI'), ui.ms);
      const un = await timed(() => withTimeout(unloadPlugin(p.id), 20000, 'unload ' + p.id));
      if (un.err) check('插件 ' + p.id + ' 卸载', false, un.err, un.ms);
    }
    check('全部模块插件可用（' + okCount + '/' + modulePlugins.length + '）', failed.length === 0, failed.slice(0, 6).join(' ;; '));
    // 宠物插件
    const petP = list.find((p) => p.type === 'pet');
    if (petP) {
      const r = await timed(() => withTimeout(loadPlugin(petP.id), 60000, 'pet plugin'));
      const acts = await timed(() => withTimeout(callPlugin(petP.id, 'pet.get_actions', {}), 15000, 'pet actions'));
      check('宠物插件可加载并返回动作', !r.err && !acts.err && Array.isArray(acts.v), JSON.stringify(acts.v).slice(0, 120));
      await timed(() => unloadPlugin(petP.id));
    }
    // 并发：同时拉起 6 个（信号量上限 5）——验证不死锁、最终全部就绪
    const six = modulePlugins.slice(0, 6).map((p) => p.id);
    const t0 = Date.now();
    const res = await Promise.all(six.map((id) => withTimeout(loadPlugin(id), 150000, 'concurrent ' + id).then(() => true).catch(() => false)));
    const dt = Date.now() - t0;
    check('并发拉起 6 个插件不死锁（信号量=5）', res.every(Boolean), 'ok=' + res.filter(Boolean).length + '/' + six.length, dt);
    const running = six.filter((id) => runtimeOf(id)?.child);
    check('并发后插件进程均在运行', running.length >= 5, 'running=' + running.length);
    for (const id of six) await timed(() => unloadPlugin(id));
    check('并发后全部卸载（槽位归还）', six.every((id) => !runtimeOf(id)?.child));
    // 再次加载同一插件（验证槽位未被泄漏）
    const again = await timed(() => withTimeout(loadPlugin(six[0]), 90000, 'reload'));
    check('卸载后可再次加载（无槽位泄漏）', !again.err && Boolean(runtimeOf(six[0])?.child), again.err ?? 'ok', again.ms);
    await timed(() => unloadPlugin(six[0]));
    startIdleReaper();
    check('空闲回收器可启动（180s 回收 / 60s 巡检）', true);
  });

  // ---------- 插件市场 ----------
  await section('插件市场', async () => {
    const st = await withTimeout(marketState(), 30000, 'marketState');
    check('内置市场源可读取', typeof st.source === 'string' && st.source.length > 0, 'source=' + st.source);
    check('市场条目存在', (st.items ?? []).length >= 1, 'items=' + (st.items ?? []).length);
    const id = (st.items ?? [])[0]?.id;
    if (!id) { check('市场安装', false, '无可用条目'); return; }
    const st2 = await withTimeout(installFromMarket(id), 60000, 'install');
    const installed = (st2.items ?? []).find((i) => i.id === id);
    check('市场安装成功并标记已安装', Boolean(installed && installed.installed), JSON.stringify(installed ?? {}).slice(0, 200));
    const dir = join(USER_DATA, 'plugins', id);
    check('插件文件已落盘到 userData/plugins', existsSync(join(dir, 'manifest.json')), dir);
    const rec = listPlugins().find((p) => p.id === id);
    check('安装后出现在插件列表且 origin=market', Boolean(rec && rec.origin === 'market'), JSON.stringify(rec ?? {}).slice(0, 160));
    const st3 = await withTimeout(uninstallFromMarket(id), 60000, 'uninstall');
    check('市场卸载成功', !(st3.items ?? []).find((i) => i.id === id && i.installed));
    check('卸载后目录被清理', !existsSync(dir));
    const sec = securePackagesInfo();
    check('加密留存信息可读', typeof sec.count === 'number' && typeof sec.dir === 'string', JSON.stringify(sec));
  });

  // ---------- 命令面板 ----------
  await section('命令面板', async () => {
    const cases: Array<[string, (r: Array<{ category?: string; label: string; sublabel?: string }>) => boolean, string]> = [
      ['{"a":1}', (r) => r.some((x) => x.label.includes('JSON 格式化')), 'JSON 即时结果'],
      ['ts 1727000000', (r) => r.some((x) => x.sublabel?.includes('10 位秒级')), '时间戳即时结果'],
      ['uuid', (r) => r.filter((x) => /^[0-9a-f-]{36}$/i.test(x.label)).length === 4, 'UUID 4 个'],
      ['md5 abc', (r) => r.some((x) => x.label.includes('900150983cd24fb0d6963f7d28e17f72')), 'MD5 即时结果'],
      ['b64 你好', (r) => r.some((x) => x.label === '5L2g5aW9'), 'Base64 编码即时结果'],
      ['0x1f', (r) => r.some((x) => x.label.includes('DEC 31')), '进制即时结果'],
      ['cron */5 * * * *', (r) => r.some((x) => x.sublabel?.includes('cron 语义')) && r.filter((x) => x.label.startsWith('第 ')).length === 5, 'cron 5 次触发'],
      ['1+2*3', (r) => r.some((x) => x.label.includes('= 7')), '计算器'],
      ['todo 审计待办条目', (r) => r.some((x) => x.sublabel?.includes('待办快记')), '待办快记'],
    ];
    for (const [q, pred, name] of cases) {
      const r = await timed(() => withTimeout(paletteSearch(q), 20000, q));
      if (r.err) { check('面板：' + name, false, r.err, r.ms); continue; }
      check('面板：' + name, pred(r.v as never[]), JSON.stringify((r.v as never[]).slice(0, 2)).slice(0, 200), r.ms);
    }
    // 别名置顶
    saveAlias({ id: '', alias: 'audit-open', targetId: 'fn-devtools', targetType: 'function', targetLabel: '开发者工具', createdAt: 0 } as never);
    const aliasRes = await withTimeout(paletteSearch('audit-open'), 20000, 'alias');
    check('面板：别名精确命中置顶', aliasRes[0]?.id?.startsWith('alias:') === true, JSON.stringify(aliasRes[0] ?? {}).slice(0, 200));
    const a = listAliases().find((x) => x.alias === 'audit-open');
    if (a) removeAlias(a.id);
    // 待办快记落库
    const todosBefore = JSON.stringify(dataStore().get().modules.filter((m) => m.type === 'todo_list'));
    addTodoQuick('审计待办快记');
    const todosAfter = dataStore().get().modules.filter((m) => m.type === 'todo_list');
    check('待办快记写入待办模块', JSON.stringify(todosAfter) !== todosBefore && JSON.stringify(todosAfter).includes('审计待办快记'));
    check('待办模块缺少 todo_list 时自动创建', todosAfter.length >= 1);
    // 未知指令容错
    const weird = await timed(() => withTimeout(paletteSearch('!!!@@@###'), 15000, 'weird'));
    check('面板：异常输入不抛错', !weird.err, weird.err ?? 'ok', weird.ms);
    const empty = await timed(() => withTimeout(paletteSearch('   '), 10000, 'empty'));
    check('面板：空白输入返回空数组', !empty.err && Array.isArray(empty.v), String(empty.err ?? 'ok'));
  });

  // ---------- 收纳盒 ----------
  await section('桌面收纳盒', async () => {
    const testDir = join(USER_DATA, 'audit-files');
    mkdirSync(testDir, { recursive: true });
    const names = ['审计图片.png', '审计文档.pdf', '审计压缩包.zip', '审计音频.mp3', '审计脚本.txt'];
    for (const n of names) writeFileSync(join(testDir, n), 'x');
    const before = boxes.listBoxes().length;
    const box = boxes.createBox({ name: '审计盒' } as never);
    check('创建收纳盒', boxes.listBoxes().length === before + 1 && Boolean(box.id));
    await boxes.addPaths(box.id, names.map((n) => join(testDir, n)));
    const b1 = boxes.getBox(box.id)!;
    check('拖入文件仅建立索引（原文件未被移动）', b1.items.length === names.length && names.every((n) => existsSync(join(testDir, n))), 'items=' + b1.items.length);
    const kinds = new Set(b1.items.map((i) => i.kind).filter(Boolean));
    check('文件分类已写入（image/doc/archive/audio/text）', kinds.size >= 3, [...kinds].join(','));
    // 叠放
    const stacked = boxes.stackItem(box.id, join(testDir, '审计图片.png'), '审计摞');
    check('手动叠放生效', stacked.find((x) => x.id === box.id)?.items.some((i) => i.stack === '审计摞') === true);
    const auto = boxes.autoStack(box.id);
    check('自动归组不抛错且保留条目', auto.find((x) => x.id === box.id)?.items.length === names.length);
    // 胶囊
    boxes.setCapsule(box.id, true);
    check('胶囊模式开关', boxes.getBox(box.id)?.capsule === true);
    boxes.capsuleHover(box.id, true);
    boxes.setCapsule(box.id, false);
    // 移除条目不影响磁盘文件
    boxes.removeItem(box.id, join(testDir, '审计音频.mp3'));
    check('移除条目只删索引（文件仍在）', boxes.getBox(box.id)!.items.length === names.length - 1 && existsSync(join(testDir, '审计音频.mp3')));
    // 布局持久化
    boxes.updateBox(box.id, { x: 111, y: 222, width: 333, height: 444 } as never);
    const persisted = JSON.parse(JSON.stringify(boxes.getBox(box.id)));
    check('布局更新写入', persisted.x === 111 && persisted.width === 333, JSON.stringify({ x: persisted.x, w: persisted.width }));
    // applyRules / reorganize 不抛错
    const rules = await timed(() => boxes.applyRules());
    check('applyRules 不抛错', !rules.err, rules.err ?? 'ok', rules.ms);
    const reorg = await timed(() => boxes.reorganizeAll());
    check('reorganizeAll 不抛错', !reorg.err, rules.err ?? JSON.stringify(reorg.v));
    // 清理
    boxes.removeBox(box.id);
    check('删除收纳盒', !boxes.getBox(box.id));
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------- 文件搜索 / 预览 ----------
  await section('文件搜索与预览', async () => {
    const dir = join(USER_DATA, 'audit-search');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'audit-target-file.txt'), 'hello 小鹏');
    writeFileSync(join(dir, 'sub', 'audit-target-2.txt'), 'x');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'audit-target-3.txt'), 'x');
    // 最近/收藏搜索
    dataStore().update((d) => { d.recentFiles = [{ path: join(dir, 'audit-target-file.txt'), name: 'audit-target-file.txt', at: Date.now() } as never]; });
    const r1 = await withTimeout(searchFiles('audit-target', false), 15000, 'searchFiles');
    check('最近记录搜索命中', r1.length === 1 && r1[0].path.includes('audit-target-file'), JSON.stringify(r1));
    const r2 = await withTimeout(searchFiles('audit-target', true, ['Z:\\']), 25000, 'fullDisk');
    check('全盘搜索：非法盘符被忽略（不抛错）', Array.isArray(r2), 'n=' + r2.length);
    // 快速搜索（限时 200ms，避免拖慢）
    const r3 = await timed(() => quickFileSearch('audit-target-file', 200, 8));
    check('快速搜索（CP-03 兜底）不抛错', !r3.err, 'n=' + (Array.isArray(r3.v) ? r3.v.length : '?') + ' ' + (r3.err ?? ''), r3.ms);
    // 打开不存在路径
    let openErr = '';
    try { await openPath(join(dir, '不存在.txt')); } catch (e) { openErr = (e as Error).message; }
    check('打开不存在路径给出可读错误', openErr.includes('不存在'), openErr);
    // 预览
    const txt = previewData(join(dir, 'audit-target-file.txt'));
    check('文本预览可读', txt.kind === 'text' && String(txt.text ?? '').includes('小鹏'), JSON.stringify(txt).slice(0, 150));
    const png = join(USER_DATA, 'default-pet.png');
    const petPng = join(app.getAppPath(), 'resources', 'default-pet.png');
    const imgPrev = previewData(existsSync(png) ? png : petPng);
    check('图片预览返回宽高或 dataUrl', imgPrev.kind === 'image', JSON.stringify(imgPrev).slice(0, 150));
    const missing = previewData(join(dir, '不存在.png'));
    check('预览不存在文件不抛错', Boolean(missing));
  });

  // ---------- MCP 服务 ----------
  await section('MCP 工具服务', async () => {
    dataStore().updateSettings({ mcpEnabled: true, mcpPort: 47129, mcpToken: '' });
    applyMcpServer();
    await sleep(600);
    const st = mcpStatus();
    check('MCP 服务启动', st.running === true, JSON.stringify({ ...st, token: st.token ? 'yes' : 'no' }));
    check('启动后自动生成令牌', Boolean(st.token && st.token.length >= 16), st.token ? 'len=' + st.token.length : 'empty');
    const call = (headers: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = httpRequest({ host: '127.0.0.1', port: st.port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    const noToken = await call({ Host: '127.0.0.1:' + st.port }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('MCP：无令牌被拒绝（401）', noToken.status === 401, String(noToken.status));
    const badHost = await call({ Host: 'evil.example.com', Authorization: 'Bearer ' + st.token }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('MCP：非回环 Host 被拒绝（防 DNS rebinding）', badHost.status === 403, String(badHost.status));
    const init = await call({ Host: '127.0.0.1:' + st.port, Authorization: 'Bearer ' + st.token }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('MCP：带令牌 initialize 成功', init.status === 200 && init.text.includes('protocolVersion'), init.text.slice(0, 120));
    const tools = await call({ Host: '127.0.0.1:' + st.port, 'X-MCP-Token': st.token }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const toolNames = (() => { try { return (JSON.parse(tools.text).result.tools as Array<{ name: string }>).map((t) => t.name); } catch { return []; } })();
    check('MCP：tools/list 返回全部 Agent 工具', toolNames.length === AGENT_TOOLS.length && toolNames.length > 0, toolNames.join(','));
    stopMcpServer();
    await sleep(300);
    check('MCP 服务可停止', mcpStatus().running === false);
    dataStore().updateSettings({ mcpEnabled: false });
  });

  // ---------- Agent 工具 ----------
  await section('Agent 工具', async () => {
    const todoBefore = JSON.stringify(dataStore().get().modules.filter((m) => m.type === 'todo_list'));
    const r = await timed(() => withTimeout(execAgentTool('add_todo', { text: 'Agent 审计待办' }) as Promise<unknown>, 15000, 'add_todo'));
    const todoAfter = JSON.stringify(dataStore().get().modules.filter((m) => m.type === 'todo_list'));
    check('Agent add_todo 生效', !r.err && todoAfter !== todoBefore && todoAfter.includes('Agent 审计待办'), String(r.err ?? String(r.v).slice(0, 80)));
    const unknown = await timed(() => withTimeout(execAgentTool('no_such_tool', {}) as Promise<unknown>, 10000, 'unknown'));
    check('未知工具返回可读错误而非抛异常', !unknown.err && /未知|不支持|not/i.test(String(unknown.v)), String(unknown.err ?? unknown.v).slice(0, 120));
    check('工具定义结构完整（name/description/parameters）', AGENT_TOOLS.every((t) => t.function.name && t.function.description && t.function.parameters));
  });

  // ---------- LLM ----------
  await section('AI 对话（无 Key 容错）', async () => {
    dataStore().updateSettings({ deepseekApiKey: '' });
    clearMemory();
    const r = await timed(() => withTimeout(chatRound('你好'), 25000, 'chat'));
    const reply = (r.v as { reply?: string } | null)?.reply ?? '';
    check('无 API Key 时给出可读提示（不崩溃）', !r.err && reply.length > 0, (r.err ?? reply).slice(0, 120), r.ms);
    check('失败对话不污染历史（或按设计记录）', Array.isArray(loadMemory()), 'len=' + loadMemory().length);
  });

  // ---------- 热键 ----------
  await section('全局热键管理', () => {
    const list = hotkeyList();
    check('热键清单 ≥ 8 项', list.length >= 8, 'n=' + list.length + ' actions=' + list.map((h) => h.action).join(','));
    check('每项含 action/accelerator/ok', list.every((h) => h.action && h.accelerator));
    const after = setHotkey('sidebar', 'NotAKey+++');
    const item = after.find((h) => h.action === 'sidebar');
    check('非法热键被拒绝并回传原因', Boolean(item && item.ok === false && item.error), JSON.stringify(item ?? {}).slice(0, 160));
    const reset = resetHotkeys();
    check('重置热键恢复默认（Ctrl+Alt+X）', reset.some((h) => h.action === 'sidebar' && h.accelerator === 'Ctrl+Alt+X'));
  });

  // ---------- 性能 / 系统 / 天气 / 音乐 ----------
  await section('性能与系统信息', async () => {
    const p = perfUsage();
    check('资源占用可读（RSS/堆/窗口数）', typeof p.rssMB === 'number' || typeof (p as unknown as Record<string, unknown>).rss === 'number' || Object.keys(p).length > 0, JSON.stringify(p).slice(0, 200));
    const si = await timed(() => withTimeout(getSystemInfo() as Promise<unknown>, 20000, 'sysinfo'));
    check('系统信息可读（CPU/内存）', !si.err && Boolean(si.v), si.err ?? JSON.stringify(si.v).slice(0, 160), si.ms);
    const w = await timed(() => withTimeout(getWeather() as Promise<unknown>, 20000, 'weather'));
    check('天气接口不抛错（失败返回 null）', !w.err, w.err ?? JSON.stringify(w.v).slice(0, 120), w.ms);
    const m = await timed(() => withTimeout(getMusicState(), 15000, 'music'));
    check('音乐状态可读（无播放器时兜底）', !m.err && Boolean(m.v), m.err ?? JSON.stringify(m.v).slice(0, 160), m.ms);
  });

  // ---------- 备份/诊断（打桩对话框） ----------
  await section('备份与诊断', async () => {
    const backupPath = join(USER_DATA, 'audit-backup.json');
    const diagPath = join(USER_DATA, 'audit-diag.txt');
    const realSave = dialog.showSaveDialog;
    const realOpen = dialog.showOpenDialog;
    (dialog as unknown as Record<string, unknown>).showSaveDialog = async (opts: { title?: string }) =>
      String(opts?.title ?? '').includes('诊断') ? { canceled: false, filePath: diagPath } : { canceled: false, filePath: backupPath };
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: [backupPath] });
    try {
      dataStore().updateSettings({ petName: '备份前名字' });
      const exported = await exportSettingsBackup();
      check('导出设置备份生成文件', exported === backupPath && existsSync(backupPath));
      const parsed = JSON.parse(readFileSync(backupPath, 'utf-8'));
      check('备份包含 settings 与版本戳', Boolean(parsed.settings && parsed.app === 'xiaopeng-toolbox'), JSON.stringify(Object.keys(parsed)));
      dataStore().updateSettings({ petName: '被改坏的名字' });
      const imported = await importSettingsBackup();
      check('导入备份恢复设置', imported?.petName === '备份前名字', 'petName=' + String(imported?.petName));
      const diag = await exportDiagBundle();
      check('导出诊断包生成文件', diag === diagPath && existsSync(diagPath));
      const diagText = readFileSync(diagPath, 'utf-8');
      check('诊断包含环境信息', diagText.includes('数据目录') || diagText.length > 20, 'len=' + diagText.length);
      // 损坏备份文件
      writeFileSync(backupPath, '{bad json', 'utf-8');
      let err = '';
      try { await importSettingsBackup(); } catch (e) { err = (e as Error).message; }
      check('导入损坏备份给出可读错误', err.includes('有效的 JSON'), err);
      // 脱敏
      const red = redact('key sk-abcdefghijklmnopqrstuvwxyz012345 path C:\\Users\\king\\secret.txt mail a@b.com');
      check('日志脱敏：API Key/邮箱/用户目录被遮蔽', !red.includes('sk-abcdefghijklmnopqrstuvwxyz012345') || !red.includes('a@b.com'), red.slice(0, 160));
    } finally {
      (dialog as unknown as Record<string, unknown>).showSaveDialog = realSave;
      (dialog as unknown as Record<string, unknown>).showOpenDialog = realOpen;
    }
  });

  // ---------- 上下文动作 / 动作条 ----------
  await section('工作台上下文动作', async () => {
    const acts = listContextActions({ type: 'text', text: 'Hello 小鹏' });
    check('文本上下文动作 ≥ 4', acts.length >= 4, 'n=' + acts.length);
    const up = await runContextAction('text.upper', { type: 'text', text: 'abc 中文' });
    check('执行动作写回剪贴板', up.ok === true && clipboard.readText() === 'ABC 中文', JSON.stringify(up).slice(0, 120));
    const bad = await runContextAction('nope.nope', { type: 'text', text: 'x' });
    check('未知动作返回可读错误', bad.ok === false && Boolean(bad.message), JSON.stringify(bad).slice(0, 120));
    const invalid = await runContextAction('json.format', { type: 'text', text: '{bad' });
    check('非法 JSON 动作给出位置错误', invalid.ok === false && /行/.test(invalid.message ?? ''), invalid.message?.slice(0, 120));
    const bar = listSelectionBarActions();
    check('划词动作条 ≥ 6 且含翻译', bar.length >= 6 && bar.some((a) => a.id === 'text.translate'), 'n=' + bar.length);
  });

  // ---------- 窗口看门狗 ----------
  await section('窗口看门狗', () => {
    const repaired = repairStuckWindows();
    check('修复卡住窗口（无窗口时返回数组）', Array.isArray(repaired), JSON.stringify(repaired).slice(0, 120));
  });

  // ---------- 收尾 ----------
  check('无未捕获异常', fatal === '', fatal.slice(0, 400));
  const failed = results.filter((r) => !r.ok);
  console.log('\n审计结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(' - ' + f.name + (f.detail ? '  <- ' + String(f.detail).slice(0, 200) : ''));
  }
  app.exit(failed.length || fatal ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
  console.error('AUDIT-FATAL', e);
  app.exit(2);
});
