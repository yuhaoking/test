import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`);
  }
}

function pngOk(path) {
  if (!existsSync(path)) return false;
  const b = readFileSync(path);
  return b.length > 40 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[24] === 8;
}

console.log('assets');
check('default-pet.png valid', pngOk(join(ROOT, 'resources', 'default-pet.png')));
for (const action of ['idle', 'nod', 'wave', 'blink', 'jump']) {
  const dir = join(ROOT, 'resources', 'pet-frames', action);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : [];
  check(`pet-frames/${action} frames (${files.length})`, files.length >= 2 && files.every((f) => pngOk(join(dir, f))));
}
check('build/icon.ico exists', existsSync(join(ROOT, 'build', 'icon.ico')));

console.log('manifests');
for (const dir of ['example-plugin', 'example-pet-plugin']) {
  try {
    const m = JSON.parse(readFileSync(join(ROOT, 'plugins', dir, 'manifest.json'), 'utf-8'));
    check(`${dir} manifest`, Boolean(m.id && m.name && m.entry && m.type));
  } catch {
    check(`${dir} manifest`, false);
  }
}

console.log('pinyin search keys');
const first = pinyin('微信', { pattern: 'first', toneType: 'none', type: 'array' }).join('');
const full = pinyin('微信', { toneType: 'none', type: 'array' }).join('');
check("'微信' first='wx'", first === 'wx');
check("'微信' full='weixin'", full === 'weixin');

console.log('office plugins');
const officeDirs = readdirSync(join(ROOT, 'plugins')).filter((d) => d.startsWith('office-'));
check(`office plugin count (${officeDirs.length})`, officeDirs.length >= 11);
check(
  'convert plugin unified',
  officeDirs.includes('office-convert-all') && !officeDirs.includes('office-convert-image')
);
let officeOk = true;
for (const dir of officeDirs) {
  try {
    const m = JSON.parse(readFileSync(join(ROOT, 'plugins', dir, 'manifest.json'), 'utf-8'));
    const hasMain = existsSync(join(ROOT, 'plugins', dir, 'main.py'));
    const hasIcon = existsSync(join(ROOT, 'plugins', dir, 'icon.png'));
    if (!(m.id && m.category && m.entry && m.type === 'module' && hasMain && hasIcon)) officeOk = false;
  } catch {
    officeOk = false;
  }
}
check('office plugins structure', officeOk);
const utf8Check = readdirSync(join(ROOT, 'plugins')).filter((d) => d.startsWith('office-'));
let utf8Ok = true;
for (const dir of utf8Check) {
  const src = readFileSync(join(ROOT, 'plugins', dir, 'main.py'));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(src);
  } catch {
    utf8Ok = false;
    console.error('  encoding corrupt:', dir);
  }
}
check('office plugins utf-8 intact', utf8Ok);

console.log('office shared lib');
const sharedSrc = readFileSync(join(ROOT, 'plugins', '_shared', 'screen_capture.py'), 'utf-8');
check(
  '_shared/screen_capture.py has capture+png',
  sharedSrc.includes('def capture(') && sharedSrc.includes('def png_encode(')
);

function rpcCall(child, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 8000);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(msg);
          }
        } catch {
          /* ignore */
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

console.log('python plugin json-rpc');
await new Promise((resolve) => {
  const child = spawn('python', [join(ROOT, 'plugins', 'example-plugin', 'main.py')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'inherit']
  });
  child.on('error', () => {
    console.warn('  skip: python not available');
    resolve();
  });
  child.on('spawn', async () => {
    try {
      const init = await rpcCall(child, 1, 'plugin.init', {});
      const ui = await rpcCall(child, 2, 'plugin.get_ui', {});
      const action = await rpcCall(child, 3, 'plugin.handle_action', { action: 'hello' });
      check('plugin.init responds', init.result?.status === 'ok' && init.error == null);
      check('plugin.get_ui has buttons', Array.isArray(ui.result?.buttons) && ui.result.buttons.length >= 2);
      check('handle_action returns message', typeof action.result?.message === 'string');
    } catch {
      check('python plugin json-rpc flow', false);
    } finally {
      child.kill();
      resolve();
    }
  });
});

console.log('db schema consistency (P0-1)');
{
  // 动态验证：用 db.ts 里的建表 DDL 建库，再执行 SqliteBackend 的通用 (key,value) 读写 SQL。
  // 目的是拦住“建表列名与读写 SQL 列名不一致”这类致命缺陷（曾导致 SQLite 后端启用即崩溃）。
  let entries = [];
  try {
    const src = readFileSync(join(ROOT, 'electron', 'store', 'db.ts'), 'utf-8');
    const start = src.indexOf('const SQLITE_TABLES');
    const end = src.indexOf('export { SQLITE_TABLES }');
    const block = src.slice(start, end > start ? end : undefined);
    entries = [...block.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  } catch {
    /* 解析失败下面统一报错 */
  }
  check('db.ts SQLITE_TABLES 解析（≥9 张表）', entries.length >= 9);
  let sqlite = null;
  try {
    sqlite = (await import('better-sqlite3')).default;
  } catch {
    sqlite = null;
  }
  if (!sqlite) {
    console.warn('  skip: better-sqlite3 在纯 Node 下不可加载（ABI/未构建），仅做静态解析');
  } else {
    const mem = new sqlite(':memory:');
    for (const [table, ddl] of entries) mem.exec(`CREATE TABLE IF NOT EXISTS ${table} (${ddl})`);
    for (const [table] of entries) {
      mem
        .prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run('k', 'v');
      const got = mem.prepare(`SELECT value FROM ${table} WHERE key = ?`).get('k');
      const rows = mem.prepare(`SELECT key, value FROM ${table}`).all();
      check(`db ${table} 支持 (key,value) 读写`, got?.value === 'v' && rows.length === 1);
      mem.prepare(`DELETE FROM ${table} WHERE key = ?`).run('k');
    }
    mem.close();
  }
}

console.log('embedded python runtime (setup-python)');
{
  // 打包链路看门狗：安装包必须带一个「含 tkinter」的嵌入式运行时，否则区域截图/区域录制插件失效
  // （历史上曾因 python.org 完整安装包静默空跑导致 engines/python 缺 tkinter，构建却"成功"）
  const pyRoot = join(ROOT, 'engines', 'python');
  const exe = join(pyRoot, 'python.exe');
  if (!existsSync(exe)) {
    console.warn('  skip: engines/python 未安装（开发环境可跳过；打包前请执行 npm run setup-python）');
  } else {
    const countFiles = (dir, ext) => {
      let n = 0;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) n += countFiles(join(dir, e.name), ext);
        else if (e.name.toLowerCase().endsWith(ext)) n++;
      }
      return n;
    };
    check('engines/python/python.exe 存在', true);
    check('tkinter 包存在（区域截图/录制依赖）', existsSync(join(pyRoot, 'Lib', 'tkinter', '__init__.py')));
    check('tcl 运行库存在', existsSync(join(pyRoot, 'tcl', 'tcl8.6', 'init.tcl')));
    check('调试符号已精简（无 .pdb）', countFiles(pyRoot, '.pdb') === 0);
    const smoke = spawnSync(exe, ['-c', 'import ssl,json,sqlite3,tkinter;print("ok")'], { encoding: 'utf-8' });
    check('运行时导入 ssl/json/sqlite3/tkinter', smoke.status === 0 && (smoke.stdout || '').includes('ok'));
  }
}

console.log('T-14 devtools pure functions');
{
  // 纯函数全部在 Node 下直接断言（Node 内置 TypeScript 类型剥离，无需构建）
  const json = await import('../shared/devtools/json.ts');
  const time = await import('../shared/devtools/time.ts');
  const codec = await import('../shared/devtools/codec.ts');
  const hash = await import('../shared/devtools/hash.ts');
  const uuid = await import('../shared/devtools/uuid.ts');
  const radix = await import('../shared/devtools/radix.ts');
  const unit = await import('../shared/devtools/unit.ts');
  const cron = await import('../shared/devtools/cron.ts');
  const diff = await import('../shared/devtools/diff.ts');
  const regex = await import('../shared/devtools/regex.ts');
  const qr = await import('../shared/devtools/qrcode.ts');
  const intent = await import('../shared/devtools/intent.ts');
  const alias = await import('../shared/devtools/alias.ts');

  // DEV-01 JSON
  const jf = json.jsonFormat('{"a":1,"b":[1,2]}');
  check('DEV-01 jsonFormat 格式化成功', jf.ok && jf.out.includes('\n  "a": 1'));
  const jf2 = json.jsonFormat('{"a":}');
  check('DEV-01 jsonFormat 非法 JSON 返回位置', !jf2.ok && jf2.pos >= 0 && typeof jf2.line === 'number');
  const jm = json.jsonMinify('{\n  "a": 1\n}');
  check('DEV-01 jsonMinify 压缩为单行', jm.ok && jm.out === '{"a":1}');
  check('DEV-01 looksLikeJson 形态判定', json.looksLikeJson('{"a":1}') && !json.looksLikeJson('hello'));
  check('DEV-01 jsonSummary 摘要', json.jsonSummary([1, 2, 3]) === '数组 · 3 项');

  // DEV-02 时间戳
  const t10 = time.parseTimeInput('1727000000');
  const t13 = time.parseTimeInput('1727000000000');
  check('DEV-02 10 位秒级时间戳', t10 && t10.kind === 'seconds' && t10.epochMs === 1727000000000);
  check('DEV-02 13 位毫秒时间戳', t13 && t13.kind === 'milliseconds' && t13.epochMs === 1727000000000);
  check('DEV-02 ISO 输出', t10 && t10.iso === new Date(1727000000000).toISOString());
  check('DEV-02 日期字符串识别', time.parseTimeInput('2026-09-27 10:30') !== null);
  check('DEV-02 非时间输入返回 null', time.parseTimeInput('hello world') === null);
  check('DEV-02 相对时间文案', time.relativeTime(Date.now() - 3 * 86400000, Date.now()) === '3 天前');

  // DEV-03 编解码
  check('DEV-03 Base64 编码（ASCII）', codec.base64Encode('abc') === 'YWJj');
  check('DEV-03 Base64 解码（中文往返）', codec.base64Decode(codec.base64Encode('小鹏工具箱')) === '小鹏工具箱');
  check('DEV-03 Base64 双向自动识别（解码）', codec.base64Auto('aGVsbG8gd29ybGQ=')?.mode === 'decode');
  check('DEV-03 Base64 双向自动识别（编码）', codec.base64Auto('hello world')?.mode === 'encode');
  check('DEV-03 URL 编码', codec.urlEncode('a b&c') === 'a%20b%26c');
  check('DEV-03 URL 解码', codec.urlDecode('a%20b%26c') === 'a b&c');
  check('DEV-03 URL 双向自动识别', codec.urlAuto('%E4%B8%AD%E6%96%87')?.out === '中文');

  // DEV-05 哈希（标准测试向量）
  const h = hash.hashAll('abc');
  check('DEV-05 MD5 测试向量', h.md5 === '900150983cd24fb0d6963f7d28e17f72');
  check('DEV-05 SHA1 测试向量', h.sha1 === 'a9993e364706816aba3e25717850c26c9cd0d89d');
  check('DEV-05 SHA256 测试向量', h.sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('DEV-05 空串哈希', hash.md5('') === 'd41d8cd98f00b204e9800998ecf8427e');

  // DEV-06 UUID
  const u4 = uuid.uuidBatch(4);
  check('DEV-06 uuidBatch 生成 4 个', u4.length === 4 && u4.every((x) => uuid.isUuid(x)));
  check('DEV-06 UUID v4 版本位', u4[0][14] === '4');
  check('DEV-06 UUID 唯一性', new Set(u4).size === 4);

  // DEV-07 进制
  const r16 = radix.radixConvert('0xFF');
  check('DEV-07 十六进制自动识别', r16.ok && r16.from === 16 && r16.values['10'] === '255');
  const r10 = radix.radixConvert('255');
  check('DEV-07 十进制四进制对照', r10.ok && r10.values['2'] === '11111111' && r10.values['16'] === 'FF');
  check('DEV-07 非法字符报错', !radix.radixConvert('12z', 10).ok);
  check('DEV-07 looksLikeRadixInput', radix.looksLikeRadixInput('0b1010') && !radix.looksLikeRadixInput('abc'));

  // DEV-08 单位换算
  check('DEV-08 长度换算 1km=1000m', unit.convertUnit(1, 'km', 'm') === 1000);
  check('DEV-08 数据大小 1MiB=1048576B', unit.convertUnit(1, 'MiB', 'B') === 1048576);
  check('DEV-08 时间换算 1h=3600s', unit.convertUnit(1, 'h', 's') === 3600);
  check('DEV-08 单位族 ≥ 3 类', unit.UNIT_FAMILIES.length >= 3);
  check('DEV-08 同族全量对照', unit.convertFamily(1, 'm', 'length')?.cm === 100);

  // DEV-10 cron
  const cNext = cron.cronNext('*/15 9-18 * * 1-5', 5, new Date('2026-09-28T00:00:00'));
  check('DEV-10 cronNext 返回 5 次', cNext.length === 5);
  check('DEV-10 cronNext 命中 9-18 点区间', cNext.every((d) => d.getHours() >= 9 && d.getHours() <= 18));
  check('DEV-10 cronNext 命中工作日', cNext.every((d) => d.getDay() >= 1 && d.getDay() <= 5));
  check('DEV-10 cronDescribe 中文语义', cron.cronDescribe('30 9 * * *').includes('09:30'));
  check('DEV-10 非法表达式被拒绝', !cron.parseCron('* * *').ok);

  // DEV-11 diff
  const d = diff.diffLines('a\nb\nc', 'a\nc\nd');
  check('DEV-11 diff 行级结果', d.lines.length === 4 && d.added === 1 && d.removed === 1);
  check('DEV-11 diff 相同行计数', d.lines.filter((l) => l.type === 'same').length === 2);
  check('DEV-11 diff 完全相同相似度 1', diff.diffSimilarity(diff.diffLines('x', 'x')) === 1);

  // DEV-04 正则
  const rx = regex.regexTest('\\d+', 'g', 'a1b22c333');
  check('DEV-04 匹配数量', rx.ok && rx.matches.length === 3);
  check('DEV-04 匹配分组与位置', rx.ok && rx.matches[2].value === '333' && rx.matches[0].index === 1);
  check('DEV-04 非法表达式结构化错误', !regex.regexTest('([a-z', 'g', 'x').ok);
  check('DEV-04 常用预设 ≥ 5 条', regex.REGEX_PRESETS.length >= 5);
  check('DEV-04 高亮分段', regex.regexHighlight('\\d+', 'g', 'a1b').filter((s) => s.hit).length === 1);

  // DEV-09 二维码（几何 + 编解码往返 + 图像解码）
  const totals = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  check(
    'DEV-09 各版本总码字数与标准一致',
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every((v) => qr.totalCodewords(v) === totals[v - 1])
  );
  const qrText = 'https://example.com/小鹏?x=1';
  const enc = qr.qrEncode(qrText, 'M');
  check('DEV-09 二维码生成', enc.ok && enc.size === enc.version * 4 + 17);
  const dec = enc.ok ? qr.qrDecodeMatrix(enc.modules) : { ok: false };
  check('DEV-09 矩阵解码往返一致', dec.ok && dec.text === qrText);
  let imgOk = false;
  if (enc.ok) {
    const scale = 4;
    const quiet = 4;
    const dim = enc.size;
    const W = (dim + quiet * 2) * scale;
    const rgba = new Uint8ClampedArray(W * W * 4).fill(255);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const mr = Math.floor(y / scale) - quiet;
        const mc = Math.floor(x / scale) - quiet;
        const dark = mr >= 0 && mc >= 0 && mr < dim && mc < dim && enc.modules[mr][mc];
        const p = (y * W + x) * 4;
        const v = dark ? 0 : 255;
        rgba[p] = v;
        rgba[p + 1] = v;
        rgba[p + 2] = v;
        rgba[p + 3] = 255;
      }
    }
    const imgDec = qr.qrDecodeRgba(rgba, W, W);
    imgOk = imgDec.ok && imgDec.text === qrText;
  }
  check('DEV-09 图片解码（含中文链接）', imgOk);

  // CP-07 剪贴板意图识别
  check('CP-07 识别 URL', intent.inferClipboardIntent('https://example.com/a?b=1').kind === 'url');
  check('CP-07 识别 Windows 路径', intent.inferClipboardIntent('C:\\Users\\me\\Desktop\\a.txt').kind === 'path');
  check(
    'CP-07 识别多选路径（资源管理器多选）',
    intent.inferClipboardIntent('D:\\a\\b.txt\r\nD:\\a\\c.txt').paths.length === 2
  );
  check('CP-07 识别 JSON', intent.inferClipboardIntent('{"a":1}').kind === 'json');
  check('CP-07 识别时间戳', intent.inferClipboardIntent('1727000000000').kind === 'timestamp');
  check('CP-07 识别颜色值', intent.inferClipboardIntent('#5b8cff').kind === 'color');
  check('CP-07 普通文本归类 unknown', intent.inferClipboardIntent('今天天气不错').kind === 'unknown');
  check('CP-07 空输入归类 unknown', intent.inferClipboardIntent('   ').kind === 'unknown');

  // AL-01 / AL-03 别名规则
  const existing = [{ id: 'a1', alias: 'fy', targetId: 'plugincmd:x:y', targetLabel: '中英互译' }];
  check('AL-01 合法别名通过校验', alias.validateAliasInput({ alias: 'json', targetId: 'fn-devtools' }, existing) === null);
  check('AL-01 空别名被拒绝', alias.validateAliasInput({ alias: '  ', targetId: 'x' }, existing) !== null);
  check('AL-01 含空格被拒绝', alias.validateAliasInput({ alias: 'a b', targetId: 'x' }, existing) !== null);
  check('AL-01 缺少目标被拒绝', alias.validateAliasInput({ alias: 'aa', targetId: '' }, existing) !== null);
  check('AL-01 冲突被拒绝（大小写不敏感）', alias.validateAliasInput({ alias: 'FY', targetId: 'z' }, existing) !== null);
  check('AL-01 编辑自身不视为冲突', alias.validateAliasInput({ id: 'a1', alias: 'fy', targetId: 'z' }, existing) === null);
  check('AL-03 别名精确命中', alias.matchAlias(' FY ', existing)?.targetId === 'plugincmd:x:y');
  check('AL-03 非精确输入不命中', alias.matchAlias('fy2', existing) === null);

  // db 表：aliases（T-14 / AL-01）
  const dbSrc = readFileSync(join(ROOT, 'electron', 'store', 'db.ts'), 'utf-8');
  check('AL-01 db.ts 含 aliases 表', /aliases:\s*'key TEXT PRIMARY KEY/.test(dbSrc));
}

console.log('审计缺陷回归（独立测试报告 41 项）');
{
  const time = await import('../shared/devtools/time.ts');
  const codec = await import('../shared/devtools/codec.ts');
  const radix = await import('../shared/devtools/radix.ts');
  const diff = await import('../shared/devtools/diff.ts');
  const cron = await import('../shared/devtools/cron.ts');
  const regex = await import('../shared/devtools/regex.ts');
  const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

  // P2-12：不存在的日期必须被拒绝，而不是静默滚到下个月
  const bad1 = time.parseTimeInput('2026-02-30');
  const bad2 = time.parseTimeInput('2026-13-01');
  const bad3 = time.parseTimeInput('2026-01-01 25:99');
  check('P2-12 2026-02-30 被判非法（不再滚到 03-02）', bad1 === null);
  check('P2-12 2026-13-01 被判非法', bad2 === null);
  check('P2-12 25:99 被判非法', bad3 === null);
  check('P2-12 越界原因可读', (time.explainTimeInput('2026-02-30') ?? '').includes('有效日期'), time.explainTimeInput('2026-02-30'));
  check('P2-12 合法日期仍正常', time.parseTimeInput('2026-02-28')?.ok === true);
  check('P2-12 闰年 2024-02-29 合法', time.parseTimeInput('2024-02-29')?.ok === true);
  check('P2-12 合法日期不产生误报原因', time.explainTimeInput('2026-02-28') === null);

  // P2-13：2 月 29 日的 cron 必须能算出未来触发时间
  const feb29 = cron.cronNext('0 0 29 2 *', 3, new Date('2026-03-01T00:00:00'));
  check('P2-13 0 0 29 2 * 能算出未来 2 次以上', feb29.length >= 2, String(feb29.length));
  check('P2-13 结果全部是 2 月 29 日', feb29.every((d) => d.getMonth() === 1 && d.getDate() === 29));
  const t0 = Date.now();
  cron.cronNext('*/15 9-18 * * 1-5', 5, new Date('2026-09-28T00:00:00'));
  check('P2-13 常用表达式仍然毫秒级', Date.now() - t0 < 500, String(Date.now() - t0) + 'ms');

  // P2-11：灾难性回溯风险可被静态识别，且输入长度有上限
  check('P2-11 识别嵌套量词风险', regex.assessRegexRisk('(a+)+$').risky === true);
  check('P2-11 识别分支量词风险', regex.assessRegexRisk('(a|a)*$').risky === true);
  check('P2-11 正常表达式不误报', regex.assessRegexRisk('\\d{1,3}').risky === false);
  check('P2-11 输入长度上限存在', regex.REGEX_MAX_INPUT > 0);
  const capped = regex.regexTest('b', 'g', 'a'.repeat(regex.REGEX_MAX_INPUT + 100));
  check('P2-11 超长输入被截断并标记', capped.ok === true && capped.inputTruncated === true && capped.matches.length === 0);

  // P3-1：孤立代理项按 U+FFFD 编码（与 Node / Python 标准实现一致）
  const lone = '\ud83d';
  check(
    'P3-1 孤立代理项 Base64 与 Buffer 一致',
    codec.base64Encode(lone) === Buffer.from(lone, 'utf-8').toString('base64'),
    codec.base64Encode(lone)
  );
  check('P3-1 合法 emoji 不受影响', codec.base64Decode(codec.base64Encode('😀')) === '😀');

  // P3-2：带符号的进制前缀
  const negHex = radix.radixConvert('-0xFF');
  check('P3-2 -0xFF 可解析为 -255', negHex.ok && negHex.decimal === -255, JSON.stringify(negHex.values));
  check('P3-2 0xFF 仍为 255', radix.radixConvert('0xFF').decimal === 255);

  // P3-3：'+' 不再被当成空格
  check('P3-3 a+b 解码保持原样', codec.urlDecode('a+b') === 'a+b');
  check('P3-3 %20 仍解码为空格', codec.urlDecode('a%20b') === 'a b');
  check('P3-3 往返对称', codec.urlDecode(codec.urlEncode('x+y z')) === 'x+y z');

  // P3-4：结尾换行差异必须被标出
  check('P3-4 结尾换行不同会被标记', diff.diffLines('a', 'a\n').trailingNewlineDiffers === true);
  check('P3-4 两侧一致时不误报', diff.diffLines('a\n', 'a\n').trailingNewlineDiffers === false);

  // P2-14：排除目录必须按路径边界匹配（真实行为在 Electron 运行时冒烟中断言，见 scripts/smoke-main.ts）
  const fsearch = read('electron/services/fileSearch.ts');
  check('P2-14 排除判定已按路径分隔符划边界', /lower === dir \|\| lower\.startsWith\(dir \+ '\\\\'/.test(fsearch));

  // P1-2 / UPD-01
  const pkg = JSON.parse(read('package.json'));
  check('P1-2 package.json 版本已与产品文档对齐（≥2.0.0）', Number(String(pkg.version).split('.')[0]) >= 2, pkg.version);
  const upd = read('electron/services/updateChecker.ts');
  check('P1-2 更新源支持 owner/repo 简写', /shorthand/.test(upd));
  check('P1-2 提供占位源提示能力', /isPlaceholderFeed/.test(upd));

  // P1-1 / P1-4：源码级契约断言
  const store = read('electron/store/dataStore.ts');
  check('P1-1 全新库会播种内置模块', /const fresh = settingRows\.length === 0/.test(store) && /defaults\.modules\.map/.test(store));
  check('P1-4 设置校验区分数组与对象', /if \(Array\.isArray\(def\)\)/.test(store) && /Array\.isArray\(value\)/.test(store));
  check('P1-4 提供枚举白名单校验', /ENUM_SETTINGS/.test(store));
  check('P1-4 提供数值区间夹取', /RANGE_SETTINGS/.test(store));

  // P3-10 / P2-10 / P2-23 / P2-25 / P2-24 / P2-17
  const market = read('electron/services/marketplace.ts');
  check('P3-10 市场安装会写入 origin=market', /markOrigin\(manifest\.id, 'market'\)/.test(market));
  const pm = read('electron/services/pluginManager.ts');
  check('P2-10 persist 改为展开运行时记录（不再丢字段）', /\.\.\.runtime\.record/.test(pm));
  const forge = read('electron/services/pluginForge.ts');
  check('P2-23 造插件入口/图标做文件名校验', /safeRelativeFileName/.test(forge));
  check('P2-23 加载前做入口路径包含性校验', /入口路径越界/.test(pm));
  const wd = read('electron/services/windowWatchdog.ts');
  check('P2-25 看门狗按已加载页面判定', /RELOADABLE_PAGES/.test(wd) && /isReloadableWindow/.test(wd));
  const tray = read('electron/services/trayManager.ts');
  check('P2-24 托盘切换剪贴板记录时重放热键', /applyClipboardHotkey\(\)/.test(tray));
  check('P2-24 设置变更后刷新托盘菜单', /refreshTray/.test(read('electron/ipc/moduleIpc.ts')));
  const dbsrc = read('electron/store/db.ts');
  check('P2-17 JSON 后端落盘失败按退避重试', /MAX_FLUSH_RETRY/.test(dbsrc) && /this\.failures/.test(dbsrc));

  // P2-8 / P2-7 / P2-1 / P2-9 / P2-3 / P2-2 / P2-4 / P2-5 / P2-6 / P2-16
  check('P2-8 备份导入剥离 BOM', /uFEFF/.test(read('electron/services/backup.ts')));
  const al = read('electron/services/aliases.ts');
  check('P2-7/P2-8 别名导入幂等且剥 BOM', /existing\?\.id \?\? ''/.test(al) && /uFEFF/.test(al));
  const cc = read('electron/services/contextCapture.ts');
  check('P2-1 只有内容真被改动才回写剪贴板', /if \(changed\) restore\(snap\)/.test(cc));
  check('P2-1 检测文件列表格式并跳过取词', /hasFileListFormat/.test(cc));
  const sn = read('electron/services/snippets.ts');
  check('P2-9 片段展开进入剪贴板抑制窗口', /suppressClipboardCapture/.test(sn) && /setClipboardText/.test(sn));
  check('P2-3 侧边栏窗口按需重建', /按需重建/.test(read('electron/windows/sidebarWindow.ts')));
  const pw = read('electron/windows/paletteWindow.ts');
  check('P2-2 面板等 did-finish-load 后再通知', /isLoadingMainFrame/.test(pw) && /did-finish-load/.test(pw));
  const fp = read('electron/services/filePreview.ts');
  check('P2-4 预览按需读取文件头部', /function readHead/.test(fp) && /readHead\(path, MAX_TEXT_BYTES\)/.test(fp));
  const bx = read('electron/services/desktopBoxes.ts');
  check('P2-5 跨盘目录走递归复制', /cpSync\(src, dest, \{ recursive: true/.test(bx));
  check('P2-5 失败会提示用户', /部分文件未能移动/.test(bx));
  check('P2-6 非胶囊态不再使用过期 expandBounds', /box\.capsule \? box\.expandBounds/.test(read('electron/windows/boxWindow.ts')));
  check('P2-16 向下拖拽按目标之后插入', /from < to \? targetIdx \+ 1 : targetIdx/.test(read('src/components/DesktopBoxCard.vue')));

  // P2-22 / P1-3 / P2-18 / P3-6 / P3-9
  const cm = read('electron/services/clipboardManager.ts');
  check('P2-22 OCR 临时图先声明后清理', /const tmp = join\(imagesDir\(\), .ocr-/.test(cm));
  check('P1-3 缩略图加密落盘', /thumbEncrypted/.test(cm) && /encryptBuffer\(thumb\)/.test(cm));
  check('P1-3 OCR 文本加密落盘', /ocrEncrypted/.test(cm));
  check('P2-18 密钥文件异常先备份再重建', /bad-\$\{Date\.now\(\)\}\.bak/.test(read('electron/utils/secrets.ts')));
  check('P3-6 无提醒时不写库不广播', /if \(!pending\.length\) return;/.test(read('electron/main.ts')));
  // 注意别写成 /16 插件/：任务编号 "T-16 插件异步任务模型" 会误命中（本断言自己踩过一次）
  check('P3-9 文档不再出现「16 个插件」的错误口径', !/16 个插件/.test(read('tasks.md')));
}

console.log('PM-03 插件异步任务模型（B）');
{
  // 直接对 Python 侧共享库做协议一致性断言（不启动真实插件，毫秒级）
  const py = [
    'import json, sys',
    "sys.path.insert(0, 'plugins')",
    'from _shared.jobs import JobRegistry',
    'events = []',
    'reg = JobRegistry(lambda o: events.append(o))',
    "j = reg.start('测试任务')",
    "j.progress(40, '进行中')",
    "j.done('完成', result='out.txt')",
    'out = {',
    "  'events': events,",
    "  'snapshot': reg.snapshot(),",
    "  'jobsAnswer': reg.handle('plugin.jobs', {}),",
    "  'otherAnswer': reg.handle('plugin.init', {}),",
    '}',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n');
  // PYTHONUTF8/PYTHONIOENCODING：与 pluginManager 启动插件时的环境保持一致。
  // 否则 Windows 下 Python 按 ANSI 码页输出中文、Node 按 UTF-8 解码 → 断言必然失败（实测踩过）。
  const r = spawnSync('python', ['-c', py], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  if (r.error || r.status !== 0) {
    check('_shared/jobs.py 可导入并工作（python 可用）', false, String(r.error || r.stderr || '').slice(0, 200));
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(String(r.stdout).trim().split('\n').pop());
    } catch (e) {
      check('_shared/jobs.py 输出可解析', false, (e).message);
    }
    if (parsed) {
      const evs = parsed.events ?? [];
      check('B job 事件已上报（progress + done）', evs.length === 2, String(evs.length));
      check('B 事件类型与状态正确', evs[0]?.params?.type === 'job' && evs[0]?.params?.status === 'running', JSON.stringify(evs[0]?.params ?? {}).slice(0, 120));
      check('B 进度与文案如实透传', evs[0]?.params?.progress === 40 && evs[0]?.params?.message === '进行中');
      check('B 终态带产物说明', evs[1]?.params?.status === 'done' && evs[1]?.params?.result === 'out.txt');
      check('B 快照可供宿主轮询', (parsed.snapshot ?? [])[0]?.status === 'done');
      check('B plugin.jobs 应答结构正确', (parsed.jobsAnswer?.jobs ?? []).length === 1, JSON.stringify(parsed.jobsAnswer).slice(0, 120));
      check('B 非 plugin.jobs 请求返回 null（让调用方继续处理）', parsed.otherAnswer === null);
    }
  }

  // 宿主侧源码契约：协议字段与保护逻辑都在位
  const pm = readFileSync(join(ROOT, 'electron', 'services', 'pluginManager.ts'), 'utf-8');
  check('B 宿主登记任务并广播', /function upsertJob/.test(pm) && /plugins:changed/.test(pm));
  check('B 有后台任务时不回收插件进程', /hasRunningJob\(runtime\)\) continue/.test(pm));
  check('B 宿主轮询 plugin.jobs（兼作心跳）', /plugin\.jobs/.test(pm) && /JOB_POLL_INTERVAL_MS/.test(pm));
  check('B 进程退出时任务标记失败', /插件进程已退出，任务未完成/.test(pm));
  check('B 运行期状态对 UI 可见', /rec\.runtimeStatus = runtime\.record\.status/.test(pm));
  const rec = readFileSync(join(ROOT, 'plugins', 'office-screenrecord-gif', 'main.py'), 'utf-8');
  check('B 录屏插件已接入任务模型', /JobRegistry/.test(rec) && /plugin\.jobs/.test(rec) === false || /JOBS\.handle/.test(rec));
  check('B 录屏插件上报进度并在终态回调', /job\.progress\(/.test(rec) && /job\.done\(/.test(rec));
  check('B 任务登记表在 send() 之后初始化（否则插件起不来）', rec.indexOf('def send') < rec.indexOf('JobRegistry(send)'));
}

console.log('T-07 搜索内核增强（Windows 搜索索引兜底）');
{
  const ws = readFileSync(join(ROOT, 'electron', 'services', 'windowsSearch.ts'), 'utf-8');
  check('D 提供可用性探测与查询入口', /export function windowsIndexAvailable/.test(ws) && /export function windowsIndexSearch/.test(ws));
  check('D LIKE 通配符与单引号转义（SQL 注入/误匹配防护）', /replace\(\/%\/g, '\[%\]'\)/.test(ws) && /replace\(\/'\/g, "''"\)/.test(ws));
  check('D 查询有超时上限（不拖慢首屏）', /QUERY_TIMEOUT_MS/.test(ws) && /timeout: QUERY_TIMEOUT_MS \+ 1500/.test(ws));
  check('D 可用性结果缓存（避免每次查询都探测）', /availabilityCache/.test(ws));
  check('D 失败降级为调试日志（不刷警告）', /logDebug\('\[winsearch\] 查询失败/.test(ws));

  const es = readFileSync(join(ROOT, 'electron', 'services', 'fileSearch.ts'), 'utf-8');
  check('D 全盘搜索并发合并索引结果', /windowsIndexSearch\(trimmed, MAX_RESULTS\)/.test(es) && /isExcluded\(r\.path, excluded\)/.test(es));
  const ps = readFileSync(join(ROOT, 'electron', 'services', 'paletteSearch.ts'), 'utf-8');
  check('D 面板仍先走 180ms 快速遍历（保首屏预算）', /quickFileSearch\(q, 180, 20\)/.test(ps));
  check('D 索引补全只在结果过少且查询够长时触发', /files\.length < 4 && q\.length >= 3/.test(ps));
  // 关键：索引查询绝不能同步 await —— 实测会把首屏 181ms 拖到 600ms/1150ms（被 npm run bench 当场抓出）
  check('D 索引查询是异步补全，不阻塞首屏', /prefetchIndexResults\(raw, q\)/.test(ps) && !/await windowsIndexSearch/.test(ps));
  check('D 补全结果按查询新鲜度校验后才推送', /lastQuery !== q \|\| Date\.now\(\) - lastQueryAt > 8000/.test(ps));
  check(
    'D 通过 palette:results 推送增强结果',
    /palette:results/.test(ps) && /palette:results/.test(readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf-8'))
  );
  check(
    'D 渲染层按当前查询过滤推送',
    /e\.query\.trim\(\)\.toLowerCase\(\) !== query\.value/.test(readFileSync(join(ROOT, 'src', 'PaletteApp.vue'), 'utf-8'))
  );
  check('D 索引结果与遍历结果去重合并', /seen\.has\(f\.path\.toLowerCase\(\)\)/.test(ps));
  check('D DBNull 防护（目录无 Size 曾导致整段脚本失败）', /GetVal \$rs "System.Size"/.test(ws) && /DBNull/.test(ws));
  check('D 连续失败后本会话停用索引（不再每次白等）', /MAX_CONSECUTIVE_FAILURES/.test(ws));
  const st = readFileSync(join(ROOT, 'electron', 'store', 'dataStore.ts'), 'utf-8');
  check('D 设置项 searchUseWindowsIndex 默认开启', /searchUseWindowsIndex: true/.test(st));
  const ipc = readFileSync(join(ROOT, 'electron', 'ipc', 'featuresIpc.ts'), 'utf-8');
  check('D 设置页可查搜索后端诊断', /search:backend/.test(ipc) && /everythingAvailable/.test(ipc));
  const sv = readFileSync(join(ROOT, 'src', 'views', 'SettingsView.vue'), 'utf-8');
  check('D 设置页提供开关与后端展示', /toggleWindowsIndex/.test(sv) && /searchBackend/.test(sv));
}

console.log('SY-02 全局快捷键：废弃默认值的一次性升级（P3-7 存量漏网）');
{
  /*
   * 背景（本机日志实测）：老用户库里 `paletteHotkey` 还是 P3-7 之前的 Alt+Space，
   * 而该键与 Windows 系统菜单冲突、注册必然失败。P3-7 只改了默认值，默认值只在首次安装写库，
   * 于是升级过的用户热键永远注册不上，唯一信号只有控制台一行警告。
   */
  const hk = await import('../shared/hotkeys.ts');
  const up = hk.shouldUpgradeLegacyPaletteHotkey;
  check('SY-02 旧默认值 Alt+Space 注册失败后应升级', up('Alt+Space', false) === true);
  check('SY-02 忽略大小写与空白', up('  alt+space ', false) === true);
  check('SY-02 用户自选的其它热键不动', up('Ctrl+Space', false) === false && up('Ctrl+Alt+P', false) === false);
  check('SY-02 已升级过就不再干涉（用户改回去是他的选择）', up('Alt+Space', true) === false);
  check('SY-02 空值不触发升级', up('', false) === false);
  check('SY-02 新默认值就是 Ctrl+Space', hk.HOTKEY_DEFAULTS.palette === 'Ctrl+Space');

  const pw = readFileSync(join(ROOT, 'electron', 'windows', 'paletteWindow.ts'), 'utf-8');
  // 顺序很关键：必须先尝试用户当前的热键，失败了才升级 —— 否则会把"本来能用"的设置改掉
  const firstTry = pw.indexOf('if (attempt(settings.paletteHotkey)) return;');
  const upgrade = pw.indexOf('shouldUpgradeLegacyPaletteHotkey(settings.paletteHotkey');
  check('SY-02 只在注册失败后才升级（能用就不动用户设置）', firstTry > 0 && upgrade > firstTry);
  check('SY-02 升级时落库标记，避免每次启动都改', /paletteHotkeyMigrated: true/.test(pw));
  check('SY-02 升级后立刻重试注册', /if \(attempt\(HOTKEY_DEFAULTS\.palette\)\) return;/.test(pw));
  check('SY-02 升级失败仍有可读提示并指向设置页', /设置 → 快捷键 更改/.test(pw));
  const st = readFileSync(join(ROOT, 'electron', 'store', 'dataStore.ts'), 'utf-8');
  check('SY-02 迁移标记默认 false（存量用户才会触发）', /paletteHotkeyMigrated: false/.test(st));
}

console.log('T-12 国际化（i18n 核心 + 繁简转换）');
{
  const i18n = await import('../shared/i18n/index.ts');
  const hant = await import('../shared/i18n/hant.ts');
  const { ZH_CN } = await import('../shared/i18n/messages.ts');

  // ---- 语言解析 ----
  check('T-12 系统语言归一（zh-Hant-TW → zh-TW）', i18n.normalizeSystemLocale('zh-Hant-TW') === 'zh-TW');
  check('T-12 系统语言归一（zh-HK / zh-MO → zh-TW）', i18n.normalizeSystemLocale('zh-HK') === 'zh-TW' && i18n.normalizeSystemLocale('zh-MO') === 'zh-TW');
  check('T-12 系统语言归一（zh-CN / zh-SG → zh-CN）', i18n.normalizeSystemLocale('zh-CN') === 'zh-CN' && i18n.normalizeSystemLocale('zh-SG') === 'zh-CN');
  check('T-12 系统语言归一（ja-JP / en-US）', i18n.normalizeSystemLocale('ja-JP') === 'ja' && i18n.normalizeSystemLocale('en-US') === 'en');
  check('T-12 不支持的语言回退源语言', i18n.normalizeSystemLocale('de-DE') === 'zh-CN' && i18n.normalizeSystemLocale('') === 'zh-CN');
  check('T-12 设置脏值回退到跟随系统（不抛错）', i18n.resolveLocale('bogus', 'ja-JP') === 'ja' && i18n.resolveLocale(undefined, 'en-US') === 'en');
  check('T-12 显式设置优先于系统', i18n.resolveLocale('ja', 'en-US') === 'ja');

  // ---- 翻译与插值 ----
  check('T-12 四语言取词', i18n.translate('zh-CN', 'common.ok') === '确定' && i18n.translate('en', 'common.ok') === 'OK' && i18n.translate('ja', 'common.save') === '保存');
  check('T-12 参数插值', i18n.translate('en', 'tray.newVersion', { version: '2.1.0' }) === 'New version v2.1.0 available (click to download)');
  check('T-12 缺参数时保留占位符（不显示 undefined）', i18n.translate('en', 'tray.newVersion') === 'New version v{version} available (click to download)');
  check('T-12 缺失 key 回退为 key 本身（一眼看出漏翻译）', i18n.translate('en', 'no.such.key') === 'no.such.key');
  check('T-12 目标语言缺失时回退源语言', (() => {
    // 构造一个只在 zh-CN 存在的 key 场景：用 dictionaryFor 直接验证回退链
    const dict = i18n.dictionaryFor('en');
    return !('tray.tooltip.only.cn' in dict) && i18n.translate('en', 'tray.tooltip.only.cn') === 'tray.tooltip.only.cn';
  })());

  // ---- 字典完整性（en/ja/zh-TW 必须覆盖 zh-CN 全部 key）----
  const gaps = i18n.dictionaryGaps();
  check(`T-12 字典完整（zh-CN ${Object.keys(ZH_CN).length} 个 key 全覆盖）`, gaps.length === 0, JSON.stringify(gaps.map((g) => g.locale + ':' + g.missing.join(','))));
  check('T-12 四个语言都可选', i18n.LOCALES.length === 4 && i18n.LOCALES.every((l) => i18n.isLocale(l.id)));

  // ---- 繁简转换 ----
  check('T-12 词表优先于字表（复制→複製，不是復制）', hant.toTraditional('复制') === '複製');
  check('T-12 词表优先于字表（设置→設定，不是設置）', hant.toTraditional('设置') === '設定');
  check('T-12 两岸用词（窗口→視窗）', hant.toTraditional('窗口') === '視窗');
  check('T-12 两岸用词（文件→檔案）', hant.toTraditional('文件') === '檔案');
  check('T-12 长词优先（文件夹 不被 文件 切碎）', hant.toTraditional('文件夹') === '資料夾');
  check('T-12 逐字兜底（幽灵→幽靈、暂无→暫無）', hant.toTraditional('幽灵') === '幽靈' && hant.toTraditional('暂无') === '暫無');
  check('T-12 应用名转换（小鹏工具箱→小鵬工具箱）', hant.toTraditional('小鹏工具箱') === '小鵬工具箱');
  check('T-12 未收录字符原样保留（不产生乱码）', hant.toTraditional('ABC 123 😀') === 'ABC 123 😀');
  check('T-12 空串安全', hant.toTraditional('') === '');

  /*
   * 不变式：转换结果里不能再残留任何"字表里声明为简体独有"的字。
   * 这条断言的价值在于——新增 zh-CN 文案时若引入没收录的简体字，这里会立刻变红，
   * 而不是等到用户切到繁体才发现「幽灵視窗」这种半简半繁的怪东西（本轮实测踩过）。
   */
  // 只把"映射后与自己不同"的字视作简体独有；字表里为可读性保留的同形字（小:小）不算
  const simplifiedOnly = new Set(Object.entries(hant.CHAR_TABLE).filter(([s, t]) => s !== t).map(([s]) => s));
  const leaked = [];
  const tw = i18n.dictionaryFor('zh-TW');
  for (const [key, value] of Object.entries(tw)) {
    for (const ch of value) {
      if (simplifiedOnly.has(ch)) leaked.push(key + ':' + ch + '→' + hant.CHAR_TABLE[ch]);
    }
  }
  check(`T-12 繁中结果不残留简体独有字（字表 ${simplifiedOnly.size} 个）`, leaked.length === 0, leaked.slice(0, 8).join(' '));
  check('T-12 字表/词表规模可观测', hant.HANT_TABLE_SIZE.chars > 300 && hant.HANT_TABLE_SIZE.phrases > 40, JSON.stringify(hant.HANT_TABLE_SIZE));
  check('T-12 一字多形字不进字表（制/发/后 的坑已用词表覆盖）', !('制' in hant.CHAR_TABLE));
}

console.log('contextBridge 参数序列化（响应式代理无法穿过 IPC）');
{
  /*
   * 根因（本轮实测定位）：渲染层把 ref/reactive 里的对象直接传给 window.api.* 时，
   * **contextBridge 会在 preload 代码执行之前就把参数复制到隔离世界**，用的正是 V8 值序列化器 ——
   * 遇到 Vue 的响应式 Proxy 直接抛 "An object could not be cloned."。
   * 所以在 preload 里兜底是无效的（参数早就复制完了），只能在调用点转成纯数据。
   * 用户可见表现：工作台"动作执行失败"、命令面板点了没反应。主进程日志里一条记录都不会有。
   */
  const { plain } = await import('../src/utils.ts');
  const vue = await import('vue');
  const v8 = await import('node:v8');

  /** 用 Electron IPC 同款序列化器判定"能不能过桥" */
  const crossable = (v) => {
    try {
      v8.deserialize(v8.serialize(v));
      return true;
    } catch {
      return false;
    }
  };

  // 先证明这个判定有区分度：不转就过不去
  check('（对照）响应式对象直接过桥会失败', !crossable(vue.ref({ type: 'text' }).value));
  check('（对照）响应式数组项直接过桥会失败', !crossable(vue.ref([{ id: 'a' }]).value[0]));

  check('plain() 剥掉对象 ref 的代理', crossable(plain(vue.ref({ type: 'text', text: 'x' }).value)));
  check('plain() 剥掉数组项的代理', crossable(plain(vue.ref([{ id: 'a', label: 'b' }]).value[0])));
  check('plain() 剥掉嵌套对象的代理', crossable(plain(vue.reactive({ a: { b: { c: 1 } } }))));
  check('plain() 剥掉"展开响应式数组"后的元素（工作台待办快照的写法）', crossable(plain([...vue.ref([{ id: 1 }]).value, { id: 2 }])));
  check('plain() 不改变数据内容', JSON.stringify(plain(vue.ref({ a: 1, b: [2, 3] }).value)) === '{"a":1,"b":[2,3]}');
  check('plain() 对 null/undefined 原样返回', plain(null) === null && plain(undefined) === undefined);

  // 调用点契约：这些地方都传过响应式对象（每一条都对应一个真实会炸的入口）
  const sites = [
    ['src/DeskboardApp.vue', /runContextAction\(a\.id, plain\(ctxPayload\.value\)\)/],
    ['src/DeskboardApp.vue', /contextActions\(plain\(ctxPayload\.value\)\)/],
    ['src/DeskboardApp.vue', /palette\.execute\(plain\(r\)\)/],
    ['src/DeskboardApp.vue', /modules\.update\(todoModuleId\.value, plain\(\{ config: \{ items \} \}\)\)/],
    ['src/PaletteApp.vue', /palette\.execute\(plain\(result\), openFolder\)/],
    ['src/components/SearchPanel.vue', /palette\.execute\(plain\(result\)\)/],
    ['src/views/PluginForgeView.vue', /forge\.install\(plain\(result\.value\)\)/],
    ['src/views/PluginForgeView.vue', /forge\.publish\(plain\(result\.value\)\)/],
    ['src/LongApp.vue', /longFinish\(plain\(segments\.value\)\)/],
    ['src/ClipboardApp.vue', /snippets\.save\(plain\(draft\.value\)\)/],
    ['src/views/ClipboardView.vue', /snippets\.save\(plain\(editing\.value\)\)/],
    // 设置写入的唯一入口收口：一处覆盖所有 settings.update 调用点（patch 里常带响应式嵌套对象）
    ['src/stores/settings.ts', /updateSettings\(plain\(patch\)\)/]
  ];
  let fixed = 0;
  for (const [file, re] of sites) {
    if (re.test(readFileSync(join(ROOT, file), 'utf-8'))) fixed++;
    else console.error('   调用点未修复：', file, re.source);
  }
  check(`响应式参数调用点全部已转纯数据（${fixed}/${sites.length}）`, fixed === sites.length);
}

console.log('悬浮窗行为（侧边栏自动收回的时序防护）');
{
  const wb = await import('../shared/windowBehavior.ts');
  const { beginCollapseSession, stepCollapse, shouldCollapseOnBlur, COLLAPSE_GRACE_MS, COLLAPSE_LEAVE_MS } = wb;

  /** 用一条伪时间轴跑状态机，返回"发生收回的时刻"（没收回返回 null） */
  const run = (samples) => {
    let st = beginCollapseSession(0);
    for (const [t, inside] of samples) {
      const r = stepCollapse(st, { now: t, inside });
      st = r.state;
      if (r.collapse) return t;
    }
    return null;
  };

  check('光标从未进入过：永不自动收回（热键唤出时鼠标本来就在别处）', run([[500, false], [5000, false], [60000, false]]) === null);
  // 用户反馈的核心场景：展开后 ~1s 光标移开就没了（本机日志实测 1.03s/1.54s 被收回）
  check('进入后立刻离开：宽限期内不收回（旧实现会在这里消失）', run([[500, true], [1000, false]]) === null);
  check('宽限期内光标在外也不收回', run([[100, false], [300, true], [400, false], [900, false], [1100, false]]) === null);
  const t1 = run([[500, true], [1300, false], [2000, false], [2300, false], [3000, false]]);
  check('持续离开超过去抖时长后才收回', t1 !== null && t1 >= COLLAPSE_GRACE_MS + COLLAPSE_LEAVE_MS, String(t1));
  check('短暂离开又回来：去抖计时被重置（扫过边界不算离开）', run([[300, true], [1400, false], [1700, true], [2000, false], [2500, false], [2700, false]]) === null);
  // 宽限期内出现"在外"采样不能开始去抖计时：否则 t=400 开始计时 → 1300 就被收回
  check('去抖起点不从宽限期内偷跑', run([[200, true], [400, false], [1300, false], [1600, false]]) === null);

  check('会话重置清掉"上一次入内过"', (() => {
    const s = beginCollapseSession(1000);
    return s.wasInside === false && s.shownAt === 1000 && s.outsideSince === 0;
  })());
  /*
   * 对照实验 —— 这是本机日志里 1.54s 那次收回的真正成因：
   * 若沿用上一轮的 wasInside=true（shownAt 也是旧的、宽限期早已失效），
   * 那么这一轮**光标从未靠近侧边栏**也会在 1.5s 被收回（去抖两次采样后触发）。
   * 也就是说"光加宽限期"并不能修好它，必须每次展开都重置会话。
   */
  const stale = (() => {
    let s = { wasInside: true, shownAt: 0, outsideSince: 0 };
    for (const t of [500, 1000, 1500, 2000, 2500, 3000]) {
      const r = stepCollapse(s, { now: t, inside: false });
      s = r.state;
      if (r.collapse) return t;
    }
    return null;
  })();
  // 宽限期把旧的 1.5s 推迟到 2.5s，但**依然会误收** —— 所以只加宽限期是不够的，必须重置会话
  check('（对照）不重置会话：光标从未靠近也会在 2.5s 被误收回', stale === 2500, String(stale));
  check('重置会话后同样时序不再收回', run([[500, false], [1000, false], [1500, false], [2000, false]]) === null);

  check('失焦在宽限期内不收回（工作台/宠物呼出时的焦点交接）', shouldCollapseOnBlur({ wasInside: true, shownAt: 1000, outsideSince: 0 }, 1500) === false);
  check('失焦且已过宽限期才收回', shouldCollapseOnBlur({ wasInside: true, shownAt: 1000, outsideSince: 0 }, 2500) === true);
  check('未入内过则失焦也不收回', shouldCollapseOnBlur({ wasInside: false, shownAt: 1000, outsideSince: 0 }, 99999) === false);

  const sb = readFileSync(join(ROOT, 'electron', 'windows', 'sidebarWindow.ts'), 'utf-8');
  check('侧边栏已接入纯函数状态机', /stepCollapse\(collapse, \{ now: Date\.now\(\), inside \}\)/.test(sb) && /beginCollapseSession/.test(sb));
  check('每次展开都重置收回会话', /collapse = beginCollapseSession\(Date\.now\(\)\)/.test(sb));
  check('失焦收回同样过宽限期', /shouldCollapseOnBlur\(collapse, Date\.now\(\)\)/.test(sb));
  // 宠物可见性派生自窗口事件（任何隐藏路径都能把宠物还回来）
  check('侧边栏显示时隐藏宠物、隐藏/销毁时恢复（事件驱动）', /win\.on\('show', \(\) => hidePet\(\)\)/.test(sb) && /win\.on\('hide', \(\) => showPet\(\)\)/.test(sb) && /win\.on\('closed', \(\) => \{[\s\S]{0,120}showPet\(\)/.test(sb));
  check('hideSidebar 不再成对手写 showPet（改由 hide 事件负责）', !/win\.hide\(\);\s*\n\s*showPet\(\)/.test(sb));
  check('展开侧边栏前先收起工作台（消除重叠窗口期）', /hideDeskboard\(\);/.test(sb) && /from '\.\/deskboardWindow'/.test(sb));
}

console.log('T-06 UGC 主题包（制作 / 导入 / 分享）');
{
  const zip = await import('../shared/themePack/zip.ts');
  const inflate = await import('../shared/themePack/inflate.ts');
  const manifest = await import('../shared/themePack/manifest.ts');
  const zlib = await import('node:zlib');
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // ---- 1) ZIP 读写往返（真实字节，不查字符串）----
  const payload = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 251);
  const pack = zip.buildZip(
    [
      { name: 'theme.json', data: enc('{"format":"xiaopeng-theme","中文字段":"值"}') },
      { name: 'pet.png', data: payload },
      { name: 'frames/nod/01.png', data: payload.subarray(0, 100) },
      { name: 'readme copy.md', data: enc('# 说明') }
    ],
    new Date(2026, 0, 2, 3, 4, 6)
  );
  const back = zip.readZip(pack);
  check('T-06 ZIP 往返：条目数一致', back.entries.length === 4);
  check('T-06 ZIP 往返：中文内容无损', dec(back.files.get('theme.json')).includes('中文字段'));
  check('T-06 ZIP 往返：二进制逐字节一致', same(back.files.get('pet.png'), payload));
  check('T-06 ZIP 往返：目录内文件可读', back.files.get('frames/nod/01.png').length === 100);
  check('T-06 ZIP 往返：含空格文件名', back.files.has('readme copy.md'));
  check(
    'T-06 ZIP 内容被篡改必须被 CRC 拦截',
    (() => {
      const bad = pack.slice();
      const at = pack.length - 60;
      bad[at] = bad[at] ^ 0xff;
      try {
        zip.readZip(bad);
        return false;
      } catch {
        return true;
      }
    })()
  );

  // ---- 2) 与系统压缩工具互操作（用户会用「右键→压缩文件夹」打包）----
  const deflated = new Uint8Array(zlib.deflateRawSync(Buffer.from(enc('小鹏工具箱主题包 theme'))));
  check('T-06 自研 inflate 与 node:zlib 结果一致', dec(inflate.inflateRaw(deflated, 4096)) === '小鹏工具箱主题包 theme');
  for (const [label, opts] of [
    ['stored', { level: 0 }],
    ['fixed', { strategy: zlib.constants.Z_FIXED }],
    ['dynamic', { level: 9 }]
  ]) {
    const raw = Uint8Array.from({ length: 30000 }, (_, i) => (i * 7 + (i >> 3)) % 256);
    const compressed = new Uint8Array(zlib.deflateRawSync(Buffer.from(raw), opts));
    check('T-06 inflate 支持 ' + label + ' 块', same(inflate.inflateRaw(compressed, raw.length + 1), raw));
  }
  check(
    'T-06 inflate 输出超限立即报错（解压炸弹拦截）',
    (() => {
      try {
        inflate.inflateRaw(new Uint8Array(zlib.deflateRawSync(Buffer.alloc(200000))), 1000);
        return false;
      } catch {
        return true;
      }
    })()
  );
  // 注意：要匹配「真正的 import」而不是字面量 node:zlib —— 文件注释里正好解释了"为什么不用 node:zlib"，
  // 只判字面量会让这条断言永远失败（本断言自己踩过）
  const inflateSrc = readFileSync(join(ROOT, 'shared', 'themePack', 'inflate.ts'), 'utf-8');
  check('T-06 纯 JS 实现，不依赖 node:zlib', !/from ['"]node:zlib['"]|require\(['"]node:zlib['"]\)/.test(inflateSrc));

  // ---- 3) 安全拦截面（UGC 输入不可信）----
  const NUL = String.fromCharCode(0);
  const BS = String.fromCharCode(92);
  const evilNames = [
    '../evil.png',
    'a' + BS + '..' + BS + '..' + BS + 'evil.png',
    '/etc/passwd.png',
    'C:/Windows/x.png',
    'a.png:evil',
    BS + BS + 'server' + BS + 'share' + BS + 'x.png',
    'CON.png',
    'x.png.',
    'a' + NUL + 'b.png'
  ];
  const blocked = evilNames.filter((n) => zip.normalizeZipPath(n) === null).length;
  check('T-06 路径穿越面全部拦截（' + blocked + '/' + evilNames.length + '）', blocked === evilNames.length);
  check('T-06 合法相对路径放行', zip.normalizeZipPath('frames/nod/01.png') === 'frames/nod/01.png');
  check('T-06 反斜杠路径归一化', zip.normalizeZipPath('frames' + BS + 'nod' + BS + '01.png') === 'frames/nod/01.png');

  const rejects = (fn, re) => {
    try {
      fn();
      return false;
    } catch (e) {
      return re ? re.test(e.message) : true;
    }
  };
  check('T-06 拒绝空文件', rejects(() => zip.listZipEntries(new Uint8Array(0))));
  check('T-06 拒绝非 ZIP 内容', rejects(() => zip.listZipEntries(enc('this is not a zip file at all'))));
  check('T-06 拒绝截断的 ZIP', rejects(() => zip.listZipEntries(pack.subarray(0, pack.length - 40))));
  check(
    'T-06 拒绝重复条目名（覆盖同名文件攻击）',
    rejects(
      () => zip.listZipEntries(zip.buildZip([{ name: 'a.png', data: enc('1') }, { name: 'a.png', data: enc('2') }])),
      /重复条目/
    )
  );
  check(
    'T-06 拒绝超大单文件（按声明值拦截，先审后解）',
    rejects(
      () =>
        zip.listZipEntries(pack, {
          maxEntries: 512,
          maxEntryUncompressed: 10,
          maxTotalUncompressed: 1 << 20,
          maxCompressionRatio: 200,
          maxNameLength: 180
        }),
      /单文件过大/
    )
  );
  check(
    'T-06 拒绝条目数超限',
    rejects(
      () =>
        zip.listZipEntries(pack, {
          maxEntries: 2,
          maxEntryUncompressed: 1 << 20,
          maxTotalUncompressed: 1 << 20,
          maxCompressionRatio: 200,
          maxNameLength: 180
        }),
      /条目过多/
    )
  );
  check(
    'T-06 拒绝压缩比异常的炸弹包',
    rejects(() => {
      const bomb = zip.buildZip([{ name: 'a.png', data: new Uint8Array(0) }]);
      const dv = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
      // 中央目录在本地头之后，偏移要从 EOCD 里读（写死下标会改到本地头的字段上，测试就假通过了）
      const cd = dv.getUint32(bomb.length - 22 + 16, true);
      dv.setUint32(cd + 24, 1024 * 1024, true); // 声明解压后 1MB
      dv.setUint32(cd + 20, 1024, true); // 声明压缩后 1KB → 压缩比 1024:1
      zip.listZipEntries(bomb);
    }, /解压炸弹/)
  );

  // ---- 4) 清单校验规则（面向创作者的错误提示）----
  const base = {
    format: 'xiaopeng-theme',
    formatVersion: 1,
    id: 'com.test.cat',
    name: '测试主题',
    version: '1.0.0',
    image: 'pet.png'
  };
  const files = ['pet.png', 'frames/nod/01.png'];
  const ok1 = manifest.normalizeThemeManifest({ ...base, actions: { nod: ['frames/nod/01.png'] } }, files);
  check('T-06 合法清单通过校验', ok1.ok);
  check('T-06 未声明动作补齐为空数组', ok1.ok && Array.isArray(ok1.manifest.actions.wave) && ok1.manifest.actions.wave.length === 0);

  const badCases = [
    ['非对象清单', 'not-an-object', /不是有效的对象/],
    ['format 不匹配', { ...base, format: 'other' }, /不是小鹏工具箱主题包/],
    ['版本过新', { ...base, formatVersion: 99 }, /版本过新/],
    ['id 不合法', { ...base, id: 'Bad_ID' }, /id 不合法/],
    ['id 无命名空间', { ...base, id: 'cat' }, /id 不合法/],
    ['name 为空', { ...base, name: '   ' }, /name 不能为空/],
    ['version 不合法', { ...base, version: 'v1 beta' }, /version 不合法/],
    ['homepage 非 http', { ...base, homepage: 'javascript:alert(1)' }, /homepage/],
    ['image 非图片', { ...base, image: 'pet.exe' }, /必须是图片文件/],
    ['引用文件缺失', { ...base, image: 'missing.png' }, /缺少清单引用的文件/],
    ['动作帧缺失', { ...base, actions: { nod: ['frames/nod/99.png'] } }, /缺少清单引用的文件/],
    ['actions 非对象', { ...base, actions: ['nod'] }, /必须是「动作名 → 文件名数组」/],
    ['动作帧非数组', { ...base, actions: { nod: 'frames/nod/01.png' } }, /必须是文件名数组/],
    ['动作帧含非图片', { ...base, actions: { nod: ['x.txt'] } }, /含非图片文件/]
  ];
  let badOk = 0;
  for (const [, raw, re] of badCases) {
    const r = manifest.normalizeThemeManifest(raw, files);
    if (!r.ok && re.test(r.error)) badOk++;
    else console.error('   未按预期拒绝：', JSON.stringify(raw), '→', r.ok ? 'ok' : r.error);
  }
  check('T-06 非法清单全部拒绝并给出可读原因（' + badOk + '/' + badCases.length + '）', badOk === badCases.length);

  const style = manifest.normalizeThemeManifest(
    {
      ...base,
      scale: 99,
      tags: ['猫', '可爱', '', 'x'.repeat(50)],
      bubble: { bg: 'red;background:url(x)', color: '#FFF', fontSize: 999, radius: -5 },
      skin: { theme: 'neon', accent: '#5b8cff' }
    },
    files
  );
  check('T-06 颜色只接受 #hex（拒绝任意 CSS 注入）', style.ok && style.manifest.bubble.bg === '' && style.manifest.bubble.color === '#fff');
  check('T-06 气泡字号/圆角夹取到合法区间', style.ok && style.manifest.bubble.fontSize === 24 && style.manifest.bubble.radius === 0);
  check('T-06 scale 夹取到 4 以内', style.ok && style.manifest.scale === 4);
  check('T-06 标签去空并按长度截断', style.ok && style.manifest.tags.length === 3 && style.manifest.tags[2].length === 16);
  check('T-06 非法明暗主题被丢弃（skin 仅保留合法字段）', style.ok && style.manifest.skin.theme === '' && style.manifest.skin.accent === '#5b8cff');

  check(
    'T-06 主题包只允许图片与文本（无可执行类型）',
    !['.exe', '.dll', '.ps1', '.bat', '.py', '.js', '.msi'].some((e) => manifest.isAllowedThemeEntry('x' + e))
  );
  check('T-06 id 生成兜底（中文名也有合法 id）', manifest.isValidThemeId(manifest.themeIdFromName('橘猫', 'a1b2c3')));
  check('T-06 slug 化 id 稳定可读', manifest.themeIdFromName('Orange Cat', 'a1b2c3') === 'local.orange-cat-a1b2c3');
  const share = manifest.themeShareText(ok1.manifest, { sha256: 'abc123', bytes: 2048, frames: 3 });
  check('T-06 分享文案含 SHA256 与安装指引', share.includes('abc123') && share.includes('主题包') && share.includes('.xptheme'));

  // ---- 5) 服务层：先审后解 / 不信任渲染层路径 ----
  const svc = readFileSync(join(ROOT, 'electron', 'services', 'themePack.ts'), 'utf-8');
  const listAt = svc.indexOf('entries = listZipEntries(buf, DEFAULT_ZIP_LIMITS)');
  const writeAt = svc.indexOf('writeFileSync(dest, data)');
  check('T-06 先校验目录再解压落盘（先审后解）', listAt > 0 && writeAt > listAt);
  check(
    'T-06 解压到暂存目录，失败不污染已安装主题',
    /const staging = join\(themesRoot\(\)/.test(svc) && /\.staging-/.test(svc) && /rmSync\(staging/.test(svc)
  );
  check('T-06 内置主题不可删除', /内置主题不可删除/.test(svc) && /id === BUILTIN_THEME_ID/.test(svc));
  // 真实漏洞（自查发现）：removeTheme 曾用调用方传来的 id 现拼路径 + rmSync(recursive)，
  // 传 "../../Documents" 就等于任意目录删除。现在删除目标取自目录扫描结果，并带 id 校验与兜底断言。
  check('T-06 主题目录路径拼接带 id 校验（防任意目录删除）', /function themeDir\(id: string\): string \{\s*if \(!isValidThemeId\(id\)\) throw/.test(svc));
  check('T-06 删除目标取自扫描结果而非调用方 id', /const info = getThemeInfo\(id\);\s*\n\s*if \(!info\) return \{ ok: false, error: '主题包不存在' \};/.test(svc) && /const dir = info\.dir;/.test(svc));
  check('T-06 删除前兜底断言路径位于主题目录内', /dir !== join\(root, basename\(dir\)\)/.test(svc));
  check('T-06 主题包不允许可执行内容（服务层再拦一次）', /assertThemeEntries/.test(svc) && /只允许图片与文本/.test(svc));
  check('T-06 主题列表不做索引文件（扫描即自愈）', !/themes\.json/.test(svc) && /readdirSync\(root\)/.test(svc));
  check('T-06 制作只打包当前设置里的形象/动作帧', /String\(settings\.petImage \|\| defaultPetImage\(\)\)/.test(svc));

  const ipc = readFileSync(join(ROOT, 'electron', 'ipc', 'themeIpc.ts'), 'utf-8');
  check('T-06 IPC 丢弃渲染层传来的路径字段', /只保留文案类字段/.test(ipc) && !/draft\.image/.test(ipc) && !/draft\.actions/.test(ipc));
  check('T-06 覆盖确认复用主进程记录的路径', /pendingImport/.test(ipc) && /const file = pendingImport/.test(ipc));

  // ---- 6) 畸形输入模糊测试（UGC 包在传输/编辑后可能被任意破坏）----
  let fuzzOk = 0;
  const FUZZ_N = 300;
  const seeds = [pack, zip.buildZip([{ name: 'theme.json', data: enc('{"a":1}') }]), new Uint8Array(64).fill(0x50)];
  for (let i = 0; i < FUZZ_N; i++) {
    const buf = seeds[i % seeds.length].slice();
    const flips = 1 + (i % 8);
    for (let k = 0; k < flips; k++) buf[(i * 7919 + k * 104729) % buf.length] ^= (i + k * 31) & 0xff;
    try {
      zip.readZip(buf); // 解出来也算合法结果
      fuzzOk++;
    } catch (e) {
      if (e instanceof Error) fuzzOk++;
    }
  }
  check(`T-06 畸形压缩包模糊测试：只干净报错，不挂死不崩溃（${fuzzOk}/${FUZZ_N}）`, fuzzOk === FUZZ_N);

  let inflateFuzz = 0;
  for (let i = 0; i < 200; i++) {
    const b = Uint8Array.from({ length: 64 }, (_, k) => (i * 31 + k * 17) & 0xff);
    try {
      inflate.inflateRaw(b, 1 << 20);
      inflateFuzz++;
    } catch (e) {
      if (e instanceof Error) inflateFuzz++;
    }
  }
  check('T-06 inflate 对随机字节只报错不挂死（200 例）', inflateFuzz === 200);

  // 缓存必须"变更即失效"：否则导入后列表要等 TTL，应用主题后宠物窗样式不跟手
  check(
    'T-06 主题列表缓存带 TTL 且在变更点显式失效',
    /const LIST_TTL_MS/.test(svc) && (svc.match(/afterMutation\(\)/g) ?? []).length >= 4
  );

  const st = readFileSync(join(ROOT, 'electron', 'store', 'dataStore.ts'), 'utf-8');
  check('T-06 设置项 petThemeId 默认空（内置形象）', /petThemeId: ''/.test(st));
  check(
    'T-06 宠物窗按主题包渲染气泡样式',
    /bubbleStyle/.test(readFileSync(join(ROOT, 'src', 'PetApp.vue'), 'utf-8')) &&
      /activeBubbleStyle/.test(readFileSync(join(ROOT, 'electron', 'services', 'petManager.ts'), 'utf-8'))
  );
}


// =====================================================================================
// 优化方案 OPT-xx 回归（审计整改 + 幽灵窗口修复）
//   规则本体尽量放在 shared/ 的纯函数里，这里既断言行为，也用源码断言锁住"服务层真的接上了"。
// =====================================================================================
{
  const pkg = await import('../shared/pluginPackage.ts');
  // 设置默认值文件在后面的 OPT-15/16/18 断言里也会用到，先读一次（避免 TDZ 顺序问题）
  const st = readFileSync(join(ROOT, 'electron', 'store', 'dataStore.ts'), 'utf-8');

  // ---- OPT-09 / OPT-19：插件标识与清单校验（SEC-001 的根因面） ----
  check('OPT-09 插件标识白名单接受反向域名式 id', pkg.isValidPluginId('com.example.hello') && pkg.isValidPluginId('com.office.screenshot.region'));
  const badIds = ['..', '../..', 'a/b.c', 'hello', 'Com.Example', '.com.a', 'com..a', '', 'com.a b'];
  check(
    `OPT-09 插件标识白名单拒绝路径穿越等非法值（${badIds.filter((i) => !pkg.isValidPluginId(i)).length}/${badIds.length}）`,
    badIds.every((i) => !pkg.isValidPluginId(i))
  );

  const root = join(ROOT, 'userData', 'plugins');
  check('OPT-09 合法 id 解析到插件根内的目录', pkg.resolvePluginDir(root, 'com.foo.bar') === join(root, 'com.foo.bar'));
  check(
    'OPT-09 路径 containment：.. / 绝对路径 / 越界一律返回 null',
    pkg.resolvePluginDir(root, '..') === null &&
      pkg.resolvePluginDir(root, '..' + sep + '..' + sep + 'Windows') === null &&
      pkg.resolvePluginDir(root, 'C:' + sep + 'Windows') === null &&
      pkg.resolvePluginDir(root, '.') === null
  );

  const goodManifest = pkg.normalizePluginManifest({ id: 'com.foo.bar', name: 'Foo', version: '1.0.0', entry: 'main.py', type: 'module' });
  check('OPT-19 合法清单归一化通过', goodManifest.ok === true && goodManifest.manifest.type === 'module');
  const iconNum = pkg.normalizePluginManifest({ id: 'com.foo.bar', name: 'Foo', version: '1.0.0', entry: 'main.py', icon: 123 });
  check('OPT-19 manifest.icon 为数字时不再整体抛错（丢弃该字段）', iconNum.ok === true && iconNum.manifest.icon === undefined);
  check(
    'OPT-19 entry 越界（上级目录与子目录）一律拒绝',
    pkg.normalizePluginManifest({ id: 'com.foo.bar', name: 'F', version: '1', entry: '..' + sep + 'evil.py' }).ok === false &&
      pkg.normalizePluginManifest({ id: 'com.foo.bar', name: 'F', version: '1', entry: 'sub/main.py' }).ok === false
  );
  check(
    'OPT-19 字段类型异常不再让 plugins:list 整体失败（逐项归一）',
    pkg.normalizePluginManifest({ id: 'com.foo.bar', name: 42, version: '1.0.0', entry: 'main.py' }).ok === false ||
      pkg.normalizePluginManifest({ id: 'com.foo.bar', name: 'F', version: '1.0.0', entry: 'main.py', author: 5 }).ok === true
  );

  // ---- OPT-19 / DEF-007：版本号（参与路径拼接，必须白名单） ----
  check('OPT-19 版本号白名单接受常见形态', ['1.0.0', '1.2.3-beta.1', '2.0.0+build5'].every((v) => pkg.isValidPluginVersion(v)));
  check(
    'OPT-19 版本号拒绝路径穿越与分隔符',
    ['..', '..' + sep + 'x', 'a/b', '1.0.0/..', '', 'x'.repeat(40)].every((v) => !pkg.isValidPluginVersion(v))
  );

  // ---- OPT-15：内置插件保留命名空间 ----
  check('OPT-15 com.office.* 为保留命名空间', pkg.isReservedPluginId('com.office.convert.all'));
  check('OPT-15 com.example.* 为保留命名空间', pkg.isReservedPluginId('com.example.hello'));
  check('OPT-15 第三方命名空间不受影响', !pkg.isReservedPluginId('com.acme.tool'));
  check(
    'OPT-15 市场条目被保留了内置命名空间时给出可读原因',
    String(pkg.marketItemBlockedReason({ id: 'com.office.screenshot.region', version: '1.0.0' }) ?? '').includes('保留') &&
      pkg.marketItemBlockedReason({ id: 'com.acme.tool', version: '1.0.0' }) === null &&
      pkg.marketItemBlockedReason({ id: 'com.acme.tool', version: '..' + sep + 'x' }) !== null
  );

  // ---- 服务层接线断言：规则写在 shared 里，但必须真的被调用 ----
  const pm = readFileSync(join(ROOT, 'electron', 'services', 'pluginManager.ts'), 'utf-8');
  const installBody = pm.slice(pm.indexOf('export async function installPlugin'), pm.indexOf('export function trustPlugin'));
  check('OPT-09 installPlugin 走 resolvePluginDir（id 白名单 + containment）', /resolvePluginDir\(parent, manifest\.id\)/.test(installBody));
  check('OPT-09 installPlugin 删除已有目录前弹确认框', /覆盖已有插件确认/.test(installBody) && /if \(response !== 0\) return listPlugins\(\)/.test(installBody));
  check('OPT-09 installPlugin 复制失败清理残留（不留半截目录）', /插件复制失败（已清理残留）/.test(installBody));
  check(
    'OPT-09 installPlugin 不再用 join(parent, manifest.id) 直接拼路径',
    !/const target = join\(parent, manifest\.id\)/.test(pm)
  );
  check('OPT-19 readManifest 走 normalizePluginManifest', /normalizePluginManifest\(JSON\.parse\(raw\)\)/.test(pm));
  check('OPT-15 listPlugins 对同 id 冲突显式标记并告警', /conflictIds/.test(pm) && /插件标识冲突/.test(pm) && /rec\.conflict = true/.test(pm));

  const mk = readFileSync(join(ROOT, 'electron', 'services', 'marketplace.ts'), 'utf-8');
  check('OPT-15/16 市场安装拒绝内置保留命名空间', /isReservedPluginId\(item\.id\)/.test(mk) && /内置插件保留命名空间/.test(mk));
  check('OPT-15 市场安装拒绝顶替本机内置插件', /builtinSameId/.test(mk));
  check('OPT-16 远程索引默认关闭（有闸门且默认值为 false）', /function remoteIndexBlocked/.test(mk) && /marketAllowRemoteIndex !== true/.test(mk) && /marketAllowRemoteIndex: false/.test(st));
  check('OPT-17 解压侧上限与主题包口径对齐（条目/单文件/总量）', /maxEntries: 2048/.test(mk) && /maxTotalUncompressed: 256 \* 1024 \* 1024/.test(mk));
  check('OPT-17 listZipEntries fail-closed（列不出条目即拒绝）', /reject\(new Error\(`安装包无法读取/.test(mk) && !/if \(err\) return resolve\(\[\]\)/.test(mk));
  check('OPT-17 解压后断言全部文件落在目标目录内', /function assertExtractedInside/.test(mk) && /assertExtractedInside\(zip, dest\)/.test(mk));
  check('OPT-21 加密留存移到清单校验通过之后', mk.indexOf('backupSecurePackage(item, zip)') > mk.indexOf('插件标识与市场条目不一致'));
  const settingsVue = readFileSync(join(ROOT, 'src', 'views', 'SettingsView.vue'), 'utf-8');
  check(
    'OPT-11 加密留存不再承诺"离线重装"（注释与设置页文案都如实化）',
    /旧注释写的是"可离线重装\/备份"/.test(mk) &&
      !/^\s*\*\s*安装成功前将安装包 AES-256-GCM 加密留存.*可离线重装/m.test(mk) &&
      /仅作加密归档/.test(settingsVue) &&
      /暂不支持从留存包离线重装/.test(settingsVue)
  );

  const ipcMod = readFileSync(join(ROOT, 'electron', 'ipc', 'moduleIpc.ts'), 'utf-8');
  check(
    'OPT-18 安全敏感设置从通用通道摘除（trustedSources / mcpToken / deepseekApiKey）',
    /MAIN_PROCESS_ONLY_SETTINGS/.test(st) &&
      /'trustedSources', 'mcpToken', 'deepseekApiKey'/.test(st) &&
      /dataStore\(\)\.updateSettings\(patch\)/.test(ipcMod) &&
      /updateSettingsTrusted/.test(readFileSync(join(ROOT, 'electron', 'services', 'pluginManager.ts'), 'utf-8'))
  );

  // ---- OPT-01 / OPT-02 / OPT-08：幽灵窗口防线 ----
  const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf-8');
  check(
    'OPT-01 禁用 Chromium 原生遮挡计算',
    /appendSwitch\('disable-features', 'CalculateNativeWinOcclusion'\)/.test(mainSrc)
  );
  const perfSrc = readFileSync(join(ROOT, 'electron', 'services', 'perf.ts'), 'utf-8');
  check(
    'OPT-01 只对最小化/不可见窗口开启节流（可见窗永不停帧）',
    /win\.isMinimized\(\) \|\| !win\.isVisible\(\)/.test(perfSrc) &&
      /setBackgroundThrottling\(background \? eff\.idleRelease : false\)/.test(perfSrc)
  );
  check('OPT-02 常驻交互窗集合与 isPermanentInteractiveWindow 存在', /PERMANENT_INTERACTIVE_PAGES/.test(readFileSync(join(ROOT, 'electron', 'windows', 'common.ts'), 'utf-8')));
  for (const f of ['deskboardWindow', 'sidebarWindow', 'paletteWindow']) {
    check(
      `OPT-02 ${f} webPreferences 关闭背景节流`,
      /backgroundThrottling: false/.test(readFileSync(join(ROOT, 'electron', 'windows', f + '.ts'), 'utf-8'))
    );
  }

  const wd = readFileSync(join(ROOT, 'electron', 'services', 'windowWatchdog.ts'), 'utf-8');
  check('OPT-08 看门狗接入 gpu-process-gone', /gpu-process-gone/.test(wd) && /GPU 进程异常退出/.test(wd));
  check('OPT-08 unresponsive 宽限后自动恢复（不再只记日志）', /UNRESPONSIVE_GRACE_MS/.test(wd) && /recordCrashAndRecover\(win, 'unresponsive'\)/.test(wd));
  // 实测缺陷回归：launch-failed 会毫秒级连发十几次 render-process-gone，
  // 原实现每次都弹通知 → 用户侧"通知一直在弹"。现在必须有限流 + 启动失败不重载。
  check(
    '看门狗通知限流（单窗口 10 分钟 + 全局预算），不再刷屏',
    /NOTIFY_COOLDOWN_MS = 10 \* 60 \* 1000/.test(wd) &&
      /NOTIFY_GLOBAL_BUDGET/.test(wd) &&
      /function notifyThrottled/.test(wd) &&
      /notifyThrottled\(id, t\('app.name'\), t\('notify.crashHidden'/.test(wd) &&
      /notifyThrottled\(0, t\('app.name'\), t\('notify.gpuGone'/.test(wd)
  );
  check(
    '看门狗区分 launch-failed：不重载、直接隐藏（重载修不好环境级故障）',
    // R2-T8 重构后，判定收敛到 decideRecovery 状态机；这里只断言"看门狗真的按它执行"
    /details\.reason === 'launch-failed'/.test(wd) &&
      /const action = decideRecovery\(breaker, \{/.test(wd) &&
      /const hideNow = action === 'hide-only'/.test(wd) &&
      /渲染进程启动失败（launch-failed），不再重载/.test(wd)
  );
  check(
    '启动自检：渲染进程集体起不来时给出汇总与可操作指引',
    /checkRenderHealthAtStartup/.test(mainSrc) && /启动自检失败/.test(mainSrc) && /renderHealthSummary/.test(wd)
  );
  check(
    'launch-failed 时留下环境快照与 Chromium 日志指引（一次拿全根因数据）',
    /function logLaunchFailureContext/.test(wd) &&
      /launch-failed 环境快照/.test(wd) &&
      /XP_RENDER_DEBUG/.test(mainSrc)
  );
  // =====================================================================================
  // R2-T8 / R2-T3：启动熔断与兼容模式自救（审计 DEF-R01 / UX-001）
  //   熔断是安全关键行为：判错一边 = 无限重试刷爆日志，另一边 = 误把偶发崩溃当环境故障。
  //   因此规则本体抽成 shared/renderBreaker.ts 纯函数，这里逐条断言边界。
  // =====================================================================================
  {
    const br = await import('../shared/renderBreaker.ts');
    const fresh = br.initialBreakerState();
    check('R2-T8 初始态未熔断', fresh.broken === false && fresh.reason === '');

    check('R2-T8 launch-failed 被识别为环境级故障', br.isLaunchFailure('launch-failed') === true);
    // 实机回归：调用方曾把 reason 拼成 `reason=launch-failed` 传给状态机，
    // 精确匹配失败 → 熔断永不触发 → 窗口反复重建、通知一直弹。
    check(
      'R2-T8 容忍展示用的 reason= 前缀（实机踩过：精确匹配导致熔断永不触发）',
      br.isLaunchFailure('reason=launch-failed') === true &&
        br.isLaunchFailure('reason: launch-failed') === true &&
        br.isLaunchFailure(' launch-failed ') === true
    );
    check(
      'R2-T8 前缀剥离不等于包含匹配（不误判 crashpad-launch-failed 之类）',
      br.isLaunchFailure('crashpad-launch-failed') === false &&
        br.isLaunchFailure('not-launch-failed') === false
    );
    check(
      'R2-T8 调用点传原始 reason，不再拼 reason= 前缀',
      /enterLaunchBreaker\(details\.reason\)/.test(wd) && !/enterLaunchBreaker\(`reason=/.test(wd)
    );
    check(
      'R2-T8 运行期崩溃不被误判为环境级故障',
      ['crashed', 'oom', 'killed', 'integrity-failure'].every((r) => br.isLaunchFailure(r) === false)
    );

    const afterLaunch = br.recordRenderGone(fresh, 'launch-failed');
    check('R2-T8 launch-failed 一次即熔断（不等待 3 次阈值）', afterLaunch.broken === true && afterLaunch.reason.includes('launch-failed'));
    check(
      'R2-T8 运行期崩溃不触发熔断',
      br.recordRenderGone(fresh, 'crashed').broken === false && br.recordRenderGone(fresh, 'oom').broken === false
    );
    check(
      'R2-T8 熔断后永久保持（不自愈，避免"每 5 分钟再撞 15 次"）',
      br.recordRenderGone(afterLaunch, 'crashed').broken === true &&
        br.recordRenderGone(afterLaunch, 'launch-failed').reason === afterLaunch.reason
    );

    // 恢复动作决策表（这是审计 DEF-R01 的核心：熔断期间不能再建渲染进程）
    const H = 3;
    check(
      'R2-T8 熔断期间一切恢复动作短路为 skip',
      br.decideRecovery(afterLaunch, { launchFailed: false, recentFailures: 0, hideThreshold: H }) === 'skip' &&
        br.decideRecovery(afterLaunch, { launchFailed: true, recentFailures: 9, hideThreshold: H }) === 'skip'
    );
    check(
      'R2-T8 启动失败只隐藏不重载（重载一万次也起不来）',
      br.decideRecovery(fresh, { launchFailed: true, recentFailures: 1, hideThreshold: H }) === 'hide-only'
    );
    check(
      'R2-T8 偶发运行期崩溃仍然允许重载（不误伤正常恢复）',
      br.decideRecovery(fresh, { launchFailed: false, recentFailures: 1, hideThreshold: H }) === 'reload' &&
        br.decideRecovery(fresh, { launchFailed: false, recentFailures: 2, hideThreshold: H }) === 'reload'
    );
    check(
      'R2-T8 反复崩溃达阈值转为隐藏（原有策略不回退）',
      br.decideRecovery(fresh, { launchFailed: false, recentFailures: 3, hideThreshold: H }) === 'hide-only'
    );

    // 服务层必须真的用上这个状态机，而不是各写一份判断
    check(
      'R2-T8 看门狗接入纯状态机（单一事实来源）',
      /from '\.\.\/\.\.\/shared\/renderBreaker\.ts'/.test(wd) &&
        /decideRecovery\(breaker, \{/.test(wd) &&
        /breaker = recordRenderGone\(breaker, reason\)/.test(wd) &&
        /if \(breaker\.broken\) return;/.test(wd)
    );
  }

  // ---- R2-T3：launch-failed 时的产品内自救（原生对话框 + 兼容模式重启）----
  // RUN-001 根因（实机取证）：integrity=High = 提权运行 → 提权进程建不了沙箱子进程。
  /*
   * 提权判据必须只有一条通道，且**不得**用"再 spawn 一个进程读文本"来判断本进程状态。
   *
   * 教训：初版解析 `whoami /groups` 的本地化文本，在同一个进程里先后给出相反答案
   * （15:01:15 报已提权、15:01:24 报未提权），造成"又报错又正常"的自相矛盾，
   * 把排查引向错误方向。现在只调 `IsInRole(Administrator)` 一条通道。
   * 注意：断言里的正则**不要**对 `[` `]` 加反斜杠 —— 源码里就是裸方括号。
   */
  check(
    'RUN-001 提权判据只有一条通道（IsInRole），不用"spawn 读文本"判断本进程状态',
    /export function isProcessElevated/.test(wd) &&
      /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/.test(wd) &&
      /elevationCache/.test(wd)
  );
  check(
    'RUN-001 提权只作诊断信息，不单独触发警报（避免"又报错又正常"的自相矛盾）',
    /提权运行=\$\{elevated \? '是' : '否'\}，窗口=\$\{h\.windows\}/.test(mainSrc) &&
      /提权运行=\$\{isProcessElevated\(\) \? '是（提权进程可能无法创建沙箱子进程，可作为可疑因素）' : '否'\}/.test(mainSrc) &&
      !/logError\(\s*'\[main\] 本程序正以【管理员身份】运行/.test(mainSrc)
  );
  check(
    'RUN-001 提权检测失败时按未提权处理（宁可不降级也不误报）',
    /elevationCache = status === 1;/.test(wd) && /elevationCache = false; \/\/ 正常退出/.test(wd)
  );
  check(
    'RUN-001 反应式恢复：观测到 launch-failed 且沙箱开启时才重启一次（不预测式降级）',
    /function recoverFromSandboxLaunchFailure/.test(wd) &&
      /function sandboxExplicitlyDisabled/.test(wd) &&
      /if \(sandboxExplicitlyDisabled\(\)\)/.test(wd) &&
      /recoverFromSandboxLaunchFailure\(\);/.test(wd)
  );
  check(
    'RUN-001 自动重启有防循环保护（一次进程生命周期只重启一次）',
    /let compatRelaunchDone = false;/.test(wd) && /if \(compatRelaunchDone\) return;/.test(wd)
  );
  check(
    'RUN-001 关沙箱仍失败时不再徒劳重启（并把结论写进日志）',
    /已关闭沙箱仍然 launch-failed —— 问题不在沙箱，不再自动重启/.test(wd)
  );
  check(
    'RUN-001 沙箱只在用户显式要求时降级（撤掉未经证实的"提权自动降级"）',
    /if \(sandboxDisabledByEnv \|\| sandboxDisabledByArg\)/.test(mainSrc) &&
      /已按用户选择关闭 Chromium 沙箱/.test(mainSrc) &&
      !/sandboxDisabledByElevation/.test(mainSrc) &&
      !/已自动关闭 Chromium 沙箱/.test(mainSrc)
  );
  check(
    'RUN-001 记录"谁让它降级的"（便于事后归因，而不是静默降级）',
    /已按用户选择关闭 Chromium 沙箱/.test(mainSrc)
  );
  check(
    'RUN-001 故障对话框只给可执行处置，不断言未经验证的因果（提权已被推翻）',
    /function buildCompatibilityDetail/.test(wd) &&
      /detail: buildCompatibilityDetail\(\)/.test(wd) &&
      /这是目前唯一被证实可用的处置/.test(wd) &&
      !/这正是界面出不来的原因/.test(wd)
  );
  check(
    'RUN-001 熔断日志直接标明是否提权（便于一眼定性）',
    /提权运行=\$\{elevated/.test(wd)
  );
  check(
    'R2-T3 熔断时弹原生对话框（通知受节流，对话框才保证看得见）',
    /dialog\.showMessageBox/.test(wd) && /以兼容模式重启（关闭沙箱）/.test(wd) && /showCompatibilityDialog/.test(wd)
  );
  check(
    'R2-T3 一键重启走 app.relaunch 并追加 --no-sandbox',
    /app\.relaunch\(\{ args \}\)/.test(wd) && /args\.push\('--no-sandbox'\)/.test(wd)
  );
  check(
    'R2-T3 命令行也接受 --no-sandbox（relaunch 无法注入环境变量）',
    /process\.argv\.includes\('--no-sandbox'\)/.test(mainSrc) &&
      /sandboxDisabledByArg/.test(mainSrc)
  );
  check(
    'R2-T3 对话框只在用户点击后降级（不静默关沙箱）',
    /if \(response !== 0\) return;/.test(wd) && /用户选择以兼容模式重启/.test(wd)
  );

  // ---- R2-T2 / R2-T4：分发包自检门禁 ----
  const verifier = readFileSync(join(ROOT, 'scripts', 'verify-dist.mjs'), 'utf-8');
  check(
    'R2-T2 构建后自检门禁存在且接入 npm run dist',
    /verify-dist/.test(readFileSync(join(ROOT, 'package.json'), 'utf-8')) && verifier.length > 1000
  );
  check(
    'R2-T2 半成品安装包必须被拦（体积下限断言）',
    /MIN_INSTALLER_BYTES/.test(verifier) && /这是 NSIS 第一遍的中间安装器/.test(verifier)
  );
  check(
    'R2-T2 载荷可解析性断言（7-Zip 完整性测试）',
    /'t', payload/.test(verifier) && /应用载荷可解析/.test(verifier)
  );
  check(
    'R2-T4 同源同版本断言（安装器内主程序 == win-unpacked 主程序）',
    /同源同版本/.test(verifier) && /innerBytes === unpackedBytes/.test(verifier)
  );
  check(
    'R2-T5 产物自检含"版本资源已写入"断言（防再发出未处理的 Electron 拷贝）',
    /主程序已写入自有版本资源/.test(verifier) && /ProductName/.test(verifier)
  );
  check(
    'R2-T5 资源编辑不依赖 GitHub（走 electron-builder 自带纯 JS 实现）',
    /editWindowsResources/.test(readFileSync(join(ROOT, 'scripts', 'stamp-exe.mjs'), 'utf-8')) &&
      /app-builder-lib/.test(readFileSync(join(ROOT, 'scripts', 'stamp-exe.mjs'), 'utf-8'))
  );
  check(
    'R2-T5 stamp 已接入 npm run dist，且资源编辑不改权限级别（仍 asInvoker）',
    /stamp-exe\.mjs/.test(readFileSync(join(ROOT, 'package.json'), 'utf-8')) &&
      /requestedExecutionLevel: 'asInvoker'/.test(readFileSync(join(ROOT, 'scripts', 'stamp-exe.mjs'), 'utf-8'))
  );
  check(
    'R2-T2 自检结果落盘留档',
    /dist-selfcheck\.json/.test(verifier)
  );
  {
    const prep = readFileSync(join(ROOT, 'scripts', 'prepare-dist.mjs'), 'utf-8');
    check(
      'R2-T2/QUAL-R02 构建前清理上一轮产物（防三类产物混放）',
      /cleanStaleArtifacts/.test(prep) &&
        prep.includes('(merged)') &&
        prep.includes('__uninstaller.exe') &&
        prep.includes('.nsis.7z') &&
        /cleanStaleArtifacts\(\);/.test(prep)
    );
  }

  /*
   * R2-T6/DOC-001：诊断脚本不再把用户带偏。
   *
   * 原断言读 `诊断-小鹏工具箱启动.ps1` 的内容，检查它已删除被证伪的"electron 39"结论。
   * 2026-09-30 清理时该脚本已删除（4 模式对比的价值已并入 docs/变更记录.md），
   * 于是断言改为锁定**删除这一事实**：若有人重新引入该脚本，这里会失败并提醒同步结论。
   */
  check(
    'R2-T6/DOC-001 已被证伪的"electron 39"诊断脚本不再随仓库分发',
    !existsSync(join(ROOT, '诊断-小鹏工具箱启动.ps1')),
    '若确需重新引入诊断脚本，请先确认其结论与 docs/变更记录.md 一致'
  );
  // ---- 专项调查发现：better-sqlite3 的 Node-API 门槛与"升级即丢数据"风险 ----
  const sqliteDbSrc = readFileSync(join(ROOT, 'electron', 'store', 'db.ts'), 'utf-8');
  check(
    'DB-01 探针改为"成功标记 + 退出码"双条件（旧实现只看退出码）',
    /XP_SQLITE_PROBE_OK/.test(sqliteDbSrc) && /markOk/.test(sqliteDbSrc) && /r\.status === 0 && markOk/.test(sqliteDbSrc)
  );
  check(
    'DB-01 探针不再丢弃 stderr（旧实现 stdio:ignore 把失败原因整段丢掉）',
    /encoding: 'utf-8'/.test(sqliteDbSrc) && /stderr=\$\{stderr/.test(sqliteDbSrc) && !/stdio: 'ignore'/.test(sqliteDbSrc)
  );
  check(
    'DB-01 探针区分"子进程没起来"与"二进制不兼容"（避免误导性报错）',
    /这不是 ABI 问题/.test(sqliteDbSrc) && /r\.signal/.test(sqliteDbSrc)
  );
  check(
    'DB-01 失败原因写入日志（含退出码十六进制与 Node-API 版本）',
    /原因：\$\{probe\.detail\}/.test(sqliteDbSrc) && /Node-API/.test(sqliteDbSrc)
  );
  check(
    'DB-02 空库 + 存在 JSON 历史数据时一次性导入（防升级后"数据全丢"）',
    /function migrateJsonIntoEmptySqlite/.test(sqliteDbSrc) &&
      /migrateJsonIntoEmptySqlite\(backend\)/.test(sqliteDbSrc) &&
      /sqlite\.all\('settings'\)\.length > 0\) return/.test(sqliteDbSrc) &&
      /已一次性导入 SQLite 空库/.test(sqliteDbSrc)
  );
  check('DB-02 迁移源文件保留不删（可回溯）', /源文件保留不删/.test(sqliteDbSrc) && !/rmSync\(jsonFile/.test(sqliteDbSrc));
  check(
    'RUN-001 清除继承来的 Windows 兼容层（Installer/Detectors* 挂钩进程创建）',
    /COMPAT_SHIMS/.test(mainSrc) &&
      /delete process\.env\['__COMPAT_LAYER'\]/.test(mainSrc) &&
      /已清除继承来的 Windows 兼容层/.test(mainSrc) &&
      /DetectorsAdminProtection\|DetectorsAppHealth/.test(mainSrc)
  );
  check(
    'RUN-001 清除是无害且可审计的（只删除本进程环境变量，不碰注册表）',
    !/Set-ItemProperty/.test(mainSrc) && !/registry/i.test(mainSrc) && /只影响本进程/.test(mainSrc)
  );
  check(
    '诊断探针默认零噪音（只在渲染异常时写、有 256KB 上限）',
    /PROBE_MAX_BYTES = 256 \* 1024/.test(wd) &&
      /render-probe\.log/.test(wd) &&
      /statSync\(file\)\.size > PROBE_MAX_BYTES/.test(wd)
  );
  check(
    'R2-T7 补一条不依赖 Chrome 日志的取证路径（child-process-gone）',
    /installChildProcessForensics/.test(wd) &&
      /'child-process-gone'/.test(wd) &&
      /子进程退出：type=/.test(wd) &&
      /CHILD_GONE_LOG_LIMIT/.test(wd)
  );
  check(
    'R2-T7 抓日志通道双入口（环境变量 + 命令行），且日志路径明确落盘',
    /XP_RENDER_DEBUG'\] === '1'/.test(mainSrc) &&
      /process\.argv\.includes\('--render-debug'\)/.test(mainSrc) &&
      /chromium\.log/.test(mainSrc) &&
      /appendSwitch\('enable-logging', 'file'\)/.test(mainSrc)
  );
  check(
    'R2-T6/QUAL-R01 兼容模式启动器不再硬编码开发机路径',
    /%~dp0/.test(readFileSync(join(ROOT, '启动-兼容模式(关沙箱).bat'), 'utf-8')) &&
      !/D:\\mimo小鹏工具箱\\dist\\win-unpacked/.test(readFileSync(join(ROOT, '启动-兼容模式(关沙箱).bat'), 'utf-8'))
  );
  check('OPT-14 周期性活性探测（capturePage 采样 + 连续无变化判定）', /installLivenessProbe/.test(wd) && /capturePage\(rect\)/.test(wd) && /INDICATOR_FREEZE_STRIKES/.test(wd));
  check('OPT-14 探测只覆盖"必然出帧"的指示窗（避免误判静止页）', /INDICATOR_PAGES = \/\(\?:\^\|\\\/\)\(pet\|index\|palette\|deskboard\)/.test(wd));
  check('OPT-14 探测开关默认开启且可在设置里关闭', /windowLivenessProbe: true/.test(st) && /windowLivenessProbe !== false/.test(wd));

  const capW = readFileSync(join(ROOT, 'electron', 'windows', 'captureWindows.ts'), 'utf-8');
  const capM = readFileSync(join(ROOT, 'electron', 'services', 'captureManager.ts'), 'utf-8');
  // 遮罩状态必须"句柄 + 钩子"打包并做身份校验：destroy() 的 'closed' 是异步投递的，
// 长截图的"关旧遮罩 → 建新遮罩"之间迟到的旧监听器不能抹掉新窗口的句柄/钩子。
check(
  'OPT-03 遮罩销毁钩子（任何销毁路径都释放捕获会话）',
  /interface OverlayState/.test(capW) &&
    /overlay = null; \/\/ 先摘状态/.test(capW) &&
    /if \(overlay !== state\) return;/.test(capW) &&
    /onOverlayTornDown/.test(capM)
);
  check('OPT-03 遮罩崩溃/无响应直接关闭（不 reload）', /render-process-gone.*遮罩|遮罩渲染进程异常退出/.test(capM) && /遮罩无响应/.test(capM));
  check('OPT-03 捕获会话超时兜底会关闭遮罩', /捕获会话超时（120s）/.test(capM) && /closeOverlay\(\)/.test(capM.slice(capM.indexOf('CAPTURE_BUSY_TIMEOUT_MS'))));
  check('OPT-03 逃生口导出且不与渲染路径重复实现', /export function abortCapture/.test(capM));
  const traySrc = readFileSync(join(ROOT, 'electron', 'services', 'trayManager.ts'), 'utf-8');
  check('OPT-03 托盘提供「退出截图」逃生口', /abortCapture/.test(traySrc) && /tray\.abortCapture/.test(traySrc));
  check(
  'OPT-06 长截图控制条关闭释放互斥锁',
  /interface LongState/.test(capW) &&
    /if \(long !== state\) return;/.test(capW) &&
    /长截图控制条已关闭，捕获会话已释放/.test(capM)
);
// 长截图是"遮罩选完 → 关遮罩 → 开控制条"，关遮罩属正常步骤：无条件清 longRect 会让 longStep 立刻返回 null
check(
  'OPT-06 关闭遮罩不误清长截图选中区（只在其无控制条接管时清）',
  /if \(!longWindow\(\)\) \{\s*\n\s*longRect = null;/.test(capM)
);
  check('OPT-06 捕获忙时有用户可见提示', /notifyCaptureBusy/.test(capM) && /上一次截图还没结束/.test(capM));

  const hk = readFileSync(join(ROOT, 'electron', 'services', 'hotkeyManager.ts'), 'utf-8');
  check('OPT-04 热键注册失败弹一次可见通知', /notifyHotkeyFailure/.test(hk) && /notify\.hotkeyConflict/.test(hk));
  check('OPT-04 热键恢复可用时给出确认通知', /notifyHotkeyRecovered/.test(hk));
  for (const f of ['deskboardWindow', 'clipboardWindow', 'paletteWindow']) {
    check(
      `OPT-04 ${f} 的注册结果仍统一回报（通知由 hotkeyManager 收口）`,
      /reportHotkey\(/.test(readFileSync(join(ROOT, 'electron', 'windows', f + '.ts'), 'utf-8'))
    );
  }

  const deskboardSrc = readFileSync(join(ROOT, 'electron', 'windows', 'deskboardWindow.ts'), 'utf-8');
  check('OPT-05 工作台显示前夹取到当前显示器工作区', /clampToVisibleArea/.test(deskboardSrc) && /getDisplayMatching\(b\)\.workArea/.test(deskboardSrc));
  check('OPT-05 夹取发生在 show 之前', deskboardSrc.indexOf('clampToVisibleArea(w);') < deskboardSrc.indexOf('w.showInactive();'));
  check('OPT-07 收尾 focus 带 isVisible 守卫', /if \(!w\.isDestroyed\(\) && w\.isVisible\(\)\) w\.focus\(\)/.test(deskboardSrc));

  // ---- OPT-10：窗口导航防护（SEC-002） ----
  const commonSrc = readFileSync(join(ROOT, 'electron', 'windows', 'common.ts'), 'utf-8');
  check(
    'OPT-10 统一入口注册 setWindowOpenHandler 且一律 deny',
    /setWindowOpenHandler/.test(commonSrc) && /action: 'deny'/.test(commonSrc)
  );
  check('OPT-10 统一入口注册 will-navigate 守卫', /'will-navigate'/.test(commonSrc) && /event\.preventDefault\(\)/.test(commonSrc));
  check('OPT-10 外链走 openExternalSafe 协议白名单', /openExternalSafe/.test(commonSrc));
  check(
    'OPT-10 防护幂等（同一窗口只注册一次）',
    /NAV_HARDENED/.test(commonSrc) && /if \(wc\[NAV_HARDENED\]\) return;/.test(commonSrc)
  );
  // 所有窗口都必须经过 loadPage 这个唯一入口，否则"统一入口"名不副实
  const winDir = join(ROOT, 'electron', 'windows');
  const winFiles = readdirSync(winDir).filter((f) => f.endsWith('.ts') && f !== 'common.ts');
  const missingLoad = winFiles.filter((f) => {
    const src = readFileSync(join(winDir, f), 'utf-8');
    return /new BrowserWindow\(/.test(src) && !/loadPage\(/.test(src);
  });
  check(`OPT-10 全部窗口经过统一入口 loadPage（未接入：${missingLoad.join('、') || '无'}）`, missingLoad.length === 0);

  // ---- OPT-20：主题扫描对非法目录名免疫 ----
  const themeSvc = readFileSync(join(ROOT, 'electron', 'services', 'themePack.ts'), 'utf-8');
  check('OPT-20 readInstalledManifest 入口先做 id 校验', /function readInstalledManifest\(id: string\): ThemeManifest \| null \{\s*\n\s*if \(!isValidThemeId\(id\)\)/.test(themeSvc));
  check('OPT-20 单目录处理包 try/catch（坏目录不拖垮整个列表）', /主题目录处理失败，已跳过/.test(themeSvc));
};

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
