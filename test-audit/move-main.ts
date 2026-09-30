/** 审计（第三轮）：收纳盒「真移动」模式跨盘符移动目录 */
import { app, dialog } from 'electron';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataStore } from '../electron/store/dataStore';
import { db } from '../electron/store/db';
import * as boxes from '../electron/services/desktopBoxes';

const ROOT = process.env['XP_AUDIT_ROOT'] || app.getAppPath();
const USER_DATA = process.env['XP_AUDIT_USERDATA'] || join(ROOT, 'out', 'audit', 'move-userdata');
app.setPath('userData', USER_DATA);
app.disableHardwareAcceleration();
mkdirSync(USER_DATA, { recursive: true });
app.on('window-all-closed', () => { /* keep alive */ });

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? '  <- ' + detail : ''));
}
async function main(): Promise<void> {
  (dialog as unknown as Record<string, unknown>).showMessageBox = async () => ({ response: 0, checkboxChecked: false });

  const srcRoot = join(USER_DATA, 'src');
  const srcDir = join(srcRoot, '审计目录');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'a.txt'), 'hello');

  const sameTarget = join(USER_DATA, 'target-same');
  const crossTarget = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'king' + String.fromCharCode(92) + 'AppData' + String.fromCharCode(92) + 'Local' + String.fromCharCode(92) + 'Temp' + String.fromCharCode(92) + 'audit-move-target';

  dataStore().updateSettings({ boxMoveMode: true, desktopBoxesEnabled: true });

  // 同盘符：应成功移动
  const boxA = boxes.createBox({ name: '同盘盒', targetDir: sameTarget } as never);
  await boxes.addPaths(boxA.id, [srcDir]);
  const sameMoved = existsSync(join(sameTarget, '审计目录', 'a.txt')) && !existsSync(srcDir);
  check('同盘符移动目录成功（renameSync 路径）', sameMoved, 'target=' + sameTarget + ' exists=' + existsSync(join(sameTarget, '审计目录')) + ' srcGone=' + !existsSync(srcDir));

  // 跨盘符：应（走 copyFileSync 回退）
  const srcDir2 = join(srcRoot, '审计目录2');
  mkdirSync(srcDir2, { recursive: true });
  writeFileSync(join(srcDir2, 'b.txt'), 'hello2');
  const boxB = boxes.createBox({ name: '跨盘盒', targetDir: crossTarget } as never);
  let thrown = '';
  try { await boxes.addPaths(boxB.id, [srcDir2]); } catch (e) { thrown = (e as Error).message; }
  const crossMoved = existsSync(join(crossTarget, '审计目录2', 'b.txt'));
  const srcGone = !existsSync(srcDir2);
  check('跨盘符移动目录成功（期望：文件出现在目标盘）', crossMoved, 'thrown=' + thrown + ' targetExists=' + existsSync(join(crossTarget, '审计目录2')) + ' srcStillThere=' + !srcGone);
  check('移动失败时对用户有反馈（不应静默）', crossMoved || thrown !== '', thrown ? '抛出：' + thrown : '无异常、无提示、文件未移动 → 静默失败');
  const logRows = db().all('move_log');
  console.log('  ..  move_log 条数=' + logRows.length + ' ' + JSON.stringify(logRows.map((r) => r.value)).slice(0, 300));

  // 对照：单文件跨盘移动
  const srcFile = join(srcRoot, 'single.txt');
  writeFileSync(srcFile, 'x');
  const boxC = boxes.createBox({ name: '跨盘文件盒', targetDir: crossTarget } as never);
  await boxes.addPaths(boxC.id, [srcFile]);
  check('跨盘符移动单个文件成功（copyFileSync 正常）', existsSync(join(crossTarget, 'single.txt')) && !existsSync(srcFile));

  // 清理
  try { rmSync(crossTarget, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const failed = results.filter((r) => !r.ok);
  console.log('\n移动取证：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  app.exit(failed.length ? 1 : 0);
}
app.whenReady().then(main).catch((e) => { console.error('MOVE-FATAL', e); app.exit(2); });
