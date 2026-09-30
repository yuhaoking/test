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


def worker(seconds, mode, save_dir):
    try:
        time.sleep(seconds)
        data, w, h = sc.capture_full()
        if mode == 'copy':
            ok = sc.copy_png_to_clipboard(w, h, data)
            msg = '已复制到剪贴板' if ok else '复制失败'
        elif mode == 'pin':
            path = sc.save_temp_png('延时截图', w, h, data)
            sc.request_pin(path)
            msg = '已贴图到桌面（可缩放/透明/关闭）'
        else:
            path = os.path.join(save_dir, sc.new_name('延时截图', 'png'))
            sc.save_png(path, w, h, data)
            msg = '截图已保存：' + path
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': msg}})
    except Exception as e:
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '截图失败：' + str(e)}})


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '延时截图', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '倒计时结束后自动截取全屏，计时期间请先展开要截取的内容。',
            'inputs': [
                {'id': 'seconds', 'label': '延迟(秒)', 'type': 'number', 'default': '3'},
                {'id': 'dir', 'label': '保存目录', 'type': 'picker', 'picker': 'folder',
                 'default': (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()}
            ],
            'buttons': [
                {'id': 'save', 'label': '倒计时并保存'},
                {'id': 'copy', 'label': '倒计时并复制'},
                {'id': 'pin', 'label': '倒计时并贴图（T-04）'}
            ]
        }
    if method == 'plugin.handle_action':
        params_src = params or {}
        values = params_src.get('values') or {}
        try:
            seconds = max(1, min(60, int(float(values.get('seconds') or 3))))
        except Exception:
            seconds = 3
        mode = (params_src.get('action') or 'save')
        if mode not in ('copy', 'pin', 'save'):
            mode = 'save'
        threading.Thread(target=worker, args=(seconds, mode, sc.to_copy_dir(values.get('dir'))), daemon=True).start()
        return {'message': '将在 %d 秒后%s' % (seconds, '复制到剪贴板' if mode == 'copy' else '截图')}
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
