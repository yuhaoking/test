/**
 * 独立审计脚本 A：核心纯函数边界与模糊测试（与参考实现对比）
 * 运行：node test-audit/edge-pure.mjs
 */
import { createHash } from 'node:crypto';
import * as codec from '../shared/devtools/codec.ts';
import * as hash from '../shared/devtools/hash.ts';
import * as radix from '../shared/devtools/radix.ts';
import * as time from '../shared/devtools/time.ts';
import * as unit from '../shared/devtools/unit.ts';
import * as diff from '../shared/devtools/diff.ts';
import * as cron from '../shared/devtools/cron.ts';
import * as regex from '../shared/devtools/regex.ts';
import * as intent from '../shared/devtools/intent.ts';
import * as json from '../shared/devtools/json.ts';
import * as uuid from '../shared/devtools/uuid.ts';
import * as qr from '../shared/devtools/qrcode.ts';

let issues = 0;
const report = (area, msg, detail) => {
  issues++;
  console.log('  BUG [' + area + '] ' + msg + (detail !== undefined ? '  :: ' + detail : ''));
};
const note = (area, msg, detail) => console.log('  note[' + area + '] ' + msg + (detail !== undefined ? '  :: ' + detail : ''));
const ok = (area, msg) => console.log('  ok  [' + area + '] ' + msg);

// ---------- 1. codec: Base64 vs Node Buffer ----------
{
  const samples = ['', 'a', 'ab', 'abc', 'abcd', '小鹏工具箱', '😀 emoji 🎉', '\u0000\u0001\u007f', 'a\nb\r\nc', 'x'.repeat(1000)];
  for (let i = 0; i < 200; i++) {
    let s = '';
    const n = Math.floor(Math.random() * 40);
    for (let k = 0; k < n; k++) s += String.fromCodePoint(Math.floor(Math.random() * 0x10ffff) + 1);
    samples.push(s);
  }
  let bad = 0;
  for (const s of samples) {
    const mine = codec.base64Encode(s);
    const ref = Buffer.from(s, 'utf8').toString('base64');
    if (mine !== ref) { bad++; if (bad < 4) report('codec', 'base64Encode 与 Node 不一致', JSON.stringify(s) + ' mine=' + mine + ' ref=' + ref); }
    /*
     * 修正（审计脚本自身缺陷）：样本由 String.fromCodePoint(D800~DFFF) 生成，
     * 会包含**孤立代理项**——它本就是非法 Unicode 标量，任何符合标准的 UTF-8 实现
     * （Node / Python / 本实现）都会替换为 U+FFFD，因此"往返等于原串"是不可满足的期望。
     * 正确的不变量是：往返结果等于"标准 UTF-8 编码再解码"的结果。
     */
    const back = codec.base64Decode(mine);
    const wellFormed = Buffer.from(s, 'utf8').toString('utf8');
    if (back !== wellFormed) { bad++; if (bad < 8) report('codec', 'base64 往返不一致', JSON.stringify(s) + ' -> ' + JSON.stringify(back)); }
  }
  if (!bad) ok('codec', 'Base64 编码/往返与 Node Buffer 一致（' + samples.length + ' 例含随机 Unicode）');

  // 解码容错
  if (codec.base64Decode('!!!!') !== null) report('codec', '非法字符未被拒绝', '!!!!');
  const padded = codec.base64Decode('YWJj====');
  if (padded === null) report('codec', '多余填充被拒绝（容错不足）', 'YWJj====');
  // URL
  const urlSamples = ['a b&c=d', '中文 空格', '#frag?x=1', 'a+b', '%25', 'ü'];
  for (const s of urlSamples) {
    const mine = codec.urlEncode(s);
    const ref = encodeURIComponent(s);
    if (mine !== ref) report('codec', 'urlEncode 与 encodeURIComponent 不一致', JSON.stringify(s) + ' mine=' + mine + ' ref=' + ref);
    const round = codec.urlDecode(mine);
    if (round !== s) report('codec', 'urlEncode/urlDecode 往返不一致', JSON.stringify(s) + ' -> ' + JSON.stringify(round));
  }
  if (codec.urlDecode('a+b') !== 'a+b') report('codec', "urlDecode 把字面 '+' 解码成空格（非 form 语义时应保留）", "'a+b' -> " + JSON.stringify(codec.urlDecode('a+b')));
  if (codec.urlDecode('%E4%B8') !== null) note('codec', '截断的 %XX 序列返回 null（符合“非法返回 null”约定）');
}

