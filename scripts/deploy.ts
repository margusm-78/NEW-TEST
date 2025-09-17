import "dotenv/config";
import { ethers } from "ethers";
import { ArbiSearcherRouter__factory } from "../typechain-types";

// Small env helpers
function env(key: string): string {
  const v = (process.env[key] || "").trim();
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

async function main() {
  const RPC = env("ARB_RPC_URL");
  const PK  = env("PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(RPC, { name: "arbitrum", chainId: 42161 });
  const wallet   = new ethers.Wallet(PK, provider);
  const owner    = await wallet.getAddress();

  console.log("Deployer:", owner);

  // Typechain factory; your router constructor expects _owner
  const factory  = new ArbiSearcherRouter__factory(wallet);
  const contract = await factory.deploy(owner);              // <— pass constructor arg
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  const hash = contract.deploymentTransaction()?.hash;

  console.log("Deployed ArbiSearcherRouter at:", addr);
  if (hash) console.log("Deployment tx:", hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
