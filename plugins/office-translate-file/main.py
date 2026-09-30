import json
import os
import sys
import threading
import urllib.parse
import urllib.request


# PYP-11 修复：强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def _http_get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.read().decode('utf-8')


def translate(text):
    try:
        url = ('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&tl=zh-CN&q='
               + urllib.parse.quote(text))
        data = json.loads(_http_get(url))
        out = ''.join(seg[0] for seg in data[0] if seg and seg[0])
        if out:
            return out
    except Exception:
        pass
    src = 'en'
    if any('\u4e00' <= ch <= '\u9fff' for ch in text):
        src = 'zh-CN'
    url = ('https://api.mymemory.translated.net/get?q=' + urllib.parse.quote(text)
           + '&langpair=' + urllib.parse.quote(src + '|zh-CN'))
    data = json.loads(_http_get(url))
    out = data.get('responseData', {}).get('translatedText')
    if not out:
        raise RuntimeError('翻译接口无返回')
    return out


def worker(src):
    try:
        lines = open(src, encoding='utf-8').read().splitlines()
        base, _ = os.path.splitext(src)
        dst = base + '_translated.txt'
        out = []
        failed = 0
        for idx, line in enumerate(lines):
            if line.strip():
                # PYP-4 修复：逐行容错——单行限流/超长失败时保留原文继续，不再整体中断丢结果
                try:
                    out.append(translate(line))
                except Exception:
                    failed += 1
                    out.append(line)
            else:
                out.append('')
            if (idx + 1) % 50 == 0:
                # 定期落盘中间结果，避免中途失败已译内容全丢
                with open(dst, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(out))
        with open(dst, 'w', encoding='utf-8') as f:
            f.write('\n'.join(out))
        msg = '翻译完成：' + dst + (('（%d 行失败已保留原文）' % failed) if failed else '')
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': msg}})
    except Exception as e:
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '翻译失败：' + str(e)}})


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '批量翻译文件', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '输入 UTF-8 文本文件路径，逐行翻译（目标中文，需联网），结果写到同目录 _translated.txt。',
            'inputs': [{'id': 'path', 'label': '文件路径', 'type': 'text', 'default': 'D:\\文档\\notes.txt'}],
            'buttons': [{'id': 'go', 'label': '开始翻译'}]
        }
    if method == 'plugin.handle_action':
        values = (params or {}).get('values') or {}
        src = (values.get('path') or '').strip().strip('"')
        if not src or not os.path.exists(src):
            return {'message': '文件不存在：' + src}
        threading.Thread(target=worker, args=(src,), daemon=True).start()
        return {'message': '翻译中，完成后面板会通知'}
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
