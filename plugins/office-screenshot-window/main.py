import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _shared import screen_capture as sc


# PYP-11 修复：强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def worker(action, save_dir):
    try:
        time.sleep(3)
        data, w, h = sc.capture_foreground_window()
        if not data or w < 20 or h < 20:
            # PYP-13：优先使用底层给出的具体失败原因（如尺寸超限）
            msg = getattr(sc, 'LAST_ERROR', '') or '未识别到可截取的窗口，请确认已切换到目标窗口（如浏览器、文档），再重试'
        elif action == 'copy':
            ok = sc.copy_png_to_clipboard(w, h, data)
            msg = '已复制到剪贴板' if ok else '复制失败，请重试'
        elif action == 'pin':
            path = sc.save_temp_png('窗口截图', w, h, data)
            sc.request_pin(path)
            msg = '已贴图到桌面（可缩放/透明/关闭）'
        else:
            path = os.path.join(save_dir, sc.new_name('窗口截图', 'png'))
            sc.save_png(path, w, h, data)
            msg = '窗口截图已保存：' + path
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': msg}})
    except Exception as e:
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '截图失败：' + str(e)[:160]}})


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '窗口截图', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '点击按钮后请在 3 秒内切换到要截取的窗口（浏览器/文档/程序），插件会自动截取当前前台窗口。'
                    '保存目录留空使用默认，也可直接复制。',
            'inputs': [
                {'id': 'dir', 'label': '保存目录', 'type': 'picker', 'picker': 'folder',
                 'default': (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()}
            ],
            'buttons': [
                {'id': 'save', 'label': '截取当前窗口并保存'},
                {'id': 'copy', 'label': '截取当前窗口并复制'},
                {'id': 'pin', 'label': '截取当前窗口并贴图（T-04）'}
            ]
        }
    if method == 'plugin.handle_action':
        params_src = params or {}
        values = params_src.get('values') or {}
        action = (params_src.get('action') or 'save')
        threading.Thread(
            target=worker, args=(action, sc.to_copy_dir(values.get('dir'))), daemon=True
        ).start()
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {
            'type': 'show_notification', 'message': '请在 3 秒内切换到目标窗口，即将开始截图'}})
        return {'message': '请在 3 秒内切换到目标窗口，完成后面板会通知'}
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
