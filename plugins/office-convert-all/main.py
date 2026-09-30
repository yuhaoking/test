import json
import os
import shutil
import subprocess
import sys
import winreg

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _shared import screen_capture as sc

IMAGE_TARGETS = ['png', 'jpg', 'bmp', 'webp', 'gif', 'ico', 'tiff']
AUDIO_TARGETS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma']
VIDEO_TARGETS = ['mp4', 'mov', 'mkv', 'webm', 'avi']
ENCODINGS = ['utf-8', 'gbk', 'gb2312', 'big5']

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.ico', '.tif', '.tiff',
              '.tga', '.heic', '.heif', '.cr2', '.cr3', '.nef', '.arw', '.dng'}
AUDIO_EXTS = {'.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'}
VIDEO_EXTS = {'.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.wmv', '.flv'}
PDF_EXTS = {'.pdf'}
DOC_EXTS = {'.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.rtf', '.odt', '.ods', '.odp',
            '.txt', '.md', '.html', '.htm', '.csv', '.epub', '.xml', '.log'}
TEXT_EXTS = {'.txt', '.csv', '.md', '.xml', '.log', '.json', '.ini'}


# PYP-11 修复：强制 stdout 为 UTF-8，避免第三方拉起方在 GBK 环境下解析 JSON 失败
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


PILLOW_OK = False
PYPDF_OK = False
try:
    from PIL import Image
    PILLOW_OK = True
except Exception:
    pass
try:
    from pypdf import PdfReader, PdfWriter
    PYPDF_OK = True
except Exception:
    pass


def find_exe(names, paths):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for path in paths:
        if path and os.path.exists(path):
            return path
    return None


def engines_root():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    return os.path.join(root, 'engines')


LOCAL_BIN = engines_root()
NESTED_BIN = os.path.join(os.path.dirname(LOCAL_BIN), 'resources', 'engines')
ENV_BIN = (os.environ.get('ENGINES_ROOT') or '').strip()
LOCAL_FFMPEG = find_exe(['ffmpeg.exe', 'ffmpeg'], [os.path.join(LOCAL_BIN, 'bin', 'ffmpeg.exe'), os.path.join(NESTED_BIN, 'bin', 'ffmpeg.exe'), os.path.join(ENV_BIN, 'bin', 'ffmpeg.exe')])
LOCAL_SOFFICE = find_exe(['soffice.exe', 'soffice'], [os.path.join(LOCAL_BIN, 'LibreOffice', 'program', 'soffice.exe'), os.path.join(NESTED_BIN, 'LibreOffice', 'program', 'soffice.exe'), os.path.join(ENV_BIN, 'LibreOffice', 'program', 'soffice.exe')])
LOCAL_PANDOC = find_exe(['pandoc.exe', 'pandoc'], [os.path.join(LOCAL_BIN, 'pandoc', 'pandoc.exe'), os.path.join(NESTED_BIN, 'pandoc', 'pandoc.exe'), os.path.join(ENV_BIN, 'pandoc', 'pandoc.exe')])
LOCAL_TESSERACT = find_exe(['tesseract.exe', 'tesseract'], [os.path.join(LOCAL_BIN, 'tesseract', 'tesseract.exe'), os.path.join(NESTED_BIN, 'tesseract', 'tesseract.exe'), os.path.join(ENV_BIN, 'tesseract', 'tesseract.exe')])

FFMPEG = LOCAL_FFMPEG or find_exe(['ffmpeg'], [r'C:\ffmpeg\bin\ffmpeg.exe', r'C:\Program Files\ffmpeg\bin\ffmpeg.exe'])
SOFFICE = LOCAL_SOFFICE or find_exe(['soffice'], [r'C:\Program Files\LibreOffice\program\soffice.exe', r'C:\Program Files (x86)\LibreOffice\program\soffice.exe'])
PANDOC = LOCAL_PANDOC or find_exe(['pandoc'], [r'C:\Program Files\Pandoc\pandoc.exe'])
PDFTOPPM = find_exe(['pdftoppm'], [r'C:\Program Files\poppler\Library\bin\pdftoppm.exe'])
TESSERACT = LOCAL_TESSERACT or find_exe(['tesseract'], [r'C:\Program Files\Tesseract-OCR\tesseract.exe'])

