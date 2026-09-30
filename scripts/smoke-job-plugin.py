"""冒烟用桩插件（B：插件异步任务模型）。

只依赖 Python 标准库：handle_action 立即返回 job → 后台线程上报进度 → 终态 done + result。
宿主侧由 scripts/smoke-main.ts 复制到临时 userData 的 plugins/ 目录下运行。
"""

import json
import sys
import threading
import time


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


JOBS = {}


def emit(job):
    send({'jsonrpc': '2.0', 'method': 'event', 'params': dict(job, type='job', jobId=job['id'])})


def work(job):
    for pct in (30, 60, 100):
        time.sleep(0.4)
        job['progress'] = pct
        job['status'] = 'running'
        job['message'] = '已完成 %d%%' % pct
        emit(job)
    job['status'] = 'done'
    job['message'] = '冒烟任务完成'
    job['result'] = 'smoke-result.txt'
    emit(job)


def handle(method, params):
    # 宿主每 2s 轮询后台任务
    if method == 'plugin.jobs':
        return {'jobs': list(JOBS.values())}
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '冒烟任务插件', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        return {'text': '冒烟桩插件', 'buttons': [{'id': 'go', 'label': '跑一个后台任务'}]}
    if method == 'plugin.handle_action':
        now = int(time.time() * 1000)
        job = {'id': 'smoke-1', 'title': '冒烟后台任务', 'status': 'running',
               'progress': 0, 'startedAt': now, 'updatedAt': now}
        JOBS[job['id']] = job
        threading.Thread(target=work, args=(job,), daemon=True).start()
        return {'message': '任务已开始', 'job': job}
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
