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
        return {'status': 'ok', 'name': '区域截图', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '点击后屏幕出现半透明遮罩，拖出截图区域（Esc 取消）。保存目录留空使用默认，也可直接复制。',
            'inputs': [
                {'id': 'dir', 'label': '保存目录', 'type': 'picker', 'picker': 'folder',
                 'default': (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()}
            ],
            'buttons': [
                {'id': 'save', 'label': '选择区域截图'},
                {'id': 'copy', 'label': '选择区域并复制'},
                {'id': 'pin', 'label': '选择区域并贴图（T-04）'}
            ]
        }
    if method == 'plugin.handle_action':
        params_src = params or {}
        values = params_src.get('values') or {}
        rect = sc.select_region_tk()
        if not rect or rect[2] < 2 or rect[3] < 2:
            return {'message': '已取消截图'}
        x, y, w, h = rect
        data = sc.capture(x, y, w, h)
        action = (params_src.get('action') or 'save')
        if action == 'copy':
            ok = sc.copy_png_to_clipboard(w, h, data)
            return {'message': '已复制到剪贴板' if ok else '复制失败'}
        if action == 'pin':
            path = sc.save_temp_png('区域截图', w, h, data)
            sc.request_pin(path)
            return {'message': '已贴图到桌面（可缩放/透明/关闭）'}
        path = os.path.join(sc.to_copy_dir(values.get('dir')), sc.new_name('区域截图', 'png'))
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
