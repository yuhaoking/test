import { clipboard, globalShortcut } from 'electron';
import { unlink } from 'fs';
import { dataStore } from '../store/dataStore';
import { reportHotkey } from './hotkeyManager';
import { ocrImage } from './ocr';
import { startOcrCapture } from './captureManager';
import { suppressClipboardCapture } from './clipboardManager';
import { hideTranslateBar, showTranslateBar, translateBarWindow } from '../windows/translateBarWindow';
import { sendKeys } from '../utils/sendkeys';
import { listSelectionBarActions, runContextAction } from './contextActions';
import { setClipboardText } from './clipboardManager';
import { logWarn } from '../utils/log';
import type { ContextAction, TranslateBarData } from '../../shared/types';

/**
 * 划词翻译 / 取词 OCR（T-07）
 *
 * pot 模式（热键触发取词，不做全局键盘钩子）：
 * - 划词翻译（默认 Ctrl+Alt+T）：模拟 Ctrl+C 取到当前选中文本 → 聚合翻译引擎（office-translate-pro，
 *   兜底中英互译插件）→ 悬浮条展示原文/译文（复制 / 朗读），并恢复用户原剪贴板；
 * - 取词 OCR（默认 Ctrl+Alt+O）：框选屏幕区域 → Tesseract 识别 → 悬浮条展示识别文本。
 */

let current: TranslateBarData = { mode: 'translate', source: '', result: '' };
const registered = new Map<string, string>();

export function currentBarData(): TranslateBarData {
  return current;
}

