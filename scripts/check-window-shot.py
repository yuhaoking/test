import json
import os
import queue
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = os.path.join(ROOT, '.tmp-shot')
os.makedirs(tmp, exist_ok=True)

child = subprocess.Popen(
    [sys.executable, os.path.join(ROOT, 'plugins', 'office-screenshot-window', 'main.py')],
    cwd=os.path.join(ROOT, 'plugins', 'office-screenshot-window'),
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding='utf-8',
    errors='replace',
    env={**os.environ, 'PYTHONUTF8': '1', 'PLUGIN_SAVE_DIR': tmp}
)
q = queue.Queue()
errs = []
threading.Thread(target=lambda: [q.put(json.loads(l.strip())) for l in child.stdout if l.strip().startswith('{')], daemon=True).start()
threading.Thread(target=lambda: [errs.append(l.rstrip()) for l in child.stderr], daemon=True).start()
rid = 0


def call(method, params, timeout=20):
    global rid
    rid += 1
    rid_now = rid
    child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': rid_now, 'method': method, 'params': params}) + '\n')
    child.stdin.flush()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            msg = q.get(timeout=0.25)
        except queue.Empty:
            continue
        if msg.get('id') == rid_now:
            return msg
    return None


try:
    print('init:', call('plugin.init', {}))
    res = call('plugin.handle_action', {'action': 'save', 'values': {'dir': tmp}})
    print('start:', (res or {}).get('result'))
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            msg = q.get(timeout=0.5)
        except queue.Empty:
            continue
        if msg.get('method') == 'event':
            print('event:', msg.get('params', {}).get('message'))
            break
    files = [f for f in os.listdir(tmp) if f.endswith('.png')]
    if files:
        p = os.path.join(tmp, files[0])
        with open(p, 'rb') as fh:
            head = fh.read(8)
        print('png:', os.path.getsize(p), 'bytes | valid:', head == b'\x89PNG\r\n\x1a\n')
finally:
    child.kill()
print('stderr:', errs[:4])
