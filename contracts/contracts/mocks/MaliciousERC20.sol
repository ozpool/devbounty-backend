// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BountyEscrow} from "../BountyEscrow.sol";

/// @dev A token whose transfer hook reenters BountyEscrow.release, used to prove
///      the nonReentrant guard blocks reentrancy. Arm it after the bounty is
///      funded so only the payout transfer triggers the reentrant call. Not
///      production code.
contract MaliciousERC20 is ERC20 {
    BountyEscrow public escrow;
    bytes32 public targetId;
    bool public armed;

    constructor() ERC20("Malicious", "MAL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(BountyEscrow _escrow, bytes32 _id) external {
        escrow = _escrow;
        targetId = _id;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed) {
            armed = false; // one-shot, so the reentrant attempt happens exactly once
            escrow.release(targetId, to, bytes32(0));
        }
    }
}
