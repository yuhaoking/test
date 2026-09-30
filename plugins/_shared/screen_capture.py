import ctypes
import json
import os
import random
import struct
import sys
import tempfile
import time
import zlib

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

# 最近一次截图失败的具体原因（PYP-13：供插件生成可读提示）
LAST_ERROR = ''


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', ctypes.c_uint32), ('biWidth', ctypes.c_int32), ('biHeight', ctypes.c_int32),
        ('biPlanes', ctypes.c_uint16), ('biBitCount', ctypes.c_uint16), ('biCompression', ctypes.c_uint32),
        ('biSizeImage', ctypes.c_uint32), ('biXPelsPerMeter', ctypes.c_int32), ('biYPelsPerMeter', ctypes.c_int32),
        ('biClrUsed', ctypes.c_uint32), ('biClrImportant', ctypes.c_uint32)
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', ctypes.c_uint32 * 3)]


def capture(x, y, w, h):
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    if w <= 0 or h <= 0:
        raise ValueError('截图区域尺寸非法：%dx%d' % (w, h))
    hdc = user32.GetDC(0)
    memdc = None
    bmp = None
    try:
        # PYP-5 修复：用 try/finally 保证异常路径也释放 GDI 资源
        memdc = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
        if not memdc or not bmp:
            raise RuntimeError('创建位图失败')
        gdi32.SelectObject(memdc, bmp)
        gdi32.BitBlt(memdc, 0, 0, w, h, hdc, x, y, 0x00CC0020)
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = w
        bmi.bmiHeader.biHeight = -h
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        buf = ctypes.create_string_buffer(w * h * 4)
        if not gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bmi), 0):
            raise RuntimeError('GetDIBits 失败')
        return buf.raw
    finally:
        if bmp:
            gdi32.DeleteObject(bmp)
        if memdc:
            gdi32.DeleteDC(memdc)
        user32.ReleaseDC(0, hdc)


def png_encode(width, height, bgra):
    # PYP-12 修复：BGRA→RGBA 改用切片赋值（C 层完成），替代逐像素 Python 循环。
    # 实测 1080p：旧实现 ~0.69s → 现在约 0.05s 量级，4K 截图不再明显卡顿。
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        row = bgra[y * stride:(y + 1) * stride]
        rgba = bytearray(stride)
        rgba[0::4] = row[2::4]
        rgba[1::4] = row[1::4]
        rgba[2::4] = row[0::4]
        rgba[3::4] = row[3::4]
        raw.append(0)
        raw += rgba

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw)))
            + chunk(b'IEND', b''))


def save_png(path, width, height, bgra):
    with open(path, 'wb') as f:
        f.write(png_encode(width, height, bgra))
    return path


def pictures_dir():
    d = os.path.join(os.path.expanduser('~'), 'Pictures')
    os.makedirs(d, exist_ok=True)
    return d


def videos_dir():
    d = os.path.join(os.path.expanduser('~'), 'Videos')
    os.makedirs(d, exist_ok=True)
    return d


