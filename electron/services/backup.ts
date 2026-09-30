/**
 * 设置备份 / 恢复 + 一键诊断包（T-11 数据资产与信任）
 *
 * - 导出设置备份：settings JSON 一键导出（含版本戳）；
 * - 导入恢复：校验 JSON 后合并写回并重放系统副作用（热键/托盘/自启等）；
 * - 一键诊断包：环境信息 + 隐私过滤日志（spec 5.4）导出。
 */

import { app, dialog, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import { dataStore } from '../store/dataStore';
import { listBoxes } from './desktopBoxes';
import { buildDiagReport, redact } from '../utils/log';
import type { AppSettings } from '../../shared/types';

interface BackupFile {
  app?: string;
  version?: number;
  exportedAt?: string;
  settings?: Partial<AppSettings>;
}

/** 导出设置备份（JSON），返回保存路径；取消返回 null */
export async function exportSettingsBackup(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const stamp = new Date().toISOString().slice(0, 10);
  const ret = await dialog.showSaveDialog(win ?? undefined, {
    title: '导出设置备份',
    defaultPath: `xiaopeng-settings-${stamp}.json`,
    filters: [{ name: 'JSON 设置备份', extensions: ['json'] }]
  });
  if (ret.canceled || !ret.filePath) return null;
  const payload: BackupFile = {
    app: 'xiaopeng-toolbox',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: dataStore().get().settings
  };
  writeFileSync(ret.filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return ret.filePath;
}

/** 导入设置备份：返回合并后的设置；取消/格式错误返回 null（错误由调用方提示） */
export async function importSettingsBackup(): Promise<AppSettings | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const ret = await dialog.showOpenDialog(win ?? undefined, {
    title: '导入设置备份',
    filters: [{ name: 'JSON 设置备份', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (ret.canceled || !ret.filePaths[0]) return null;
  // SVC-1 修复：解析失败给出可读提示（此前 JSON.parse 无 try，坏文件直接抛栈）
  let parsed: BackupFile;
  try {
    // P2-8：先剥离 UTF-8 BOM——用记事本"另存为 UTF-8"会把 BOM 写进文件，
    // 直接 JSON.parse 会失败并提示"不是有效的 JSON 文件"，把用户引向错误方向。
    // 项目其它 JSON 读取处（db.ts / dataStore.ts）早已如此处理。
    parsed = JSON.parse(readFileSync(ret.filePaths[0], 'utf-8').replace(/^\uFEFF/, '')) as BackupFile;
  } catch {
    throw new Error('设置备份不是有效的 JSON 文件（若为记事本保存，请另存为 UTF-8 无 BOM）');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !parsed.settings ||
    typeof parsed.settings !== 'object' ||
    Array.isArray(parsed.settings)
  ) {
    throw new Error('设置备份格式不正确（缺少 settings 字段）');
  }
  // P1-4 配套：settings 的具体字段由 sanitizeSettingsPatch 逐项校验/夹取，
  // 被手工改坏或来自其它版本的键会在这里被丢弃，不会污染运行时。
  dataStore().updateSettings(parsed.settings);
  return dataStore().get().settings;
}

/** 导出诊断包（脱敏日志 + 环境信息），返回保存路径；取消返回 null */
export async function exportDiagBundle(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const stamp = new Date().toISOString().slice(0, 10);
  const ret = await dialog.showSaveDialog(win ?? undefined, {
    title: '导出诊断包（日志已脱敏）',
    defaultPath: `xiaopeng-diag-${stamp}.txt`,
    filters: [{ name: '文本', extensions: ['txt'] }]
  });
  if (ret.canceled || !ret.filePath) return null;
  const data = dataStore().get();
  const report = buildDiagReport({
    数据目录: app.getPath('userData'),
    模块数: data.modules.length,
    收纳盒数: listBoxes().length,
    剪贴板加密: data.settings.clipboardEncrypt ? '开' : '关',
    托盘常驻: data.settings.trayEnabled ? '开' : '关'
  });
  writeFileSync(ret.filePath, redact(report), 'utf-8');
  return ret.filePath;
}
