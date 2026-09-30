import { ipcMain } from 'electron';
import { getWeather } from '../services/weather';
import { hideDeskboard, lastContextEvent } from '../windows/deskboardWindow';
import { captureContext, readClipboardContext } from '../services/contextCapture';
import { listContextActions, runContextAction, selectionBarCatalog, togglePin } from '../services/contextActions';
import type { ContextPayload } from '../../shared/types';

/** 工作台 IPC（T-14 / WK-01 ~ WK-04：上下文抓取 + 动作执行 + 固定） */
export function registerDeskboardIpc(): void {
  ipcMain.handle('weather:get', () => getWeather());
  ipcMain.on('deskboard:hide', () => hideDeskboard());

  // WK-01：主动抓取（呼出时主进程也会推送）；copyKey=false 时只读剪贴板
  ipcMain.handle('deskboard:capture-context', (_e, copyKey?: boolean) =>
    copyKey === false ? readClipboardContext() : captureContext({ copyKey: true })
  );
  // WK-02：动作清单与执行
  ipcMain.handle('deskboard:context-actions', (_e, payload: ContextPayload) =>
    listContextActions(payload ?? { type: 'none' })
  );
  ipcMain.handle('deskboard:run-action', (_e, id: string, payload: ContextPayload) =>
    runContextAction(String(id ?? ''), payload ?? { type: 'none' })
  );
  // WK-03：固定 / 取消固定
  ipcMain.handle('deskboard:pin-action', (_e, id: string, pinned: boolean) => togglePin(String(id ?? ''), Boolean(pinned)));
  // WK-07：划词动作条可选动作清单（设置页用）
  ipcMain.handle('deskboard:selection-catalog', () => selectionBarCatalog());
  // 渲染层挂载/重载时补齐最近一次上下文（推送可能早于监听注册）
  ipcMain.handle('deskboard:last-context', () => lastContextEvent());
}
