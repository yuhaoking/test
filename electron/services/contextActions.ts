import { Notification, clipboard, shell } from 'electron';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { db } from '../store/db';
import { dataStore, userDataDir } from '../store/dataStore';
import { setClipboardText } from './clipboardManager';
import { ocrImage } from './ocr';
import { speak } from './voice';
import { jsonFormat } from '../../shared/devtools/json.ts';
import { explainTimeInput, parseTimeInput } from '../../shared/devtools/time.ts';
import { openExternalSafe } from '../utils/openExternalSafe';
import { logDebug, logWarn } from '../utils/log';
import type { ContextAction, ContextGroup, ContextPayload, SelectionBarAction } from '../../shared/types';

/**
 * 上下文动作模型（WK-02 / SPC 2.2）
 *
 * 一处定义、三处复用：工作台上下文区（M1）、命令面板粘贴智能匹配（CP-07）、划词动作条（WK-07）。
 * 全部动作走既有服务（translateBar / voice / ocr / filePreview / desktopBoxes / captureManager），
 * 不新造窗口、不引入全局钩子。
 */

interface ActionDef {
  id: string;
  group: Exclude<ContextGroup, 'pinned'>;
  label: string;
  icon: string;
  /** 适用的上下文类型 */
  types: ContextPayload['type'][];
  /** WK-06：默认不启用（需用户手动固定 / 启用后才显示） */
  requiresEnable?: boolean;
}

/** 内置动作目录（顺序即默认展示顺序） */
export const ACTION_CATALOG: ActionDef[] = [
  // —— 文本组（≥ 4 个，WK-02） ——
  { id: 'text.translate', group: 'text', label: '翻译', icon: 'globe', types: ['text'] },
  { id: 'text.webSearch', group: 'text', label: '搜索', icon: 'search', types: ['text'] },
  { id: 'text.copy', group: 'text', label: '复制', icon: 'copy', types: ['text'] },
  { id: 'text.upper', group: 'text', label: '转大写', icon: 'up', types: ['text'] },
  { id: 'text.lower', group: 'text', label: '转小写', icon: 'down', types: ['text'] },
  { id: 'text.title', group: 'text', label: '首字母大写', icon: 'pen', types: ['text'] },
  { id: 'text.trim', group: 'text', label: '去空白换行', icon: 'doc', types: ['text'] },
  { id: 'text.speak', group: 'text', label: '朗读', icon: 'music', types: ['text'] },
  // —— 文件组（≥ 4 个） ——
  { id: 'file.reveal', group: 'file', label: '打开所在目录', icon: 'folder', types: ['file'] },
  { id: 'file.copyPath', group: 'file', label: '复制路径', icon: 'copy', types: ['file'] },
  { id: 'file.preview', group: 'file', label: '预览', icon: 'eye', types: ['file'] },
  { id: 'file.archive', group: 'file', label: '归档到收纳盒', icon: 'box', types: ['file'], requiresEnable: true },
  // —— 网址组 ——
  { id: 'url.open', group: 'url', label: '网页快开', icon: 'rocket', types: ['url'] },
  { id: 'url.copy', group: 'url', label: '复制链接', icon: 'copy', types: ['url'] },
  { id: 'url.copyDomain', group: 'url', label: '复制域名', icon: 'globe', types: ['url'] },
  // —— 图片组 ——
  { id: 'image.pin', group: 'image', label: '贴图到桌面', icon: 'pin', types: ['image'] },
  { id: 'image.ocr', group: 'image', label: 'OCR 取字', icon: 'eye', types: ['image'] },
  { id: 'image.save', group: 'image', label: '另存为图片', icon: 'save', types: ['image'] },
  // —— 智能匹配专用（CP-07） ——
  { id: 'json.format', group: 'text', label: 'JSON 格式化', icon: 'doc', types: ['text'] },
  { id: 'json.minify', group: 'text', label: 'JSON 压缩', icon: 'doc', types: ['text'] },
  { id: 'time.convert', group: 'text', label: '时间戳转换', icon: 'clock', types: ['text'] }
];

