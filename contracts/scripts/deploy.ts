// Deploys the three contracts and writes addresses + ABIs to ../deployments/<network>.json,
// which the oracle and the dashboard read.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";

const { ethers, networkName } = await network.getOrCreate();
// One wallet runs the demo on every network: it deploys, operates the oracle, owns the
// demo devices (as a community-energy supplier) and acts as auditor. In production these
// are separate parties, and the roles below are what you would hand to each of them.
const [operator] = await ethers.getSigners();
const admin = operator;
const oracle = operator;

const registry = await ethers.deployContract("DeviceRegistry", [admin.address]);
const reward = await ethers.deployContract("ShiftReward", [admin.address]);
const gc = await ethers.deployContract("GranularCertificate", [
  admin.address,
  await registry.getAddress(),
  await reward.getAddress(),
]);
await Promise.all([registry.waitForDeployment(), reward.waitForDeployment(), gc.waitForDeployment()]);

await (await reward.grantRole(await reward.MINTER_ROLE(), await gc.getAddress())).wait();
await (await gc.grantRole(await gc.ORACLE_ROLE(), oracle.address)).wait();
await (await registry.grantRole(await registry.REGISTRAR_ROLE(), oracle.address)).wait();
await (await gc.grantRole(await gc.AUDITOR_ROLE(), admin.address)).wait();

const abi = (name: string) =>
  JSON.parse(readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, "utf8")).abi;

// Where anyone can check the contracts without trusting GridProof.
const PUBLIC = {
  sepolia: { rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io" },
} as Record<string, { rpc: string; explorer: string }>;

const out = {
  network: networkName,
  publicRpc: PUBLIC[networkName]?.rpc ?? "http://127.0.0.1:8545",
  explorer: PUBLIC[networkName]?.explorer ?? null,
  chainId: Number((await ethers.provider.getNetwork()).chainId),
  admin: admin.address,
  oracle: oracle.address,
  contracts: {
    DeviceRegistry: { address: await registry.getAddress(), abi: abi("DeviceRegistry") },
    ShiftReward: { address: await reward.getAddress(), abi: abi("ShiftReward") },
    GranularCertificate: { address: await gc.getAddress(), abi: abi("GranularCertificate") },
  },
};

mkdirSync("../deployments", { recursive: true });
writeFileSync(`../deployments/${networkName}.json`, JSON.stringify(out, null, 2));
console.log(`Deployed to ${networkName}:`);
for (const [k, v] of Object.entries(out.contracts)) console.log(`  ${k.padEnd(20)} ${v.address}`);