// ---------- 2. hash vs node:crypto ----------
{
  const samples = ['', 'abc', '小鹏工具箱', 'x'.repeat(500)];
  for (let i = 0; i < 60; i++) samples.push(Buffer.from(Array.from({ length: Math.floor(Math.random() * 300) }, () => Math.floor(Math.random() * 256))).toString('latin1'));
  let bad = 0;
  for (const s of samples) {
    const h = hash.hashAll(s);
    // 修正（审计脚本自身缺陷）：被测实现按 UTF-8 编码字符串，
    // 这里原先用 'binary'（latin1）构造参考字节，非 ASCII 输入必然"不一致"（假阳性）。
    const buf = Buffer.from(s, 'utf8');
    for (const [algo, key] of [['md5', 'md5'], ['sha1', 'sha1'], ['sha256', 'sha256']]) {
      const ref = createHash(algo).update(buf).digest('hex');
      if (h[key] !== ref) { bad++; if (bad < 5) report('hash', key + ' 与 node:crypto 不一致', JSON.stringify(s.slice(0, 20))); }
    }
  }
  if (!bad) ok('hash', 'MD5/SHA1/SHA256 与 node:crypto 完全一致（' + samples.length + ' 例）');
}

// ---------- 3. radix vs BigInt ----------
{
  const bad = [];
  for (let i = 0; i < 500; i++) {
    const v = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    for (const [base, fn, fmt] of [[2, 'toString', (x) => x.toString(2)], [8, 'toString', (x) => x.toString(8)], [10, 'toString', (x) => x.toString(10)], [16, 'toString', (x) => x.toString(16)]]) {
      const s = v.toString(base);
      const r = radix.radixConvert(s, base);
      if (!r.ok || r.decimal !== Number(v)) { bad.push(base + ':' + s + ' -> ' + JSON.stringify(r).slice(0, 120)); continue; }
      for (const b of [2, 8, 10, 16]) {
        const expect = v.toString(b);
        const got = r.values[String(b)];
        const cmp = b === 16 ? expect.toUpperCase() : expect;
        if (got !== cmp) bad.push('values[' + b + '] ' + s + '(base' + base + ') got=' + got + ' want=' + cmp);
      }
    }
  }
  if (bad.length) report('radix', '进制转换与 BigInt 参考不一致', bad.slice(0, 3).join(' | '));
  else ok('radix', '2/8/10/16 转换与 BigInt 参考一致（500 随机值 × 4 进制）');

  // 边界
  const negHex = radix.radixConvert('-0xFF');
  if (!negHex.ok) note('radix', '带前缀的负数（-0xFF）被拒绝', negHex.message);
  const overflow = radix.radixConvert('99999999999999999999');
  if (overflow.ok) report('radix', '超出安全整数范围未报错', JSON.stringify(overflow).slice(0, 120));
  const withSpace = radix.radixConvert(' 0xff ');
  if (!withSpace.ok) report('radix', '两侧空白导致解析失败', JSON.stringify(withSpace).slice(0, 100));
  const upper0X = radix.radixConvert('0X1F');
  if (!upper0X.ok || upper0X.values['10'] !== '31') report('radix', '0X 大写前缀解析失败', JSON.stringify(upper0X).slice(0, 120));
  const detect = radix.detectRadix('-10');
  if (detect !== 10) note('radix', "detectRadix('-10') = " + detect);
}

// ---------- 4. time ----------
{
  const badDate = time.parseTimeInput('2026-02-30 10:00');
  if (badDate) report('time', '不存在的日期被解析为有效时间（JS 日期溢出未校验）', "'2026-02-30 10:00' -> " + badDate.local);
  const badMonth = time.parseTimeInput('2026-13-01');
  if (badMonth) report('time', '非法月份 13 被接受', "'2026-13-01' -> " + badMonth.local);
  const badTime = time.parseTimeInput('2026-01-01 25:99');
  if (badTime) report('time', '非法时分 25:99 被接受', "'2026-01-01 25:99' -> " + badTime.local);
  const micro = time.parseTimeInput('1727000000000000');
  if (!micro || micro.kind !== 'microseconds' || micro.epochMs !== 1727000000000) report('time', '16 位微秒时间戳解析错误', JSON.stringify(micro));
  const neg = time.parseTimeInput('-1');
  if (neg !== null) report('time', '负数输入被当成时间', JSON.stringify(neg));
  const future = time.parseTimeInput('4102444800001');
  if (future !== null) note('time', '超出 2100 年的 13 位时间戳被拒绝（设计如此）');
  if (time.relativeTime(Date.now() - 400 * 86400000) !== '1 年前') note('time', '相对时间：400 天 -> ' + time.relativeTime(Date.now() - 400 * 86400000));
  // 时区/本地格式
  const t = time.parseTimeInput('1727000000');
  const d = new Date(1727000000000);
  const expectLocal = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  if (t.local !== expectLocal) report('time', '本地时间格式与 Date 不一致', t.local + ' vs ' + expectLocal);
  if (t.zone !== '+08:00' && t.zone.length !== 6) report('time', '时区文本异常', t.zone);
  ok('time', '时间戳基本转换正常（时区 ' + t.zone + '）');
}

