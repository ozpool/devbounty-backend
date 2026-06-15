require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@nomicfoundation/hardhat-verify');

// The in-process Hardhat network compiles and tests BountyEscrow; `localhost`
// targets a standalone node; `arbitrumSepolia` is the testnet deploy target.
// Network secrets (RPC URL, deployer key) come from the environment so nothing
// sensitive is committed — set ARB_SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY
// before running `npm run deploy:arb-sepolia`.
const ARB_SEPOLIA_RPC_URL = process.env.ARB_SEPOLIA_RPC_URL || '';
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || '';
// Etherscan-family API key for source verification on Arbiscan. A single
// multichain key from etherscan.io covers Arbitrum Sepolia.
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.30',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks: {
    // Target for `npm run deploy:local` — the standalone node from `hardhat node`.
    // Its accounts and chain id (31337) are provided by that node, not configured here.
    localhost: {
      url: 'http://127.0.0.1:8545',
    },
    // Arbitrum Sepolia testnet (chain id 421614).
    arbitrumSepolia: {
      url: ARB_SEPOLIA_RPC_URL,
      chainId: 421614,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  // Source verification on Arbiscan goes through the Etherscan API family.
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
};