function bar(data: TranslateBarData): void {
  current = data;
  showTranslateBar();
  translateBarWindow()?.webContents.send('translatebar:show', data);
  // WK-07：把当前可用动作条一并推送（设置改动作即时生效）
  translateBarWindow()?.webContents.send('translatebar:actions', currentBarActions());
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/** 聚合翻译（office-translate.pro）→ 兜底中英互译（com.office.translate.cnen） */
export async function translateText(text: string): Promise<{ result: string; hint: string }> {
  const target = hasCjk(text) ? 'en' : 'zh-CN';
  const hint = target === 'en' ? '中 → 英（聚合翻译）' : '外 → 中（聚合翻译）';
  try {
    const { pluginAction } = await import('./pluginManager');
    const r = (await pluginAction('com.office.translate.pro', 'go', {
      text,
      target,
      engine: 'auto'
    })) as { message?: string } | null;
    const msg = (r?.message ?? '').trim();
    if (msg.startsWith('译文：')) return { result: msg.slice(3).trim(), hint };
    if (msg) logWarn('[translatebar] 聚合翻译未返回译文，走兜底：', msg);
  } catch (e) {
    logWarn('[translatebar] 聚合翻译失败，走兜底', e);
  }
  // 兜底：中英互译插件
  const { runPluginCommand } = await import('./pluginManager');
  const r2 = (await runPluginCommand('com.office.translate.cnen', 'translate', text)) as {
    message?: string;
  } | null;
  const msg2 = (r2?.message ?? '').trim();
  if (!msg2) throw new Error('翻译插件没有返回结果');
  return { result: msg2, hint: '中 ⇄ 英（互译兜底）' };
}

/** 划词翻译：Ctrl+C 取词 → 翻译 → 悬浮条（恢复原剪贴板） */
export async function translateSelection(): Promise<void> {
  const before = clipboard.readText();
  // SVC-6 修复：抑制剪贴板历史捕获，避免模拟取词/恢复过程污染用户剪贴板历史
  suppressClipboardCapture(1500);
  clipboard.writeText('');
  sendKeys('^c', 100);
  await sleep(350);
  const sel = clipboard.readText().trim();
  // 恢复用户原剪贴板（悬浮条“复制译文”时才会覆盖）
  if (before) clipboard.writeText(before);
  suppressClipboardCapture(1200);
  if (!sel) {
    bar({
      mode: 'translate',
      source: '',
      result: '',
      error: '没有取到选中文本：请先在任意应用里选中文字，再按划词翻译热键'
    });
    return;
  }
  if (sel.length > 2000) {
    bar({ mode: 'translate', source: sel.slice(0, 2000) + '…', result: '', error: '选中文本过长（>2000 字），请缩小选区' });
    return;
  }
  bar({ mode: 'translate', source: sel, result: '…', hint: '翻译中' });
  try {
    const { result, hint } = await translateText(sel);
    bar({ mode: 'translate', source: sel, result, hint });
  } catch (e) {
    bar({ mode: 'translate', source: sel, result: '', error: `翻译失败：${(e as Error).message}` });
  }
}

// ---------- WK-07：可配置划词动作条 ----------

/** 悬浮条可用动作（按设置启用/排序；默认 ≥ 6 个） */
export function currentBarActions(): ContextAction[] {
  return listSelectionBarActions();
}

/** 文本变换类动作的本地实现（在悬浮条内直接显示结果，反馈更直观） */
function transformOf(id: string, text: string): string | null {
  switch (id) {
    case 'text.upper':
      return text.toUpperCase();
    case 'text.lower':
      return text.toLowerCase();
    case 'text.title':
      return text.replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case 'text.trim':
      return text.replace(/[ \t]+/g, ' ').replace(/\s*\r?\n\s*/g, ' ').trim();
    default:
      return null;
  }
}

/**
 * 执行划词动作条上的动作（WK-07）
 * @param id 动作 id（来自 currentBarActions）
 * @param text 原文（渲染层回传，避免取词内容被后续操作覆盖）
 */
export async function runBarAction(id: string, text: string): Promise<void> {
  const source = String(text || current.source || '').trim();
  const action = listSelectionBarActions().find((a) => a.id === id);
  const label = action?.label ?? id;
  if (!source) {
    current = { ...current, notice: '没有可处理的文本' };
    translateBarWindow()?.webContents.send('translatebar:show', current);
    return;
  }
  if (id === 'text.translate') {
    bar({ mode: 'translate', source, result: '…', hint: '翻译中' });
    try {
      const { result, hint } = await translateText(source);
      bar({ mode: 'translate', source, result, hint });
    } catch (e) {
      bar({ mode: 'translate', source, result: '', error: `翻译失败：${(e as Error).message}` });
    }
    return;
  }
  const transformed = transformOf(id, source);
  if (transformed !== null) {
    setClipboardText(transformed);
    current = {
      ...current,
      source,
      result: transformed,
      hint: label + '（已复制，原文见上方）',
      notice: '已' + label + '并复制到剪贴板'
    };
    translateBarWindow()?.webContents.send('translatebar:show', current);
    return;
  }
  const r = await runContextAction(id, { type: 'text', text: source });
  current = {
    ...current,
    source,
    notice: r.message,
    error: r.ok ? undefined : r.message
  };
  translateBarWindow()?.webContents.send('translatebar:show', current);
}

/** 取词 OCR：进入框选截图模式，识别结果进悬浮条（captureManager 回调 showOcr） */
export async function ocrSelection(): Promise<void> {
  await startOcrCapture();
}

/** captureManager 框选完成回调：OCR 临时图 → 悬浮条 */
export async function showOcr(file: string): Promise<void> {
  bar({ mode: 'ocr', source: '识别中…', result: '', hint: 'Tesseract OCR' });
  try {
    const text = (await ocrImage(file)).trim();
    bar({
      mode: 'ocr',
      source: text || '（没有识别到文字）',
      result: '',
      hint: 'OCR 完成，点复制取走文本',
      error: text ? undefined : '识别结果为空，可换更清晰的区域重试'
    });
  } catch (e) {
    bar({ mode: 'ocr', source: '', result: '', error: `OCR 失败：${(e as Error).message}（需 Tesseract 引擎）` });
  } finally {
    try {
      unlink(file, () => undefined);
    } catch {
      /* 临时文件清理失败可忽略 */
    }
  }
}

export function hideBar(): void {
  hideTranslateBar();
}

// ---------- 全局热键（SY-02 热键管理页统一登记） ----------

function registerOne(action: 'translate' | 'ocr', accelerator: string, handler: () => void): void {
  const prev = registered.get(action);
  if (prev) {
    try {
      globalShortcut.unregister(prev);
    } catch {
      /* noop */
    }
    registered.delete(action);
  }
  if (!accelerator) return;
  try {
    if (globalShortcut.register(accelerator, handler)) {
      registered.set(action, accelerator);
      reportHotkey(action, accelerator, true);
    } else {
      reportHotkey(action, accelerator, false, '注册失败（可能被其他程序占用）');
      logWarn('[translatebar] 热键注册失败:', accelerator);
    }
  } catch (e) {
    reportHotkey(action, accelerator, false, (e as Error).message);
    logWarn('[translatebar] 热键注册异常', e);
  }
}

/** 应用划词翻译 / 取词 OCR 热键（SY-02：修改立即生效） */
export function applyTranslateHotkeys(): void {
  const s = dataStore().get().settings;
  registerOne('translate', s.translateHotkey, () => {
    void translateSelection();
  });
  registerOne('ocr', s.ocrHotkey, () => {
    void ocrSelection();
  });
}
