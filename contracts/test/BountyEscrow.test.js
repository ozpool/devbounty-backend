const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');

const REFUND_WINDOW = 14n * 24n * 60n * 60n; // 14 days, in seconds
const AMOUNT = 1000n * 10n ** 6n; // 1,000 USDC (6 decimals)
const ID = ethers.id('bounty-1');
const SHA = ethers.id('merge-commit-sha'); // a bytes32 stand-in

// Enum Status { None, Open, Paid, Refunded }
const Status = { None: 0, Open: 1, Paid: 2, Refunded: 3 };

async function deployFixture() {
  const [owner, maintainer, hunter, caller, other] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  await usdc.mint(maintainer.address, AMOUNT * 10n);

  const escrow = await (
    await ethers.getContractFactory('BountyEscrow')
  ).deploy(usdc.target, caller.address, REFUND_WINDOW);

  await usdc.connect(maintainer).approve(escrow.target, AMOUNT * 10n);
  return { owner, maintainer, hunter, caller, other, usdc, escrow };
}

async function createBounty(escrow, maintainer, id = ID, amount = AMOUNT) {
  return escrow.connect(maintainer).create(id, amount);
}

describe('BountyEscrow', () => {
  describe('deployment', () => {
    it('records usdc, authorized caller, refund window and owner', async () => {
      const { escrow, usdc, caller, owner } = await loadFixture(deployFixture);
      expect(await escrow.usdc()).to.equal(usdc.target);
      expect(await escrow.authorizedCaller()).to.equal(caller.address);
      expect(await escrow.defaultRefundWindow()).to.equal(REFUND_WINDOW);
      expect(await escrow.owner()).to.equal(owner.address);
    });
  });

  describe('create', () => {
    it('escrows the funds, stores the bounty and emits BountyCreated', async () => {
      const { escrow, usdc, maintainer } = await loadFixture(deployFixture);
      await expect(createBounty(escrow, maintainer))
        .to.emit(escrow, 'BountyCreated')
        .withArgs(ID, maintainer.address, AMOUNT, REFUND_WINDOW);

      expect(await usdc.balanceOf(escrow.target)).to.equal(AMOUNT);
      const b = await escrow.bounties(ID);
      expect(b.maintainer).to.equal(maintainer.address);
      expect(b.amount).to.equal(AMOUNT);
      expect(b.refundWindow).to.equal(REFUND_WINDOW);
      expect(Number(b.status)).to.equal(Status.Open);
    });

    it('reverts on a zero amount', async () => {
      const { escrow, maintainer } = await loadFixture(deployFixture);
      await expect(createBounty(escrow, maintainer, ID, 0n)).to.be.revertedWithCustomError(
        escrow,
        'ZeroAmount',
      );
    });

    it('reverts on an amount that overflows uint96', async () => {
      const { escrow, maintainer } = await loadFixture(deployFixture);
      await expect(createBounty(escrow, maintainer, ID, 2n ** 96n)).to.be.revertedWithCustomError(
        escrow,
        'AmountTooLarge',
      );
    });

    it('reverts on a duplicate id', async () => {
      const { escrow, maintainer } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await expect(createBounty(escrow, maintainer)).to.be.revertedWithCustomError(
        escrow,
        'BountyExists',
      );
    });
  });

  describe('release', () => {
    it('pays the hunter and emits BountyReleased', async () => {
      const { escrow, usdc, maintainer, hunter, caller } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);

      await expect(escrow.connect(caller).release(ID, hunter.address, SHA))
        .to.emit(escrow, 'BountyReleased')
        .withArgs(ID, hunter.address, AMOUNT, SHA);

      expect(await usdc.balanceOf(hunter.address)).to.equal(AMOUNT);
      expect(await usdc.balanceOf(escrow.target)).to.equal(0n);
      expect(Number((await escrow.bounties(ID)).status)).to.equal(Status.Paid);
    });

    it('reverts when the caller is not the authorized backend wallet', async () => {
      const { escrow, maintainer, hunter, other } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await expect(
        escrow.connect(other).release(ID, hunter.address, SHA),
      ).to.be.revertedWithCustomError(escrow, 'NotAuthorized');
    });

    it('reverts on a second release of the same bounty', async () => {
      const { escrow, maintainer, hunter, caller } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await escrow.connect(caller).release(ID, hunter.address, SHA);
      await expect(
        escrow.connect(caller).release(ID, hunter.address, SHA),
      ).to.be.revertedWithCustomError(escrow, 'BountyNotOpen');
    });

    it('reverts for an unknown bounty', async () => {
      const { escrow, hunter, caller } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(caller).release(ethers.id('nope'), hunter.address, SHA),
      ).to.be.revertedWithCustomError(escrow, 'BountyNotOpen');
    });
  });

  describe('refund', () => {
    it('reverts before the refund window elapses', async () => {
      const { escrow, maintainer } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await expect(escrow.connect(maintainer).refund(ID)).to.be.revertedWithCustomError(
        escrow,
        'RefundTooEarly',
      );
    });

    it('returns the funds to the maintainer once the window passes', async () => {
      const { escrow, usdc, maintainer } = await loadFixture(deployFixture);
      const before = await usdc.balanceOf(maintainer.address);
      await createBounty(escrow, maintainer);
      await time.increase(REFUND_WINDOW + 1n);

      await expect(escrow.connect(maintainer).refund(ID))
        .to.emit(escrow, 'BountyRefunded')
        .withArgs(ID, AMOUNT);

      expect(await usdc.balanceOf(maintainer.address)).to.equal(before);
      expect(await usdc.balanceOf(escrow.target)).to.equal(0n);
      expect(Number((await escrow.bounties(ID)).status)).to.equal(Status.Refunded);
    });

    it('reverts when a non-maintainer tries to refund', async () => {
      const { escrow, maintainer, other } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await time.increase(REFUND_WINDOW + 1n);
      await expect(escrow.connect(other).refund(ID)).to.be.revertedWithCustomError(
        escrow,
        'NotMaintainer',
      );
    });

    it('reverts when the bounty was already paid', async () => {
      const { escrow, maintainer, hunter, caller } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await escrow.connect(caller).release(ID, hunter.address, SHA);
      await time.increase(REFUND_WINDOW + 1n);
      await expect(escrow.connect(maintainer).refund(ID)).to.be.revertedWithCustomError(
        escrow,
        'BountyNotOpen',
      );
    });
  });

  describe('admin', () => {
    it('rotates the authorized caller (owner only) and emits', async () => {
      const { escrow, owner, caller, other } = await loadFixture(deployFixture);
      await expect(escrow.connect(owner).setAuthorizedCaller(other.address))
        .to.emit(escrow, 'AuthorizedCallerSet')
        .withArgs(caller.address, other.address);
      expect(await escrow.authorizedCaller()).to.equal(other.address);
    });

    it('lets only the new caller release after a rotation', async () => {
      const { escrow, owner, maintainer, hunter, caller, other } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await escrow.connect(owner).setAuthorizedCaller(other.address);

      await expect(
        escrow.connect(caller).release(ID, hunter.address, SHA),
      ).to.be.revertedWithCustomError(escrow, 'NotAuthorized');
      await expect(escrow.connect(other).release(ID, hunter.address, SHA)).to.emit(
        escrow,
        'BountyReleased',
      );
    });

    it('rejects a non-owner changing admin settings', async () => {
      const { escrow, other } = await loadFixture(deployFixture);
      await expect(escrow.connect(other).setAuthorizedCaller(other.address))
        .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
      await expect(escrow.connect(other).setDefaultRefundWindow(1n))
        .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
        .withArgs(other.address);
    });

    it('snapshots the refund window so a later change does not move an existing bounty', async () => {
      const { escrow, owner, maintainer } = await loadFixture(deployFixture);
      await createBounty(escrow, maintainer);
      await escrow.connect(owner).setDefaultRefundWindow(REFUND_WINDOW * 2n);
      expect((await escrow.bounties(ID)).refundWindow).to.equal(REFUND_WINDOW);
      expect(await escrow.defaultRefundWindow()).to.equal(REFUND_WINDOW * 2n);
    });
  });

  describe('ownership (Ownable2Step)', () => {
    it('only transfers ownership after the new owner accepts', async () => {
      const { escrow, owner, other } = await loadFixture(deployFixture);
      await escrow.connect(owner).transferOwnership(other.address);
      expect(await escrow.owner()).to.equal(owner.address);
      expect(await escrow.pendingOwner()).to.equal(other.address);

      await escrow.connect(other).acceptOwnership();
      expect(await escrow.owner()).to.equal(other.address);
    });
  });

  describe('reentrancy', () => {
    it('blocks a malicious token from reentering release and double-paying', async () => {
      const [, maintainer, hunter, caller] = await ethers.getSigners();
      const mal = await (await ethers.getContractFactory('MaliciousERC20')).deploy();
      await mal.mint(maintainer.address, AMOUNT);

      const escrow = await (
        await ethers.getContractFactory('BountyEscrow')
      ).deploy(mal.target, caller.address, REFUND_WINDOW);

      await mal.connect(maintainer).approve(escrow.target, AMOUNT);
      await escrow.connect(maintainer).create(ID, AMOUNT);
      await mal.arm(escrow.target, ID); // re-enter only on the payout transfer

      await expect(escrow.connect(caller).release(ID, hunter.address, SHA)).to.be.reverted;

      // State must be untouched: still Open, funds still held, hunter unpaid.
      expect(Number((await escrow.bounties(ID)).status)).to.equal(Status.Open);
      expect(await mal.balanceOf(escrow.target)).to.equal(AMOUNT);
      expect(await mal.balanceOf(hunter.address)).to.equal(0n);
    });
  });
});
