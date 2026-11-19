import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getAppDataPath, getSafeStorage } from '../runtimeBus';

const ENC_V1_PREFIX = 'enc:v1:';
const APP_VAULT_SALT = 'RetroTunes-rTunes-AES-256-GCM-Vault-v1';

let cachedKeySignature = '';
let cachedMasterKey: Buffer | null = null;

function resolveMasterKey(): Buffer {
  const envSecret = (process.env.RTUNES_SECRET_KEY || '').trim();
  const dataDir = getAppDataPath();
  const safeStorage = getSafeStorage();
  const safeStorageAvail = Boolean(safeStorage?.isEncryptionAvailable?.());
  const sig = `${envSecret}|${dataDir}|${safeStorageAvail ? 'safe:1' : 'safe:0'}`;

  if (cachedMasterKey && cachedKeySignature === sig) {
    return cachedMasterKey;
  }

  // 1. Explicit RTUNES_SECRET_KEY environment variable
  if (envSecret) {
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(envSecret)) {
      key = Buffer.from(envSecret, 'hex');
    } else {
      key = crypto.scryptSync(envSecret, APP_VAULT_SALT, 32);
    }
    cachedKeySignature = sig;
    cachedMasterKey = key;
    return key;
  }

  fs.mkdirSync(dataDir, { recursive: true });

  // 2. Desktop Electron safeStorage wrapped key (.rtunes.key.enc)
  if (safeStorageAvail && safeStorage) {
    const encKeyPath = path.join(dataDir, '.rtunes.key.enc');
    try {
      if (fs.existsSync(encKeyPath)) {
        const encBuf = fs.readFileSync(encKeyPath);
        const hexStr = safeStorage.decryptString(encBuf).trim();
        if (/^[0-9a-fA-F]{64}$/.test(hexStr)) {
          const key = Buffer.from(hexStr, 'hex');
          cachedKeySignature = sig;
          cachedMasterKey = key;
          return key;
        }
      }
      const rawKey = crypto.randomBytes(32);
      const wrapped = safeStorage.encryptString(rawKey.toString('hex'));
      fs.writeFileSync(encKeyPath, wrapped, { mode: 0o600 });
      cachedKeySignature = sig;
      cachedMasterKey = rawKey;
      return rawKey;
    } catch {
      // fall through to headless file fallback if safeStorage throws
    }
  }

  // 3. Headless zero-config fallback (.rtunes.key with 0o600 permissions)
  const rawKeyPath = path.join(dataDir, '.rtunes.key');
  try {
    if (fs.existsSync(rawKeyPath)) {
      const content = fs.readFileSync(rawKeyPath, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(content)) {
        const key = Buffer.from(content, 'hex');
        cachedKeySignature = sig;
        cachedMasterKey = key;
        return key;
      }
      const rawBuf = fs.readFileSync(rawKeyPath);
      if (rawBuf.length === 32) {
        cachedKeySignature = sig;
        cachedMasterKey = rawBuf;
        return rawBuf;
      }
    }
  } catch {
    // regenerate if unreadable
  }

  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(rawKeyPath, newKey.toString('hex'), { mode: 0o600 });
  try {
    fs.chmodSync(rawKeyPath, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
  cachedKeySignature = sig;
  cachedMasterKey = newKey;
  return newKey;
}

export function isEncryptedSecret(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(ENC_V1_PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  if (isEncryptedSecret(plaintext)) {
    return plaintext;
  }
  const key = resolveMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_V1_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!isEncryptedSecret(stored)) {
    return stored;
  }
  try {
    const payload = stored.slice(ENC_V1_PREFIX.length);
    const parts = payload.split(':');
    if (parts.length !== 3) return '';
    const [ivB64, tagB64, cipherB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(cipherB64, 'base64');
    if (iv.length !== 12 || authTag.length !== 16) return '';

    const key = resolveMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}
