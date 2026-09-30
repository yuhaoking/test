import json
import sys
import time


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
        return {'status': 'ok', 'name': '示例插件', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'title': '示例插件',
            'text': '你好，这是一个 Python 模块插件，运行在独立进程中。',
            'buttons': [
                {'id': 'hello', 'label': '打个招呼'},
                {'id': 'time', 'label': '当前时间'},
            ],
        }
    if method == 'plugin.handle_action':
        action = (params or {}).get('action')
        if action == 'hello':
            return {'message': '你好！我是示例插件 :)'}
        if action == 'time':
            return {'message': time.strftime('%Y-%m-%d %H:%M:%S')}
        return {'message': '未知动作：' + str(action)}
    return {'status': 'unknown-method'}


def main():
    send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '示例插件已启动'}})
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
