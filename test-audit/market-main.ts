/** 审计（第五轮）：插件市场 安装→卸载→重装 的状态一致性 */
import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataStore } from '../electron/store/dataStore';
import { installFromMarket, marketState, uninstallFromMarket, upgradeFromMarket } from '../electron/services/marketplace';
import { listPlugins } from '../electron/services/pluginManager';

const ROOT = process.env['XP_AUDIT_ROOT'] || app.getAppPath();
const USER_DATA = process.env['XP_AUDIT_USERDATA'] || join(ROOT, 'out', 'audit', 'market-userdata');
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
  const st = await marketState();
  const item = st.items[0];
  check('市场源有条目', Boolean(item), 'items=' + st.items.length);
  if (!item) { app.exit(1); return; }
  const dir = join(USER_DATA, 'plugins', item.id);
  console.log('  ..  条目 ' + item.id + ' url=' + item.url + ' 已安装=' + String(item.installed));

  await installFromMarket(item.id);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  console.log('  ..  安装后目录文件：' + files.join(', '));
  check('安装后入口文件存在', files.includes('main.py') && files.includes('manifest.json'), files.join(','));
  check('安装后插件记录 origin=market', listPlugins().find((p) => p.id === item.id)?.origin === 'market');

  await uninstallFromMarket(item.id);
  check('卸载后插件目录被删除', !existsSync(dir), existsSync(dir) ? '仍存在，内容：' + readdirSync(dir).join(',') : '已删除');
  const afterRec = dataStore().get().plugins.find((p) => p.id === item.id);
  check('卸载后插件记录被清除', !afterRec, afterRec ? JSON.stringify(afterRec).slice(0, 160) : '已清除');
  check('卸载后 listPlugins 不再包含该插件', !listPlugins().some((p) => p.id === item.id));
  const st2 = await marketState();
  check('卸载后市场条目恢复为未安装', st2.items.find((i) => i.id === item.id)?.installed !== true);

  // 重装
  await installFromMarket(item.id);
  check('可重复安装（卸载→重装）', existsSync(join(dir, 'main.py')));
  // 重复安装
  let dupErr = '';
  try { await installFromMarket(item.id); } catch (e) { dupErr = (e as Error).message; }
  check('重复安装给出可读提示', dupErr.includes('已安装'), dupErr);
  // 升级（同版本）
  let upErr = '';
  let upState = '';
  try { const s = await upgradeFromMarket(item.id); upState = JSON.stringify(s.items.find((i) => i.id === item.id) ?? {}).slice(0, 160); } catch (e) { upErr = (e as Error).message; }
  check('升级（同版本）不抛异常', upErr === '', upErr || upState);
  check('升级后入口文件仍在', existsSync(join(dir, 'main.py')), existsSync(dir) ? readdirSync(dir).join(',') : '目录不存在');
  check('升级后插件记录仍是 market', listPlugins().find((p) => p.id === item.id)?.origin === 'market');

  const failed = results.filter((r) => !r.ok);
  console.log('\n市场取证：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  app.exit(0);
}
app.whenReady().then(main).catch((e) => { console.error('MARKET-FATAL', e); app.exit(2); });
