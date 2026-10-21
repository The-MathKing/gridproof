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

// Public RPCs are often load-balanced and can report a stale nonce between transactions,
// so number every transaction ourselves and wait for each one before the next.
let nonce = await ethers.provider.getTransactionCount(operator.address, "pending");
// ethers defaults to a 1 gwei tip, which on a quiet testnet is ~100x what's needed.
// Pay the current base fee (with headroom) plus a small tip instead.
const baseFee = (await ethers.provider.getBlock("latest"))?.baseFeePerGas ?? 0n;
const tip = ethers.parseUnits("0.01", "gwei");
const fees = { maxPriorityFeePerGas: tip, maxFeePerGas: baseFee * 3n + tip };
const next = () => ({ nonce: nonce++, ...fees });

const deploy = async (name: string, args: unknown[]) => {
  const c = await ethers.deployContract(name, args, next());
  await c.waitForDeployment();
  console.log(`  ${name} deployed`);
  return c;
};
const send = async (p: Promise<{ wait: () => Promise<unknown> }>) => (await p).wait();

const registry = await deploy("DeviceRegistry", [admin.address]);
const reward = await deploy("ShiftReward", [admin.address]);
const gc = await deploy("GranularCertificate", [admin.address, await registry.getAddress(), await reward.getAddress()]);

await send(reward.grantRole(await reward.MINTER_ROLE(), await gc.getAddress(), next()));
await send(gc.grantRole(await gc.ORACLE_ROLE(), oracle.address, next()));
await send(registry.grantRole(await registry.REGISTRAR_ROLE(), oracle.address, next()));
await send(gc.grantRole(await gc.AUDITOR_ROLE(), admin.address, next()));

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
