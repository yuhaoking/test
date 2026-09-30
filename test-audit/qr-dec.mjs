// 用被测解码器读取 qrcode 库（独立编码器）产生的二维码
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as qr from '../shared/devtools/qrcode.ts';
const OUT = join(process.env.TEMP, 'qr-cross');
const refs = JSON.parse(readFileSync(join(OUT, 'ref.json'), 'utf-8'));
let fail = 0;
for (const r of refs) {
  const raw = readFileSync(join(OUT, r.file));
  const rgba = new Uint8ClampedArray(r.w * r.h * 4);
  for (let i = 0; i < r.w * r.h; i++) { const v = raw[i]; rgba[i*4] = v; rgba[i*4+1] = v; rgba[i*4+2] = v; rgba[i*4+3] = 255; }
  const res = qr.qrDecodeRgba(rgba, r.w, r.h);
  if (!res.ok || res.text !== r.text) { fail++; console.log('  FAIL ' + r.ec + ' ' + JSON.stringify(r.text.slice(0, 30)) + ' -> ' + JSON.stringify(res.ok ? res.text : res)); }
}
console.log(fail === 0 ? '  ok  被测解码器可正确读取第三方编码器产出的 ' + refs.length + ' 张二维码' : '  !! ' + fail + '/' + refs.length + ' 张第三方二维码解码失败');
