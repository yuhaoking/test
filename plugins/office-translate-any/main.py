import json
import sys
import urllib.parse
import urllib.request

LANGS = ['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'ru', 'es', 'pt', 'it']


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


def guess_lang(text):
    if any('\u4e00' <= ch <= '\u9fff' for ch in text):
        return 'zh-CN'
    if any('\u3040' <= ch <= '\u30ff' for ch in text):
        return 'ja'
    if any('\uac00' <= ch <= '\ud7af' for ch in text):
        return 'ko'
    return 'en'


def translate(text, target):
    try:
        url = ('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&tl='
               + urllib.parse.quote(target) + '&q=' + urllib.parse.quote(text))
        data = json.loads(_http_get(url))
        out = ''.join(seg[0] for seg in data[0] if seg and seg[0])
        if out:
            return out
    except Exception:
        pass
    src = guess_lang(text)
    url = ('https://api.mymemory.translated.net/get?q=' + urllib.parse.quote(text)
           + '&langpair=' + urllib.parse.quote(src + '|' + target))
    data = json.loads(_http_get(url))
    out = data.get('responseData', {}).get('translatedText')
    if not out:
        raise RuntimeError('翻译接口无返回')
    return out


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '多语言翻译', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '选择目标语言，输入文本后翻译（需要联网，自动切换可用的翻译服务）。',
            'inputs': [
                {'id': 'text', 'label': '文本', 'type': 'text', 'default': 'Hello world'},
                {'id': 'lang', 'label': '目标语言', 'type': 'select', 'options': LANGS, 'default': 'zh-CN'}
            ],
            'buttons': [{'id': 'go', 'label': '翻译'}]
        }
    if method == 'plugin.handle_action':
        values = (params or {}).get('values') or {}
        text = (values.get('text') or '').strip()
        target = (values.get('lang') or 'zh-CN').strip()
        if not text:
            return {'message': '请输入要翻译的内容'}
        try:
            return {'message': '译文：' + translate(text, target)}
        except Exception as e:
            return {'message': '翻译失败（请检查网络）：' + str(e)}
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
