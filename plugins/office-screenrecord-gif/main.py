import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _shared import screen_capture as sc
from _shared.jobs import JobRegistry

DEP_ERROR = None
try:
    import mss
    from PIL import Image
except Exception as e:
    DEP_ERROR = '依赖加载失败：' + str(e) + '（请检查 requirements.txt 依赖已安装）'


# PYP-11 修复：强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()
# B（PM-03 异步任务模型）：GIF 生成（采集 + 编码）耗时较长，走后台任务通道上报进度。
# 注意：必须定义在 send() 之后 —— 它把 send 作为回调注入。
JOBS = JobRegistry(send)


def record(job, fps, seconds, path):
    try:
        frames = []
        # PYP-3 修复：按 1/fps 节拍采样，GIF 播放速度与真实时间一致
        interval = 1.0 / max(1, int(fps))
        next_at = time.time()
        started = time.time()
        deadline = started + seconds
        last_reported = -1
        with mss.mss() as sct:
            while time.time() < deadline:
                shot = sct.grab(sct.monitors[1])
                frame = Image.frombytes('RGB', shot.size, shot.rgb)
                frames.append(frame)
                # B：采集阶段占 80% 进度，最后 20% 留给编码落盘（编码是同步阻塞的最后一步）
                pct = int((time.time() - started) * 80 / max(1, seconds))
                if pct != last_reported:
                    last_reported = pct
                    job.progress(pct, '已采集 %d%%' % pct)
                next_at += interval
                gap = next_at - time.time()
                if gap > 0:
                    time.sleep(gap)
        if not frames:
            raise RuntimeError('未采集到任何帧')
        job.progress(85, '正在编码 GIF…')
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=int(1000 / fps), loop=0)
        job.done('GIF 已生成', result=path)
    except Exception as e:
        job.fail('录制失败：' + str(e))


def handle(method, params):
    # B：宿主轮询后台任务时由登记表应答
    answer = JOBS.handle(method, params)
    if answer is not None:
        return answer
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '录屏转GIF', 'version': '1.1.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '把屏幕录制为 GIF 动图（帧数较多时生成较慢），保存目录留空使用默认。',
            'inputs': [
                {'id': 'seconds', 'label': '时长(秒)', 'type': 'number', 'default': '5'},
                {'id': 'fps', 'label': '帧率', 'type': 'number', 'default': '8'},
                {'id': 'dir', 'label': '保存目录', 'type': 'picker', 'picker': 'folder',
                 'default': (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()}
            ],
            'buttons': [{'id': 'go', 'label': '开始录制'}]
        }
    if method == 'plugin.handle_action':
        if DEP_ERROR:
            return {'message': DEP_ERROR}
        params_src = params or {}
        values = params_src.get('values') or {}
        try:
            seconds = max(1, min(60, int(float(values.get('seconds') or 5))))
        except Exception:
            seconds = 5
        try:
            fps = max(2, min(15, int(float(values.get('fps') or 8))))
        except Exception:
            fps = 8
        path = os.path.join(sc.to_copy_dir(values.get('dir')), sc.new_name('录屏GIF', 'gif'))
        job = JOBS.start('录屏转 GIF')
        threading.Thread(target=record, args=(job, fps, seconds, path), daemon=True).start()
        return {'message': '录制中（%d 秒 @%d fps），可在卡片上看到进度' % (seconds, fps), 'job': job.to_dict()}
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
