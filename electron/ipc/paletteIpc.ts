import { ipcMain } from 'electron';
import { executeResult, listAliasTargets, search } from '../services/paletteSearch';
import { hidePalette } from '../windows/paletteWindow';
import type { PaletteResult } from '../../shared/types';

export function registerPaletteIpc(): void {
  ipcMain.handle('palette:search', (_e, query: string) => search(query));
  ipcMain.handle('palette:execute', (_e, result: PaletteResult, openFolder?: boolean) =>
    executeResult(result, Boolean(openFolder))
  );
  ipcMain.on('palette:hide', () => hidePalette());
  // T-14（AL-02）：别名管理页的目标清单
  ipcMain.handle('palette:targets', () => listAliasTargets());
}
