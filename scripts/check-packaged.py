import json
import os
import subprocess
import sys
import threading
import time
import queue

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Rpc:
    def __init__(self, dirname, base):
        self.child = subprocess.Popen(
            [sys.executable, os.path.join(base, dirname, 'main.py')],
            cwd=os.path.join(base, dirname),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            env={**os.environ, 'PYTHONUTF8': '1', 'ENGINES_ROOT': os.path.join(ROOT, 'engines')}
        )
        self.q = queue.Queue()
        self.errs = []
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._errs, daemon=True).start()
        self.rid = 0

    def _reader(self):
        for line in self.child.stdout:
            line = line.strip()
            if line:
                try:
                    self.q.put(json.loads(line))
                except Exception:
                    pass

    def _errs(self):
        for line in self.child.stderr:
            self.errs.append(line.rstrip())

    def call(self, method, params, timeout=12):
        self.rid += 1
        rid = self.rid
        self.child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}) + '\n')
        self.child.stdin.flush()
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


BASE = os.path.join(ROOT, 'dist-dist5', 'win-unpacked', 'resources', 'plugins')
if not os.path.isdir(BASE):
    BASE = os.path.join(ROOT, 'plugins')

plugins = sorted(d for d in os.listdir(BASE) if d.startswith('office-'))
total = 0
ok = 0
for p in plugins:
    r = Rpc(p, BASE)
    try:
        init = r.call('plugin.init', {})
        ui = r.call('plugin.get_ui', {})
        good = bool(init and (init.get('result') or {}).get('status') == 'ok') and bool(ui and ui.get('result'))
        total += 1
        ok += 1 if good else 0
        if not good:
            print('FAIL', p, '| stderr:', ' | '.join(r.errs[:3]))
    finally:
        r.close()
        time.sleep(0.2)
print('packaged plugins init/get_ui: %d/%d OK' % (ok, total))
