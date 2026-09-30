import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime

USAGE_URL = 'https://platform.deepseek.com/usage'
BALANCE_URL = 'https://api.deepseek.com/user/balance'
LOW_BALANCE_CNY = 10.0
LOW_BALANCE_INTERVAL = 3600.0

# ---- 状态缓存（后台线程更新，UI / 命令读取）----
_cache_lock = threading.Lock()
_cached = {
    'balance': '加载中…',
    'balance_cny': None,
    'harness': '检测中…',
    'updated': '',
    'harness_at': 0.0,
}


# PYP-11 修复：强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def api_key():
    return (os.environ.get('DEEPSEEK_API_KEY') or '').strip()


def now_text():
    return datetime.now().strftime('%H:%M:%S')


def pet_notify(message):
    """T-05：消息走桌宠气泡通道（开启语音播报后由桌宠朗读）"""
    send({'jsonrpc': '2.0', 'method': 'event',
          'params': {'type': 'pet_notify', 'message': message}})


def notify(title, message):
    send({'jsonrpc': '2.0', 'method': 'event',
          'params': {'type': 'show_notification', 'title': title, 'message': message}})


def get_balance():
    key = api_key()
    if not key:
        return ('未配置 Key', None)
    try:
        req = urllib.request.Request(BALANCE_URL, headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))
        infos = data.get('balance_infos') or []
        if not infos:
            return ('无余额信息', None)
        parts = []
        cny_total = None
        for info in infos:
            currency = info.get('currency', 'CNY')
            total = info.get('total_balance', '—')
            granted = info.get('granted_balance', '')
            topped = info.get('topped_up_balance', '')
            if currency == 'CNY':
                try:
                    cny_total = float(total)
                except Exception:
                    cny_total = None
            parts.append('%s %s（充值 %s + 赠送 %s）' % (currency, total, topped or '0', granted or '0'))
        return (parts[0] if len(parts) == 1 else ('；'.join(parts)), cny_total)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return ('API Key 无效', None)
        return ('余额获取失败(%d)' % e.code, None)
    except Exception:
        return ('余额获取失败', None)


def powershell_cpu():
    try:
        script = ("$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
                  "Where-Object { $_.CommandLine -match 'dsh|harness' } | Select-Object -First 1; "
                  "if ($p) { (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue | "
                  "Measure-Object CPU -Sum).Sum } else { -1 }")
        out = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script],
                             capture_output=True, text=True, timeout=15)
        try:
            return float(str(out.stdout).strip())
        except Exception:
            return -1
    except Exception:
        return -1


def harness_status():
    cpu1 = powershell_cpu()
    if cpu1 is None or cpu1 < 0:
        return '未检测到进程'
    time.sleep(2.5)
    cpu2 = powershell_cpu()
    if cpu2 < 0:
        return '未检测到进程'
    delta = cpu2 - cpu1
    if delta > 0.15:
        return '工作进行中'
    return '工作已完成'


def worker():
    """后台循环：每轮更新余额（20s）与 harness 状态（每轮约 3s 采样）；
    状态转完成 / 余额不足时经桌宠气泡（+语音播报）提醒（T-05 AI 用量管家）"""
    notified = False
    low_balance_at = 0.0
    while True:
        try:
            balance, cny = get_balance()
            status = harness_status()
            with _cache_lock:
                prev = _cached['harness']
                _cached['balance'] = balance
                _cached['balance_cny'] = cny
                _cached['harness'] = status
                _cached['updated'] = now_text()
                _cached['harness_at'] = time.time()
            # 状态：工作进行中 -> 工作已完成 时播报一次
            if status == '工作已完成' and prev == '工作进行中' and not notified:
                pet_notify('AI 用量管家：任务已完成，可以查看结果了')
                notify('DeepSeek Harness', '任务已完成，可以查看结果了')
                notified = True
            if status == '工作进行中':
                notified = False
            # 低余额预警（CNY 余额 < %.0f 元，1 小时节流）（T-05）
            if cny is not None and cny < LOW_BALANCE_CNY and time.time() - low_balance_at > LOW_BALANCE_INTERVAL:
                low_balance_at = time.time()
                pet_notify('AI 用量管家：DeepSeek 余额只剩 %.2f 元啦，记得充值哦' % cny)
        except Exception:
            pass
        try:
            time.sleep(5)
        except Exception:
            break


def build_metrics():
    with _cache_lock:
        return [
            {'label': 'API 余额', 'value': _cached['balance']},
            {'label': 'Harness 状态', 'value': _cached['harness']},
            {'label': '更新时间', 'value': _cached['updated']}
        ]


def build_report():
    """T-05：用量简报文本（命令面板 / 桌宠 Agent 触发，可经语音播报）"""
    with _cache_lock:
        balance = _cached['balance']
        harness = _cached['harness']
        updated = _cached['updated']
    return 'AI 用量管家播报：DeepSeek 余额 %s；本地任务状态：%s（%s 更新）' % (balance, harness, updated or '刚刚')


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': 'AI 用量管家', 'version': '2.0.0'}
    if method == 'plugin.get_ui':
        return {
            'text': 'AI 用量管家：余额与任务状态每 5 秒自动刷新；任务完成 / 余额不足时经桌宠播报（开启语音后朗读）。点击"用量简报"立即播报一次。',
            'inputs': [],
            'metrics': build_metrics(),
            'buttons': [
                {'id': 'report', 'label': '用量简报'},
                {'id': 'refresh', 'label': '刷新'},
                {'id': 'open', 'label': '打开用量页'}
            ]
        }
    if method == 'plugin.handle_action':
        params_src = params or {}
        action = (params_src.get('action') or 'refresh')
        if action == 'open':
            return {'message': '已打开 DeepSeek 用量页', 'openUrl': USAGE_URL}
        if action == 'report':
            text = build_report()
            pet_notify(text)
            return {'message': text}
        return {'message': '已刷新', 'metrics': build_metrics()}
    if method == 'plugin.handle_command':
        # PM-03 命令（T-05 Agent 工具闭环 / 命令面板：AI 用量播报）
        text = build_report()
        pet_notify(text)
        return {'message': text, 'metrics': build_metrics()}
    return {'status': 'unknown-method'}


def main():
    t = threading.Thread(target=worker, daemon=True)
    t.start()
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
