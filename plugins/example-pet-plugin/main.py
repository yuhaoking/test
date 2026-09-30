import json
import sys


# PYP-11 修复：强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '示例宠物插件', 'version': '1.0.0'}
    if method == 'pet.get_actions':
        return ['nod', 'wave', 'dance']
    if method == 'pet.play_action':
        return {'status': 'ok', 'action': (params or {}).get('action')}
    return {'status': 'unknown-method'}


def main():
    send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '宠物插件已启动'}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get('id') is None:
            continue
        try:
            result = handle(req.get('method', ''), req.get('params') or {})
            send({'jsonrpc': '2.0', 'id': req['id'], 'result': result, 'error': None})
        except Exception as e:
            send({'jsonrpc': '2.0', 'id': req['id'], 'result': None, 'error': str(e)})


if __name__ == '__main__':
    main()
