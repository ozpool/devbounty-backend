import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { env } from '../config/env.js';

// AES-256-GCM: a 32-byte key, a fresh 12-byte IV per message, and a 16-byte auth
// tag that makes any tampering fail closed on decrypt.
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string; // which key encrypted this — lets us rotate without losing old data
}

function decodeKey(version: string, hex: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key "${version}" must be ${KEY_BYTES} bytes of hex`);
  }
  return key;
}

// Build the version -> key registry once from the validated env.
function buildRegistry(): Map<string, Buffer> {
  const registry = new Map<string, Buffer>();
  registry.set('v1', decodeKey('v1', env.ENC_KEY_V1));
  if (env.ENC_KEY_V2) registry.set('v2', decodeKey('v2', env.ENC_KEY_V2));
  return registry;
}

const keyRegistry = buildRegistry();

if (!keyRegistry.has(env.ENC_ACTIVE_KEY_VERSION)) {
  throw new Error(`ENC_ACTIVE_KEY_VERSION "${env.ENC_ACTIVE_KEY_VERSION}" has no matching key`);
}

function keyFor(version: string): Buffer {
  const key = keyRegistry.get(version);
  if (!key) throw new Error(`No encryption key for version "${version}"`);
  return key;
}

/**
 * Encrypt plaintext under a key version (defaults to the active version).
 * The explicit version is used by rotation flows that re-encrypt old data.
 */
export function encrypt(
  plaintext: string | Buffer,
  keyVersion: string = env.ENC_ACTIVE_KEY_VERSION,
): EncryptedBlob {
  const key = keyFor(keyVersion);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
}

/** Decrypt a blob using the key named by its own keyVersion. Throws on tamper. */
export function decrypt(blob: EncryptedBlob): Buffer {
  const key = keyFor(blob.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, key, blob.iv);
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
}

export function decryptToString(blob: EncryptedBlob): string {
  return decrypt(blob).toString('utf8');
}
