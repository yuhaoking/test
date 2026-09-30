/** 审计（第四轮）：命令面板首次呼出焦点复现 + 截图保存/光标等未被覆盖的 IPC */
import { app, BrowserWindow, clipboard } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataStore } from '../electron/store/dataStore';

const ROOT = process.env['XP_AUDIT_ROOT'] || app.getAppPath();
const USER_DATA = process.env['XP_AUDIT_USERDATA'] || join(ROOT, 'out', 'audit', 'focus-userdata');
app.setPath('userData', USER_DATA);
app.disableHardwareAcceleration();
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(join(USER_DATA, 'saves'), { recursive: true });
app.on('window-all-closed', () => { /* keep alive */ });

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? '  <- ' + detail : ''));
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const preload = join(ROOT, 'out', 'preload', 'index.js');
  const page = join(ROOT, 'out', 'renderer', 'palette.html');
  // 复现主进程 showPalette 的真实时序：创建窗口 → loadFile → 立即 send('palette:shown')
  const w = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  const loadPromise = w.loadFile(page);
  w.webContents.send('palette:shown'); // 与 paletteWindow.showPalette() 同一时刻（页面尚未加载）
  console.log('  ..  发出 palette:shown 时 isLoading=' + w.webContents.isLoading());
  await loadPromise;
  await sleep(2200);
  const first = String(await w.webContents.executeJavaScript('document.activeElement ? document.activeElement.tagName + (document.activeElement.className ? "." + String(document.activeElement.className).split(" ")[0] : "") : "none"'));
  check('首次呼出（事件在加载前发出）输入框获得焦点', first.startsWith('INPUT'), 'activeElement=' + first + '  ← 事件丢失导致 onShown 回调未执行');
  const firstResults = await w.webContents.executeJavaScript('document.querySelectorAll(".palette-body [data-idx]").length');
  check('首次呼出已展示结果（剪贴板推荐/搜索结果）', Number(firstResults) > 0, '结果条数=' + firstResults);
  // 对照组：页面就绪后再发一次
  w.webContents.send('palette:shown');
  await sleep(1500);
  const second = String(await w.webContents.executeJavaScript('document.activeElement ? document.activeElement.tagName : "none"'));
  check('第二次发出（页面已就绪）输入框获得焦点', second.startsWith('INPUT'), 'activeElement=' + second);
  w.destroy();

  // 截图相关 IPC（不触发全屏遮罩）
  const { cursorPos, saveImage, copyImage } = await import('../electron/services/captureManager');
  const cur = cursorPos();
  check('capture:cursor 返回坐标', typeof cur?.x === 'number' && typeof cur?.y === 'number', JSON.stringify(cur));
  dataStore().updateSettings({ saveDir: join(USER_DATA, 'saves') });
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const saved = saveImage(dataUrl);
  check('截图保存返回路径', typeof saved === 'string' && saved.length > 0, String(saved));
  check('截图文件确实写入磁盘', Boolean(saved && existsSync(saved)), String(saved));
  copyImage(dataUrl);
  check('截图复制到剪贴板', !clipboard.readImage().isEmpty());

  const failed = results.filter((r) => !r.ok);
  console.log('\n焦点/截图取证：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  app.exit(0);
}
app.whenReady().then(main).catch((e) => { console.error('FOCUS-FATAL', e); app.exit(2); });