def default_save_dir():
    custom = (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()
    if custom and os.path.isdir(custom):
        return custom
    return pictures_dir()


def to_copy_dir(value):
    custom = (value or '').strip().strip('"')
    if custom and os.path.isdir(custom):
        return custom
    return default_save_dir()


def copy_png_to_clipboard(width, height, bgra):
    k32 = ctypes.windll.kernel32
    u32 = ctypes.windll.user32
    CF_DIB = 8
    k32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    k32.GlobalAlloc.restype = ctypes.c_void_p
    k32.GlobalLock.argtypes = [ctypes.c_void_p]
    k32.GlobalLock.restype = ctypes.c_void_p
    k32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    k32.GlobalFree.argtypes = [ctypes.c_void_p]
    u32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    u32.SetClipboardData.restype = ctypes.c_void_p
    pixels = bytearray(bgra)
    for i in range(3, len(pixels), 4):
        pixels[i] = 255
    header = struct.pack('<IiiHHIIiiII', 40, width, -height, 1, 32, 0, width * height * 4, 0, 0, 0, 0)
    data = header + bytes(pixels)
    if not u32.OpenClipboard(0):
        return False
    h = None
    try:
        # PYP-6 修复：先分配并锁定内存，成功后才清空剪贴板——
        # 避免分配失败时用户原有剪贴板内容已被清空（数据丢失）；GlobalLock 返回 NULL 时直接失败
        h = k32.GlobalAlloc(0x0002, len(data))
        if not h:
            return False
        p = k32.GlobalLock(h)
        if not p:
            k32.GlobalFree(h)
            h = None
            return False
        ctypes.memmove(p, data, len(data))
        k32.GlobalUnlock(h)
        u32.EmptyClipboard()
        if not u32.SetClipboardData(CF_DIB, h):
            k32.GlobalFree(h)
            h = None
            return False
        h = None  # 所有权已移交剪贴板，不再释放
        return True
    finally:
        if h:
            k32.GlobalFree(h)
        u32.CloseClipboard()


def capture_full():
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    return capture(0, 0, w, h), w, h


def capture_foreground_window():
    from ctypes import wintypes
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    hwnd = user32.GetForegroundWindow()
    rect = wintypes.RECT()
    global LAST_ERROR
    LAST_ERROR = ''
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        LAST_ERROR = '无法获取前台窗口位置（可能已最小化或权限不足）'
        return None, 0, 0
    x1, y1, x2, y2 = rect.left, rect.top, rect.right, rect.bottom
    w, h = x2 - x1, y2 - y1
    if w <= 0 or h <= 0:
        LAST_ERROR = '未识别到可截取的窗口，请确认已切换到目标窗口（如浏览器、文档），再重试'
        return None, 0, 0
    if w > 4096 or h > 4096:
        # PYP-13 修复：超宽/超高窗口不再静默失败，写明原因供调用方提示
        LAST_ERROR = '窗口尺寸 %dx%d 超出截图上限 4096，请改用“区域截图”框选目标区域' % (w, h)
        return None, 0, 0
    return capture(x1, y1, w, h), w, h


def select_region_tk():
    import tkinter as tk

    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    # PYP-14 修复：遮罩覆盖整个虚拟桌面（多显示器），不再只覆盖主屏。
    # SM_XVIRTUALSCREEN=76 / SM_YVIRTUALSCREEN=77 / SM_CXVIRTUALSCREEN=78 / SM_CYVIRTUALSCREEN=79
    vx = user32.GetSystemMetrics(76)
    vy = user32.GetSystemMetrics(77)
    vw = user32.GetSystemMetrics(78)
    vh = user32.GetSystemMetrics(79)
    if vw <= 0 or vh <= 0:
        vx, vy = 0, 0
        vw = user32.GetSystemMetrics(0)
        vh = user32.GetSystemMetrics(1)
    result = {}

    root = tk.Tk()
    root.overrideredirect(True)
    root.geometry('%dx%d+%d+%d' % (vw, vh, vx, vy))
    root.attributes('-alpha', 0.25)
    root.attributes('-topmost', True)
    cv = tk.Canvas(root, bg='black', highlightthickness=0)
    cv.pack(fill='both', expand=True)

    state = {'x1': 0, 'y1': 0, 'rect': None}

    def on_press(e):
        state['x1'], state['y1'] = e.x, e.y
        if state['rect'] is not None:
            cv.delete(state['rect'])
        state['rect'] = cv.create_rectangle(e.x, e.y, e.x, e.y, outline='#3b6ef6', width=2, fill='')

    def on_drag(e):
        if state['rect'] is None:
            return
        cv.coords(state['rect'], state['x1'], state['y1'], e.x, e.y)

    def on_release(e):
        x, y = e.x, e.y
        try:
            user32.SetCursorPos(0, 0)
        except Exception:
            pass
        root.destroy()
        # 转换为虚拟桌面绝对坐标（capture/GetDC(0) 用的就是这套坐标系）
        result['rect'] = (
            vx + min(state['x1'], x),
            vy + min(state['y1'], y),
            abs(x - state['x1']),
            abs(y - state['y1'])
        )

    cv.bind('<ButtonPress-1>', on_press)
    cv.bind('<B1-Motion>', on_drag)
    cv.bind('<ButtonRelease-1>', on_release)
    root.bind('<Escape>', lambda e: root.destroy())
    root.mainloop()
    return result.get('rect')


def new_name(prefix, ext):
    # PYP-16 修复：时间戳精确到毫秒 + 唯一后缀，同秒内连续保存不再互相覆盖
    stamp = time.strftime('%Y%m%d_%H%M%S')
    ms = int((time.time() % 1) * 1000)
    return '%s_%s%03d_%04d.%s' % (prefix, stamp, ms, random.randint(0, 9999), ext)


def save_temp_png(prefix, width, height, bgra):
    """保存到临时目录（贴图流程使用：不落到用户的图片库）"""
    d = os.path.join(tempfile.gettempdir(), 'xiaopeng-toolkit')
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, new_name(prefix, 'png'))
    return save_png(path, width, height, bgra)


def request_pin(path):
    """T-04 贴图联动：请求主进程把图片钉到桌面置顶（pin.capture 事件）。

    主进程收到后会创建贴图窗口（可缩放/透明/关闭），插件无需自建窗口。
    """
    sys.stdout.write(json.dumps({
        'jsonrpc': '2.0', 'method': 'event',
        'params': {'type': 'pin.capture', 'path': path}
    }, ensure_ascii=False) + '\n')
    sys.stdout.flush()
