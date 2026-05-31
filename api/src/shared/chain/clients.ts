import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  getAddress,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { env } from '../config/env.js';

// Built from CHAIN_ID/RPC rather than a hardcoded chain so the same code runs
// against Arbitrum Sepolia and a local node.
function buildChain() {
  return defineChain({
    id: env.CHAIN_ID,
    name: `chain-${env.CHAIN_ID}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL_HTTP] } },
  });
}

let publicClient: PublicClient | undefined;
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: buildChain(), transport: http(env.RPC_URL_HTTP) });
  }
  return publicClient;
}

/** The deployed escrow address, validated. Throws if unset/malformed. */
export function getEscrowAddress(): Address {
  const raw = env.ESCROW_ADDRESS;
  if (!raw || !isAddress(raw)) {
    throw new Error('ESCROW_ADDRESS is not set to a valid address');
  }
  return getAddress(raw);
}

let walletAccount: PrivateKeyAccount | undefined;
function getWalletAccount(): PrivateKeyAccount {
  if (!walletAccount) {
    const key = env.BACKEND_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('BACKEND_PRIVATE_KEY is not set to a 32-byte hex key');
    }
    walletAccount = privateKeyToAccount(key as `0x${string}`);
  }
  return walletAccount;
}

let walletClient: WalletClient | undefined;
export function getWalletClient(): WalletClient {
  if (!walletClient) {
    walletClient = createWalletClient({
      account: getWalletAccount(),
      chain: buildChain(),
      transport: http(env.RPC_URL_HTTP),
    });
  }
  return walletClient;
}

/** True when both a signer and an escrow address are configured for releasing. */
export function isPayoutConfigured(): boolean {
  return (
    Boolean(env.BACKEND_PRIVATE_KEY) &&
    Boolean(env.ESCROW_ADDRESS) &&
    isAddress(env.ESCROW_ADDRESS ?? '')
  );
}

/** True when the indexer has an escrow address to watch. */
export function isIndexerConfigured(): boolean {
  return Boolean(env.ESCROW_ADDRESS) && isAddress(env.ESCROW_ADDRESS ?? '');
}
