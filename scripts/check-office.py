import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'plugins', '_shared'))


def spawn_plugin(name):
    return subprocess.Popen(
        [sys.executable, os.path.join(ROOT, 'plugins', name, 'main.py')],
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        env={**os.environ, 'PYTHONUTF8': '1'}
    )


class Rpc:
    def __init__(self, child):
        self.child = child
        self.rid = 0
        self.messages = __import__('queue').Queue()
        threading = __import__('threading')

        def reader():
            for line in child.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    self.messages.put(json.loads(line))
                except Exception:
                    pass

        t = threading.Thread(target=reader, daemon=True)
        t.start()

    def call(self, method, params, timeout=20):
        self.rid += 1
        rid = self.rid
        self.child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}) + '\n')
        self.child.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self.messages.get(timeout=0.2)
            except __import__('queue').Empty:
                continue
            if msg.get('id') == rid:
                return msg
        return None

    def close(self):
        try:
            self.child.kill()
        except Exception:
            pass


print('== rpc init/get_ui for all office plugins ==')
plugins = sorted(d for d in os.listdir(os.path.join(ROOT, 'plugins')) if d.startswith('office-'))
all_ok = True
for name in plugins:
    child = spawn_plugin(name)
    rpc = Rpc(child)
    ok = False
    try:
        init = rpc.call('plugin.init', {})
        ui = rpc.call('plugin.get_ui', {})
        ok = bool(init and (init.get('result') or {}).get('status') == 'ok' and ui and ui.get('result'))
        if not ok:
            all_ok = False
    finally:
        rpc.close()
    print(('ok  ' if ok else 'FAIL') + ' ' + name)
print('all rpc ok:', all_ok)

print('== color accuracy: mss BGRA->RGB vs PIL reference ==')
try:
    import mss
    import numpy as np
    from PIL import ImageGrab

    with mss.mss() as sct:
        shot = sct.grab(sct.monitors[1])
        ours = np.asarray(shot)[:, :, :3][:, :, ::-1].astype(np.int64)
    ref = np.asarray(ImageGrab.grab(bbox=(0, 0, shot.width, shot.height)).convert('RGB')).astype(np.int64)
    diff_fixed = np.abs(ours - ref).mean()
    diff_raw = np.abs(np.asarray(shot)[:, :, :3].astype(np.int64) - ref).mean()
    print('fixed RGB mean diff: %.2f | raw BGRA mean diff: %.2f' % (diff_fixed, diff_raw))
    print('color fix:', 'ok' if diff_fixed < 12 else 'CHECK')
except Exception as e:
    print('color check skipped:', e)

print('== clipboard CF_DIB ==')
try:
    import ctypes
    import screen_capture as sc

    data, w, h = sc.capture_full()
    ok = sc.copy_png_to_clipboard(w, h, data)
    u32 = ctypes.windll.user32
    if u32.OpenClipboard(0):
        avail = bool(u32.IsClipboardFormatAvailable(8))
        u32.CloseClipboard()
        print('copy returned:', ok, '| CF_DIB available:', avail)
    else:
        print('copy returned:', ok, '| clipboard busy')
except Exception as e:
    print('clipboard check failed:', e)

print('== real 3s mp4 recording via plugin ==')
tmp = os.path.join(ROOT, '.tmp-office')
os.makedirs(tmp, exist_ok=True)
child = spawn_plugin('office-screenrecord-full')
rpc = Rpc(child)
try:
    rpc.call('plugin.init', {})
    res = rpc.call('plugin.handle_action', {'action': 'go', 'values': {'seconds': '3', 'dir': tmp}}, 15)
    print('start result:', (res or {}).get('result'))
    deadline = time.time() + 12
    while time.time() < deadline:
        try:
            msg = rpc.messages.get(timeout=0.3)
        except __import__('queue').Empty:
            continue
        if msg.get('method') == 'event':
            print('worker event:', msg.get('params'))
    mp4s = [f for f in os.listdir(tmp) if f.endswith('.mp4')]
    if mp4s:
        p = os.path.join(tmp, mp4s[0])
        print('mp4:', p, '| size:', os.path.getsize(p))
        import imageio.v2 as imageio
        reader = imageio.get_reader(p)
        meta = reader.get_meta_data()
        print('meta fps/duation/size:', meta.get('fps'), meta.get('duration'), meta.get('size'))
        reader.close()
    else:
        print('mp4 NOT created')
finally:
    rpc.close()

print('== gif 1s via plugin ==')
child = spawn_plugin('office-screenrecord-gif')
rpc = Rpc(child)
try:
    rpc.call('plugin.init', {})
    res = rpc.call('plugin.handle_action', {'action': 'go', 'values': {'seconds': '1', 'fps': '4', 'dir': tmp}}, 15)
    print('start result:', (res or {}).get('result'))
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            msg = rpc.messages.get(timeout=0.3)
        except __import__('queue').Empty:
            continue
        if msg.get('method') == 'event':
            print('worker event:', msg.get('params'))
    gifs = [f for f in os.listdir(tmp) if f.endswith('.gif')]
    print('gif exists:', bool(gifs), ('| size: %d' % os.path.getsize(os.path.join(tmp, gifs[0]))) if gifs else '')
finally:
    rpc.close()

print('done')
