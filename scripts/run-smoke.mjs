/**
 * 运行期冒烟测试启动器（\`npm run smoke\`）
 *
 * 1) 用 esbuild 把 scripts/smoke-main.ts（含主进程服务源码）打成 CJS 包；
 * 2) 把 out/renderer + out/preload **快照**到临时目录（避免 npm run dev 正在重建时读到半个文件）；
 * 3) 用项目自带 Electron 以独立进程运行：隐藏窗口 + 临时 userData，不弹 UI、不动用户数据。
 * 退出码 0 = 全绿。
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'out', 'smoke');
const BUNDLE = join(OUT_DIR, 'smoke-main.cjs');

if (!existsSync(join(ROOT, 'out', 'renderer', 'deskboard.html')) || !existsSync(join(ROOT, 'out', 'preload', 'index.js'))) {
  console.error('缺少 out/renderer 或 out/preload，请先执行 npm run build');
  process.exit(2);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
// 快照渲染产物：即使此刻有 npm run dev 在重建 out/，冒烟测试读到的也是一份完整拷贝
cpSync(join(ROOT, 'out', 'renderer'), join(OUT_DIR, 'renderer'), { recursive: true });
cpSync(join(ROOT, 'out', 'preload'), join(OUT_DIR, 'preload'), { recursive: true });
/*
 * 快照 resources/：主进程的 resourcesRoot() 取的是 app.getAppPath()/resources，
 * 而冒烟进程的 app 根目录就是本快照目录 —— 不复制的话「内置宠物形象 / 动作帧」在冒烟环境下
 * 全部不存在（T-06 主题包段落因此抓到：导出的模板缺少 pet.png、回退默认形象指向不存在的文件）。
 */
cpSync(join(ROOT, 'resources'), join(OUT_DIR, 'resources'), { recursive: true });

await build({
  entryPoints: [join(ROOT, 'scripts', 'smoke-main.ts')],
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
const child = spawn(exe, [BUNDLE], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    XP_SMOKE: '1',
    // XP_SMOKE_ROOT = 渲染产物快照目录（页面从这里加载）；XP_SMOKE_REPO = 仓库根（桩插件等原始资产在这里）
    XP_SMOKE_ROOT: OUT_DIR,
    XP_SMOKE_REPO: ROOT,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
});

let finished = false;
const timer = setTimeout(() => {
  console.error('冒烟测试超时（180s），强制结束');
  child.kill();
}, 180000);

child.on('exit', (code, signal) => {
  finished = true;
  clearTimeout(timer);
  if (code !== 0) console.error(`\n冒烟进程退出：code=${code} signal=${signal ?? '-'}（1=有失败项，2=启动即失败，null/异常=进程崩溃）`);
  try {
    rmSync(OUT_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败可忽略 */
  }
  process.exit(code ?? 1);
});

process.on('exit', () => {
  if (!finished) {
    try {
      rmSync(OUT_DIR, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});
