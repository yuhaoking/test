
import { createHash } from 'node:crypto';
import * as codec from '../shared/devtools/codec.ts';
import * as hash from '../shared/devtools/hash.ts';
import * as regex from '../shared/devtools/regex.ts';

// --- hash: correct reference (utf8) ---
const samples = ['小鹏工具箱', 'abc', '', '😀', 'a'.repeat(300)];
for (let i = 0; i < 50; i++) { let s=''; for (let k=0;k<30;k++) s += String.fromCodePoint(Math.floor(Math.random()*0x10ffff)+1); samples.push(s); }
let bad = 0;
for (const s of samples) {
  const h = hash.hashAll(s);
  for (const a of ['md5','sha1','sha256']) {
    const ref = createHash(a).update(s, 'utf8').digest('hex');
    if (h[a] !== ref) { bad++; if (bad<4) console.log('HASH MISMATCH', a, JSON.stringify(s).slice(0,40), h[a], ref); }
  }
}
console.log(bad === 0 ? 'ok  hash 与 node:crypto(utf8) 完全一致' : 'BUG hash 有 '+bad+' 处不一致');

// --- base64 lone surrogate ---
const lone = '\ud83d'; // half of an emoji
console.log('lone surrogate: mine=' + codec.base64Encode(lone) + '  node=' + Buffer.from(lone,'utf8').toString('base64') + '  python-style=' + Buffer.from([0xed,0xa0,0xbd]).toString('base64'));
const rt = codec.base64Decode(codec.base64Encode(lone));
console.log('lone surrogate roundtrip equal=' + (rt === lone) + ' codePoints=' + [...rt].map(c=>c.codePointAt(0).toString(16)).join(','));

// --- regex catastrophic backtracking scaling (renderer freeze risk) ---
for (const n of [20, 24, 26, 28]) {
  const t0 = process.hrtime.bigint();
  regex.regexTest('(a+)+$', 'g', 'a'.repeat(n) + 'b');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  backtrack n=' + n + ' -> ' + ms.toFixed(0) + 'ms');
  if (ms > 8000) break;
}
