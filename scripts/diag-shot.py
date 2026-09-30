import json
import os
import subprocess
import sys
import threading
import time
import queue

BASE = os.path.join(os.getcwd(), 'dist-dist5', 'win-unpacked', 'resources', 'plugins')

child = subprocess.Popen(
    [sys.executable, os.path.join(BASE, 'office-screenshot-full', 'main.py')],
    cwd=os.path.join(BASE, 'office-screenshot-full'),
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding='utf-8',
    errors='replace',
    env={**os.environ, 'PYTHONUTF8': '1', 'ENGINES_ROOT': os.path.join(os.getcwd(), 'engines'),
         'PLUGIN_SAVE_DIR': r'D:\小鹏工具箱\.tmp-shot'}
)
q = queue.Queue()
errs = []
threading.Thread(target=lambda: [q.put(json.loads(l.strip())) for l in child.stdout if l.strip() and not json.loads(l.strip()) or True] or None, daemon=True).start()
threading.Thread(target=lambda: [errs.append(l.rstrip()) for l in child.stderr], daemon=True).start()

os.makedirs(r'D:\小鹏工具箱\.tmp-shot', exist_ok=True)
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
    res = call('plugin.handle_action', {'action': 'save', 'values': {'dir': r'D:\小鹏工具箱\.tmp-shot'}})
    print('save result:', (res or {}).get('result') or (res or {}).get('error'))
    files = [f for f in os.listdir(r'D:\小鹏工具箱\.tmp-shot') if f.endswith('.png')]
    if files:
        p = os.path.join(r'D:\小鹏工具箱\.tmp-shot', files[0])
        print('png:', p, '| size:', os.path.getsize(p))
        with open(p, 'rb') as f:
            head = f.read(8)
        print('valid png:', head == b'\x89PNG\r\n\x1a\n')
    else:
        print('NO PNG CREATED')
finally:
    child.kill()
print('stderr tail:', errs[:5])
