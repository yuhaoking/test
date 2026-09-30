import json
import os
import re
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

LANGS = ['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'ru', 'es']
ENGINES = ['bing', 'alibaba', 'youdao']
CHUNK_SIZE = 900


# PYP-11 修复：强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


# P1-2 修复：translators 库首次导入需联网拉取引擎配置（实测 10~35 秒），
# 放在模块顶层会让 plugin.init 直接超时（宿主 15 秒）并误触发依赖重装。
# 改为首次实际翻译时懒加载（带锁，避免并发重复导入）。
DEP_ERROR = None
_TS = None
_TS_LOCK = threading.Lock()


def get_translators():
    global _TS, DEP_ERROR
    if _TS is not None:
        return _TS
    with _TS_LOCK:
        if _TS is None:
            try:
                import translators as ts
                _TS = ts
                DEP_ERROR = None
            except Exception as e:
                DEP_ERROR = '依赖加载失败：' + str(e) + '（首次使用会自动安装 translators，需联网）'
    return _TS


def chunk_text(text, size=CHUNK_SIZE):
    paragraphs = re.split(r'(?<=\n)', text)
    out = []
    cur = ''
    for p in paragraphs:
        while len(p) > size:
            cur2 = cur + p[:size - len(cur)]
            out.append(cur2)
            p = p[size - len(cur):]
            cur = ''
        if len(cur) + len(p) <= size:
            cur += p
        else:
            if cur:
                out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return out


def translate_one(piece, engine_order, to_lang):
    ts = get_translators()
    if ts is None:
        raise RuntimeError(DEP_ERROR or '翻译引擎依赖未就绪')
    last = None
    for eng in engine_order:
        try:
            return ts.translate_text(piece, translator=eng, from_language='auto', to_language=to_lang, timeout=40)
        except Exception as e:
            last = e
    raise RuntimeError('所有引擎均失败：' + str(last)[:120])


def translate_long(text, engine_order, to_lang):
    pieces = chunk_text(text)
    result = []
    for piece in pieces:
        result.append(translate_one(piece, engine_order, to_lang))
    return ''.join(result)


def parse_lang(target):
    return target if target else 'zh-CN'


def engine_order_of(value):
    if value and value in ENGINES:
        return [value] + [e for e in ENGINES if e != value]
    return list(ENGINES)


def save_dir_of(values):
    custom = (values.get('dir') or '').strip().strip('"')
    if custom and os.path.isdir(custom):
        return custom
    env_dir = (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    return os.path.join(os.path.expanduser('~'), 'Documents')


def worker_text(text, engine_order, to_lang, out_dir, tag):
    try:
        result = translate_long(text, engine_order, to_lang)
        name = 'translation_%s_%s.txt' % (tag, to_lang)
        path = os.path.join(out_dir, name)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(result)
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '翻译完成：' + path}})
    except Exception as e:
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '翻译失败：' + str(e)[:200]}})


def worker_file(src, engine_order, to_lang, out_dir):
    try:
        raw = open(src, 'rb').read()
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            text = raw.decode('gbk')
        out_dir = out_dir or os.path.dirname(src) or os.getcwd()
        result = translate_long(text, engine_order, to_lang)
        base = os.path.splitext(os.path.basename(src))[0]
        path = os.path.join(out_dir, base + '_to_' + to_lang + '.txt')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(result)
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '翻译完成：' + path}})
    except Exception as e:
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'show_notification', 'message': '翻译失败：' + str(e)[:200]}})


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '聚合翻译', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '参考 GitHub 项目 UlionTse/translators（翻译官）实现：聚合 Bing/阿里/有道免费引擎，'
                    '自动分段支持长句长文，可翻译文本文件（UTF-8/GBK）。\n'
                    '1) 文件模式：选择文件路径；2) 文本模式：直接输入文本（长文建议用文件，结果保存为文件）。',
            'inputs': [
                {'id': 'paths', 'label': '文件路径', 'type': 'picker', 'picker': 'file', 'default': ''},
                {'id': 'text', 'label': '文本', 'type': 'text', 'default': 'Hello world'},
                {'id': 'target', 'label': '目标语言', 'type': 'select', 'options': LANGS, 'default': 'zh-CN'},
                {'id': 'engine', 'label': '引擎', 'type': 'select', 'options': ['auto'] + ENGINES, 'default': 'auto'},
                {'id': 'dir', 'label': '保存目录', 'type': 'picker', 'picker': 'folder',
                 'default': (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()}
            ],
            'buttons': [{'id': 'go', 'label': '开始翻译'}]
        }
    if method == 'plugin.handle_action':
        if get_translators() is None:
            return {'message': DEP_ERROR}
        params_src = params or {}
        values = params_src.get('values') or {}
        src = (values.get('paths') or '').strip().strip('"')
        text = (values.get('text') or '').strip()
        target = parse_lang((values.get('target') or '').strip())
        engine_order = engine_order_of((values.get('engine') or '').strip())
        out_dir = save_dir_of(values)
        if src:
            if not os.path.exists(src):
                return {'message': '文件不存在：' + src}
            threading.Thread(target=worker_file, args=(src, engine_order, target, out_dir), daemon=True).start()
            return {'message': '文件翻译中（%s），完成后面板会通知' % target}
        if not text:
            return {'message': '请输入文本或选择文件'}
        if len(text) <= CHUNK_SIZE:
            try:
                result = translate_one(text, engine_order, target)
                return {'message': '译文：' + result}
            except Exception as e:
                return {'message': '翻译失败：' + str(e)[:160]}
        threading.Thread(target=worker_text, args=(text, engine_order, target, out_dir, 'text'), daemon=True).start()
        return {'message': '长文翻译中（%d 字），完成后面板会通知并保存为文件' % len(text)}
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
