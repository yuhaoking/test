/**
 * 分发包自检门禁（R2-T2 / R2-T4）
 *
 * 为什么需要：PKG-001 这次事故的本质是 —— **安装包从不被任何测试覆盖**。
 * `npm test` 与 `npm run smoke` 都只验源码与运行期，而 electron-builder 的 NSIS 目标是
 * **两遍构建**：第一遍产出的是"不含应用载荷"的中间安装器（约 169KB），
 * 第二遍才把载荷打进去并覆盖同名文件。一旦第二遍没跑完（构建中断、环境限制），
 * `dist\小鹏工具箱 Setup 2.1.0.exe` 就静静躺着一个 169KB 的废文件，
 * README 还指着它说"这是安装包" —— 用户双击装不上，而构建侧一路绿灯。
 *
 * 本脚本把"装不上/发错包"从用户侧提前到构建侧，逐项断言：
 *   1) 安装包存在且体积足够（必须大于应用载荷）；
 *   2) 应用载荷存在且可被 7-Zip 解析（能被识别为归档 = 有真实内容）；
 *   3) 安装包内嵌了载荷（体积 ≥ 载荷 + 存根）；若只是存根，直接判定为中间产物；
 *   4) 同源同版本（R2-T4）：安装包内的主 exe 与 win-unpacked 的主 exe **字节数一致**。
 *
 * 用法：
 *   node scripts/verify-dist.mjs            # 只检查，不通过则退出码 1
 *   node scripts/verify-dist.mjs --allow-missing   # 允许"还没打包"（用于 CI 的早阶段）
 *
 * 输出：控制台摘要 + dist/dist-selfcheck.json（供审计/CI 留档）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// resedit：electron-builder 自带的纯 JS PE 资源编辑器，用来在进程内读版本资源（避免中文经管道乱码）
import * as resedit from 'resedit';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const UNPACKED = join(DIST, 'win-unpacked');
const allowMissing = process.argv.includes('--allow-missing');

/** 安装包最小体积（字节）：应用载荷本体就有 ~200MB，低于这个量级必然是中间产物 */
const MIN_INSTALLER_BYTES = 150 * 1024 * 1024;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail ? `  —— ${detail}` : ''}`);
}

/** 找 7za.exe（electron-builder 自带），找不到就退回 PATH 上的 7z */
function find7z() {
  const base = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  if (existsSync(base)) {
    for (const d of readdirSync(base)) {
      if (!d.startsWith('7zip')) continue;
      for (const sub of readdirSync(join(base, d))) {
        const exe = join(base, d, sub, 'bin', '7za.exe');
        if (existsSync(exe)) return exe;
      }
      const direct = join(base, d, '7za.exe');
      if (existsSync(direct)) return direct;
    }
  }
  for (const candidate of ['7z', '7za']) {
    try {
      execFileSync(candidate, ['i'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

function main() {
  console.log('分发包自检门禁（R2-T2 / R2-T4）');
  console.log(`  dist = ${DIST}`);

  if (!existsSync(DIST)) {
    if (allowMissing) {
      console.log('  （--allow-missing：dist 不存在，跳过）');
      return 0;
    }
    check('dist 目录存在', false, '还没打过包');
    return 1;
  }

  // ---- 1) 找出安装包与载荷 ----
  const files = readdirSync(DIST).filter((f) => !f.endsWith('__uninstaller.exe'));
  const installerName = files.find((f) => /Setup.*\.exe$/i.test(f) && !/merged/i.test(f));
  const mergedName = files.find((f) => /merged.*\.exe$/i.test(f));
  const payloadName = files.find((f) => /\.nsis\.7z$/i.test(f));
  const installer = installerName ? join(DIST, installerName) : null;
  const payload = payloadName ? join(DIST, payloadName) : null;

  console.log(`  安装包 : ${installerName ?? '(未找到)'}`);
  console.log(`  应用载荷: ${payloadName ?? '(未找到)'}`);
  if (mergedName) console.log(`  ⚠️ 发现手工拼接产物 ${mergedName}（非 electron-builder 产出，不应分发）`);

  // ---- 2) 载荷必须存在且可解析 ----
  let payloadBytes = 0;
  if (payload) {
    payloadBytes = statSync(payload).size;
    check('应用载荷存在', true, `${(payloadBytes / 1048576).toFixed(1)} MB`);
    const sz = find7z();
    if (!sz) {
      check('7-Zip 可用（用于校验载荷可解析）', false, '未找到 7za.exe；无法确认载荷完整性');
    } else {
      // 注意：中文文件名在 Windows 控制台可能乱码，因此只看退出码，不解析输出文本
      let listOk = false;
      try {
        execFileSync(sz, ['t', payload], { stdio: 'ignore', windowsHide: true, timeout: 300000 });
        listOk = true;
      } catch {
        listOk = false;
      }
      check('应用载荷可解析（7-Zip 完整性测试通过）', listOk, listOk ? 't 测试通过' : '7-Zip 测试失败');
    }
  } else {
    check('应用载荷存在', false, '缺 .nsis.7z —— 构建未走到打包载荷这一步');
  }

  // ---- 3) 安装包必须是"含载荷的最终产物" ----
  if (installer) {
    const size = statSync(installer).size;
    const looksLikeStub = size < MIN_INSTALLER_BYTES;
    check(
      '安装包是最终产物而非中间存根（体积 ≥ 150MB）',
      !looksLikeStub,
      looksLikeStub
        ? `只有 ${(size / 1024).toFixed(0)}KB —— 这是 NSIS 第一遍的中间安装器（无内嵌载荷），不可分发`
        : `${(size / 1048576).toFixed(1)} MB`
    );
    if (payloadBytes > 0 && !looksLikeStub) {
      check(
        '安装包体积 ≥ 应用载荷（说明载荷确实被打了进去）',
        size >= payloadBytes,
        `安装包 ${(size / 1048576).toFixed(1)}MB vs 载荷 ${(payloadBytes / 1048576).toFixed(1)}MB`
      );
    }
  } else {
    check('安装包存在', false, 'dist 下没有 Setup*.exe');
  }

  // ---- 4) 同源同版本（R2-T4）----
  const unpackedExe = join(UNPACKED, '小鹏工具箱.exe');
  if (existsSync(unpackedExe) && payload) {
    const unpackedBytes = statSync(unpackedExe).size;
    check('win-unpacked 主程序存在', true, `${(unpackedBytes / 1048576).toFixed(0)} MB`);
    /*
     * 断言"安装器内的主 exe 与 win-unpacked 的主 exe 字节数一致"。
     * 实现方式：从载荷里单独解出主 exe 到临时目录比字节数 —— 不去 parse 安装器，
     * 因为安装器的载荷就是这份 .nsis.7z，比解析 EXE 稳得多。
     */
    const sz = find7z();
    if (sz && payloadBytes > 0) {
      const tmp = mkdtempSync(join(tmpdir(), 'xp-distcheck-'));
      try {
        const inner = join(tmp, 'inner');
        execFileSync(sz, ['x', payload, '-o' + inner, '小鹏工具箱.exe', '-y'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 300000
        });
        const extracted = join(inner, '小鹏工具箱.exe');
        if (existsSync(extracted)) {
          const innerBytes = statSync(extracted).size;
          check(
            '同源同版本：安装器内主程序 == win-unpacked 主程序（字节数）',
            innerBytes === unpackedBytes,
            `安装器内 ${innerBytes} vs 目录内 ${unpackedBytes}`
          );
        } else {
          check('同源同版本：能从载荷中取出主程序', false, '解压后未找到 小鹏工具箱.exe');
        }
      } catch (e) {
        check('同源同版本：能从载荷中取出主程序', false, `解压失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  } else if (!existsSync(unpackedExe)) {
    check('win-unpacked 主程序存在', false, '未找到 dist/win-unpacked/小鹏工具箱.exe');
  }

  // ---- 4b) 版本资源与图标（R2-T5 的无证书部分）----
  /*
   * 断言"exe 已经过资源编辑"。为什么把这条放进门禁：
   * 未经资源编辑的产物，版本资源会原样保留 Electron 的（ProductName=Electron / CompanyName=GitHub, Inc.），
   * 这在 Windows 眼里就是"没有身份、来路不明"的可执行文件 —— PCA/杀软判定最不友好，
   * 实测表现为"普通双击毫无反应、以管理员身份运行才起得来"。
   * 用 PowerShell 读版本资源即可判定，跨版本稳定。
   */
  if (existsSync(unpackedExe)) {
    /*
     * 用 resedit 在**进程内**直接读 PE 版本资源，不经 PowerShell 管道。
     * 为什么不用 `Get-Item ... .VersionInfo`：中文经控制台管道会变成乱码
     * （实测拿到 "ProductName=С��������"），会把"已写入"误判成"未写入"。
     * resedit 是 electron-builder 自带的传递依赖，读的是 UTF-16 资源本体，无编码损耗。
     */
    let vi = null;
    try {
      const buf = readFileSync(unpackedExe);
      const exeObj = resedit.NtExecutable.from(buf, { ignoreCert: true });
      const res = resedit.NtExecutableResource.from(exeObj);
      const list = resedit.Resource.VersionInfo.fromEntries(res.entries);
      if (list.length > 0) {
        const langs = list[0].getAllLanguagesForStringValues();
        const strings = langs.length > 0 ? list[0].getStringValues(langs[0]) : {};
        vi = {
          ProductName: strings.ProductName ?? '',
          CompanyName: strings.CompanyName ?? '',
          FileDescription: strings.FileDescription ?? '',
          FileVersion: strings.FileVersion ?? ''
        };
      }
    } catch (e) {
      check('能读取 exe 版本资源', false, e instanceof Error ? e.message : String(e));
    }
    if (vi) {
      const stamped = vi.ProductName === '小鹏工具箱' && vi.CompanyName !== 'GitHub, Inc.';
      check(
        '主程序已写入自有版本资源（不是未处理的 Electron 原样拷贝）',
        stamped,
        `ProductName=${vi.ProductName || '(空)'} CompanyName=${vi.CompanyName || '(空)'} FileVersion=${vi.FileVersion || '(空)'}`
      );
    }
  }

  // ---- 5) 产物命名与留档 ----
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
  const electronVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf-8')).version;
    } catch {
      return '未知';
    }
  })();
  const report = {
    generatedAt: new Date().toISOString(),
    appVersion: version,
    electronVersion,
    installer: installerName ?? null,
    installerBytes: installer ? statSync(installer).size : 0,
    payload: payloadName ?? null,
    payloadBytes,
    unpackedExeBytes: existsSync(unpackedExe) ? statSync(unpackedExe).size : 0,
    strayMergedArtifact: mergedName ?? null,
    checks
  };
  writeFileSync(join(DIST, 'dist-selfcheck.json'), JSON.stringify(report, null, 2), 'utf-8');

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length) {
    console.log(`自检未通过：${failed.length}/${checks.length} 项失败 —— 不要分发当前 dist/`);
    /*
     * 开发场景提示：只跑了 `electron-builder --dir`（只为验证打包可行性）时，
     * 本来就不会产出安装器与载荷，此时报红是正确的（确实没有可分发产物），
     * 但要说清楚"这不是构建出错"，否则会误导人去查打包流程。
     */
    if (existsSync(UNPACKED) && !installer && !payload) {
      console.log('提示：当前只跑过 `electron-builder --dir`（仅解包、不产安装器），所以没有可分发产物。');
      console.log('      要出正式安装包请在**有桌面会话**的终端执行：npm run dist');
      console.log('      （NSIS 打包需要运行一次中间安装器来导出卸载器，无桌面会话会中断 —— 见 docs/变更记录.md）');
    }
    console.log(`详情：${join(DIST, 'dist-selfcheck.json')}`);
    return 1;
  }
  console.log(`自检通过：${checks.length} 项全绿（app v${version} / electron ${electronVersion}）`);
  console.log(`留档：${join(DIST, 'dist-selfcheck.json')}`);
  return 0;
}

process.exit(main());