// ---------- 5. unit ----------
{
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const fam = unit.UNIT_FAMILIES[Math.floor(Math.random() * unit.UNIT_FAMILIES.length)];
    const a = fam.units[Math.floor(Math.random() * fam.units.length)];
    const b = fam.units[Math.floor(Math.random() * fam.units.length)];
    const v = Math.random() * 1e6 - 5e5;
    const got = unit.convertUnit(v, a.key, b.key);
    const want = (v * a.factor) / b.factor;
    if (got === null || Math.abs(got - want) > Math.abs(want) * 1e-12 + 1e-9) { bad++; if (bad < 4) report('unit', '换算与参考不一致', a.key + '->' + b.key + ' ' + v + ' got=' + got + ' want=' + want); }
  }
  if (!bad) ok('unit', '单位换算与参考公式一致（300 例随机）');
  // 跨族同名单位
  const cross = unit.convertUnit(1, 's', 'm');
  if (cross !== null) report('unit', '跨族单位换算未返回 null', "convertUnit(1,'s','m') = " + cross);
  const caseIns = unit.convertUnit(1, 'KM', 'M');
  if (caseIns !== 1000) note('unit', '单位大小写不敏感：KM->M = ' + caseIns);
  // 'b' 与 'B'
  const dataCase = unit.convertUnit(1, 'kb', 'b');
  if (dataCase !== 1000) report('unit', "单位大小写混用导致歧义/错误：convertUnit(1,'kb','b') = " + dataCase);
  if (unit.formatUnit(0.1 + 0.2) !== '0.3') note('unit', 'formatUnit(0.1+0.2) = ' + unit.formatUnit(0.1 + 0.2));
  if (unit.formatUnit(Infinity) !== '—') report('unit', 'formatUnit(Infinity) 未兜底', unit.formatUnit(Infinity));
}

// ---------- 6. diff ----------
{
  const reconstruct = (res) => ({ a: res.lines.filter((l) => l.type !== 'add').map((l) => l.text).join('\n'), b: res.lines.filter((l) => l.type !== 'del').map((l) => l.text).join('\n') });
  let bad = 0;
  const vocab = ['a', 'b', 'c', 'd', ''];
  for (let i = 0; i < 400; i++) {
    const mk = () => Array.from({ length: Math.floor(Math.random() * 8) }, () => vocab[Math.floor(Math.random() * vocab.length)]).join('\n');
    const A = mk(), B = mk();
    const res = diff.diffLines(A, B);
    const rec = reconstruct(res);
    if (rec.a !== A || rec.b !== B) { bad++; if (bad < 4) report('diff', '行级 diff 无法还原原文', JSON.stringify({ A, B, rec })); }
    const realAdd = res.lines.filter((l) => l.type === 'add').length;
    const realDel = res.lines.filter((l) => l.type === 'del').length;
    if (realAdd !== res.added || realDel !== res.removed) { bad++; report('diff', 'added/removed 计数与行类型不一致', JSON.stringify(res).slice(0, 160)); }
  }
  if (!bad) ok('diff', 'diff 可还原两侧原文且计数自洽（400 随机例）');
  const trunc = diff.diffLines(Array.from({ length: 2500 }, (_, i) => 'l' + i).join('\n'), 'x');
  if (!trunc.truncated) report('diff', '超过 2000 行未标记 truncated', String(trunc.lines.length));
  else note('diff', '超长输入截断标记生效（lines=' + trunc.lines.length + '）');
  const sim = diff.diffSimilarity(diff.diffLines('a\nb\nc\nd', 'w\nx\ny\nz'));
  if (sim !== 0) note('diff', '完全不同文本相似度 = ' + sim);
}

