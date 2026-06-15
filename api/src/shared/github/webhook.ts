import { createHmac, timingSafeEqual } from 'crypto';
import { decryptFromBufferToString } from '../crypto/tokenCrypto.js';
import type { Repo } from '../models/index.js';

const SIGNATURE_PREFIX = 'sha256=';
// A rotated-out secret stays valid for this long so deliveries already in flight
// when the secret changed still verify.
const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Constant-time check that the X-Hub-Signature-256 header ("sha256=<hex>") is a
 * valid HMAC-SHA256 of the raw body under `secret`. Returns false (never throws)
 * for a missing prefix, malformed hex or a length mismatch.
 */
export function verifyHmacSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  // Buffer.from(..., 'hex') never throws; bad hex yields a short buffer, which
  // then fails the length check below.
  const provided = Buffer.from(signatureHeader.slice(SIGNATURE_PREFIX.length), 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Verify a delivery against a repo's stored secrets. Tries the current secret
 * first, then the previous secret if a rotation is still inside the 24h window.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  repo: Pick<
    Repo,
    | 'webhookSecretCurrent'
    | 'webhookSecretPrevious'
    | 'webhookSecretRotatedAt'
    | 'webhookKeyVersion'
  >,
): boolean {
  const current = decryptFromBufferToString(repo.webhookSecretCurrent, repo.webhookKeyVersion);
  if (verifyHmacSignature(rawBody, signatureHeader, current)) return true;

  if (repo.webhookSecretPrevious && repo.webhookSecretRotatedAt) {
    const withinWindow = Date.now() - repo.webhookSecretRotatedAt.getTime() < ROTATION_WINDOW_MS;
    if (withinWindow) {
      const previous = decryptFromBufferToString(
        repo.webhookSecretPrevious,
        repo.webhookKeyVersion,
      );
      if (verifyHmacSignature(rawBody, signatureHeader, previous)) return true;
    }
  }
  return false;
}
