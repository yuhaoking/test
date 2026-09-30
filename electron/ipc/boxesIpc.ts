import { BrowserWindow, ipcMain } from 'electron';
import {
  addAppsToBox,
  addPaths,
  applyRules,
  autoStack,
  capsuleHover,
  createBox,
  getBox,
  listBoxes,
  openPath,
  removeBox,
  removeItem,
  setBoxVisible,
  setCapsule,
  stackItem,
  updateBox
} from '../services/desktopBoxes';
import { previewData, previewFile } from '../services/filePreview';
import { openPreviewWindow } from '../windows/previewWindow';
import { windowBoxId } from '../windows/boxWindow';
import type { DesktopBox } from '../../shared/types';

export function registerBoxesIpc(): void {
  ipcMain.handle('boxes:list', () => listBoxes());
  ipcMain.handle('boxes:get', (_e, id: string) => getBox(id));
  ipcMain.handle('boxes:create', (_e, partial?: Partial<DesktopBox>) => {
    createBox(partial);
    return listBoxes();
  });
  ipcMain.handle('boxes:update', (_e, id: string, patch: Partial<DesktopBox>) => {
    updateBox(id, patch);
    return listBoxes();
  });
  ipcMain.handle('boxes:remove', (_e, id: string) => {
    removeBox(id);
    return listBoxes();
  });
  ipcMain.handle('boxes:set-visible', (_e, id: string, visible: boolean) => {
    setBoxVisible(id, visible);
    return listBoxes();
  });
  ipcMain.handle('boxes:remove-item', (_e, boxId: string, path: string) => {
    removeItem(boxId, path);
    return listBoxes();
  });
  ipcMain.handle('boxes:open-path', (_e, path: string) => openPath(path));
  ipcMain.handle('boxes:apply-rules', () => applyRules());
  ipcMain.handle('boxes:add-apps', (_e, boxId: string) => addAppsToBox(boxId));
  // ---- T-08 收纳盒深化：QuickLook 预览 / 文件叠放 / 胶囊模式 ----
  ipcMain.handle('boxes:preview', async (_e, path: string) => {
    await previewFile(String(path ?? ''), (p) => openPreviewWindow(p));
  });
  // P3-7：渲染层"未选中文件"时会以 '' 调用 —— 返回一个空预览而不是抛错，
  // 避免 Electron 打出 "Error occurred in handler for 'boxes:preview-data'" 的噪音日志
  ipcMain.handle('boxes:preview-data', (_e, path: string) => {
    const p = String(path ?? '');
    if (!p) {
      return { name: '（未选择文件）', path: '', kind: 'other', mime: 'application/octet-stream', size: 0, mtime: 0 };
    }
    return previewData(p);
  });
  ipcMain.handle('boxes:stack', (_e, boxId: string, path: string, stackName: string | null) =>
    stackItem(String(boxId ?? ''), String(path ?? ''), stackName == null ? null : String(stackName))
  );
  ipcMain.handle('boxes:auto-stack', (_e, boxId: string) => autoStack(String(boxId ?? '')));
  ipcMain.handle('boxes:set-capsule', (_e, id: string, capsule: boolean) => setCapsule(String(id ?? ''), Boolean(capsule)));
  ipcMain.on('boxes:capsule-hover', (_e, id: string, hovering: boolean) => {
    capsuleHover(String(id ?? ''), Boolean(hovering));
  });
  // 拖入文件：由 preload 捕获 drop 事件并发送（仅收纳盒窗口有效）
  ipcMain.on('boxes:drop', (e, paths: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const boxId = win ? windowBoxId(win) : null;
    if (!boxId || !Array.isArray(paths)) return;
    const valid = paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (valid.length) void addPaths(boxId, valid);
  });
}
