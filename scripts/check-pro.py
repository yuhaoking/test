import json
import os
import queue
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = os.path.join(ROOT, '.tmp-office')
os.makedirs(tmp, exist_ok=True)

child = subprocess.Popen(
    [sys.executable, os.path.join(ROOT, 'plugins', 'office-translate-pro', 'main.py')],
    cwd=os.path.join(ROOT, 'plugins', 'office-translate-pro'),
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
threading.Thread(target=lambda: [q.put(json.loads(l.strip())) for l in child.stdout if l.strip() and l.strip().startswith('{')], daemon=True).start()
threading.Thread(target=lambda: [errs.append(l.rstrip()) for l in child.stderr], daemon=True).start()
rid = 0


def call(method, params, timeout=60):
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
    # 1) 短文本同步翻译
    res = call('plugin.handle_action', {'action': 'go', 'values': {'text': '你好，聚合翻译。', 'target': 'en', 'engine': 'auto'}})
    print('short ->', (res or {}).get('result'))

    # 2) 长文本（thread + event + 文件）
    f = os.path.join(tmp, 'long_cn.txt')
    with open(f, 'w', encoding='utf-8') as fh:
        fh.write('人工智能正在改变我们的世界。' * 400)
    res = call('plugin.handle_action', {'action': 'go', 'values': {'paths': f, 'target': 'en', 'engine': 'auto'}})
    print('file start ->', (res or {}).get('result'))
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            msg = q.get(timeout=0.5)
        except queue.Empty:
            continue
        if msg.get('method') == 'event':
            print('event ->', msg.get('params'))
            break
    outs = [x for x in os.listdir(tmp) if x.startswith('long_cn_to_')]
    if outs:
        p = os.path.join(tmp, outs[0])
        data = open(p, encoding='utf-8').read()
        print('file trans len:', len(data), '| head:', data[:60])
    else:
        print('NO OUTPUT FILE')
finally:
    child.kill()
print('stderr:', errs[:4])
