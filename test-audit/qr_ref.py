# -*- coding: utf-8 -*-
"""独立验证：1) zxing-cpp 解码被测实现产出的二维码；2) qrcode 库生成参考二维码供被测解码器读取"""
import json, os, sys
sys.path.insert(0, os.path.join(os.environ['TEMP'], 'qrdec'))
from PIL import Image
import zxingcpp
import qrcode

OUT = os.path.join(os.environ['TEMP'], 'qr-cross')
cases = json.load(open(os.path.join(OUT, 'expect.json'), encoding='utf-8'))

print('--- A. 被测编码器产物 -> zxing-cpp 解码 ---')
checked = fail = 0
for c in cases:
    if not c.get('ok'):
        print('  skip 容量不足: %r %s -> %s' % (c['text'][:30], c['ec'], c.get('err')))
        continue
    checked += 1
    img = Image.open(c['file'])
    res = zxingcpp.read_barcode(img)
    got = res.text if res is not None else None
    if got != c['text']:
        fail += 1
        print('  FAIL v%s-%s %r -> zxing 得到 %r' % (c.get('version'), c['ec'], c['text'][:40], got))
if fail == 0:
    print('  ok  全部 %d 张二维码均可被 zxing-cpp 正确解码（含中文/长文本/全纠错级）' % checked)
else:
    print('  !! %d/%d 张无法被标准解码器识别' % (fail, checked))

print('--- B. qrcode 库（独立编码器）产物 -> 被测解码器 ---')
os.makedirs(os.path.join(OUT, 'ref'), exist_ok=True)
refs = []
ref_texts = ['A', 'hello world', 'https://example.com', '小鹏工具箱', '中文混合ABC123', 'x' * 100, '1234567890']
for i, t in enumerate(ref_texts):
    for ec_name, ec in [('L', qrcode.constants.ERROR_CORRECT_L), ('M', qrcode.constants.ERROR_CORRECT_M),
                        ('Q', qrcode.constants.ERROR_CORRECT_Q), ('H', qrcode.constants.ERROR_CORRECT_H)]:
        q = qrcode.QRCode(error_correction=ec, box_size=1, border=4)
        q.add_data(t); q.make(fit=True)
        img = q.make_image(fill_color='black', back_color='white').convert('L')
        w, h = img.size
        img.save(os.path.join(OUT, 'ref', 'r%d_%s.png' % (i, ec_name)))
        with open(os.path.join(OUT, 'ref', 'r%d_%s.rgba' % (i, ec_name)), 'wb') as f:
            f.write(img.tobytes())
        refs.append({'text': t, 'ec': ec_name, 'w': w, 'h': h, 'file': 'ref/r%d_%s.rgba' % (i, ec_name)})
json.dump(refs, open(os.path.join(OUT, 'ref.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('  参考二维码 %d 张已生成（qrcode 库）' % len(refs))
