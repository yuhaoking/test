import { ipcMain } from 'electron';
import { realpathSync, readFileSync } from 'fs';
import { dataStore, isPathAllowed } from '../store/dataStore';
import type { AssetData } from '../../shared/types';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;

export function normalizePath(p: string): string {
  if (!p) return p;
  let out = p;
  if (/^file:\/\//i.test(out)) {
    try {
      out = decodeURIComponent(new URL(out).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
    } catch {
      out = out.replace(/^file:\/\//i, '');
    }
  }
  return out.replace(/\//g, '\\');
}

/** 用户显式挑选过的图片（宠物形象）：允许在白名单外读取，但只限这些具体文件 + 图片扩展名 */
function userPickedAssets(): string[] {
  try {
    const s = dataStore().get().settings;
    return [s.petImage].filter(Boolean) as string[];
  } catch {
    return [];
  }
}

function realpathOf(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function readAsset(p: string): AssetData {
  const path = normalizePath(p);
  /*
   * P3-7：空路径要给出**明确**的早退错误。
   * 渲染层在"没有图标/没有文件"时会以 '' 调用 asset:to-url，旧实现会走完 realpath 再抛
   * 「文件不存在或不可读」，在日志里留下 "Error occurred in handler for 'asset:to-url'" 噪音，
   * 让人误以为真出了问题。这里直接给出可读原因，且不产生"异常"观感。
   */
  // 渲染层在"没有图标/没有文件"时会以 '' 调用 asset:read：给出明确原因即可（调用方必须处理失败）
  if (!path) throw new Error('路径为空');
  // P1-3 修复：先解析真实路径（realpath 折叠 .. 与符号链接），再做白名单判断；
  // 同时取消“图片扩展名直接放行”的旁路——图片同样必须落在允许范围内（或为用户挑选的文件）
  const real = realpathOf(path);
  if (!real) throw new Error('文件不存在或不可读');
  const allowedByRoot = isPathAllowed(real);
  const allowedByPick =
    IMAGE_EXT.test(real) &&
    userPickedAssets().some((picked) => {
      const pickedReal = realpathOf(normalizePath(picked));
      return pickedReal !== null && pickedReal.toLowerCase() === real.toLowerCase();
    });
  if (!allowedByRoot && !allowedByPick) throw new Error('路径不在允许范围内');
  const ext = real.slice(real.lastIndexOf('.')).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  return { data: readFileSync(real).toString('base64'), mime };
}

export function registerAssetIpc(): void {
  ipcMain.handle('asset:read', (_e, p: string) => {
    return readAsset(p);
  });
  ipcMain.handle('asset:to-url', (_e, p: string) => {
    /*
     * P3-7：渲染层在"该条目没有图标/没有文件"时会以 '' 调用本通道。
     * 旧实现让它走完 realpath 再抛错，于是 Electron 打出
     * "Error occurred in handler for 'asset:to-url'"——日志里看着像出了故障，
     * 实际只是"没有图标"。空路径直接返回空串，语义清晰且无噪音。
     */
    if (!normalizePath(p)) return '';
    const { data, mime } = readAsset(p);
    return `data:${mime};base64,${data}`;
  });
}
