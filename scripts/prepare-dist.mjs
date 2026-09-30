/**
 * 打包前置清理（Windows）
 *
 * 背景：electron-builder 打包前必须清空 `dist/win-unpacked`。若上一次打包出的程序
 * **仍在运行**（主进程 + 渲染/GPU 等子进程会锁住 d3dcompiler_47.dll、ffmpeg.dll 等），
 * 清理会失败并中断构建：
 *     ⨯ remove ...\dist\win-unpacked\d3dcompiler_47.dll: Access is denied.
 *
 * 本脚本（`npm run dist` 的其中一步）：
 *   1) 清理 dist/ 下**上一轮构建的残留产物**（R2-T2 / QUAL-R02）；
 *   2) 结束所有**可执行文件位于本项目 dist/ 目录下**的进程（只动打包产物，不影响 dev 实例与其它程序）；
 *   3) 带重试地删除 `dist/win-unpacked`，若仍被占用（如杀毒软件扫描中）给出可操作的提示。
 *
 * 用法：node scripts/prepare-dist.mjs
 */
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(process.cwd());
const distDir = join(root, 'dist');
const unpackedDir = join(distDir, 'win-unpacked');

const sleep = (ms) => {
  // 同步等待（脚本为一次性流程，无需异步）
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
};

/**
 * 清掉 dist 下**上一轮构建的残留产物**（R2-T2 / QUAL-R02）。
 *
 * 为什么必须清：审计发现 dist 里同时躺着三类 exe —— 169KB 的中间安装器、206MB 的手工拼接物、
 * 159KB 的中间卸载器，而且**没有任何标记**说明哪个能用。
 * 后果是"测 A 发 B"，以及用户/同事把那个 169KB 的废文件当安装包去双击。
 * 一次构建只应留下一套同源产物，因此这里先清干净再打。
 */
function cleanStaleArtifacts() {
  if (!existsSync(distDir)) return;
  const stale = readdirSync(distDir).filter(
    (name) =>
      name.endsWith('__uninstaller.exe') ||
      name.includes('(merged)') ||
      /Setup.*\.exe$/i.test(name) ||
      name.endsWith('.nsis.7z') ||
      name === 'builder-debug.yml' ||
      name === 'builder-effective-config.yaml' ||
      name === 'dist-selfcheck.json'
  );
  for (const name of stale) {
    try {
      rmSync(join(distDir, name), { recursive: true, force: true });
      console.log(`[prepare-dist] 已清理上一轮产物：${name}`);
    } catch (e) {
      console.warn(`[prepare-dist] 清理 ${name} 失败（可忽略）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 列出可执行文件位于本项目 dist/ 下的进程 PID */
function listDistProcesses() {
  // 注意：项目路径可能含中文（如 D:\mimo小鹏工具箱\dist）。
  // 直接把路径拼进 `powershell -Command` 会被控制台代码页破坏匹配，
  // 因此通过环境变量传入（CreateProcessW 传递 Unicode，安全）。
  const script =
    `$root = $env:XPOS_DIST_DIR; if (-not $root) { exit 0 }; ` +
    `Get-Process -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($root.ToLower()) } | ` +
    `ForEach-Object { "$($_.Id)|$($_.ProcessName)" }`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
    env: { ...process.env, XPOS_DIST_DIR: distDir }
  });
  if (res.status !== 0) return [];
  return (res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, name] = line.split('|');
      return { pid: Number(pid), name: name || 'unknown' };
    })
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0);
}

function killProcesses(list) {
  let killed = 0;
  for (const p of list) {
    const res = spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { encoding: 'utf-8' });
    if (res.status === 0) {
      killed += 1;
      console.log(`[prepare-dist] 已结束运行中的打包版实例：${p.name} (PID ${p.pid})`);
    }
  }
  return killed;
}

function removeUnpacked() {
  if (!existsSync(unpackedDir)) return true;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      rmSync(unpackedDir, { recursive: true, force: true });
      console.log('[prepare-dist] 已清空 dist/win-unpacked');
      return true;
    } catch (e) {
      const last = attempt === 6;
      if (last) {
        console.error(
          `[prepare-dist] 无法清空 dist/win-unpacked：${e instanceof Error ? e.message : String(e)}\n` +
            '  请检查：① 是否还有“小鹏工具箱”在运行（任务管理器结束即可）；② 杀毒软件/资源管理器预览是否占用该目录；\n' +
            '  处理后重跑 `npm run dist`。'
        );
        return false;
      }
      console.log(`[prepare-dist] 目录仍被占用，${attempt}/6 次重试 …`);
      sleep(1200);
    }
  }
  return false;
}

function main() {
  cleanStaleArtifacts();
  if (process.platform !== 'win32') {
    // 其它平台没有该锁定问题，直接走删除
    removeUnpacked();
    return;
  }
  let running = listDistProcesses();
  if (running.length) {
    console.log(`[prepare-dist] 检测到 ${running.length} 个来自 dist 的进程，正在结束 …`);
    killProcesses(running);
    sleep(800);
    // 复核一次：主进程结束会带走子进程，仍残留的再补杀
    running = listDistProcesses();
    if (running.length) killProcesses(running);
  }
  if (!removeUnpacked()) process.exit(1);
}

main();
