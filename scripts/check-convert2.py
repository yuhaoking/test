import json
import os
import subprocess
import sys
import time
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = os.path.join(ROOT, '.tmp-office')
os.makedirs(tmp, exist_ok=True)
sys.path.insert(0, os.path.join(ROOT, 'plugins', '_shared'))
import screen_capture as sc


class Rpc:
    def __init__(self):
        self.child = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, 'plugins', 'office-convert-all', 'main.py')],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            env={**os.environ, 'PYTHONUTF8': '1', 'PLUGIN_SAVE_DIR': tmp}
        )
        self.rid = 0
        import queue
        import threading
        self.q = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.child.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.q.put(json.loads(line))
            except Exception:
                pass

    def call(self, method, params, timeout=60):
        self.rid += 1
        rid = self.rid
        self.child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}) + '\n')
        self.child.stdin.flush()
        import queue
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self.q.get(timeout=0.2)
            except queue.Empty:
                continue
            if msg.get('id') == rid:
                return msg
        return None

    def close(self):
        try:
            self.child.kill()
        except Exception:
            pass


def ui_options(rpc, paths):
    ui = rpc.call('plugin.get_ui', {'values': {'paths': paths}})
    res = (ui or {}).get('result') or {}
    inputs = res.get('inputs') or []
    target_input = next((i for i in inputs if i.get('id') == 'target'), {})
    text = (res.get('text') or '')
    return target_input.get('options') or [], text


ok_all = True
rpc = Rpc()
try:
    print('== 1. 未选择文件 ==')
    opts, text = ui_options(rpc, '')
    print('options:', opts, '| text head:', text.split('\n')[0])
    if opts:
        ok_all = False

    print('== 2. 图片文件 → 仅图片类+pdf ==')
    # 用截图生成一张 PNG
    p1 = os.path.join(tmp, 'a.png')
    p2 = os.path.join(tmp, 'b.png')
    data, w, h = sc.capture_full()
    sc.save_png(p1, w, h, data)
    sc.save_png(p2, w, h, data)
    opts, text = ui_options(rpc, p1)
    print('options:', opts)
    print('text head:', text.split('\n')[0])
    expect_img = sorted(['png', 'jpg', 'bmp', 'webp', 'gif', 'ico', 'tiff', 'pdf'])
    if sorted(opts) != expect_img:
        ok_all = False
        print('  FAIL: 期望', expect_img)

    print('== 3. 音频文件（生成 wav）→ 仅音频类 ==')
    wavfile = os.path.join(tmp, 'tone.wav')
    with wave.open(wavfile, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(b'\x00\x00' * 16000)
    opts, text = ui_options(rpc, wavfile)
    print('options:', opts)
    if not set(opts) <= {'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'}:
        ok_all = False
        print('  FAIL')

    print('== 4. 视频文件（用 wav 推导不出；直接改 ext 生成 mp4 头? 跳过 ffmpeg 缺失场景）==')
    vid = os.path.join(tmp, 'dummy.mp4')
    with open(vid, 'wb') as f:
        f.write(bytes.fromhex('00000018667479706d703432'))  # 仅为扩展名检测
    opts, text = ui_options(rpc, vid)
    print('options:', opts)
    if 'mp4' not in opts:
        ok_all = False
        print('  FAIL: 视频源应含视频目标')

    print('== 5. 图片合并 PDF + PDF 加密/解密/提取 ==')
    res = rpc.call('plugin.handle_action', {'action': 'convert', 'values': {'paths': p1 + ';' + p2, 'target': 'pdf'}})
    print('images->pdf:', (res or {}).get('result'))
    pdf = None
    for f in os.listdir(tmp):
        if f.endswith('_merged.pdf'):
            pdf = os.path.join(tmp, f)
    if not pdf:
        ok_all = False
    if pdf:
        opts, text = ui_options(rpc, pdf)
        print('pdf options:', opts)
        if 'pdf-encrypt' not in opts:
            ok_all = False
        res = rpc.call('plugin.handle_action', {'action': 'convert', 'values': {'paths': pdf, 'target': 'pdf-encrypt', 'password': '123'}})
        print('encrypt:', (res or {}).get('result'))
        enc = None
        for f in os.listdir(tmp):
            if f.endswith('_encrypted.pdf'):
                enc = os.path.join(tmp, f)
        if not enc:
            ok_all = False
        if enc:
            res = rpc.call('plugin.handle_action', {'action': 'convert', 'values': {'paths': enc, 'target': 'pdf-decrypt', 'password': '123'}})
            print('decrypt:', (res or {}).get('result'))
            res = rpc.call('plugin.handle_action', {'action': 'convert', 'values': {'paths': enc, 'target': 'pdf-text'}})
            print('text from encrypted(no password, expect fail):', (res or {}).get('result'))

    print('== 6. 文档/文本 → 含编码目标 ==')
    txt = os.path.join(tmp, 'n.txt')
    with open(txt, 'w', encoding='utf-8') as f:
        f.write('你好')
    opts, text = ui_options(rpc, txt)
    print('text options:', opts)
    if 'utf-8' not in opts:
        ok_all = False

    print('== 7. gbk->utf-8 ==')
    gbk = os.path.join(tmp, 'g.txt')
    with open(gbk, 'wb') as f:
        f.write('你好'.encode('gbk'))
    res = rpc.call('plugin.handle_action', {'action': 'convert', 'values': {'paths': gbk, 'target': 'utf-8'}})
    print('gbk->utf8:', (res or {}).get('result'))

    print('== 8. png->jpg ==')
    res = rpc.call('plugin.handle_action', {'action': 'convert', 'values': {'paths': p1, 'target': 'jpg'}})
    print('png->jpg:', (res or {}).get('result'))
finally:
    rpc.close()

print('RESULT:', 'ALL PASS' if ok_all else 'HAS FAILURES')
