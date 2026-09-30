import json
import os
import sys
import threading
import time

os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _shared import screen_capture as sc
from _shared.jobs import JobRegistry

DEP_ERROR = None
try:
    import mss
    import numpy as np
    import imageio.v2 as imageio
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
# B（PM-03 异步任务模型）：录制是长任务，必须“立即返回 + 进度上报”，
# 否则 handle_action 一挂就是几分钟，宿主超时/空闲回收都会把它打断（产物损坏）。
# 注意：必须定义在 send() 之后 —— 它把 send 作为回调注入，提前初始化会 NameError 导致插件起不来。
JOBS = JobRegistry(send)


def record(job, fps, seconds, path):
    writer = None
    error = None
    try:
        writer = imageio.get_writer(path, fps=fps, codec='libx264', quality=7)
        # PYP-3 修复：按 1/fps 节拍采样，使输出时长与“时长(秒)”一致（此前全速抓帧 → 时长失真/CPU 打满）
        interval = 1.0 / max(1, int(fps))
        next_at = time.time()
        started = time.time()
        deadline = started + seconds
        last_reported = -1
        with mss.mss() as sct:
            while time.time() < deadline:
                frame = np.asarray(sct.grab(sct.monitors[1]))[:, :, :3][:, :, ::-1]
                writer.append_data(frame)
                # B：按秒上报进度（既给用户可见的进展，也是让宿主续期"勿回收"的心跳）
                elapsed = time.time() - started
                pct = int(elapsed * 100 / max(1, seconds))
                if pct != last_reported:
                    last_reported = pct
                    job.progress(pct, '已录制 %d%%' % pct)
                next_at += interval
                gap = next_at - time.time()
                if gap > 0:
                    time.sleep(gap)
    except Exception as e:
        error = e
    finally:
        # PYP-2 修复：无论成功或异常都必须 close，否则 writer 的 FFmpeg 管道挂起、MP4 缺 moov 索引不可播放
        if writer is not None:
            try:
                writer.close()
            except Exception as e:
                error = error or e
    # 终态交给任务通道上报：宿主据此弹通知并更新卡片（不再重复发 show_notification，避免双通知）
    if error is None:
        job.done('录制完成', result=path)
    else:
        job.fail('录制失败：' + str(error))


def handle(method, params):
    # B：宿主轮询后台任务时由登记表应答（不实现该方法的插件不受影响）
    answer = JOBS.handle(method, params)
    if answer is not None:
        return answer
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '全屏录制', 'version': '1.1.0'}
    if method == 'plugin.get_ui':
        return {
            'text': '录制整个屏幕为 MP4（无声音）。保存目录留空使用默认，首次使用会自动安装依赖（需联网）。',
            'inputs': [
                {'id': 'seconds', 'label': '时长(秒)', 'type': 'number', 'default': '10'},
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
            seconds = max(2, min(600, int(float(values.get('seconds') or 10))))
        except Exception:
            seconds = 10
        path = os.path.join(sc.to_copy_dir(values.get('dir')), sc.new_name('全屏录制', 'mp4'))
        job = JOBS.start('全屏录制')
        threading.Thread(target=record, args=(job, 12, seconds, path), daemon=True).start()
        # 立即返回：卡片上会显示进度条，完成/失败时宿主弹通知
        return {'message': '录制中（%d 秒），可在卡片上看到进度' % seconds, 'job': job.to_dict()}
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
