import json
import os
import sys

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


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '全屏截图', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '截取整个屏幕。可自定义保存目录（留空使用默认），也可直接复制到剪贴板粘贴使用。',
            'inputs': [
                {'id': 'dir', 'label': '保存目录', 'type': 'picker', 'picker': 'folder',
                 'default': (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()}
            ],
            'buttons': [
                {'id': 'save', 'label': '截图并保存'},
                {'id': 'copy', 'label': '截图并复制'},
                {'id': 'pin', 'label': '截图并贴图（T-04）'}
            ]
        }
    if method == 'plugin.handle_action':
        params_src = params or {}
        values = params_src.get('values') or {}
        data, w, h = sc.capture_full()
        action = (params_src.get('action') or 'save')
        if action == 'copy':
            ok = sc.copy_png_to_clipboard(w, h, data)
            return {'message': '已复制到剪贴板' if ok else '复制失败'}
        if action == 'pin':
            path = sc.save_temp_png('全屏截图', w, h, data)
            sc.request_pin(path)
            return {'message': '已贴图到桌面（可缩放/透明/关闭）'}
        path = os.path.join(sc.to_copy_dir(values.get('dir')), sc.new_name('全屏截图', 'png'))
        sc.save_png(path, w, h, data)
        return {'message': '截图已保存：' + path}
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
