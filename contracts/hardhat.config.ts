import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    version: "0.8.34",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  // Publishes the source on Etherscan so judges can read the verified code.
  // Optional: only needed for `hardhat verify`, set with `npx hardhat keystore set ETHERSCAN_API_KEY`.
  verify: {
    etherscan: { apiKey: configVariable("ETHERSCAN_API_KEY") },
    blockscout: { enabled: true },
    sourcify: { enabled: true },
  },
  networks: {
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
    // Public testnet for the judges' demo. Fill with `npx hardhat keystore set ...`.
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
});
