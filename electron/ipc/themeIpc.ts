/**
 * 主题包 IPC（T-06 UGC）
 *
 * 安全约定：**渲染层不传路径**。
 * - 导入：主进程弹选择器并把选中的路径记在模块变量里，覆盖确认时复用该路径；
 *   渲染层能传的只有 id 与几个文案字段（渲染层若被注入，也不能借主题包接口读写任意文件）。
 * - 制作：只打包"用户当前设置里的形象与动作帧"——这些路径本来就是用户自己选的，
 *   不存在把任意文件塞进包里的通道。IPC 层因此主动丢弃 draft 里的 image/actions 字段。
 */

import { ipcMain, shell } from 'electron';
import { join } from 'path';
import {
  BUILTIN_THEME_ID,
  applyTheme,
  createThemePack,
  exportTheme,
  exportThemeTemplate,
  getThemeInfo,
  importThemeFromFile,
  listThemes,
  pickThemeFile,
  removeTheme,
  themeShareTextOf,
  themesRoot,
  verifyTheme,
  type ThemeDraft
} from '../services/themePack';
import { logWarn } from '../utils/log';
import type { ThemeExportResult, ThemeImportResult } from '../../shared/types';

/** 待确认覆盖的主题包路径（只由主进程写入） */
let pendingImport: string | null = null;

/** 只保留文案类字段：路径类字段一律丢弃（见文件头说明） */
function sanitizeDraft(input: unknown): ThemeDraft {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [];
  const bubble = (o.bubble && typeof o.bubble === 'object' ? o.bubble : {}) as Record<string, unknown>;
  const skin = (o.skin && typeof o.skin === 'object' ? o.skin : {}) as Record<string, unknown>;
  return {
    name: str(o.name, 40),
    id: str(o.id, 64),
    author: str(o.author, 40),
    description: str(o.description, 200),
    version: str(o.version, 20),
    license: str(o.license, 40),
    homepage: str(o.homepage, 200),
    tags,
    bubble: { bg: str(bubble.bg, 9), color: str(bubble.color, 9), fontSize: Number(bubble.fontSize), radius: Number(bubble.radius) },
    skin: { theme: skin.theme === 'dark' || skin.theme === 'light' ? skin.theme : '', accent: str(skin.accent, 9) }
  };
}

export function registerThemeIpc(): void {
  ipcMain.handle('theme:list', () => listThemes());

  ipcMain.handle('theme:import', async (): Promise<ThemeImportResult | null> => {
    const file = await pickThemeFile();
    if (!file) return null;
    const result = importThemeFromFile(file, false);
    pendingImport = result.exists ? file : null;
    return result;
  });

  /** 覆盖确认：路径取自主进程记录的 pendingImport，渲染层无法指定文件 */
  ipcMain.handle('theme:import-confirm', (): ThemeImportResult => {
    const file = pendingImport;
    pendingImport = null;
    if (!file) return { ok: false, error: '没有待确认的导入（请重新选择文件）' };
    return importThemeFromFile(file, true);
  });

  ipcMain.handle('theme:remove', (_e, id: string) => removeTheme(String(id ?? '')));

  ipcMain.handle('theme:apply', (_e, id: string, applySkin?: boolean) => applyTheme(String(id ?? ''), Boolean(applySkin)));

  ipcMain.handle('theme:verify', (_e, id: string) => verifyTheme(String(id ?? '')));

  ipcMain.handle('theme:create', async (_e, draft: unknown): Promise<ThemeExportResult | { error: string }> => {
    try {
      return await createThemePack(sanitizeDraft(draft));
    } catch (e) {
      logWarn('[theme] 制作主题包失败', e);
      return { error: (e as Error).message };
    }
  });

  ipcMain.handle('theme:export', async (_e, id: string): Promise<ThemeExportResult | { error: string }> => {
    try {
      return await exportTheme(String(id ?? ''));
    } catch (e) {
      return { error: (e as Error).message };
    }
  });

  ipcMain.handle('theme:share-text', (_e, id: string) => themeShareTextOf(String(id ?? '')));

  ipcMain.handle('theme:template', async () => {
    try {
      return await exportThemeTemplate();
    } catch {
      return null;
    }
  });

  /** 打开主题目录（默认打开已安装主题所在目录；传入 id 则打开该主题自己的目录） */
  ipcMain.handle('theme:open-folder', async (_e, id?: string) => {
    const info = id ? getThemeInfo(String(id)) : null;
    const dir = info && !info.builtin ? info.dir : themesRoot();
    const err = await shell.openPath(dir);
    if (err) logWarn(`[theme] 打开目录失败：${err}`);
  });

  ipcMain.handle('theme:builtin-id', () => BUILTIN_THEME_ID);
  // 供设置页显示"主题包目录"位置
  ipcMain.handle('theme:root', () => join(themesRoot()));
}
