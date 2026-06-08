require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

// Local-only configuration: the in-process Hardhat network is enough to compile
// and test BountyEscrow. The Arbitrum Sepolia deploy target is added in a later
// issue once a funded signer and an RPC URL exist.
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
  },
};