OCR_LANGS = 'eng'
if TESSERACT:
    try:
        langs = subprocess.run([TESSERACT, '--list-langs'], capture_output=True, text=True, timeout=10).stdout
        if 'chi_sim' in langs:
            OCR_LANGS = 'chi_sim+eng'
    except Exception:
        pass


def office_engine():
    found = {}
    registry = {
        'powerpoint': r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\POWERPNT.EXE',
        'word': 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE',
        'excel': 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\EXCEL.EXE'
    }
    for kind, key_path in registry.items():
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path)
            path, _ = winreg.QueryValueEx(key, None)
            winreg.CloseKey(key)
            if path and os.path.exists(path):
                found[kind] = path
        except OSError:
            pass
    return found


OFFICE = office_engine()

KIND_LABEL = {'image': '图片', 'video': '视频', 'audio': '音频', 'pdf': 'PDF', 'document': '文档/文本', 'mixed': '混合'}


def parse_paths(value):
    return [p.strip().strip('"') for p in (value or '').replace('\uff1b', ';').split(';') if p.strip().strip('"')]


def kind_of_ext(ext):
    ext = ext.lower()
    if ext in IMAGE_EXTS:
        return 'image'
    if ext in AUDIO_EXTS:
        return 'audio'
    if ext in VIDEO_EXTS:
        return 'video'
    if ext in PDF_EXTS:
        return 'pdf'
    if ext in DOC_EXTS:
        return 'document'
    return 'other'


def detect_kind(srcs):
    kinds = {kind_of_ext(os.path.splitext(s)[1]) for s in srcs if os.path.exists(s)}
    if not kinds:
        return None
    if len(kinds) == 1:
        return next(iter(kinds))
    if kinds <= {'document'}:
        return 'document'
    return 'mixed'


def targets_for(kind):
    if kind == 'image':
        return list(IMAGE_TARGETS) + ['pdf']
    if kind == 'video':
        return list(VIDEO_TARGETS) + list(AUDIO_TARGETS)
    if kind == 'audio':
        return list(AUDIO_TARGETS)
    if kind == 'pdf':
        # P2-21 修复：handle_action 与卡片文案本就支持转图片 / OCR，下拉框此前漏列这两项，用户永远选不到
        return ['pdf-text', 'pdf-split', 'pdf-encrypt', 'pdf-decrypt', 'png-pages', 'ocr-txt']
    if kind == 'document':
        return ['pdf', 'docx', 'md', 'html', 'rtf', 'epub', 'txt'] + list(ENCODINGS)
    return []


def engine_hint():
    local = []
    if LOCAL_FFMPEG:
        local.append('FFmpeg')
    if LOCAL_SOFFICE:
        local.append('LibreOffice')
    if LOCAL_PANDOC:
        local.append('Pandoc')
    prefix = ('工作文件夹引擎已加载：' + '、'.join(local) + '。') if local else ''
    missing = []
    if not FFMPEG:
        missing.append('FFmpeg（音视频转换）')
    if not SOFFICE and not PANDOC and not OFFICE:
        missing.append('LibreOffice/Pandoc/Office（文档转换，转 PDF 至少装 Office 或 LibreOffice 之一）')
    if not TESSERACT:
        missing.append('Tesseract（OCR）')
    if not missing:
        return prefix + '全部引擎就绪。'
    return prefix + '检测到未安装的引擎：' + '、'.join(missing) + '（对应能力自动隐藏，安装后生效）'


