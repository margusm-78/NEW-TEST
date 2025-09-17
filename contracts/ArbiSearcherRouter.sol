// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

contract ArbiSearcherRouter {
    address public immutable owner;

    error NotOwner();
    error MinProfit();
    error CallFailed(bytes data);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner) {
        owner = _owner;
    }

    struct Step {
        address target;
        bytes data;
        uint256 value;
    }

    function exec(address profitToken, uint256 minProfit, Step[] calldata steps) external onlyOwner {
        uint256 balBefore = IERC20(profitToken).balanceOf(address(this));

        for (uint256 i = 0; i < steps.length; i++) {
            (bool ok, bytes memory ret) = steps[i].target.call{value: steps[i].value}(steps[i].data);
            if (!ok) revert CallFailed(ret);
        }

        uint256 balAfter = IERC20(profitToken).balanceOf(address(this));
        if (balAfter < balBefore + minProfit) revert MinProfit();

        unchecked { IERC20(profitToken).transfer(owner, balAfter - balBefore); }
    }

    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).approve(spender, amount);
    }

    function rescue(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    receive() external payable {}
}