/** 通用文本动作（与上下文类型无关，供划词动作条使用） */
export const TEXT_ACTIONS = ACTION_CATALOG.filter((a) => a.group === 'text').map((a) => a.id);

function catalogById(id: string): ActionDef | undefined {
  return ACTION_CATALOG.find((a) => a.id === id);
}

function usageOf(id: string): number {
  try {
    const raw = db().get('palette_usage', 'ctx:' + id);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { weight?: number };
    return parsed.weight ?? 0;
  } catch {
    return 0;
  }
}

function recordUsage(id: string): void {
  try {
    const raw = db().get('palette_usage', 'ctx:' + id);
    const weight = raw ? (JSON.parse(raw) as { weight?: number }).weight ?? 0 : 0;
    db().set('palette_usage', 'ctx:' + id, JSON.stringify({ weight: weight + 1, lastUsed: Date.now() }));
  } catch (e) {
    logDebug('[context] 记录动作使用失败', e);
  }
}

/** 整理为 ContextAction（附加使用频率与固定状态） */
function decorate(def: ActionDef, pins: string[]): ContextAction {
  return {
    id: def.id,
    group: def.group,
    label: def.label,
    icon: def.icon,
    usage: usageOf(def.id),
    pinned: pins.includes(def.id),
    requiresEnable: def.requiresEnable
  };
}

/**
 * 列出当前上下文可用的动作（WK-02 / WK-03 / WK-06）
 *
 * - 固定动作永远排最前（group=pinned，WK-03）；
 * - 其余按使用频率降序，再按目录顺序（稳定）；
 * - WK-06：requiresEnable 的动作（归档）默认隐藏，只有被固定后才出现；收纳盒关闭时强制隐藏。
 */
export function listContextActions(payload: ContextPayload): ContextAction[] {
  const settings = dataStore().get().settings;
  const pins = settings.deskboardPins ?? [];
  const type = payload.type ?? 'none';

  const pinnedActions: ContextAction[] = [];
  for (const id of pins) {
    const def = catalogById(id);
    if (!def) continue;
    // 收纳盒关闭时强制隐藏“归档到收纳盒”（WK-06）
    if (def.id === 'file.archive' && !settings.desktopBoxesEnabled) continue;
    pinnedActions.push({ ...decorate(def, pins), group: 'pinned' });
  }

  if (type === 'none') return pinnedActions;

  const rest = ACTION_CATALOG.filter((a) => a.types.includes(type))
    .filter((a) => !pins.includes(a.id))
    // WK-06：「归档到收纳盒」默认不启用——只有用户固定（Pin）后才出现（见上方 pinnedActions）
    .filter((a) => !a.requiresEnable)
    .map((a) => decorate(a, pins));

  rest.sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0));
  const out = [...pinnedActions, ...rest];
  out.forEach((a, i) => {
    a.hotIndex = i + 1;
  });
  return out;
}

/** 划词动作条动作（WK-07：按设置启用/排序，核心动作 translate 强制保留） */
export function listSelectionBarActions(): ContextAction[] {
  const settings = dataStore().get().settings;
  const configured: SelectionBarAction[] = settings.selectionBarActions ?? [];
  const pins = settings.deskboardPins ?? [];
  const enabled = configured
    .filter((c) => c && c.enabled !== false)
    .filter((c) => catalogById(c.id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const ids = enabled.length ? enabled.map((c) => c.id) : ['text.translate'];
  const out = ids.map((id) => decorate(catalogById(id) as ActionDef, pins));
  out.forEach((a, i) => {
    a.hotIndex = i + 1;
  });
  return out;
}

/** 划词动作条可配置项（设置页列全部内置文本动作 + 启用状态） */
export function selectionBarCatalog(): Array<{ id: string; label: string; icon: string; enabled: boolean; order: number }> {
  const settings = dataStore().get().settings;
  const configured = settings.selectionBarActions ?? [];
  return ACTION_CATALOG.filter((a) => a.group === 'text' && !['json.format', 'json.minify', 'time.convert'].includes(a.id)).map(
    (a) => {
      const hit = configured.find((c) => c.id === a.id);
      return {
        id: a.id,
        label: a.label,
        icon: a.icon,
        enabled: hit ? hit.enabled !== false : false,
        order: hit?.order ?? 99
      };
    }
  );
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body: body.slice(0, 180) }).show();
  } catch {
    /* 通知不可用时忽略 */
  }
}