// ---------- 7. cron ----------
{
  // 独立参考实现：逐分钟暴力扫描（仅 5 段，简单子集）
  function refNext(expr, n, from) {
    const p = cron.parseCron(expr);
    if (!p.ok) return [];
    const [secs, mins, hours, doms, months, dows] = p.sets;
    const step = p.withSeconds ? 1000 : 60000;
    const out = [];
    let t = Math.floor(from.getTime() / step) * step + step;
    // 修正（审计脚本自身缺陷）：窗口原为 366 天，'0 0 29 2 *' / '0 0 1 1 *' 这类
    // 长间隔表达式在窗口内取不满 n 条，参考实现返回空/偏少 → 与正确实现"不一致"（假阳性）。
    // 窗口扩到 8 年，覆盖 2 月 29 日的最坏间隔。
    for (let i = 0; i < 366 * 8 * 24 * (p.withSeconds ? 3600 : 60) && out.length < n; i++, t += step) {
      const d = new Date(t);
      if (!secs.includes(d.getSeconds())) continue;
      if (!mins.includes(d.getMinutes())) continue;
      if (!hours.includes(d.getHours())) continue;
      if (!months.includes(d.getMonth() + 1)) continue;
      const domHit = doms.includes(d.getDate());
      const dowHit = dows.includes(d.getDay());
      const domAll = doms.length === 31, dowAll = dows.length === 7;
      const dayOk = domAll && dowAll ? true : domAll ? dowHit : dowAll ? domHit : domHit || dowHit;
      if (!dayOk) continue;
      out.push(d.getTime());
    }
    return out;
  }
  const exprs = ['*/15 9-18 * * 1-5', '0 0 * * *', '30 9 * * *', '0 12 1 * *', '0 0 29 2 *', '*/5 * * * *', '0 0 * * 0', '15 3 * * 1,3,5', '0 0 1 1 *'];
  for (const e of exprs) {
    const from = new Date('2026-09-28T00:00:00');
    const mine = cron.cronNext(e, 5, from).map((d) => d.getTime());
    const ref = refNext(e, 5, from);
    if (JSON.stringify(mine) !== JSON.stringify(ref)) report('cron', 'cronNext 与暴力参考不一致：' + e, JSON.stringify(mine.map((x) => new Date(x).toISOString())) + ' vs ' + JSON.stringify(ref.map((x) => new Date(x).toISOString())));
  }
  ok('cron', 'cronNext 与独立暴力扫描一致（9 个表达式）');
  // 6 段
  const six = cron.cronNext('*/10 * * * * *', 3, new Date('2026-09-28T00:00:00'));
  if (six.length !== 3 || six.some((d) => d.getSeconds() % 10 !== 0)) report('cron', '6 段秒级表达式结果错误', JSON.stringify(six.map((d) => d.toISOString())));
  // 闰年 2/29
  const leap = cron.cronNext('0 0 29 2 *', 3, new Date('2026-01-01T00:00:00'));
  if (leap.length && leap[0].getFullYear() !== 2028) report('cron', '2/29 下一次触发年份错误', String(leap[0]));
  else note('cron', '2/29 下一次 = ' + (leap[0] ? leap[0].toISOString() : '无'));
  // 性能：极端表达式扫描耗时
  const t0 = Date.now();
  cron.cronNext('0 0 29 2 *', 1, new Date('2026-03-01T00:00:00'));
  const dt = Date.now() - t0;
  if (dt > 300) report('cron', 'cronNext 罕见表达式耗时过长（阻塞渲染）', dt + 'ms');
  else note('cron', 'cronNext 罕见表达式耗时 ' + dt + 'ms');
  // describe
  const desc = cron.cronDescribe('0 9 * * *');
  if (!desc.includes('09:00')) note('cron', 'describe("0 9 * * *") = ' + desc);
  if (/^\s*$/.test(cron.cronDescribe('0 9 * * *'))) report('cron', 'describe 返回空');
  const bad = cron.cronDescribe('* * *');
  if (!bad.includes('段')) note('cron', 'describe 非法表达式提示 = ' + bad);
}

