import "dotenv/config";
import { ethers } from "ethers";

const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const FactoryAbi = [
  "function getPool(address,address,uint24) view returns (address)"
] as const;
const PoolAbi = [
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)"
] as const;

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARB_RPC_URL, { name: "arbitrum", chainId: 42161 });

  const USDC = ethers.getAddress("0xAf88d065E77C8Ccc2239327C5EDb3A432268e5831");
  const WETH = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");

  const factory = new ethers.Contract(FACTORY, FactoryAbi, provider);

  for (const fee of [500, 3000, 10000]) {
    const pool = await factory.getPool(USDC, WETH, fee);
    if (pool === ethers.ZeroAddress) { console.log(`fee ${fee}: NO POOL`); continue; }
    const c = new ethers.Contract(pool, PoolAbi, provider);
    const [slot0, liq] = await Promise.all([c.slot0(), c.liquidity()]);
    const sqrt = slot0[0] as bigint;
    console.log(`fee ${fee}: pool=${pool} sqrtPriceX96=${sqrt} liquidity=${liq}`);
  }
}

main().catch(e => (console.error(e), process.exit(1)));

