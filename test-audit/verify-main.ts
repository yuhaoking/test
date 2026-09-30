/**
 * 独立审计（第二轮）：对首轮与子代理报告中的缺陷逐条做运行期取证。
 * 全部在临时 userData 中；不写用户真实数据。
 */
import { app, BrowserWindow, clipboard, dialog, nativeImage } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { dataStore } from '../electron/store/dataStore';
import * as cm from '../electron/services/clipboardManager';
import { expandSnippet, removeSnippet, saveSnippet } from '../electron/services/snippets';
import { captureContext } from '../electron/services/contextCapture';
import { exportAliases, importAliases, listAliases, removeAlias, saveAlias } from '../electron/services/aliases';
import { installFromMarket, marketState, uninstallFromMarket } from '../electron/services/marketplace';
import { listPlugins, loadPlugin, removePlugin, unloadPlugin, runtimeOf } from '../electron/services/pluginManager';
import { previewData } from '../electron/services/filePreview';
import * as boxes from '../electron/services/desktopBoxes';
import { importSettingsBackup } from '../electron/services/backup';
import { createSidebarWindow, showSidebar, sidebarWindow } from '../electron/windows/sidebarWindow';
import { paletteWindow, showPalette } from '../electron/windows/paletteWindow';

const ROOT = process.env['XP_AUDIT_ROOT'] || app.getAppPath();
const USER_DATA = process.env['XP_AUDIT_USERDATA'] || join(ROOT, 'out', 'audit', 'verify-userdata');
app.setPath('userData', USER_DATA);
app.disableHardwareAcceleration();
mkdirSync(USER_DATA, { recursive: true });
app.on('window-all-closed', () => { /* 保持进程存活 */ });

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? '  <- ' + String(detail).slice(0, 400) : ''));
}
function info(msg: string): void { console.log('  ..  ' + msg); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); } catch (e) { check('[异常] ' + name, false, (e as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(e)); }
}
function ps(script: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', timeout: 15000 });
  return (r.stdout || '') + (r.stderr || '');
}

