import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 800 } } },
  networks: {
    arbitrum: { url: process.env.ARB_RPC_URL || "", accounts: [process.env.PRIVATE_KEY || "0x" + "0".repeat(64)] },
    arbsepolia: { url: process.env.ARB_SEPOLIA_RPC_URL || "", accounts: [process.env.PRIVATE_KEY || "0x" + "0".repeat(64)] }
  }
};
export default config;
