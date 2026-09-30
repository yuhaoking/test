import json
import subprocess
import sys

proc = subprocess.Popen(
    [sys.executable, 'plugins/example-plugin/main.py'],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
    encoding='utf-8'
)


def call(method, params):
    proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}) + '\n')
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise EOFError('plugin exited')
        obj = json.loads(line)
        if obj.get('id') == 1:
            print(json.dumps(obj, ensure_ascii=False))
            return


call('plugin.init', {})
call('plugin.get_ui', {})
call('plugin.handle_action', {'action': 'hello'})
proc.kill()
