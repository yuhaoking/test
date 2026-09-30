/**
 * 为打包产物写入 Windows 版本资源与图标（R2-T5 的"无证书可做"部分，也是 RUN-001 的关键一招）
 *
 * 【为什么必须做】
 * 1) 审计 SEC-R01：electron-builder.yml 里 `signAndEditExecutable: false`，导致产物
 *    **完全没有被资源编辑**：实测 exe 的版本资源仍是 `ProductName=Electron / CompanyName=GitHub, Inc.`，
 *    且与 `node_modules/electron/dist/electron.exe` **字节数完全相同**。
 * 2) 实测故障（RUN-001 的表象之一）：**普通双击毫无反应、以管理员身份运行才起得来**。
 *    一个"无版本资源 + 无图标 + 名字不常见"的 exe，正是 Windows PCA/杀软
 *    判定"可疑安装程序"的典型特征 —— 而 PCA 的 Installer shim 会介入进程创建，
 *    与 Chromium 创建沙箱子进程冲突（环境快照里长期出现 `__COMPAT_LAYER=... Installer`）。
 *
 * 【为什么不用 electron-builder 自带的资源编辑】
 * 它的 `signAndEditExecutable` 依赖 **rcedit-x64.exe**，而该文件来自 `rcedit-windows-2_0_0.zip`，
 * 必须从 GitHub 下载（本机不可达；缓存里只有旧版 rcedit-ia32.exe，另留了 3 个 0 字节的失败残留）。
 * 因此这里改用 electron-builder **自带**的纯 JS 实现 `app-builder-lib/out/util/resEdit.js`
 * （底层是 `resedit` 纯 JS PE 资源编辑器）—— 同一个编辑逻辑，零外部下载。
 *
 * 【安全边界】本脚本只改**版本资源与图标**，不签名、不改清单的权限级别
 * （requestedExecutionLevel 继续用 Electron 自带的 asInvoker）。
 *
 * 用法：node scripts/stamp-exe.mjs [<exe 路径>]
 *   默认路径 dist/win-unpacked/小鹏工具箱.exe；路径不存在时静默跳过（便于在非打包流程中调用）。
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXE = join(ROOT, 'dist', 'win-unpacked', '小鹏工具箱.exe');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const iconPath = join(ROOT, 'build', 'icon.ico');

async function main() {
  const exe = process.argv[2] ? process.argv[2] : DEFAULT_EXE;
  if (!existsSync(exe)) {
    console.log(`[stamp-exe] 跳过：未找到 ${exe}`);
    return 0;
  }

  // 动态导入：app-builder-lib 是 devDependency，且这里是 ESM 调用 CJS，需用 pathToFileURL
  const mod = await import(pathToFileURL(join(ROOT, 'node_modules', 'app-builder-lib', 'out', 'util', 'resEdit.js')).href);
  const edit = mod.editWindowsResources ?? mod.default?.editWindowsResources;
  if (typeof edit !== 'function') {
    console.error('[stamp-exe] 找不到 editWindowsResources，跳过（不影响构建）');
    return 1;
  }

  const version = String(pkg.version || '0.0.0');
  const before = readFileSync(exe).length;
  await edit({
    file: exe,
    versionStrings: {
      CompanyName: pkg.author || 'xiaopeng',
      FileDescription: pkg.description || '小鹏工具箱',
      ProductName: '小鹏工具箱',
      LegalCopyright: `Copyright © ${new Date().getFullYear()} ${pkg.author || 'xiaopeng'}`,
      OriginalFilename: '小鹏工具箱.exe',
      InternalName: 'xiaopeng-toolbox',
      // 版本资源里带上 Electron 版本：出问题时一眼能看出这个包是用哪个运行时打的
      Comments: `Electron ${process.versions.electron ?? '?'} / app ${version}`
    },
    fileVersion: `${version}.0`,
    productVersion: `${version}.0`,
    iconPath: existsSync(iconPath) ? iconPath : null,
    requestedExecutionLevel: 'asInvoker'
  });
  const after = readFileSync(exe).length;
  console.log(
    `[stamp-exe] 已写入版本资源与图标：${exe}` +
      `（${(before / 1048576).toFixed(0)}MB → ${(after / 1048576).toFixed(0)}MB，` +
      `ProductName=小鹏工具箱 FileVersion=${version}.0）`
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // 资源编辑失败**不应中断打包**：它只影响"看起来正规不正规"，不影响功能
    console.error('[stamp-exe] 资源编辑失败（不影响构建继续）：', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
