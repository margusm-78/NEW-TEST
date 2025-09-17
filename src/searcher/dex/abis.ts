// src/searcher/dex/abis.ts
// Minimal ABIs (Ethers v6 compatible fragments)
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)"
] as const;

// Uniswap V2-style Router (Camelot V2-compatible)
export const UNIV2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)",
  // supporting-fee functions are not required for quoting
] as const;

// Uniswap V3 QuoterV2 (preferred)
export const UNIV3_QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,int24 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amountOut,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountIn,uint160 sqrtPriceX96After,int24 initializedTicksCrossed,uint256 gasEstimate)"
] as const;

// Uniswap V3 Factory for pool discovery
export const UNIV3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)"
] as const;
