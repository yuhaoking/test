import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { userDataDir } from '../store/dataStore';
import { logWarn } from './log';

/**
 * 本机密钥与对称加密工具（CH-03 / spec 5.4：可选加密存储）
 *
 * - AES-256-GCM；密钥保存于 userData/.secret.key（0600），首次使用时随机生成；
 * - 密文格式：'v1'(2B) + iv(12B) + tag(16B) + ciphertext；
 * - 仅用于剪贴板历史等本地隐私数据，不上传、不参与网络传输。
 */

const VERSION = 'v1';

let cachedKey: Buffer | null = null;

function keyFile(): string {
  return join(userDataDir(), '.secret.key');
}

/**
 * 读取（或首次生成）本机密钥。
 *
 * P2-18 修复：密钥文件存在但长度异常时，**绝不直接覆盖**——
 * 旧实现会生成新密钥写回同一路径，导致此前所有密文（剪贴板历史）永远解不开、
 * 并在下次启动时被静默丢弃。现在先把坏文件备份成 .secret.key.bad-<ts>.bak 再重建，
 * 至少在用户发现"历史读不出来"时还有恢复线索。
 *
 * 另注：Windows 上 writeFileSync 的 mode 0o600 不生效（POSIX 权限位被忽略），
 * 保护依赖「当前用户目录 ACL」本身；这一点在文档中如实说明，不做虚假承诺。
 */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const file = keyFile();
  try {
    if (existsSync(file)) {
      const buf = readFileSync(file);
      if (buf.length === 32) {
        cachedKey = buf;
        return cachedKey;
      }
      const backup = `${file}.bad-${Date.now()}.bak`;
      try {
        renameSync(file, backup);
        logWarn('[secrets] 密钥文件长度异常（期望 32 字节），已备份为', backup, '并重建密钥；此前的加密历史将无法解密');
      } catch (err) {
        logWarn('[secrets] 密钥文件异常且备份失败，使用会话临时密钥（不覆盖原文件）', err);
        cachedKey = randomBytes(32);
        return cachedKey;
      }
    }
    cachedKey = randomBytes(32);
    mkdirSync(userDataDir(), { recursive: true });
    writeFileSync(file, cachedKey, { mode: 0o600 });
  } catch (e) {
    logWarn('[secrets] 密钥文件读写失败，使用会话临时密钥', e);
    cachedKey = randomBytes(32);
  }
  return cachedKey;
}

export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from(VERSION, 'ascii'), iv, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(payload: Buffer): Buffer {
  if (payload.length < 2 + 12 + 16 || payload.subarray(0, 2).toString('ascii') !== VERSION) {
    throw new Error('密文格式不正确');
  }
  const iv = payload.subarray(2, 14);
  const tag = payload.subarray(14, 30);
  const ct = payload.subarray(30);
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptText(plain: string): string {
  return encryptBuffer(Buffer.from(plain, 'utf-8')).toString('base64');
}

export function decryptText(cipher: string): string {
  return decryptBuffer(Buffer.from(cipher, 'base64')).toString('utf-8');
}