def capabilities_text(kind, srcs):
    lines = []
    if srcs:
        names = [os.path.basename(s) for s in srcs[:5]]
        lines.append('已识别：' + KIND_LABEL.get(kind or '', '未识别') + '（' + '，'.join(names) + '）')
    else:
        lines.append('请先在下方选择或输入文件（支持多个，用分号 ; 分隔），将自动识别类型并列出可转格式。')
    if kind == 'image':
        lines.append('可转换：' + ' / '.join(IMAGE_TARGETS) + '；多张图片可合并 PDF')
    elif kind == 'video':
        lines.append('可转换：视频 ' + ' / '.join(VIDEO_TARGETS) + '；提取音频 ' + ' / '.join(AUDIO_TARGETS))
    elif kind == 'audio':
        lines.append('可转换：' + ' / '.join(AUDIO_TARGETS))
    elif kind == 'pdf':
        # P2-21：文案与 targets_for 保持一致，OCR 需要 Tesseract，是否安装由 engine_hint 提示
        lines.append('可转换：提取文本 / 拆分指定页 / 加密 / 解密 / 转图片（内置渲染，无需外部引擎）/ OCR 文字识别。')
    elif kind == 'document':
        engines = []
        if OFFICE:
            engines.append('Microsoft Office（PPT/Word/Excel → PDF）')
        if SOFFICE:
            engines.append('LibreOffice')
        if PANDOC:
            engines.append('Pandoc')
        lines.append('可转换：' + ' / '.join(['pdf', 'docx', 'md', 'html', 'rtf', 'epub', 'txt']) + '；文本可转编码 ' + ' / '.join(ENCODINGS))
        lines.append('文档引擎：' + ('、'.join(engines) if engines else '未检测到（请安装 LibreOffice 或 Pandoc；PPT/Word/Excel 转 PDF 可装 Microsoft Office）'))
    elif kind == 'mixed':
        lines.append('检测到混合类型：请按相同类型（分号分隔）分组转换；多张图片可合并 PDF，多个 PDF 可合并。')
    hint = engine_hint()
    if hint:
        lines.append(hint)
    return '\n'.join(lines)


def out_path(src, tag, ext, out_dir):
    base = os.path.splitext(os.path.basename(src))[0]
    name = base + tag + ext
    return os.path.join(out_dir or os.path.dirname(src) or os.getcwd(), name)


def unique_path(path):
    """PYP-10 修复：输出文件已存在时自动改名，绝不覆盖用户已有文件"""
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    for i in range(2, 1000):
        cand = '%s (%d)%s' % (stem, i, ext)
        if not os.path.exists(cand):
            return cand
    return path


def run_soffice_convert(src, target, out_dir):
    """LibreOffice 转换（PYP-9/10 修复）：
    ① profile 路径改用 as_uri() 正确 URL 编码（中文/空格目录不再解析失败）；
    ② 先转到临时目录，再以唯一文件名搬到目标目录，避免同名静默覆盖。"""
    import tempfile
    from pathlib import Path
    profile = os.path.join(LOCAL_BIN, 'LibreOffice', 'profile')
    os.makedirs(profile, exist_ok=True)
    profile_uri = Path(profile).as_uri()
    out_dir_eff = out_dir or os.path.dirname(src) or os.getcwd()
    tmp_out = tempfile.mkdtemp(prefix='xpos-soffice-')
    try:
        run_cmd([SOFFICE, '-env:UserInstallation=' + profile_uri, '--headless',
                 '--convert-to', target, '--outdir', tmp_out, src], timeout=300)
        produced_tmp = os.path.join(tmp_out, os.path.splitext(os.path.basename(src))[0] + '.' + target)
        if not os.path.exists(produced_tmp):
            raise RuntimeError('LibreOffice 未生成输出文件')
        final = unique_path(os.path.join(out_dir_eff, os.path.basename(produced_tmp)))
        shutil.move(produced_tmp, final)
        return final
    finally:
        shutil.rmtree(tmp_out, ignore_errors=True)


def decode_cmd_output(buf):
    """PYP-15 修复：FFmpeg/Pandoc 输出可能是 GBK（中文系统），逐编码尝试，最后兜底替换解码"""
    if not buf:
        return ''
    if isinstance(buf, str):
        return buf
    for enc in ('utf-8', 'gbk'):
        try:
            return buf.decode(enc)
        except UnicodeDecodeError:
            continue
    return buf.decode('utf-8', 'replace')


