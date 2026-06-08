const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');

// 14-day refund window and a generous deployer mint, so a local maintainer has
// plenty of test USDC to fund bounties with.
const REFUND_WINDOW = 14n * 24n * 60n * 60n;
const DEPLOYER_MINT = 1_000_000n * 10n ** 6n; // 1,000,000 USDC (6 decimals)

// Deploy MockUSDC + BountyEscrow to whatever network this is run against, then
// write the addresses to deployments/<network>.json and print the api/.env lines.
// The second signer becomes the escrow's authorizedCaller — i.e. the backend hot
// wallet that the payout service must use to call release().
async function main() {
  const [deployer, backend] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  await usdc.waitForDeployment();
  await (await usdc.mint(deployer.address, DEPLOYER_MINT)).wait();

  const escrow = await (
    await ethers.getContractFactory('BountyEscrow')
  ).deploy(await usdc.getAddress(), backend.address, REFUND_WINDOW);
  await escrow.waitForDeployment();

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    usdc: await usdc.getAddress(),
    escrow: await escrow.getAddress(),
    authorizedCaller: backend.address,
    deployer: deployer.address,
    deployBlock: await ethers.provider.getBlockNumber(),
  };

  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), `${JSON.stringify(out, null, 2)}\n`);

  console.log('Deployed BountyEscrow + MockUSDC:', out);
  console.log('\nAdd these to api/.env:');
  console.log(`CHAIN_ID=${out.chainId}`);
  console.log(`ESCROW_ADDRESS=${out.escrow}`);
  console.log(`INDEXER_START_BLOCK=${out.deployBlock}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
