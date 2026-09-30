"""插件后台任务（job）上报辅助 —— PM-03 异步任务模型。

【为什么需要】
录屏、大文件转换这类任务的耗时远超一次 JSON-RPC 往返的合理时长。若让 handle_action
一直挂着等结果：宿主容易超时、用户看不到任何进展、进程还有被空闲回收杀掉的风险。
本模块把长任务变成"立即返回 + 进度上报"：

    from _shared.jobs import JobRegistry
    JOBS = JobRegistry(send)                 # send 由插件提供（写一行 JSON 到 stdout）

    def handle(method, params):
        r = JOBS.handle(method, params)      # 宿主轮询 plugin.jobs 时自动应答
        if r is not None:
            return r
        ...
        job = JOBS.start('全屏录制')          # 建任务
        threading.Thread(target=work, args=(job,), daemon=True).start()
        return {'message': '录制中…', 'job': job.to_dict()}   # 立即返回，不阻塞

    def work(job):
        job.progress(30, '已录制 30%')        # 进度（0~100）
        job.done('录制完成', result=path)     # 或 job.fail('磁盘已满')

【协议】（与 electron/services/pluginManager.ts 对齐）
  · 事件：{"jsonrpc":"2.0","method":"event","params":{"type":"job","jobId":…,"title":…,
          "status":"running|done|error","progress":0-100,"message":…,"result":…}}
  · 查询：宿主每 2s 调 plugin.jobs，返回 {"jobs":[{…同上的字段…}]}
  · 向后兼容：不实现 plugin.jobs 的插件完全不受影响（宿主静默跳过）。
"""

import threading
import time
import uuid

# 已完成任务在内存里保留的时长（秒），便于宿主最终轮询一次拿到终态
KEEP_DONE_SECONDS = 120


class Job(object):
    """一个后台任务句柄。所有方法线程安全，可在录制线程里直接调用。"""

    def __init__(self, registry, job_id, title):
        self._registry = registry
        self.id = job_id
        self.title = title
        self.progress_value = 0
        self.status = 'running'
        self.message = ''
        self.result = None
        self.started_at = time.time()
        self.updated_at = self.started_at

    def to_dict(self):
        d = {
            'id': self.id,
            'title': self.title,
            'status': self.status,
            'startedAt': int(self.started_at * 1000),
            'updatedAt': int(self.updated_at * 1000),
        }
        if self.progress_value:
            d['progress'] = int(self.progress_value)
        if self.message:
            d['message'] = self.message
        if self.result:
            d['result'] = self.result
        return d

    def progress(self, percent, message=None):
        """上报进度（0~100）。宿主据此更新卡片进度条，并把它当作心跳续期。"""
        try:
            value = max(0, min(100, int(percent)))
        except Exception:
            return
        self.progress_value = value
        self.message = message if message is not None else self.message
        self.updated_at = time.time()
        self._registry.emit(self)

    def done(self, message=None, result=None):
        self.status = 'done'
        self.progress_value = 100
        if message:
            self.message = message
        if result:
            self.result = result
        self.updated_at = time.time()
        self._registry.emit(self)

    def fail(self, message):
        self.status = 'error'
        self.message = message or '任务失败'
        self.updated_at = time.time()
        self._registry.emit(self)


class JobRegistry(object):
    """任务登记表：负责发事件、应答宿主的 plugin.jobs 轮询、回收过期终态。"""

    def __init__(self, send, keep_done=KEEP_DONE_SECONDS):
        self._send = send
        self._lock = threading.Lock()
        self._jobs = {}
        self._keep_done = keep_done

    def start(self, title):
        job = Job(self, uuid.uuid4().hex[:12], title)
        with self._lock:
            self._jobs[job.id] = job
            self._prune_locked()
        return job

    def emit(self, job):
        """发一条 job 事件给宿主（失败不抛，任务本身不该因上报失败而中断）。"""
        try:
            self._send({
                'jsonrpc': '2.0',
                'method': 'event',
                'params': dict(job.to_dict(), type='job', jobId=job.id),
            })
        except Exception:
            pass

    def _prune_locked(self):
        now = time.time()
        for jid in [k for k, v in self._jobs.items()
                    if v.status != 'running' and now - v.updated_at > self._keep_done]:
            self._jobs.pop(jid, None)

    def snapshot(self):
        with self._lock:
            self._prune_locked()
            return [j.to_dict() for j in self._jobs.values()]

    def handle(self, method, params):
        """便捷分发：是 plugin.jobs 就返回任务快照，否则返回 None 让调用方继续处理。"""
        if method == 'plugin.jobs':
            return {'jobs': self.snapshot()}
        return None
