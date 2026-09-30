import { app, ipcMain, Menu, screen } from 'electron';
import { getFrameSet, playAction, playRandomAction } from '../services/petManager';
import { petPluginClicked } from '../services/pluginManager';
import { t } from '../services/i18n';
import { toggleSidebar } from '../windows/sidebarWindow';
import { openSettingsWindow, closeSettingsWindow } from '../windows/settingsWindow';
import { petWindow, setPetSize } from '../windows/petWindow';

let dragOrigin: { winX: number; winY: number; cursorX: number; cursorY: number } | null = null;

export function registerPetIpc(): void {
  ipcMain.on('pet:clicked', () => {
    playRandomAction();
    petPluginClicked();
  });

  ipcMain.on('pet:double-clicked', () => {
    toggleSidebar();
  });

  ipcMain.on('pet:drag-start', () => {
    const win = petWindow();
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const [winX, winY] = win.getPosition();
    dragOrigin = { winX, winY, cursorX: cursor.x, cursorY: cursor.y };
  });

  ipcMain.on('pet:drag-move', () => {
    if (!dragOrigin) return;
    const win = petWindow();
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(
      dragOrigin.winX + (cursor.x - dragOrigin.cursorX),
      dragOrigin.winY + (cursor.y - dragOrigin.cursorY),
      false
    );
  });

  ipcMain.on('pet:drag-end', () => {
    dragOrigin = null;
  });

  ipcMain.on('pet:resize', (_e, width: number, height: number) => {
    // P3 加固：拒绝 NaN/负数/超范围尺寸（此前直接透传可把宠物窗口改成非法尺寸）
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 40 || h < 40 || w > 800 || h > 800) return;
    setPetSize(w, h);
  });

  ipcMain.handle('pet:get-frames', () => getFrameSet());

  // T-05/T-09：渲染层触发宠物动作（如待办完成庆祝 jump）
  ipcMain.handle('pet:play', (_e, action: string) => {
    if (['nod', 'wave', 'blink', 'jump'].includes(action)) playAction(action);
  });

  ipcMain.on('pet:context-menu', () => {
    Menu.buildFromTemplate([
      { label: t('pet.openSettings'), click: () => openSettingsWindow() },
      { type: 'separator' },
      {
        label: t('pet.chat'),
        click: () => {
          // T-05：AI 宠物对话面板（函数级动态 import 防循环）
          void import('../windows/chatWindow').then((m) => m.toggleChatWindow());
        }
      },
      {
        label: t('pet.toggleSidebar'),
        click: () => toggleSidebar()
      },
      {
        label: t('pet.quit'),
        click: () => {
          closeSettingsWindow();
          app.quit();
        }
      }
    ]).popup({ window: petWindow() ?? undefined });
  });
}
