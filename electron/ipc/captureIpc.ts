import { BrowserWindow, ipcMain } from 'electron';
import {
  copyImage,
  createPinWindowFromFile,
  cursorPos,
  handleCancel,
  handlePickRegion,
  longFinish,
  longStep,
  longStop,
  pinClipboardImage,
  pinImage,
  saveImage,
  startColorPicker,
  startFullCapture,
  startLongCapture,
  startRegionCapture
} from '../services/captureManager';
import { pinOpFor } from '../windows/captureWindows';
import type { CaptureRect } from '../../shared/types';

/** 截图增强 IPC（T-04：贴图 / 标注 / 长截图 / 取色器） */
export function registerCaptureIpc(): void {
  ipcMain.handle('capture:region', () => startRegionCapture());
  ipcMain.handle('capture:full', () => startFullCapture());
  ipcMain.handle('capture:long', () => startLongCapture());
  ipcMain.handle('capture:color-picker', () => startColorPicker());
  ipcMain.handle('capture:pin-clipboard', () => pinClipboardImage());
  ipcMain.handle('capture:pin-file', (_e, path: string) => createPinWindowFromFile(String(path)));
  ipcMain.handle('capture:pick-region', (_e, rect: CaptureRect) => handlePickRegion(rect));
  ipcMain.on('capture:cancel', () => handleCancel());
  ipcMain.handle('capture:cursor', () => cursorPos());

  ipcMain.handle('capture:copy-image', (_e, dataUrl: string) => copyImage(String(dataUrl)));
  ipcMain.handle('capture:save-image', (_e, dataUrl: string) => saveImage(String(dataUrl)));
  ipcMain.handle('capture:pin-image', (_e, dataUrl: string) => pinImage(String(dataUrl)));

  ipcMain.handle('capture:pin-op', (e, op: string, value?: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) pinOpFor(win, op, value);
  });

  ipcMain.handle('capture:long-step', (_e, autoScroll: boolean) => longStep(Boolean(autoScroll)));
  ipcMain.on('capture:long-stop', () => longStop());
  ipcMain.handle('capture:long-finish', (_e, segments: string[]) =>
    longFinish(Array.isArray(segments) ? segments.map(String) : [])
  );
  // 标注器 / 长截图控制条：关闭调用方自身窗口
  ipcMain.on('capture:self-close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) win.close();
  });
}
