/**
 * 真机性能基准启动器（\`npm run bench\`）
 *
 * 与 npm run smoke 同款做法：esbuild 打包 → 快照渲染产物 → 独立 Electron 进程（隐藏窗口 + 临时 userData）。
 * 带 --js-flags=--expose-gc，便于测量前主动回收，拿到更干净的内存增量。
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'out', 'bench');
const BUNDLE = join(OUT_DIR, 'bench-main.cjs');

if (!existsSync(join(ROOT, 'out', 'renderer', 'deskboard.html')) || !existsSync(join(ROOT, 'out', 'preload', 'index.js'))) {
  console.error('缺少 out/renderer 或 out/preload，请先执行 npm run build');
  process.exit(2);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
cpSync(join(ROOT, 'out', 'renderer'), join(OUT_DIR, 'renderer'), { recursive: true });
cpSync(join(ROOT, 'out', 'preload'), join(OUT_DIR, 'preload'), { recursive: true });

await build({
  entryPoints: [join(ROOT, 'scripts', 'bench-main.ts')],
  outfile: BUNDLE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', 'better-sqlite3'],
  logLevel: 'warning'
});

const electron = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const exe = existsSync(electron) ? electron : join(ROOT, 'node_modules', '.bin', 'electron');
const child = spawn(exe, ['--js-flags=--expose-gc', BUNDLE], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, XP_BENCH: '1', XP_BENCH_ROOT: OUT_DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
});

const timer = setTimeout(() => {
  console.error('基准超时（10 分钟），强制结束');
  child.kill();
}, 600000);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (code !== 0) console.error(`\n基准进程退出：code=${code} signal=${signal ?? '-'}`);
  try {
    rmSync(OUT_DIR, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  process.exit(code ?? 1);
});