// ---------- 8. regex ----------
{
  let bad = 0;
  const cases = [['\\d+', 'g', 'a1b22c333'], ['(\\w)(\\d)?', 'g', 'a1 b c2'], ['^', 'g', 'abc'], ['(?=b)', 'g', 'abc'], ['[', 'g', 'abc'], ['\\p{L}+', 'gu', '中文abc'], ['a*', 'g', 'baaac']];
  for (const [p, f, s] of cases) {
    let ref;
    try { const re = new RegExp(p, f.includes('g') ? f : f + 'g'); ref = []; let m; let guard = 0; while ((m = re.exec(s)) !== null) { ref.push({ v: m[0], i: m.index }); if (m[0] === '') re.lastIndex++; if (++guard > 1000) break; } } catch { ref = null; }
    const mine = regex.regexTest(p, f, s);
    if (ref === null) { if (mine.ok) { bad++; report('regex', '非法正则被接受', p); } continue; }
    const minePairs = mine.matches.map((m) => ({ v: m.value, i: m.index }));
    if (JSON.stringify(minePairs) !== JSON.stringify(ref)) { bad++; if (bad < 4) report('regex', '匹配结果与原生 RegExp 不一致', p + ' on ' + JSON.stringify(s) + ' mine=' + JSON.stringify(minePairs) + ' ref=' + JSON.stringify(ref)); }
    // 高亮必须无损还原原文
    const hl = regex.regexHighlight(p, f, s);
    if (hl.map((x) => x.text).join('') !== s) { bad++; report('regex', '高亮分段无法还原原文', p + ' -> ' + JSON.stringify(hl)); }
  }
  if (!bad) ok('regex', '匹配/高亮与原生 RegExp 一致且高亮无损');
  // 灾难性回溯
  for (const n of [18, 22, 24]) {
    const t0 = Date.now();
    regex.regexTest('(a+)+$', 'g', 'a'.repeat(n) + 'b');
    const dt = Date.now() - t0;
    console.log('  note[regex] 灾难性回溯 n=' + n + ' 耗时 ' + dt + 'ms');
    if (dt > 1500) { report('regex', '表达式导致灾难性回溯，会冻结 UI（MAX_MATCHES 截断对此无效）', '(a+)+$ on ' + n + ' chars took ' + dt + 'ms'); break; }
  }
}

// ---------- 9. intent ----------
{
  const cases = [
    ['https://a.com/x?y=1', 'url'], ['HTTP://A.COM', 'url'], ['ftp://a.com', 'unknown'],
    ['C:\\a\\b.txt', 'path'], ['\\\\srv\\share\\a.txt', 'path'], ['/usr/local/bin/node', 'path'], ['/', 'unknown'],
    ['1727000000', 'timestamp'], ['1727000000000', 'timestamp'],
    ['#fff', 'color'], ['#ffffff', 'color'], ['#ffffffff', 'color'], ['rgb(1,2,3)', 'color'], ['rgba(1,2,3,0.5)', 'color'], ['#ffff', 'unknown'],
    ['{"a":1}', 'json'], ['[1,2]', 'json'], ['{"a":}', 'json'],
    ['', 'unknown'], ['   ', 'unknown'], ['你好', 'unknown'],
    ['a@b.com', 'unknown'], ['192.168.1.1', 'unknown'], ['+86 13800000000', 'unknown'],
  ];
  let bad = 0;
  for (const [input, expect] of cases) {
    const got = intent.inferClipboardIntent(input).kind;
    if (got !== expect) { bad++; report('intent', '识别与预期不符', JSON.stringify(input) + ' got=' + got + ' expect=' + expect); }
  }
  if (!bad) ok('intent', '意图识别 ' + cases.length + ' 例符合预期');
  // 超长截断
  const long = 'x'.repeat(5000);
  const r = intent.inferClipboardIntent(long);
  if (r.text.length !== 2000) report('intent', '超长文本截断长度不符', String(r.text.length));
  // 51 行路径
  const lines = Array.from({ length: 60 }, (_, i) => 'C:\\a\\f' + i + '.txt').join('\r\n');
  const multi = intent.inferClipboardIntent(lines);
  if (multi.kind !== 'path') note('intent', '60 行路径被归类为 ' + multi.kind + '（设计上限 50 行）');
}

