// Deploys the three contracts and writes addresses + ABIs to ../deployments/<network>.json,
// which the oracle and the dashboard read.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";

const { ethers, networkName } = await network.getOrCreate();
const [admin, oracle] = await ethers.getSigners();

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
// For the demo the oracle operator also acts as registrar and auditor; in production
// these are separate parties (issuing body, independent auditor).
await (await registry.grantRole(await registry.REGISTRAR_ROLE(), oracle.address)).wait();
await (await gc.grantRole(await gc.AUDITOR_ROLE(), admin.address)).wait();

const abi = (name: string) =>
  JSON.parse(readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, "utf8")).abi;

const out = {
  network: networkName,
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
