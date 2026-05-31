import { parseSiweMessage } from 'viem/siwe';
import { recoverMessageAddress, isAddressEqual, getAddress, type Address } from 'viem';
import { env } from '../config/env.js';

// The dapp domain SIWE messages must bind to — the frontend origin's host.
const expectedDomain = new URL(env.CORS_ORIGIN).host;

export class SiweError extends Error {}

export interface VerifiedSiwe {
  address: Address; // checksummed
}

/**
 * Verify an EIP-4361 (SIWE) message + signature for an EOA wallet: the domain and
 * server-issued nonce match, the validity window holds, and the signature recovers
 * to the address named in the message.
 */
export async function verifySiwe(
  message: string,
  signature: `0x${string}`,
  expectedNonce: string,
): Promise<VerifiedSiwe> {
  let fields: ReturnType<typeof parseSiweMessage>;
  try {
    fields = parseSiweMessage(message);
  } catch {
    throw new SiweError('Malformed SIWE message');
  }

  if (!fields.address || !fields.domain || !fields.nonce) {
    throw new SiweError('Malformed SIWE message');
  }
  if (fields.domain !== expectedDomain) {
    throw new SiweError('Unexpected SIWE domain');
  }
  if (fields.nonce !== expectedNonce) {
    throw new SiweError('Nonce mismatch');
  }

  const expiry = fields.expirationTime ? new Date(fields.expirationTime) : undefined;
  if (expiry && expiry.getTime() <= Date.now()) {
    throw new SiweError('SIWE message expired');
  }
  const notBefore = fields.notBefore ? new Date(fields.notBefore) : undefined;
  if (notBefore && notBefore.getTime() > Date.now()) {
    throw new SiweError('SIWE message not yet valid');
  }

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    throw new SiweError('Invalid signature');
  }
  if (!isAddressEqual(recovered, fields.address)) {
    throw new SiweError('Signature does not match address');
  }

  return { address: getAddress(fields.address) };
}
