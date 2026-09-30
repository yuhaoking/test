# -*- coding: utf-8 -*-
"""示例命令插件（插件市场 PM-02 / PM-03 验收用）

manifest.json 的 commands 字段声明三条命令，主程序会把它们注册进全局命令面板；
用户在命令面板中回车执行 -> 主程序调用 plugin.handle_command（params: { command }）。
"""
import datetime
import json
import os
import sys


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def handle_command(command):
    if command == 'hello':
        hour = datetime.datetime.now().hour
        if hour < 6:
            greeting = '夜深了，注意休息'
        elif hour < 12:
            greeting = '早上好'
        elif hour < 18:
            greeting = '下午好'
        else:
            greeting = '晚上好'
        return {'message': greeting + '！这是来自插件市场的示例命令。'}
    if command == 'time':
        now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        return {'message': '当前时间：' + now}
    if command == 'note':
        d = os.path.join(os.path.expanduser('~'), 'Documents', 'xiaopeng-notes')
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, datetime.datetime.now().strftime('note_%Y%m%d_%H%M%S.txt'))
        with open(path, 'w', encoding='utf-8') as f:
            f.write('示例命令插件写入：' + datetime.datetime.now().isoformat() + '\n')
        try:
            os.startfile(path)  # 打开记事本文件（Windows）
        except Exception:
            pass
        return {'message': '已写入记事本文件：' + path}
    return {'message': '未知命令：' + str(command)}


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '示例命令插件', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '本插件用于演示 PM-03 commands 协议：安装后打开全局命令面板，'
                    '搜索“示例”即可看到三条命令并可直接执行。',
            'inputs': [],
            'buttons': [{'id': 'hello', 'label': '问好（面板中也可执行）'}]
        }
    if method == 'plugin.handle_command':
        return handle_command(((params or {}).get('command') or ''))
    if method == 'plugin.handle_action':
        return handle_command('hello')
    return {'status': 'unknown-method'}


def main():
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
