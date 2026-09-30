/**
 * 独立审计运行器。用法：node test-audit/run-runtime.mjs [phase] [entry=runtime|verify]
 * 关键：把 bundle 放在仓库根目录，使 app.getAppPath() === 仓库根（否则 plugins/resources 找不到）
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2] || 'main';
const entry = process.argv[3] || 'runtime';
const BUNDLE = join(ROOT, '.audit-' + entry + '.cjs');
const USER_DATA = join(ROOT, 'out', 'audit', entry + '-userdata');

if (!existsSync(join(ROOT, 'out', 'renderer', 'deskboard.html'))) { console.error('缺少 out/renderer，请先 npm run build'); process.exit(2); }
mkdirSync(join(ROOT, 'out', 'audit'), { recursive: true });
if (phase === 'main' || phase === 'fresh') rmSync(USER_DATA, { recursive: true, force: true });

await build({
  entryPoints: [join(ROOT, 'test-audit', entry + '-main.ts')],
  outfile: BUNDLE, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  external: ['electron', 'better-sqlite3'], logLevel: 'warning'
});

const electron = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const exe = existsSync(electron) ? electron : join(ROOT, 'node_modules', '.bin', 'electron');
const child = spawn(exe, [BUNDLE], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, XP_AUDIT: '1', XP_AUDIT_ROOT: ROOT, XP_AUDIT_USERDATA: USER_DATA, XP_AUDIT_PHASE: phase, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
});
const timer = setTimeout(() => { console.error('审计超时（25 分钟），强制结束'); child.kill(); }, 25 * 60 * 1000);
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  try { rmSync(BUNDLE, { force: true }); } catch { /* 忽略 */ }
  if (code !== 0) console.error('审计进程退出：code=' + code + ' signal=' + (signal ?? '-'));
  process.exit(code ?? 1);
});
