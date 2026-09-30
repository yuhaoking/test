import { clipboard } from 'electron';
import { suppressClipboardCapture, queryForegroundApp } from './clipboardManager';
import { sendKeys } from '../utils/sendkeys';
import { inferClipboardIntent } from '../../shared/devtools/intent.ts';
import { logWarn } from '../utils/log';
import type { ContextPayload } from '../../shared/types';

/**
 * 工作台上下文抓取（WK-01 / SPC 2.1）
 *
 * 流程：剪贴板快照 → 暂停剪贴板历史捕获 → 模拟 Ctrl+C → 轮询剪贴板变化（≤ 300ms 预算）
 *      → 类型判定（text / file / url / image / none）→ 恢复原剪贴板与监听 → 返回载荷。
 *
 * 约束（规格 §4 安全 / §7 兼容）：
 * - 不引入全局键盘/鼠标钩子，仅一次模拟 Ctrl+C（复用 translateBar 既有方案）；
 * - 上下文**仅内存态**，不落盘、不上传、不写日志正文；
 * - 任一步异常都会恢复剪贴板并按 none 兜底（WK-05），绝不把错误内容留在剪贴板。
 */

/** 轮询参数：20ms 间隔 + 300ms 预算（SPC 2.1），超时后再给一次宽限以覆盖 PowerShell 启动抖动 */
const POLL_INTERVAL_MS = 20;
const CAPTURE_BUDGET_MS = 300;
const CAPTURE_GRACE_MS = 350;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Snapshot {
  text: string;
  image: Electron.NativeImage | null;
}

function snapshot(): Snapshot {
  try {
    const text = clipboard.readText() ?? '';
    const img = clipboard.readImage();
    return { text, image: img && !img.isEmpty() ? img : null };
  } catch (e) {
    logWarn('[context] 读取剪贴板失败', e);
    return { text: '', image: null };
  }
}

/**
 * 剪贴板当前是否持有「文件列表」格式（资源管理器复制文件）。
 * Electron 只能写 text/html/image/rtf/bookmark，文件列表写不回去，因此只能选择不动它。
 */
function hasFileListFormat(): boolean {
  try {
    const formats = clipboard.availableFormats() ?? [];
    return formats.some((f) => /FileName|HDROP|Shell IDList|uri-list/i.test(f));
  } catch {
    return false;
  }
}

/** 恢复剪贴板原内容（文本优先；无文本时恢复图片；都为空则清空为纯文本空串） */
function restore(snap: Snapshot): void {
  try {
    if (snap.text) clipboard.writeText(snap.text);
    else if (snap.image) clipboard.writeImage(snap.image);
    else clipboard.writeText('');
  } catch (e) {
    logWarn('[context] 剪贴板恢复失败', e);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    p.then((v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }).catch(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

/**
 * 抓取当前上下文（≤ 300ms 轮询预算）。
 * @param options.copyKey 是否模拟 Ctrl+C 取词（设置关闭时为 false，仅读剪贴板）
 */
export async function captureContext(options?: { copyKey?: boolean }): Promise<ContextPayload> {
  const useCopyKey = options?.copyKey !== false;
  const snap = snapshot();
  let selected = '';

  /*
   * 性能（实测发现）：前台应用探测要拉起 PowerShell，最长等 400ms，而它此前是**串行**挡在最后，
   * 导致"只读剪贴板"这种本该 <10ms 的路径实测 450ms。
   * 现在提前并发发起、后面只等剩余预算 —— 取词路径本身要等 300ms+ 轮询，探测正好在这段时间里跑完。
   */
  const appProbe = queryForegroundApp();

  /*
   * P2-1 修复：剪贴板里可能有「复制的文件」（CF_HDROP / text/uri-list）等 Electron **无法写回**的格式。
   * 旧实现一上来就 clipboard.writeText('') 探路，会把这些格式彻底抹掉 —— 资源管理器里再也粘不出文件。
   *
   * 现在的策略：
   *  1) 绝不预先清空剪贴板：改为"快照 → 取词 → 只在内容真的变化时才写回"；
   *     Ctrl+C 没取到新内容时剪贴板一个字节都不动（其它格式完整保留）。
   *  2) 若剪贴板当前持有文件列表，则**完全跳过模拟取词**：文件列表无法用 Electron API 还原，
   *     而它本身就是工作台最有价值的上下文（文件路径组）。这一取舍写在这里，避免以后又被"优化"掉。
   */
  const fileListOnClipboard = hasFileListFormat();

  if (useCopyKey && !fileListOnClipboard) {
    // 抑制窗口覆盖「取词 + 恢复」全过程，取词内容不进入剪贴板历史（SVC-6 既有机制）
    suppressClipboardCapture(CAPTURE_BUDGET_MS + CAPTURE_GRACE_MS + 600);
    let changed = false;
    try {
      sendKeys('^c', 0);
      const deadline = Date.now() + CAPTURE_BUDGET_MS + CAPTURE_GRACE_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const now = clipboard.readText() ?? '';
        if (now !== snap.text) {
          selected = now;
          changed = true;
          break;
        }
      }
    } catch (e) {
      logWarn('[context] 模拟取词失败', e);
    } finally {
      // 只有内容真被改动过才写回，避免"无选区的一次热键"破坏剪贴板其它格式
      if (changed) restore(snap);
      // 恢复后再抑制一小段，避免把恢复动作本身记为历史（与 translateBar 一致）
      suppressClipboardCapture(800);
    }
  }

  const source = selected.trim() ? selected : snap.text;
  // 只等 200ms（多数情况下探测已在前面的轮询窗口内完成；TTL 缓存命中时为 0ms）
  const foregroundApp = await withTimeout(appProbe, 200, '');
  const intent = inferClipboardIntent(source);

  if (source.trim()) {
    if (intent.kind === 'path') {
      return {
        type: 'file',
        text: source,
        paths: intent.paths,
        foregroundApp,
        detail: intent.detail
      };
    }
    if (intent.kind === 'url') {
      return { type: 'url', text: source, foregroundApp, detail: intent.detail };
    }
    return {
      type: 'text',
      text: source,
      foregroundApp,
      detail: selected.trim() ? '已选中文本' : fileListOnClipboard ? '剪贴板文本（检测到文件列表，未模拟取词）' : '剪贴板文本'
    };
  }

  if (snap.image) {
    try {
      const dataUrl = 'data:image/png;base64,' + snap.image.toPNG().toString('base64');
      return { type: 'image', imageDataUrl: dataUrl, foregroundApp, detail: '剪贴板图片' };
    } catch (e) {
      logWarn('[context] 图片快照转换失败', e);
    }
  }

  return { type: 'none', foregroundApp, detail: foregroundApp ? '来自 ' + foregroundApp : '无可用上下文' };
}

/** 供命令面板 / 粘贴面板复用的轻量版本：只读剪贴板，不模拟按键 */
export function readClipboardContext(): ContextPayload {
  const snap = snapshot();
  const intent = inferClipboardIntent(snap.text);
  if (snap.text.trim()) {
    if (intent.kind === 'path') return { type: 'file', text: snap.text, paths: intent.paths, detail: intent.detail };
    if (intent.kind === 'url') return { type: 'url', text: snap.text, detail: intent.detail };
    return { type: 'text', text: snap.text, detail: intent.detail };
  }
  if (snap.image) {
    try {
      return {
        type: 'image',
        imageDataUrl: 'data:image/png;base64,' + snap.image.toPNG().toString('base64'),
        detail: '剪贴板图片'
      };
    } catch {
      /* 忽略 */
    }
  }
  return { type: 'none', detail: '无可用上下文' };
}