async function main(): Promise<void> {
  // ---- 1. 加密存储覆盖面：缩略图/OCR 是否明文 ----
  await section('加密覆盖面', async () => {
    dataStore().updateSettings({ clipboardEncrypt: true, clipboardImages: true, clipboardOcr: false, clipboardExcludeKeywords: [] });
    cm.startClipboardMonitor();
    cm.clearClipboard(false);
    const img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    clipboard.writeImage(img);
    await sleep(3000);
    const imgs = cm.listClipboard({ kind: 'image' });
    check('加密模式下截图已入库', imgs.length > 0, 'images=' + imgs.length);
    const dir = join(USER_DATA, 'clipboard-images');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    info('clipboard-images 内容：' + files.join(', '));
    const binFile = files.find((f) => f.endsWith('.png.bin'));
    const thumbFile = files.find((f) => f.endsWith('.thumb.png'));
    check('整图已加密为 .png.bin', Boolean(binFile));
    check('缩略图仍以明文 PNG 落盘（加密承诺被绕过）', Boolean(thumbFile), thumbFile ? '文件：' + thumbFile + '，首字节=' + [...readFileSync(join(dir, thumbFile)).subarray(0, 4)].join(',') : '未找到缩略图');
    if (thumbFile) {
      const head = readFileSync(join(dir, thumbFile));
      check('缩略图确认为可解码 PNG（明文证据）', head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47);
      const viaApi = cm.clipboardImage(imgs[0].id, false);
      check('缩略图可经 API 直接读出明文', Boolean(viaApi && viaApi.data.length > 0), 'bytes=' + (viaApi ? viaApi.data.length : 0));
    }
    // OCR 文本是否明文入库（不实际跑 OCR，检查条目字段在加密模式下的存储形态）
    const raw = existsSync(join(USER_DATA, 'data-v2.json')) ? readFileSync(join(USER_DATA, 'data-v2.json'), 'utf-8') : '';
    info('数据文件中 clipboard 行数（明文 JSON 后端）：' + (raw.match(/"kind":"image"/g) || []).length);
    dataStore().updateSettings({ clipboardEncrypt: false });
    cm.stopClipboardMonitor();
  });

  // ---- 2. 数组类设置被写成对象 → 剪贴板监听停摆 ----
  await section('设置类型错乱 → 剪贴板停摆', async () => {
    dataStore().updateSettings({ clipboardExcludeKeywords: { x: 1 } as unknown as string[] });
    const accepted = dataStore().get().settings.clipboardExcludeKeywords as unknown;
    check('非数组值被设置接口接受（应为数组）', !Array.isArray(accepted), 'typeof=' + typeof accepted + ' value=' + JSON.stringify(accepted));
    cm.startClipboardMonitor();
    cm.clearClipboard(false);
    const marker = 'audit-typeconfusion-' + Date.now();
    clipboard.writeText(marker);
    await sleep(2500);
    const recorded = cm.listClipboard().some((e) => e.text === marker);
    check('类型错乱后剪贴板历史停摆（用户可见症状）', !recorded, recorded ? '仍记录了（未复现）' : '未记录 → 监听已被破坏');
    dataStore().updateSettings({ clipboardExcludeKeywords: [] });
    const marker2 = 'audit-recovered-' + Date.now();
    clipboard.writeText(marker2);
    await sleep(2500);
    check('恢复数组后监听自动恢复', cm.listClipboard().some((e) => e.text === marker2));
    cm.stopClipboardMonitor();
  });

  // ---- 3. 呼出工作台是否销毁「复制的文件」剪贴板 ----
  await section('工作台取词对文件剪贴板的破坏', async () => {
    const f = join(USER_DATA, 'clip-file-test.txt');
    writeFileSync(f, 'hello');
    ps('Set-Clipboard -Path "' + f + '"');
    await sleep(400);
    const before = clipboard.availableFormats();
    info('复制文件后剪贴板格式：' + before.join(', '));
    check('剪贴板中确实存在文件列表格式（CF_HDROP/FileNameW）', before.some((x) => /FileName|HDROP|FileNameW/i.test(x)), before.join(','));
    const holder = new BrowserWindow({ show: false, width: 300, height: 200 });
    await holder.loadURL('data:text/html,<html><body>audit</body></html>');
    holder.focus();
    await captureContext({ copyKey: true });
    await sleep(200);
    const after = clipboard.availableFormats();
    info('取词后剪贴板格式：' + after.join(', '));
    const lost = before.filter((x) => /FileName|HDROP/i.test(x)).filter((x) => !after.includes(x));
    check('文件剪贴板在取词后仍保留（否则用户复制的文件被销毁）', lost.length === 0, lost.length ? '丢失格式：' + lost.join(',') + ' → 剪贴板现为：' + JSON.stringify(clipboard.readText()).slice(0, 60) : '保留');
    holder.destroy();
  });

  // ---- 4. 片段展开是否污染剪贴板历史 ----
  await section('片段展开污染历史', async () => {
    dataStore().updateSettings({ clipboardExcludeKeywords: [], clipboardAppWhitelist: [] });
    cm.startClipboardMonitor();
    cm.clearClipboard(false);
    clipboard.writeText('baseline-' + Date.now());
    await sleep(1500);
    cm.clearClipboard(false);
    const list = saveSnippet({ id: '', name: '审计片段', abbr: 'auditabbr', content: '片段机密内容-' + Date.now(), createdAt: 0, updatedAt: 0 } as never);
    const snip = list.find((s) => s.abbr === 'auditabbr')!;
    expandSnippet(snip.id, false);
    await sleep(2500);
    const polluted = cm.listClipboard().some((e) => (e.text ?? '') === snip.content);
    check('内部写入的片段不应进入历史（当前会进入）', !polluted, polluted ? '历史中出现了片段内容 → 已污染' : '未污染');
    removeSnippet(snip.id);
    cm.stopClipboardMonitor();
  });

  // ---- 5. 备份导入未剥离 BOM ----
  await section('备份导入 BOM', async () => {
    const normal = join(USER_DATA, 'ok-backup.json');
    const bom = join(USER_DATA, 'bom-backup.json');
    const payload = JSON.stringify({ app: 'xiaopeng-toolbox', version: 1, settings: { petName: 'BOM 备份名' } });
    writeFileSync(normal, payload, 'utf-8');
    writeFileSync(bom, '\uFEFF' + payload, 'utf-8');
    const realOpen = dialog.showOpenDialog;
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: [normal] });
    let okErr = '';
    try { const s = await importSettingsBackup(); info('无 BOM 备份导入结果 petName=' + String(s?.petName)); } catch (e) { okErr = (e as Error).message; }
    check('无 BOM 备份可导入', okErr === '', okErr);
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: [bom] });
    let bomErr = '';
    try { await importSettingsBackup(); } catch (e) { bomErr = (e as Error).message; }
    (dialog as unknown as Record<string, unknown>).showOpenDialog = realOpen;
    check('带 BOM 的备份应可导入（记事本另存常见场景）', bomErr === '', bomErr ? '导入失败：' + bomErr : '成功');
    // 对照：项目其它 JSON 读取处会剥 BOM
    const bomData = join(USER_DATA, 'probe-bom.json');
    writeFileSync(bomData, '\uFEFF{"a":1}', 'utf-8');
    let plainErr = '';
    try { JSON.parse(readFileSync(bomData, 'utf-8')); } catch (e) { plainErr = (e as Error).message; }
    info('不剥 BOM 的 JSON.parse 结果：' + (plainErr || '成功'));
  });

  // ---- 6. 大文件文本预览是否整文件读入 ----
  await section('大文件预览阻塞', async () => {
    const big = join(USER_DATA, 'big-audit.log');
    writeFileSync(big, 'x');
    const size = 300 * 1024 * 1024;
    const fd = require('node:fs').openSync(big, 'r+');
    require('node:fs').ftruncateSync(fd, size);
    require('node:fs').closeSync(fd);
    info('已创建 ' + Math.round(statSync(big).size / 1024 / 1024) + 'MB 测试文件');
    const before = process.memoryUsage().rss;
    const t0 = Date.now();
    const p = previewData(big);
    const dt = Date.now() - t0;
    const after = process.memoryUsage().rss;
    const delta = Math.round((after - before) / 1024 / 1024);
    info('previewData 耗时 ' + dt + 'ms，RSS 增量 ' + delta + 'MB，返回文本长度 ' + String((p.text ?? '').length));
    check('预览大文件应只读前 512KB（不整文件读入）', delta < 60 && dt < 800, '耗时 ' + dt + 'ms / RSS +' + delta + 'MB / bytes=' + String((p.text ?? '').length));
    rmSync(big, { force: true });
  });

  // ---- 7. 卸载运行中的插件（EPERM） ----
  await section('移除运行中的插件', async () => {
    (dialog as unknown as Record<string, unknown>).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    const src = join(ROOT, 'plugins', 'example-plugin');
    const dst = join(USER_DATA, 'plugins', 'com.example.audit');
    mkdirSync(join(USER_DATA, 'plugins'), { recursive: true });
    // 复制一份示例插件到 userData（status=user，可移除）
    const copyDir = (from: string, to: string): void => {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from, { withFileTypes: true })) {
        if (e.isDirectory()) copyDir(join(from, e.name), join(to, e.name));
        else if (e.name !== 'manifest.json' || true) writeFileSync(join(to, e.name), readFileSync(join(from, e.name)));
      }
    };
    copyDir(src, dst);
    const mf = JSON.parse(readFileSync(join(dst, 'manifest.json'), 'utf-8'));
    mf.id = 'com.example.audit';
    mf.name = '审计用插件';
    writeFileSync(join(dst, 'manifest.json'), JSON.stringify(mf, null, 2), 'utf-8');
    const rec = listPlugins().find((p) => p.id === 'com.example.audit');
    check('userData 插件被识别为 user 来源', rec?.status === 'user', JSON.stringify(rec ?? {}).slice(0, 120));
    await loadPlugin('com.example.audit');
    check('插件已运行', Boolean(runtimeOf('com.example.audit')?.child));
    let rmErr = '';
    try { await removePlugin('com.example.audit'); } catch (e) { rmErr = (e as Error).message; }
    const leftover = existsSync(join(dst, 'main.py'));
    check('运行中直接移除插件不应报错（Windows EPERM）', rmErr === '', rmErr || '成功');
    check('插件目录应被完整删除', !existsSync(dst), leftover ? '残留：' + readdirSync(dst).join(',') : '已删除');
    await sleep(1200);
    if (existsSync(dst)) { try { rmSync(dst, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  });

  // ---- 8. 胶囊 expandBounds 陈旧 ----
  await section('胶囊 expandBounds 陈旧', () => {
    const box = boxes.createBox({ name: '审计胶囊盒' } as never);
    boxes.updateBox(box.id, { x: 10, y: 20, width: 300, height: 200 } as never);
    boxes.setCapsule(box.id, true);
    boxes.setCapsule(box.id, false);
    boxes.updateBox(box.id, { x: 900, y: 800, width: 500, height: 400 } as never);
    const b = boxes.getBox(box.id) as unknown as Record<string, unknown>;
    info('盒数据：x=' + b.x + ' y=' + b.y + ' w=' + b.width + ' h=' + b.height + ' expandBounds=' + JSON.stringify(b.expandBounds));
    const eb = b.expandBounds as { x: number; y: number; width: number; height: number } | undefined;
    check('拖动后的位置不应被陈旧 expandBounds 覆盖', !eb || (eb.x === 900 && eb.y === 800), eb ? 'expandBounds 仍为 ' + JSON.stringify(eb) + '，boxWindow 会优先使用它' : '无 expandBounds');
    boxes.removeBox(box.id);
  });

  // ---- 9. 命令面板首次呼出：事件丢失/焦点缺失 ----
  await section('命令面板首次呼出', async () => {
    showPalette();
    const w = paletteWindow();
    check('面板窗口已创建', Boolean(w && !w.isDestroyed()));
    const loading = w ? w.webContents.isLoading() : true;
    info('showPalette 后立刻 isLoading=' + loading + '（palette:shown 已在此刻发出）');
    check('首次显示时渲染层已就绪（否则 palette:shown 丢失）', loading === false, loading ? 'isLoading=true → 事件在页面加载完成前发出，必然丢失' : '已就绪');
    await sleep(2500);
    const focused = w && !w.isDestroyed() ? await w.webContents.executeJavaScript('document.activeElement ? document.activeElement.tagName + (document.activeElement.className ? "." + document.activeElement.className : "") : "none"') : 'n/a';
    info('首次呼出后 document.activeElement = ' + focused);
    check('首次呼出输入框自动获得焦点', String(focused).startsWith('INPUT'), String(focused));
    showPalette();
    await sleep(1200);
    const focused2 = w && !w.isDestroyed() ? await w.webContents.executeJavaScript('document.activeElement ? document.activeElement.tagName : "none"') : 'n/a';
    check('第二次呼出焦点正常（对照组）', String(focused2).startsWith('INPUT'), String(focused2));
    if (w && !w.isDestroyed()) w.hide();
  });

  // ---- 10. 侧边栏关闭后无法恢复 ----
  await section('侧边栏窗口关闭后', async () => {
    const w = createSidebarWindow();
    check('侧边栏窗口创建成功', Boolean(w && !w.isDestroyed()));
    w.destroy();
    await sleep(300);
    check('销毁后 sidebarWindow() 为空', sidebarWindow() === null);
    showSidebar();
    await sleep(300);
    const revived = sidebarWindow();
    check('再次呼出侧边栏应能重建窗口', Boolean(revived && !revived.isDestroyed()), revived ? '已重建' : '仍为空 → 本次运行内侧边栏/宠物入口全部失效');
    if (revived && !revived.isDestroyed()) revived.destroy();
  });

  // ---- 11. 别名导入自身备份 ----
  await section('别名导出→导入', () => {
    const before = listAliases().length;
    saveAlias({ id: '', alias: 'audit-self', targetId: 'fn-devtools', targetType: 'function', targetLabel: '开发者工具', createdAt: 0 } as never);
    const json = exportAliases();
    const imp = importAliases(json);
    check('导出后原样导入应成功（自身备份恢复）', imp.ok === true, JSON.stringify(imp));
    const created = listAliases().find((a) => a.alias.toLowerCase() === 'audit-self');
    if (created) removeAlias(created.id);
    check('清理测试别名', listAliases().length === before);
  });

  // ---- 12. 插件依赖标记是否被 persist 覆盖 ----
  await section('插件依赖标记持久化', async () => {
    (dialog as unknown as Record<string, unknown>).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    const target = listPlugins().find((p) => p.id === 'office-convert-all') ?? listPlugins().find((p) => existsSync(join(p.dir, 'requirements.txt')));
    if (!target) { check('存在带 requirements 的插件用于验证', false, '未找到'); return; }
    info('目标插件 ' + target.id + '（含 requirements.txt）');
    await loadPlugin(target.id);
    const saved = dataStore().get().plugins.find((p) => p.id === target.id) as unknown as Record<string, unknown> | undefined;
    info('加载后持久化字段：depsInstalled=' + String(saved?.depsInstalled) + ' depsPython=' + String(saved?.depsPython));
    check('依赖安装标记应被保留（否则每次启动重跑 pip）', Boolean(saved?.depsInstalled), 'depsInstalled=' + String(saved?.depsInstalled));
    await unloadPlugin(target.id);
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n取证结果：' + (results.length - failed.length) + '/' + results.length + ' 通过（失败项即已复现的缺陷）');
  for (const f of failed) console.log(' - ' + f.name + (f.detail ? '  <- ' + String(f.detail).slice(0, 200) : ''));
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error('VERIFY-FATAL', e); app.exit(2); });
