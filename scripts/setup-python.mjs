/**
 * 嵌入式 Python 安装脚本（一次性，供打包分发）
 *
 * 目标：把一份**自带 tkinter / tcl-tk / pip / ssl** 的 CPython 解压到 `engines/python`，
 * 打包时 electron-builder 将其打进应用，最终用户无需安装 Python 即可使用插件。
 *
 * 用法：npm run setup-python
 *
 * 为什么不用 python.org 的 embeddable + 完整安装包补 tkinter：
 * - embeddable 包不含 tkinter，而区域截图/区域录制插件依赖它；
 * - "完整安装包静默安装 + 提取组件" 依赖 Windows Installer 状态：一旦机器上存在
 *   指向已删除目录的僵尸注册（WixBundleInstalled=1），安装器会直接空跑（退出码 0 但
 *   什么都不装），卸载又会因 MSI 缓存缺失报 0x80070643 —— 构建脚本无法自愈；
 * - 这里改用 python-build-standalone（astral-sh）的 install_only 归档：纯 tar.gz、
 *   零注册、自带 tkinter 与 pip，解压即用，构建可重入且与机器状态无关。
 *
 * 注意：engines/ 已被 .gitignore 排除，产物不进 git。
 * 如需换版本：设置环境变量 XPOS_PY_URL 指向同结构的 install_only tar.gz 即可。
 */
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';

/** python-build-standalone 版本（install_only 归档，Windows x64） */
const PBS_TAG = '20260901';
const PY_VERSION = '3.12.14';
const PY_URL =
  process.env.XPOS_PY_URL ||
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PY_VERSION}%2B${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`;

const root = resolve(process.cwd());
const enginesDir = resolve(root, 'engines');
const pyDir = resolve(enginesDir, 'python');
const archivePath = resolve(enginesDir, 'python-standalone.tar.gz');
const extractDir = resolve(enginesDir, '.py-extract');
const pythonExe = resolve(pyDir, 'python.exe');
const tkinterInit = resolve(pyDir, 'Lib', 'tkinter', '__init__.py');

function step(name, fn) {
  process.stdout.write(`[setup-python] ${name} ... `);
  fn();
  process.stdout.write('ok\n');
}

function download(url, dest) {
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing`
    ],
    { stdio: 'ignore' }
  );
  if (res.status !== 0 || !existsSync(dest)) throw new Error(`下载失败: ${url}`);
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      total += st.isDirectory() ? dirSizeBytes(p) : st.size;
    } catch {
      /* 忽略无法读取的条目 */
    }
  }
  return total;
}

function mb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 解压 install_only 归档并把其中的 python/ 就位（先解到临时目录，再整体替换，避免半成品） */
function installRuntime() {
  download(PY_URL, archivePath);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'ignore' });
  const staged = join(extractDir, 'python');
  if (!existsSync(join(staged, 'python.exe'))) {
    throw new Error(`归档结构异常：未找到 ${join(staged, 'python.exe')}`);
  }
  rmSync(pyDir, { recursive: true, force: true });
  renameSync(staged, pyDir);
  rmSync(extractDir, { recursive: true, force: true });
  // 清理历史方案的遗留产物（embeddable zip / 完整安装包）
  rmSync(resolve(enginesDir, 'python-embed-amd64.zip'), { force: true });
  rmSync(resolve(enginesDir, 'python-3.12.9-amd64.exe'), { force: true });
  rmSync(resolve(enginesDir, 'py-layout'), { recursive: true, force: true });
  rmSync(resolve(enginesDir, 'py-full-tmp'), { recursive: true, force: true });
}

