/**
 * i18n 覆盖率报告（T-12）
 *
 * 为什么需要它：本轮只本地化了"外壳"（托盘 / 宠物右键 / 工作台 / 命令面板 / 设置导航 / 常用动作），
 * 长尾文案仍是硬编码中文。与其在文档里写一句模糊的"部分支持"，不如给一个可复跑的数字：
 * 每次迭代跑一次，看它还降不降。
 *
 * 统计口径：`.vue` / `.ts` 中含中日韩统一表意文字、且不是纯注释的行。
 * 明确排除：字典与转换表自身（它们本来就是中文）、测试与构建脚本、node_modules。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['node_modules', 'out', 'dist', 'test-audit', 'engines', '.git', 'scripts']);
const EXCLUDE_FILES = [/shared[\\/]i18n[\\/]/];

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (EXCLUDE_DIRS.has(n)) continue;
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (['.vue', '.ts'].includes(extname(n))) out.push(p);
  }
  return out;
}

const isComment = (t) => t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
const hasHan = (s) => /[\u4e00-\u9fa5]/.test(s);

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'electron'))].filter(
  (f) => !EXCLUDE_FILES.some((re) => re.test(f))
);

const rows = [];
let total = 0;
for (const f of files) {
  const lines = readFileSync(f, 'utf-8').split('\n');
  let n = 0;
  for (const l of lines) {
    if (isComment(l.trim())) continue;
    if (hasHan(l)) n++;
  }
  if (n) rows.push([relative(ROOT, f).replace(/\\/g, '/'), n]);
  total += n;
}
rows.sort((a, b) => b[1] - a[1]);

console.log('i18n 覆盖率报告（T-12）');
console.log('统计范围：src/ 与 electron/ 中非注释的含中文行（不含 shared/i18n 字典本身）');
console.log('');
console.log('  待本地化行数合计: ' + total);
console.log('  涉及文件数: ' + rows.length);
console.log('');
console.log('  已本地化的外壳（本轮）：');
console.log('    electron/services/trayManager.ts     托盘菜单');
console.log('    electron/ipc/petIpc.ts               宠物右键菜单');
console.log('    electron/services/windowWatchdog.ts  崩溃/恢复通知');
console.log('    src/DeskboardApp.vue                 工作台（左栏/卡片/上下文标签/提示）');
console.log('    src/PaletteApp.vue                   命令面板占位符');
console.log('    src/views/SettingsView.vue           设置导航 + 语言选择器');
console.log('    src/views/SidebarView.vue            侧边栏按钮标题');
console.log('');
console.log('  剩余最多的文件（下一轮优先）：');
for (const [f, n] of rows.slice(0, 12)) console.log('    ' + String(n).padStart(4) + '  ' + f);
console.log('');
console.log('提示：新增文案请优先走 t(key)；直接写中文不会报错，但会计入上面的数字。');