function clipboardText(payload: ContextPayload): string {
  return String(payload.text ?? '');
}

function firstPath(payload: ContextPayload): string {
  return String((payload.paths ?? [])[0] ?? payload.text ?? '').trim();
}

function toTitleCase(text: string): string {
  return text.replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** 写入剪贴板并提示（文本类动作的统一出口） */
function copyWithNotice(text: string, notice: string): { ok: boolean; message: string } {
  setClipboardText(text);
  notify('小鹏工具箱', notice);
  return { ok: true, message: notice };
}

/**
 * 执行上下文动作（WK-02）
 * 返回 { ok, message }：message 供工作台 / 悬浮条展示反馈。
 */
export async function runContextAction(
  id: string,
  payload: ContextPayload
): Promise<{ ok: boolean; message?: string }> {
  const def = catalogById(id);
  if (!def) return { ok: false, message: '未知动作：' + id };
  const text = clipboardText(payload);
  try {
    switch (id) {
      case 'text.translate': {
        const { translateText } = await import('./translateBar');
        const { result } = await translateText(text);
        return copyWithNotice(result, '译文已复制到剪贴板');
      }
      case 'text.webSearch': {
        await openExternalSafe('https://www.bing.com/search?q=' + encodeURIComponent(text.slice(0, 400)));
        return { ok: true, message: '已在浏览器中搜索' };
      }
      case 'text.copy':
        return copyWithNotice(text, '已复制到剪贴板');
      case 'text.upper':
        return copyWithNotice(text.toUpperCase(), '已转为大写并复制');
      case 'text.lower':
        return copyWithNotice(text.toLowerCase(), '已转为小写并复制');
      case 'text.title':
        return copyWithNotice(toTitleCase(text), '已转为首字母大写并复制');
      case 'text.trim':
        return copyWithNotice(text.replace(/[ \t]+/g, ' ').replace(/\s*\r?\n\s*/g, ' ').trim(), '已去空白换行并复制');
      case 'text.speak':
        speak(text.slice(0, 500));
        return { ok: true, message: '开始朗读' };
      case 'json.format': {
        const r = jsonFormat(text);
        if (!r.ok) return { ok: false, message: 'JSON 第 ' + r.line + ' 行第 ' + r.column + ' 列有误：' + r.message };
        return copyWithNotice(r.out, 'JSON 已格式化并复制');
      }
      case 'json.minify': {
        const r = jsonFormat(text, 0);
        if (!r.ok) return { ok: false, message: 'JSON 第 ' + r.line + ' 行第 ' + r.column + ' 列有误：' + r.message };
        return copyWithNotice(r.out, 'JSON 已压缩并复制');
      }
      case 'time.convert': {
        const t = parseTimeInput(text);
        if (!t) {
          // P2-12 配套：形如日期但越界时给出准确原因（而不是笼统的"无法识别"）
          return { ok: false, message: explainTimeInput(text) ?? '无法识别为时间戳或日期' };
        }
        return copyWithNotice(t.local, '已转换为本地时间：' + t.local);
      }
      case 'file.reveal': {
        const paths = payload.paths ?? [];
        if (!paths.length) return { ok: false, message: '没有可打开的文件路径' };
        for (const p of paths.slice(0, 10)) {
          if (existsSync(p)) shell.showItemInFolder(p);
        }
        return { ok: true, message: '已在资源管理器中定位' };
      }
      case 'file.copyPath': {
        const paths = payload.paths ?? [];
        if (!paths.length) return { ok: false, message: '没有可复制的路径' };
        return copyWithNotice(paths.join('\n'), '已复制 ' + paths.length + ' 条路径');
      }
      case 'file.preview': {
        const p = firstPath(payload);
        if (!p || !existsSync(p)) return { ok: false, message: '文件不存在或已移动' };
        const { previewFile } = await import('./filePreview');
        const { openPreviewWindow } = await import('../windows/previewWindow');
        await previewFile(p, (target) => openPreviewWindow(target));
        return { ok: true, message: '已打开预览' };
      }
      case 'file.archive': {
        if (!dataStore().get().settings.desktopBoxesEnabled) {
          return { ok: false, message: '收纳盒未启用（设置 → 桌面收纳 可开启）' };
        }
        const paths = (payload.paths ?? []).filter((p) => p && existsSync(p));
        if (!paths.length) return { ok: false, message: '没有可归档的文件' };
        const boxes = await import('./desktopBoxes');
        const target = boxes.listBoxes().find((b) => (b.kind ?? 'files') === 'files');
        const box = target ?? boxes.createBox({ name: '工作台归档', visible: true });
        await boxes.addPaths(box.id, paths);
        return { ok: true, message: '已归档 ' + paths.length + ' 个文件到「' + box.name + '」' };
      }
      case 'url.open':
        await openExternalSafe(text.trim());
        return { ok: true, message: '已在浏览器中打开' };
      case 'url.copy':
        return copyWithNotice(text.trim(), '已复制链接');
      case 'url.copyDomain': {
        try {
          const host = new URL(text.trim()).host;
          return copyWithNotice(host, '已复制域名：' + host);
        } catch {
          return { ok: false, message: '无法解析出域名' };
        }
      }
      case 'image.pin': {
        if (!payload.imageDataUrl) return { ok: false, message: '没有可贴图的图片' };
        const { pinImage } = await import('./captureManager');
        pinImage(payload.imageDataUrl);
        return { ok: true, message: '已贴图到桌面' };
      }
      case 'image.save': {
        if (!payload.imageDataUrl) return { ok: false, message: '没有可保存的图片' };
        const { saveImage } = await import('./captureManager');
        const saved = saveImage(payload.imageDataUrl);
        if (!saved) return { ok: false, message: '已取消保存' };
        return { ok: true, message: '已保存到 ' + saved };
      }
      case 'image.ocr': {
        if (!payload.imageDataUrl) return { ok: false, message: '没有可识别的图片' };
        const tmp = join(userDataDir(), 'context-ocr.png');
        try {
          writeFileSync(tmp, Buffer.from(payload.imageDataUrl.split(',')[1] ?? '', 'base64'));
          const recognized = (await ocrImage(tmp)).trim();
          if (!recognized) return { ok: false, message: '未识别到文字（需 Tesseract 引擎或图片不含文字）' };
          return copyWithNotice(recognized, 'OCR 文字已复制到剪贴板');
        } finally {
          try {
            if (existsSync(tmp)) rmSync(tmp, { force: true });
          } catch {
            /* 清理失败可忽略 */
          }
        }
      }
      default:
        return { ok: false, message: '动作暂未实现：' + id };
    }
  } catch (e) {
    logWarn('[context] 动作执行失败', id, e);
    return { ok: false, message: (e as Error).message };
  } finally {
    recordUsage(id);
  }
}

/** 固定 / 取消固定动作（WK-03，持久化 settings.deskboardPins） */
export function togglePin(id: string, pinned: boolean): string[] {
  const current = dataStore().get().settings.deskboardPins ?? [];
  const next = pinned ? [...new Set([...current, id])] : current.filter((x) => x !== id);
  dataStore().updateSettings({ deskboardPins: next });
  return next;
}

/** 剪贴板图片 → NativeImage（CP-07 图片入口复用） */
export function clipboardImageOrNull(): Electron.NativeImage | null {
  try {
    const img = clipboard.readImage();
    return img && !img.isEmpty() ? img : null;
  } catch {
    return null;
  }
}