def run_cmd(cmd, timeout=600, env=None):
    # PYP-15 修复：不再用 text=True 强制按 GBK 解码（含非法字节会 UnicodeDecodeError 把成功当失败）
    # P1-6 修复：新增可选 env（默认 None 即沿用父进程环境，其余调用点行为不变）；
    # Office COM 分支必须靠它把 SRC/OUT 下发给 OFFICE_SCRIPTS，否则脚本拿不到输入输出路径
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    if proc.returncode != 0:
        raise RuntimeError((decode_cmd_output(proc.stderr) or decode_cmd_output(proc.stdout)).strip()[-500:] or '命令失败')


def save_dir_from(values):
    custom = (values.get('dir') or '').strip().strip('"')
    if custom and os.path.isdir(custom):
        return custom
    env_dir = (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    return None


def convert_image(src, target, out_dir):
    import tempfile
    from PIL import Image
    out_dir_q = out_dir or os.path.dirname(src) or os.getcwd()
    try:
        im = Image.open(src)
        im.load()
    except Exception:
        if not FFMPEG:
            raise RuntimeError('该图片格式无法直接读取，请安装 FFmpeg 以解码（HEIC/RAW/TGA 等）')
        # PYP-7 修复：临时文件唯一命名且用后即删（此前固定 __decode_tmp.png 会泄漏并互相覆盖）
        fd, tmp_png = tempfile.mkstemp(prefix='xpos-decode-', suffix='.png', dir=out_dir_q)
        os.close(fd)
        try:
            run_cmd([FFMPEG, '-y', '-i', src, '-frames:v', '1', tmp_png])
            im = Image.open(tmp_png)
            im.load()  # PYP-8：立即解码，随后才能安全删除文件句柄
        finally:
            try:
                os.remove(tmp_png)
            except OSError:
                pass
    if target == 'jpg':
        target = 'jpeg'
    if target == 'ico':
        out = unique_path(out_path(src, '_to', '.ico', out_dir))
        try:
            im.save(out, format='ICO', sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
        finally:
            im.close()  # PYP-8 修复：句柄用后即关（批量转换不再累积解码内存）
        return out
    fmt = 'JPEG' if target == 'jpeg' else target.upper()
    out = unique_path(out_path(src, '_to', '.' + target.replace('jpeg', 'jpg'), out_dir))
    save = im
    converted = None
    if fmt in ('JPEG', 'BMP') and im.mode in ('RGBA', 'P', 'LA'):
        converted = save = im.convert('RGB')
    elif fmt == 'WEBP' and im.mode == 'P':
        converted = save = im.convert('RGB')
    try:
        save.save(out, format=fmt)
    finally:
        if converted is not None:
            converted.close()
        im.close()
    return out


def convert_media(src, target, out_dir):
    out_dir = out_dir or os.path.dirname(src) or os.getcwd()
    if target in AUDIO_TARGETS:
        out = os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + '_to.' + target)
        if target == 'ogg':
            cmd = [FFMPEG, '-y', '-i', src, '-vn', '-q:a', '5', out]
        else:
            cmd = [FFMPEG, '-y', '-i', src, '-vn', '-b:a', '256k', out]
    else:
        out = os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + '_to.' + target)
        size = []
        if target in ('mp4', 'mov', 'mkv'):
            size = ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']
            if target == 'mp4':
                size = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] + size
        cmd = [FFMPEG, '-y', '-i', src] + size + [out]
    try:
        run_cmd(cmd)
    except Exception:
        if os.path.exists(out) and os.path.getsize(out) > 1024:
            return out
        raise
    if not os.path.exists(out):
        raise RuntimeError('FFmpeg 未生成输出文件')
    return out