// ---------- 10. json / uuid ----------
{
  const j = json.jsonFormat('{"a":1}', 100);
  if (!j.ok) report('json', '缩进参数被拒');
  const deep = JSON.stringify({ a: { b: [1, 2, { c: 3 }] } });
  if (json.jsonMinify(json.jsonFormat(deep).out).out !== deep) report('json', '格式化/压缩往返不一致');
  if (json.jsonFormat('{"a":1}', -5).out !== '{"a":1}') note('json', '负缩进被夹到 0');
  const empty = json.jsonFormat('   ');
  if (empty.ok) report('json', '空白输入未报错'); else if (!empty.message) report('json', '空白输入缺少错误信息');
  const nan = json.jsonFormat('NaN');
  if (nan.ok) report('json', 'NaN 被当作合法 JSON');
  const u = new Set(Array.from({ length: 5000 }, () => uuid.uuidV4()));
  if (u.size !== 5000) report('uuid', 'UUID 出现重复', String(5000 - u.size));
  else ok('uuid', '5000 个 UUID 无重复');
  const badUuid = uuid.uuidV4();
  if (!uuid.isUuid(badUuid)) report('uuid', 'isUuid 拒绝自产 UUID', badUuid);
  if (uuid.isUuid('00000000-0000-0000-0000-000000000000')) note('uuid', 'isUuid 接受全零 UUID（仅形态校验，注释已声明含 v4 版本位）');
}

// ---------- 11. qrcode ----------
{
  const totals = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  let bad = 0;
  for (let v = 1; v <= 10; v++) {
    if (qr.totalCodewords(v) !== totals[v - 1]) { bad++; report('qrcode', '版本 ' + v + ' 总码字数不符', String(qr.totalCodewords(v))); }
  }
  if (!bad) ok('qrcode', '版本 1-10 总码字数与 ISO 一致');
  // 全版本/全纠错级往返
  const texts = ['A', 'hello', 'https://example.com/小鹏?x=1', '1234567890', 'mixed 中文 English 123 🎉'];
  let rt = 0, fail = 0;
  for (let v = 1; v <= 10; v++) {
    for (const ec of ['L', 'M', 'Q', 'H']) {
      for (const t of texts) {
        const enc = qr.qrEncode(t, ec, v);
        if (!enc.ok) continue; // 容量不足
        rt++;
        const dec = qr.qrDecodeMatrix(enc.modules);
        if (!dec.ok || dec.text !== t) { fail++; if (fail < 6) report('qrcode', '矩阵往返失败 v' + v + ' ' + ec, JSON.stringify(t) + ' -> ' + JSON.stringify(dec.ok ? dec.text : dec)); }
      }
    }
  }
  if (!fail) ok('qrcode', '矩阵编解码往返全部通过（' + rt + ' 组 版本×纠错×文本）');
  // 容量边界
  const capacityProbe = (len, ec) => qr.qrEncode('a'.repeat(len), ec).ok;
  for (const ec of ['L', 'H']) {
    let lo = 1, hi = 3000;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (capacityProbe(mid, ec)) lo = mid; else hi = mid - 1; }
    console.log('  note[qrcode] ' + ec + ' 级字节模式最大容量（自动选版）= ' + lo + ' 字符');
    const enc = qr.qrEncode('a'.repeat(lo), ec);
    if (enc.ok) { const d = qr.qrDecodeMatrix(enc.modules); if (!d.ok || d.text.length !== lo) report('qrcode', '最大容量处往返失败 ' + ec, 'len=' + lo); }
    const over = qr.qrEncode('a'.repeat(lo + 1), ec);
    if (over.ok) note('qrcode', '超容量 1 字符仍成功（可能仍有余量）');
  }
  // 图片解码：不同缩放/静默区
  let imgBad = 0;
  for (const scale of [1, 2, 3, 5, 8]) {
    for (const quiet of [0, 1, 4]) {
      const t = 'img-' + scale + '-' + quiet + '-小鹏';
      const enc = qr.qrEncode(t, 'M');
      const dim = enc.size, W = (dim + quiet * 2) * scale;
      const rgba = new Uint8ClampedArray(W * W * 4).fill(255);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const mr = Math.floor(y / scale) - quiet, mc = Math.floor(x / scale) - quiet;
        const dark = mr >= 0 && mc >= 0 && mr < dim && mc < dim && enc.modules[mr][mc];
        const p = (y * W + x) * 4, val = dark ? 0 : 255;
        rgba[p] = val; rgba[p + 1] = val; rgba[p + 2] = val; rgba[p + 3] = 255;
      }
      const d = qr.qrDecodeRgba(rgba, W, W);
      if (!d.ok || d.text !== t) { imgBad++; report('qrcode', '图片解码失败 scale=' + scale + ' quiet=' + quiet, JSON.stringify(d.ok ? d.text : d)); }
    }
  }
  if (!imgBad) ok('qrcode', '图片解码在 scale 1/2/3/5/8 与静默区 0/1/4 下均通过');
}

console.log('\n== 审计脚本 A 结束：发现 ' + issues + ' 个问题 ==');
