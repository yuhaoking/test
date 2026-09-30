import { ipcMain } from 'electron';
import { hotkeyList, resetHotkeys, setHotkey } from '../services/hotkeyManager';
import { applySettingsSideEffects } from './moduleIpc';
import type { AppSettings, HotkeyAction } from '../../shared/types';

type HotkeyField =
  | 'hotkey'
  | 'paletteHotkey'
  | 'deskboardHotkey'
  | 'clipboardHotkey'
  | 'captureHotkey'
  | 'pinHotkey'
  | 'translateHotkey'
  | 'ocrHotkey';

function fieldOf(action: HotkeyAction): HotkeyField {
  switch (action) {
    case 'sidebar':
      return 'hotkey';
    case 'palette':
      return 'paletteHotkey';
    case 'deskboard':
      return 'deskboardHotkey';
    case 'clipboard':
      return 'clipboardHotkey';
    case 'capture':
      return 'captureHotkey';
    case 'pin':
      return 'pinHotkey';
    case 'translate':
      return 'translateHotkey';
    case 'ocr':
      return 'ocrHotkey';
  }
}

/** 全局快捷键管理 IPC（SY-02：统一修改立即生效 / 冲突检测 / 一键重置） */
export function registerHotkeysIpc(): void {
  ipcMain.handle('hotkeys:list', () => hotkeyList());
  ipcMain.handle('hotkeys:set', (_e, action: HotkeyAction, accelerator: string) => {
    // P3 加固：action 必须属于已知热键项，accelerator 必须是非空字符串（此前可写入 "undefined" 键）
    const known: HotkeyAction[] = [
      'sidebar',
      'palette',
      'deskboard',
      'clipboard',
      'capture',
      'pin',
      'translate',
      'ocr'
    ];
    if (!known.includes(action)) throw new Error(`未知热键项：${String(action)}`);
    const acc = String(accelerator ?? '').trim();
    if (!acc) throw new Error('热键不能为空（可点击“恢复默认”）');
    const list = setHotkey(action, acc);
    applySettingsSideEffects({ [fieldOf(action)]: acc } as Partial<AppSettings>);
    return list;
  });
  ipcMain.handle('hotkeys:reset', () => {
    const list = resetHotkeys();
    const patch: Partial<AppSettings> = {};
    for (const f of [
      'hotkey',
      'paletteHotkey',
      'deskboardHotkey',
      'clipboardHotkey',
      'captureHotkey',
      'pinHotkey',
      'translateHotkey',
      'ocrHotkey'
    ] as HotkeyField[]) {
      patch[f] = list.find((x) => x.action === fieldToAction(f))?.accelerator;
    }
    applySettingsSideEffects(patch);
    return list;
  });
}

function fieldToAction(f: HotkeyField): HotkeyAction {
  switch (f) {
    case 'hotkey':
      return 'sidebar';
    case 'paletteHotkey':
      return 'palette';
    case 'deskboardHotkey':
      return 'deskboard';
    case 'clipboardHotkey':
      return 'clipboard';
    case 'captureHotkey':
      return 'capture';
    case 'pinHotkey':
      return 'pin';
    case 'translateHotkey':
      return 'translate';
    case 'ocrHotkey':
      return 'ocr';
  }
}
