import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { userDataDir } from '../store/dataStore';
import { logDebug, logWarn } from '../utils/log';

/**
 * 剪贴板图片 OCR（CH-06）
 *
 * 复用现有 OCR 引擎（office-convert-all 同款 Tesseract 探测逻辑）：
 * 嵌入式 engines 目录优先，其次系统安装的 tesseract；未安装则跳过（不报错）。
 * 识别文本写回剪贴板历史条目，使其可被历史搜索命中。
 */

let tesseract: string | null | undefined;

function enginesDir(): string {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'engines') : join(app.getAppPath(), 'engines'),
    app.isPackaged
      ? join(process.resourcesPath, 'resources', 'engines')
      : join(app.getAppPath(), 'resources', 'engines'),
    join(userDataDir(), 'engines')
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return '';
}

export function findTesseract(): string | null {
  if (tesseract !== undefined) return tesseract;
  const engine = enginesDir();
  const candidates = [
    join(engine, 'bin', 'tesseract.exe'),
    join(engine, 'tesseract', 'tesseract.exe'),
    join(process.env['ProgramFiles'] ?? '', 'Tesseract-OCR', 'tesseract.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Tesseract-OCR', 'tesseract.exe')
  ];
  tesseract = candidates.find((p) => p && existsSync(p)) ?? null;
  return tesseract;
}

/** 识别图片中的文本（chi_sim+eng；失败返回空串） */
export function ocrImage(file: string): Promise<string> {
  const bin = findTesseract();
  if (!bin) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile(
      bin,
      [file, 'stdout', '-l', 'chi_sim+eng', '--psm', '3'],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          logDebug('[ocr] 识别失败', err.message);
          return resolve('');
        }
        const text = stdout.replace(/\s+/g, ' ').trim();
        if (text) logDebug('[ocr] 识别完成，长度', text.length);
        resolve(text.slice(0, 8000));
      }
    );
  });
}

/** OCR 引擎状态（设置页展示） */
export function ocrAvailable(): boolean {
  const ok = findTesseract() !== null;
  if (!ok) logWarn('[ocr] 未检测到 Tesseract，剪贴板图片 OCR 已跳过');
  return ok;
}