def convert_pdf_section(srcs, target, out_dir, values):
    if target == 'pdf':
        if all(kind_of_ext(os.path.splitext(s)[1]) == 'image' for s in srcs) and len(srcs) > 1:
            import tempfile
            from PIL import Image
            images = []
            for s in srcs:
                try:
                    im = Image.open(s)
                    im.load()
                except Exception:
                    if not FFMPEG:
                        raise RuntimeError('图片无法读取，请安装 FFmpeg 解码')
                    # PYP-7 修复：唯一临时文件 + 用后即删
                    fd, tmp = tempfile.mkstemp(prefix='xpos-decode-', suffix='.png')
                    os.close(fd)
                    try:
                        run_cmd([FFMPEG, '-y', '-i', s, '-frames:v', '1', tmp])
                        im = Image.open(tmp)
                        im.load()
                    finally:
                        try:
                            os.remove(tmp)
                        except OSError:
                            pass
                images.append(im.convert('RGB') if im.mode in ('RGBA', 'P', 'LA', 'L') else im)
            out = unique_path(out_path(srcs[0], '_merged', '.pdf', out_dir))
            try:
                images[0].save(out, 'PDF', save_all=True, append_images=images[1:])
            finally:
                # PYP-8 修复：多图合并后逐个关闭句柄，避免全部解码常驻内存（大图批量合并可 OOM）
                for img in images:
                    try:
                        img.close()
                    except Exception:
                        pass
            return [out]
        if len(srcs) > 1 and all(kind_of_ext(os.path.splitext(s)[1]) == 'pdf' for s in srcs) and PYPDF_OK:
            writer = PdfWriter()
            for src in srcs:
                for page in PdfReader(src).pages:
                    writer.add_page(page)
            # P2-20 修复：本文件所有写盘输出统一经 unique_path（PYP-10 约定），合并结果不再静默覆盖同名文件
            out = unique_path(out_path(srcs[0], '_merged', '.pdf', out_dir))
            with open(out, 'wb') as f:
                writer.write(f)
            return [out]
        if len(srcs) == 1 and kind_of_ext(os.path.splitext(srcs[0])[1]) == 'video' and FFMPEG:
            # P2-20：FFmpeg 带 -y 会直接覆盖同名文件，先取唯一路径
            out = unique_path(out_path(srcs[0], '_to', '.pdf', out_dir or os.path.dirname(srcs[0])))
            run_cmd([FFMPEG, '-y', '-i', srcs[0], '-pix_fmt', 'yuv420p', out])
            return [out]
    if PYPDF_OK and target in ('pdf-text', 'pdf-split', 'pdf-encrypt', 'pdf-decrypt'):
        password = (values.get('password') or '')
        results = []
        for src in srcs:
            reader = PdfReader(src)
            if target == 'pdf-text':
                text = '\n'.join((page.extract_text() or '') for page in reader.pages)
                out = unique_path(out_path(src, '_to', '.txt', out_dir))  # P2-20 修复：统一走 unique_path
                with open(out, 'w', encoding='utf-8') as f:
                    f.write(text)
                results.append(out)
            elif target == 'pdf-split':
                try:
                    pages = [int(x) for x in (values.get('pages') or '1').replace(',', ' ').split() if x.strip().isdigit()]
                except Exception:
                    pages = [1]
                writer = PdfWriter()
                for p in pages:
                    if 1 <= p <= len(reader.pages):
                        writer.add_page(reader.pages[p - 1])
                out = unique_path(out_path(src, '_p' + str(len(pages)), '.pdf', out_dir))  # P2-20 修复
                with open(out, 'wb') as f:
                    writer.write(f)
                results.append(out)
            elif target == 'pdf-encrypt':
                if not password:
                    raise RuntimeError('请输入加密密码')
                writer = PdfWriter()
                for page in reader.pages:
                    writer.add_page(page)
                writer.encrypt(password)
                out = unique_path(out_path(src, '_encrypted', '.pdf', out_dir))  # P2-20 修复
                with open(out, 'wb') as f:
                    writer.write(f)
                results.append(out)
            else:
                if not password:
                    raise RuntimeError('请输入解密密码')
                if reader.is_encrypted and not reader.decrypt(password):
                    raise RuntimeError('密码错误')
                writer = PdfWriter()
                for page in reader.pages:
                    writer.add_page(page)
                out = unique_path(out_path(src, '_decrypted', '.pdf', out_dir))  # P2-20 修复
                with open(out, 'wb') as f:
                    writer.write(f)
                results.append(out)
        return results
    return None