/** 递归收集指定后缀的文件 */
function collectFiles(dir, ext, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, ext, out);
    else if (e.name.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * 精简运行时（幂等）：删除调试符号与开发期组件，运行插件完全不需要，可显著减小安装包体积。
 * - *.pdb：独立构建自带约 80MB 调试符号（DLLs/ 根目录/venv 模板）
 * - idlelib / turtledemo / lib2to3 / test：IDE、示例与测试套件
 * 保留 include/ 与 libs/（插件 sdist 构建需要头文件与导入库）、ensurepip（pip 自愈兜底）。
 */
function pruneRuntime() {
  const removed = [];
  let bytes = 0;
  const removePath = (p) => {
    try {
      const st = statSync(p);
      bytes += st.isDirectory() ? dirSizeBytes(p) : st.size;
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      /* 不存在或占用中：跳过 */
    }
  };
  for (const pdb of collectFiles(pyDir, '.pdb')) removePath(pdb);
  for (const rel of ['Lib/idlelib', 'Lib/turtledemo', 'Lib/lib2to3', 'Lib/test', 'Lib/tkinter/test', 'tcl/nmake']) {
    removePath(resolve(pyDir, rel));
  }
  return { count: removed.length, savedMB: Math.round(bytes / 1024 / 1024) };
}

function main() {
  mkdirSync(enginesDir, { recursive: true });

  // 需要（重新）安装的条件：缺 python.exe，或缺 tkinter（旧 embeddable 布局没有 tkinter）
  const needRuntime = !existsSync(pythonExe) || !existsSync(tkinterInit);
  if (needRuntime) {
    const why = existsSync(pythonExe) ? '当前运行时缺少 tkinter，改用自带 tkinter 的构建' : '未检测到运行时';
    console.log(`[setup-python] ${why}，开始安装 ...`);
    step(`下载 CPython ${PY_VERSION}（自带 tkinter/tcl-tk/pip）`, installRuntime);
    console.log(`[setup-python] 运行时大小：${mb(dirSizeBytes(pyDir))}`);
  } else {
    console.log('[setup-python] engines/python 已就绪（含 tkinter），跳过下载与解压');
  }

  // 精简：删除调试符号与开发期组件（幂等，重复执行无副作用）
  let prune = { count: 0, savedMB: 0 };
  step('精简运行时（删除调试符号/示例/测试组件）', () => {
    prune = pruneRuntime();
  });
  if (prune.count) console.log(`[setup-python] 已清理 ${prune.count} 项，释放 ${prune.savedMB}MB`);

  // pip：install_only 归档自带 pip（通过 python -m pip 调用，不一定有 Scripts/pip.exe）
  const pipOk = spawnSync(pythonExe, ['-m', 'pip', '--version'], { encoding: 'utf-8' }).status === 0;
  if (!pipOk) {
    step('初始化 pip（ensurepip）', () => {
      const res = spawnSync(pythonExe, ['-m', 'ensurepip', '--upgrade'], { stdio: 'inherit', timeout: 600000 });
      if (res.status !== 0) throw new Error(`ensurepip 失败（退出码 ${res.status}）`);
    });
  } else {
    console.log('[setup-python] pip 已就绪');
  }

  const deps = collectPluginDeps();
  if (deps.length) {
    // 第一步：先装构建工具（sdist 构建需要 setuptools；两步安装避免顺序竞争）
    step('安装构建工具（setuptools / wheel）', () => {
      const res = spawnSync(
        pythonExe,
        ['-m', 'pip', 'install', 'setuptools', 'wheel', '--disable-pip-version-check', '--no-warn-script-location'],
        { stdio: 'inherit', timeout: 600000 }
      );
      if (res.status !== 0) throw new Error(`构建工具安装失败（退出码 ${res.status}）`);
    });
    step(`预装插件依赖（${deps.length} 个包，首次约 1-3 分钟，需要网络）`, () => {
      const res = spawnSync(
        pythonExe,
        [
          '-m',
          'pip',
          'install',
          ...deps,
          '--disable-pip-version-check',
          '--no-warn-script-location',
          '--no-build-isolation'
        ],
        { stdio: 'inherit', timeout: 900000 }
      );
      if (res.status !== 0) throw new Error(`插件依赖预装失败（退出码 ${res.status}）`);
    });
  }

  // 冒烟测试：核心标准库 + tkinter（区域截图/区域录制插件依赖）必须可用
  step('冒烟测试（ssl / json / sqlite3 / tkinter）', () => {
    const res = spawnSync(
      pythonExe,
      [
        '-c',
        'import sys, ssl, json, sqlite3, tkinter; "".encode("utf-8"); print("python", sys.version.split()[0], "tk", tkinter.TkVersion)'
      ],
      { encoding: 'utf-8' }
    );
    if (res.status !== 0) {
      throw new Error(`嵌入式 Python 不可用（tkinter 缺失？）: ${(res.stderr || '').trim() || res.status}`);
    }
    console.log(`\n[setup-python] ${(res.stdout || '').trim()} ... `);
  });

  rmSync(archivePath, { force: true });
  console.log('[setup-python] 完成 ✓ 嵌入式 Python 位于 engines/python（将随打包分发）');
}

/** 汇总各插件目录下的 requirements.txt 依赖（去重、过滤注释与空行） */
function collectPluginDeps() {
  const pluginsDir = resolve(root, 'plugins');
  const seen = new Set();
  if (!existsSync(pluginsDir)) return [];
  for (const name of readdirSync(pluginsDir)) {
    const req = resolve(pluginsDir, name, 'requirements.txt');
    if (!existsSync(req)) continue;
    for (const line of readFileSync(req, 'utf-8').split(/\r?\n/)) {
      const pkg = line.replace(/#.*$/, '').trim();
      if (!pkg || !/[A-Za-z0-9]/.test(pkg)) continue;
      seen.add(pkg);
    }
  }
  return [...seen];
}

try {
  main();
} catch (e) {
  console.error('\n[setup-python] 失败:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
