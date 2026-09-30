import { execFile } from 'child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { extname, join } from 'path';
import { nativeImage } from 'electron';
import { logWarn } from '../utils/log';
import type { PreviewData } from '../../shared/types';

/**
 * 文件预览（T-08 QuickLook 集成）
 *
 * - 检测到 QuickLook（QL-Win）即调用其外部预览（`QuickLook.exe <path>` 切换预览窗）；
 * - 未检测到时用内置轻量预览窗口兜底（图片 / 文本 / 音视频 / 元信息卡）；
 * - 盒子内按空格触发（BoxApp），全程只读，不动原文件。
 */

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'wmv', 'flv'];
const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];
const TEXT_EXTS = [
  'txt', 'md', 'json', 'log', 'csv', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'xml', 'toml',
  'js', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'less', 'html', 'htm',
  'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'sql', 'sh', 'bat', 'cmd', 'ps1',
  'gitignore', 'env', 'editorconfig'
];

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4'
};

const MAX_TEXT_BYTES = 512 * 1024;

// ---------- QuickLook 检测（进程路径 → PATH → 常见安装目录，异步 + 进程内缓存） ----------

let quickLookProbe: Promise<string | null> | null = null;

function runCapture(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    );
  });
}

/** SVC-5 修复：探测改为异步（此前两次 execFileSync 最长阻塞主进程 13 秒，全部窗口冻结） */
function probeQuickLook(): Promise<string | null> {
  if (!quickLookProbe) {
    quickLookProbe = (async () => {
      const candidates: string[] = [];
      const running = (
        await runCapture(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '(Get-Process QuickLook -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)'
          ],
          8000
        )
      ).trim();
      if (running && existsSync(running)) candidates.push(running);

      const where = await runCapture('where.exe', ['QuickLook.exe'], 5000);
      for (const line of where.split(/\r?\n/)) {
        const p = line.trim();
        if (p && existsSync(p)) candidates.push(p);
      }
      const local = process.env.LOCALAPPDATA ?? '';
      if (local) {
        candidates.push(join(local, 'Programs', 'QuickLook', 'QuickLook.exe'));
        candidates.push(join(local, 'QuickLook', 'QuickLook.exe'));
      }
      return candidates.find((p) => existsSync(p)) ?? null;
    })();
  }
  return quickLookProbe;
}

/** 预览入口：优先外部 QuickLook，未检测到用内置预览窗（返回实际采用的方式） */
export async function previewFile(
  path: string,
  openBuiltin: (path: string) => void
): Promise<'quicklook' | 'builtin'> {
  const exe = await probeQuickLook();
  if (exe) {
    // QL-Win：`QuickLook.exe <path>` 切换该文件的预览窗；个别版本用 --preview
    execFile(exe, [path], { windowsHide: true, timeout: 5000 }, (err) => {
      if (!err) return;
      execFile(exe, ['--preview', path], { windowsHide: true, timeout: 5000 }, (err2) => {
        if (err2) {
          logWarn('[preview] QuickLook 调用失败，改用内置预览', err2.message);
          openBuiltin(path);
        }
      });
    });
    return 'quicklook';
  }
  openBuiltin(path);
  return 'builtin';
}

// ---------- 内置预览数据 ----------

function extOf(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase();
}

function kindOf(ext: string): PreviewData['kind'] {
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return 'other';
}

/** 只读取文件头部的 n 字节（不把整个文件读进内存） */
function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const len = Math.max(0, Math.min(n, size));
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** 构建内置预览数据（只读；文本截断 512KB，图片转 dataURL） */
export function previewData(path: string): PreviewData {
  const st = statSync(path);
  const ext = extOf(path);
  const kind = st.isDirectory() ? 'other' : kindOf(ext);
  const base: PreviewData = {
    name: path.replace(/\\/g, '/').split('/').pop() ?? path,
    path,
    kind,
    mime: MIME_MAP[ext] ?? 'application/octet-stream',
    size: st.size,
    mtime: st.mtimeMs
  };
  if (st.isDirectory()) return { ...base, kind: 'other', mime: 'inode/directory' };
  try {
    if (kind === 'image') {
      const img = nativeImage.createFromPath(path);
      if (!img.isEmpty()) return { ...base, dataUrl: img.toDataURL() };
      return { ...base, kind: 'other' };
    }
    if (kind === 'text') {
      /*
       * P2-4 修复：只读文件头部，不再把整个文件读进内存。
       * 旧实现 readFileSync(path).subarray(0, MAX_TEXT_BYTES) —— 截断发生在读取**之后**，
       * 打开一个 300MB 的日志文件会让主进程 RSS 瞬间 +300MB（实测），"512KB 截断"形同虚设。
       * 现在按需读取前 MAX_TEXT_BYTES 字节。
       */
      return { ...base, text: readHead(path, MAX_TEXT_BYTES).toString('utf8') };
    }
  } catch (e) {
    logWarn('[preview] 预览数据读取失败', path, (e as Error).message);
  }
  return base;
}