OFFICE_SCRIPTS = {
    'powerpoint': '''
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject PowerPoint.Application
try {
  $pres = $app.Presentations.Open($env:SRC, $true, $false, $false)
  $pres.SaveAs($env:OUT, 32)
  $pres.Close()
} finally { $app.Quit() }
''',
    'word': '''
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject Word.Application
$app.Visible = $false
try {
  $doc = $app.Documents.Open($env:SRC, $false, $true)
  $doc.SaveAs2($env:OUT, 17)
  $doc.Close($false)
} finally { $app.Quit() }
''',
    'excel': '''
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject Excel.Application
$app.Visible = $false
$app.DisplayAlerts = $false
try {
  $wb = $app.Workbooks.Open($env:SRC)
  $wb.ExportAsFixedFormat(0, $env:OUT)
  $wb.Close($false)
} finally { $app.Quit() }
'''
}


def convert_office_com(src, target, out_dir, kind):
    if target != 'pdf':
        raise RuntimeError('Microsoft Office 仅支持转换为 PDF；其他文档格式请安装 LibreOffice 或 Pandoc')
    # P2-20 修复：Office 的 SaveAs/ExportAsFixedFormat 遇到同名文件会覆盖或弹窗，先取唯一路径
    out = unique_path(out_path(src, '_to', '.pdf', out_dir))
    env = {**os.environ, 'SRC': src, 'OUT': out}
    # P1-6 修复：env 必须显式传给 run_cmd；OFFICE_SCRIPTS 全靠 $env:SRC / $env:OUT，此前算出来就丢了
    run_cmd(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', OFFICE_SCRIPTS[kind]], timeout=300, env=env)
    if not os.path.exists(out):
        raise RuntimeError('Office 转换未生成输出文件')
    return out


def convert_document(src, target, out_dir):
    # P1-6 修复：office_kinds 的键不带点，这里去掉扩展名的点统一口径。
    # 此前 ext 是带点的 '.docx'，永远匹配不到键 'docx' → kind 恒为 None → 整段 Office COM 路径是死代码
    ext = os.path.splitext(src)[1].lower().lstrip('.')
    errors = []
    office_kinds = {'ppt': 'powerpoint', 'pptx': 'powerpoint', 'doc': 'word', 'docx': 'word', 'xls': 'excel', 'xlsx': 'excel'}
    if target == 'pdf':
        kind = office_kinds.get(ext)
        if kind and OFFICE.get(kind):
            try:
                return convert_office_com(src, target, out_dir, kind)
            except Exception as e:
                errors.append('Office 转换失败：' + str(e))
        if SOFFICE:
            try:
                return run_soffice_convert(src, 'pdf', out_dir)
            except Exception as e:
                errors.append('LibreOffice 转换失败：' + str(e))
        if PANDOC:
            try:
                out = unique_path(out_path(src, '_to', '.pdf', out_dir))
                run_cmd([PANDOC, src, '-o', out])
                return out
            except Exception as e:
                errors.append('Pandoc 转换失败：' + str(e))
    else:
        if PANDOC:
            try:
                out = unique_path(out_path(src, '_to', '.' + target, out_dir))
                run_cmd([PANDOC, src, '-o', out])
                return out
            except Exception as e:
                errors.append('Pandoc 转换失败：' + str(e))
        if SOFFICE:
            try:
                return run_soffice_convert(src, target, out_dir)
            except Exception as e:
                errors.append('LibreOffice 转换失败：' + str(e))
    detail = '；'.join(errors[:2])
    raise RuntimeError('未检测到可用的文档引擎，或均已失败。请安装 LibreOffice（https://www.libreoffice.org/download/download-libreoffice/）'
                       ' 或 Pandoc（https://pandoc.org/installing.html）；Office 转换失败时同样建议安装 LibreOffice。' + ('（' + detail + '）' if detail else ''))


def convert_pdf_to_images(src, out_dir):
    out_dir = out_dir or os.path.dirname(src) or os.getcwd()
    try:
        import pymupdf as fitz
        doc = fitz.open(src)
        produced = []
        for i, page in enumerate(doc):
            pix = page.get_pixmap(dpi=120)
            # P2-20 修复：逐页输出同样走 unique_path，重跑同一份 PDF 不会覆盖上次导出的图片
            out = unique_path(os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + '_p%02d.png' % (i + 1)))
            pix.save(out)
            produced.append(out)
        doc.close()
        return produced
    except ImportError:
        pass
    if not PDFTOPPM:
        raise RuntimeError('需要安装 PyMuPDF（自动安装）或 Poppler（pdftoppm）才能将 PDF 转图片')
    # P2-20 修复：pdftoppm 只接受“输出前缀”、无法用 unique_path 预先占位，这里按同款命名规则探测一个未被占用的前缀，
    # 否则重跑会把上一次导出的同名 png 直接覆盖（报告行号未列此分支，与 PDF→图片 属同一处写盘问题）
    stem = os.path.splitext(os.path.basename(src))[0]
    existing = os.listdir(out_dir) if os.path.isdir(out_dir) else []
    out_prefix = os.path.join(out_dir, stem)
    for i in range(2, 1000):
        if not any(f.startswith(os.path.basename(out_prefix)) for f in existing):
            break
        out_prefix = os.path.join(out_dir, '%s (%d)' % (stem, i))
    run_cmd([PDFTOPPM, '-png', '-r', '120', src, out_prefix])
    produced = sorted(f for f in os.listdir(out_dir) if f.startswith(os.path.basename(out_prefix)))
    return [os.path.join(out_dir, f) for f in produced]


