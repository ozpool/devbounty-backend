// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title BountyEscrow
/// @notice Holds a sponsor's USDC for a bug bounty and releases it to the hunter
///         when the backend confirms the fixing pull request was merged. The
///         backend (the `authorizedCaller` hot wallet) is the only account that
///         can release; it can never refund, mint, or change ownership.
/// @dev    Funds are held per `bountyId`, computed off-chain as
///         keccak256(maintainerAddress, repoFullName, issueNumber, nonce). Including
///         the maintainer in the preimage makes the id unpredictable to others, so
///         no one can front-run a `create()` with a colliding id.
contract BountyEscrow is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Paid,
        Refunded
    }

    struct Bounty {
        address maintainer; // 20  slot 1
        uint96 amount; // 12  slot 1
        uint64 createdAt; // 8   slot 2
        uint64 refundWindow; // 8   slot 2  ← snapshotted at create()
        Status status; // 1   slot 2
    }

    IERC20 public immutable usdc;
    address public authorizedCaller; // backend hot wallet
    uint64 public defaultRefundWindow; // seconds; applied to NEW bounties only

    mapping(bytes32 => Bounty) public bounties;

    // ---- errors ----
    error NotAuthorized();
    error BountyExists();
    error BountyNotOpen();
    error ZeroAmount();
    error AmountTooLarge();
    error RefundTooEarly();
    error NotMaintainer();

    // ---- events ----
    event BountyCreated(
        bytes32 indexed id,
        address indexed maintainer,
        uint256 amount,
        uint64 refundWindow
    );
    event BountyReleased(
        bytes32 indexed id,
        address indexed hunter,
        uint256 amount,
        bytes32 prCommitSha
    );
    event BountyRefunded(bytes32 indexed id, uint256 amount);
    event AuthorizedCallerSet(address indexed previous, address indexed current);
    event DefaultRefundWindowSet(uint64 previous, uint64 current);

    constructor(
        IERC20 _usdc,
        address _authorizedCaller,
        uint64 _defaultRefundWindow
    ) Ownable(msg.sender) {
        usdc = _usdc;
        authorizedCaller = _authorizedCaller;
        defaultRefundWindow = _defaultRefundWindow;
    }

    /// @notice Fund a new bounty. The caller becomes its maintainer and must have
    ///         approved `amount` of USDC to this contract beforehand.
    /// @dev    The refund window is snapshotted from `defaultRefundWindow` so a
    ///         later owner change cannot move the deadline of an existing bounty.
    function create(bytes32 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint96).max) revert AmountTooLarge();
        if (bounties[id].status != Status.None) revert BountyExists();
        bounties[id] = Bounty({
            maintainer: msg.sender,
            amount: uint96(amount),
            createdAt: uint64(block.timestamp),
            refundWindow: defaultRefundWindow, // snapshot — immune to later owner changes
            status: Status.Open
        });
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BountyCreated(id, msg.sender, amount, defaultRefundWindow);
    }

    /// @notice Release a bounty's USDC to the hunter. Only the backend hot wallet
    ///         may call this; `prCommitSha` is the merge commit, emitted as a
    ///         forensic anchor the indexer cross-checks against the off-chain claim.
    function release(bytes32 id, address hunter, bytes32 prCommitSha) external nonReentrant {
        if (msg.sender != authorizedCaller) revert NotAuthorized();
        Bounty storage b = bounties[id];
        if (b.status != Status.Open) revert BountyNotOpen();
        uint256 amt = b.amount;
        b.status = Status.Paid; // effects before interaction
        usdc.safeTransfer(hunter, amt);
        emit BountyReleased(id, hunter, amt, prCommitSha);
    }

    /// @notice Refund an unpaid bounty to its maintainer once the refund window
    ///         has elapsed. Maintainer-only; the backend can never refund.
    function refund(bytes32 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.maintainer != msg.sender) revert NotMaintainer();
        if (b.status != Status.Open) revert BountyNotOpen();
        if (block.timestamp < b.createdAt + b.refundWindow) revert RefundTooEarly();
        uint256 amt = b.amount;
        b.status = Status.Refunded;
        usdc.safeTransfer(b.maintainer, amt);
        emit BountyRefunded(id, amt);
    }

    /// @notice Rotate the backend hot wallet (e.g. after a key compromise).
    function setAuthorizedCaller(address newCaller) external onlyOwner {
        emit AuthorizedCallerSet(authorizedCaller, newCaller);
        authorizedCaller = newCaller;
    }

    /// @notice Change the refund window applied to future bounties. Existing
    ///         bounties keep the window snapshotted at their creation.
    function setDefaultRefundWindow(uint64 newWindow) external onlyOwner {
        emit DefaultRefundWindowSet(defaultRefundWindow, newWindow);
        defaultRefundWindow = newWindow;
    }
}
