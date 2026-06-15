/**
 * Tests for the AES-256-GCM encryption helpers: round-trip, fresh IV per call,
 * tamper detection, wrong/unknown key version, and key rotation.
 *
 * Env (two distinct 32-byte hex keys) is set before importing the module so the
 * registry holds both v1 and v2.
 */
import { describe, it, expect } from 'vitest';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['ENC_KEY_V1'] = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env['ENC_KEY_V2'] = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
process.env['ENC_ACTIVE_KEY_VERSION'] = 'v1';

const { encrypt, decrypt, decryptToString } = await import('../shared/crypto/tokenCrypto.js');

describe('tokenCrypto', () => {
  it('round-trips a string under the active key version', () => {
    const blob = encrypt('ghp_example_oauth_token');
    expect(blob.keyVersion).toBe('v1');
    expect(decryptToString(blob)).toBe('ghp_example_oauth_token');
  });

  it('uses a fresh IV per call so the same plaintext yields different ciphertext', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(decryptToString(a)).toBe('same');
    expect(decryptToString(b)).toBe('same');
  });

  it('fails closed when the ciphertext is tampered', () => {
    const blob = encrypt('tamper-me');
    blob.ciphertext.writeUInt8((blob.ciphertext.readUInt8(0) + 1) % 256, 0);
    expect(() => decrypt(blob)).toThrow();
  });

  it('fails closed when the auth tag is tampered', () => {
    const blob = encrypt('tamper-tag');
    blob.authTag.writeUInt8((blob.authTag.readUInt8(0) + 1) % 256, 0);
    expect(() => decrypt(blob)).toThrow();
  });

  it('fails to decrypt under the wrong key version', () => {
    const blob = encrypt('mismatch', 'v1');
    expect(() => decrypt({ ...blob, keyVersion: 'v2' })).toThrow();
  });

  it('throws on an unknown key version', () => {
    const blob = encrypt('x');
    expect(() => decrypt({ ...blob, keyVersion: 'v9' })).toThrow();
  });

  it('supports rotation: data under either version decrypts via its stored version', () => {
    const v1 = encrypt('rotate', 'v1');
    const v2 = encrypt('rotate', 'v2');
    expect(v1.keyVersion).toBe('v1');
    expect(v2.keyVersion).toBe('v2');
    expect(decryptToString(v1)).toBe('rotate');
    expect(decryptToString(v2)).toBe('rotate');
  });
});