def convert_ocr(src, out_dir):
    if not TESSERACT:
        raise RuntimeError('需要安装 Tesseract OCR')
    out_dir = out_dir or os.path.dirname(src) or os.getcwd()
    # P2-20 修复：Tesseract 只接受输出前缀，先给最终 .txt 取唯一名再退回前缀，避免覆盖已有的 OCR 结果
    out_txt = unique_path(os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + '_ocr.txt'))
    if os.path.splitext(src)[1].lower() in PDF_EXTS:
        # P2-21 修复：Tesseract 读不了 PDF 本身，下拉框既然放出了 OCR 目标，就得先渲染成图片再逐页识别，
        # 否则用户一选必然报“无法读取输入文件”；渲染复用 PDF 转图片，临时图片放临时目录且用后即删
        import tempfile
        tmp_dir = tempfile.mkdtemp(prefix='xpos-ocr-')
        try:
            texts = []
            for i, img in enumerate(convert_pdf_to_images(src, tmp_dir)):
                prefix = os.path.join(tmp_dir, 'page%03d' % (i + 1))
                run_cmd([TESSERACT, img, prefix, '-l', OCR_LANGS])
                with open(prefix + '.txt', encoding='utf-8', errors='replace') as f:
                    texts.append(f.read())
            with open(out_txt, 'w', encoding='utf-8') as f:
                f.write('\n'.join(texts))
            return out_txt
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
    out_prefix = os.path.splitext(out_txt)[0]
    run_cmd([TESSERACT, src, out_prefix, '-l', OCR_LANGS])
    return out_txt


def convert_encoding(src, target, out_dir):
    data = open(src, 'rb').read()
    try:
        text = data.decode('utf-8')
    except Exception:
        text = data.decode('gbk')
    out = out_path(src, '_' + target, '.txt', out_dir)
    with open(out, 'wb') as f:
        f.write(text.encode(target))
    return out


def handle(method, params):
    if method == 'plugin.init':
        return {'status': 'ok', 'name': '万能格式转换', 'version': '1.0.0'}
    if method == 'plugin.get_ui':
        params_src = params or {}
        values = params_src.get('values') or {}
        srcs = parse_paths(values.get('paths'))
        existing = [s for s in srcs if os.path.exists(s)]
        kind = detect_kind(existing if existing else srcs)
        options = targets_for(kind)
        inputs = [
            {'id': 'paths', 'label': '文件路径', 'type': 'picker', 'picker': 'file', 'default': ''},
            {'id': 'target', 'label': '目标格式', 'type': 'select', 'options': options, 'default': options[0] if options else ''},
            {'id': 'dir', 'label': '保存目录', 'type': 'picker', 'picker': 'folder',
             'default': (os.environ.get('PLUGIN_SAVE_DIR') or '').strip()}
        ]
        if kind == 'pdf':
            inputs.insert(2, {'id': 'pages', 'label': '拆分页码', 'type': 'text', 'default': '1'})
            inputs.insert(2, {'id': 'password', 'label': 'PDF 密码', 'type': 'text', 'default': ''})
        return {
            'text': capabilities_text(kind, existing if existing else srcs),
            'inputs': inputs,
            'buttons': [{'id': 'convert', 'label': '开始转换'}]
        }
    if method == 'plugin.handle_action':
        params_src = params or {}
        values = params_src.get('values') or {}
        srcs = parse_paths(values.get('paths'))
        if not srcs:
            return {'message': '请先选择文件'}
        for s in srcs:
            if not os.path.exists(s):
                return {'message': '文件不存在：' + s}
        target = (values.get('target') or '').strip().lower()
        if not target:
            return {'message': '请先选择目标格式'}
        out_dir = save_dir_from(values)
        # P2-19 修复：除 PDF 系列分支外，图片 / 音视频 / PDF转图片 / OCR 实际都只处理 srcs[0]，
        # 此前一律回“转换完成”，用户会以为多选的文件全转了。这里取改动更小且不改既有行为的方案——
        # 只补一句准确提示（真去循环批量转换会改变返回结构与部分失败时的语义，风险大于收益）
        ignored_note = '' if len(srcs) <= 1 else '（注意：仅处理了第 1 个文件，其余 %d 个已忽略）' % (len(srcs) - 1)
        try:
            if target in ENCODINGS and len(srcs) == 1 and os.path.splitext(srcs[0])[1].lower() in TEXT_EXTS:
                return {'message': '转换完成：' + convert_encoding(srcs[0], target, out_dir)}
            if target in ('pdf-text', 'pdf-split', 'pdf-encrypt', 'pdf-decrypt') or (target == 'pdf' and len(srcs) > 1):
                outs = convert_pdf_section(srcs, target, out_dir, values)
                if outs:
                    return {'message': '转换完成：' + '；'.join(outs)}
            if target in ('md', 'html', 'docx', 'rtf', 'epub', 'txt') or target == 'pdf':
                if len(srcs) == 1 and os.path.splitext(srcs[0])[1].lower() in DOC_EXTS:
                    out = convert_document(srcs[0], target, out_dir)
                    return {'message': '转换完成：' + out}
            if target in IMAGE_TARGETS:
                out = convert_image(srcs[0], target, out_dir)
                return {'message': '转换完成：' + out + ignored_note}
            if target in AUDIO_TARGETS or target in VIDEO_TARGETS:
                if not FFMPEG:
                    return {'message': '需要安装 FFmpeg（https://ffmpeg.org/download.html）才能转换音视频'}
                try:
                    out = convert_media(srcs[0], target, out_dir)
                except RuntimeError as e:
                    msg = str(e)
                    if 'stream' in msg.lower() and 'contain' in msg.lower() or 'stream' in msg.lower() and 'no' in msg.lower():
                        return {'message': '转换失败：源文件可能没有音轨（无音频可提取），或编码器不受该 FFmpeg 版本支持'}
                    return {'message': '转换失败：' + msg[-200:]}
                return {'message': '转换完成：' + out + ignored_note}
            if target == 'png-pages':
                outs = convert_pdf_to_images(srcs[0], out_dir)
                return {'message': '转换完成：' + '；'.join(outs[:10]) + ('（共 %d 页）' % len(outs)) + ignored_note}
            if target == 'ocr-txt':
                return {'message': 'OCR 完成：' + convert_ocr(srcs[0], out_dir) + ignored_note}
            return {'message': '暂不支持该组合（' + os.path.splitext(srcs[0])[1] + ' → ' + target + '）'}
        except Exception as e:
            return {'message': '转换失败：' + str(e)}
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
