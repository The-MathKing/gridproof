import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const SOLAR = 0;

async function deploy() {
  const [admin, oracle, auditor, farm, buyer, other] = await ethers.getSigners();
  const meter = ethers.Wallet.createRandom();

  const registry = await ethers.deployContract("DeviceRegistry", [admin.address]);
  const reward = await ethers.deployContract("ShiftReward", [admin.address]);
  const gc = await ethers.deployContract("GranularCertificate", [
    admin.address,
    await registry.getAddress(),
    await reward.getAddress(),
  ]);
  await reward.grantRole(await reward.MINTER_ROLE(), await gc.getAddress());
  await gc.grantRole(await gc.ORACLE_ROLE(), oracle.address);
  await gc.grantRole(await gc.AUDITOR_ROLE(), auditor.address);

  // 5 kW rooftop array
  await registry.registerDevice(farm.address, meter.address, 5000, SOLAR, 515000, -1200, "Rooftop A");
  const deviceId = 1n;

  const now = await networkHelpers.time.latest();
  const hour = Math.floor(now / 3600) - 2; // a finished hour

  const sign = async (wh: number, h = hour, id = deviceId, key = meter) => {
    const digest = await gc.readingDigest(id, h, wh);
    return key.signMessage(ethers.getBytes(digest));
  };

  return { admin, oracle, auditor, farm, buyer, other, meter, registry, reward, gc, deviceId, hour, sign };
}

describe("GranularCertificate", function () {
  it("issues one certificate per device-hour to the device owner", async function () {
    const { gc, oracle, farm, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
    const id = await gc.tokenIdFor(deviceId, hour);

    await expect(gc.connect(oracle).issue(deviceId, hour, 3200, 1200, await sign(3200)))
      .to.emit(gc, "Issued")
      .withArgs(id, deviceId, hour, 3200, 1200);

    expect(await gc.balanceOf(farm.address, id)).to.equal(3200n);
    const [decodedDevice, decodedHour] = await gc.decode(id);
    expect(decodedDevice).to.equal(deviceId);
    expect(decodedHour).to.equal(BigInt(hour));
  });

  it("rejects issuing the same device-hour twice", async function () {
    const { gc, oracle, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
    await gc.connect(oracle).issue(deviceId, hour, 3200, 0, await sign(3200));
    await expect(gc.connect(oracle).issue(deviceId, hour, 1000, 0, await sign(1000))).to.be.revertedWithCustomError(
      gc,
      "AlreadyRecorded",
    );
  });

  it("rejects readings not signed by the device's meter", async function () {
    const { gc, oracle, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
    const attacker = ethers.Wallet.createRandom();
    await expect(
      gc.connect(oracle).issue(deviceId, hour, 3200, 0, await sign(3200, hour, deviceId, attacker)),
    ).to.be.revertedWithCustomError(gc, "BadDeviceSignature");
  });

  it("rejects a valid signature replayed with a different amount", async function () {
    const { gc, oracle, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
    await expect(gc.connect(oracle).issue(deviceId, hour, 4900, 0, await sign(3200))).to.be.revertedWithCustomError(
      gc,
      "BadDeviceSignature",
    );
  });

  it("rejects more energy than the device's capacity allows in one hour", async function () {
    const { gc, oracle, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
    await expect(gc.connect(oracle).issue(deviceId, hour, 5001, 0, await sign(5001))).to.be.revertedWithCustomError(
      gc,
      "ExceedsCapacity",
    );
  });

  it("rejects hours that have not finished yet", async function () {
    const { gc, oracle, deviceId, sign } = await networkHelpers.loadFixture(deploy);
    const current = Math.floor((await networkHelpers.time.latest()) / 3600);
    await expect(
      gc.connect(oracle).issue(deviceId, current, 100, 0, await sign(100, current)),
    ).to.be.revertedWithCustomError(gc, "FutureHour");
  });

  it("only lets the oracle issue", async function () {
    const { gc, other, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
    await expect(gc.connect(other).issue(deviceId, hour, 100, 0, await sign(100))).to.be.revertedWithCustomError(
      gc,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("blocks direct issuance when the AI anomaly score is above the threshold", async function () {
    const { gc, oracle, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
    await expect(gc.connect(oracle).issue(deviceId, hour, 3200, 9100, await sign(3200))).to.be.revertedWithCustomError(
      gc,
      "AboveThreshold",
    );
  });

  describe("quarantine", function () {
    it("holds a flagged reading until an auditor releases it", async function () {
      const { gc, oracle, auditor, farm, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
      const id = await gc.tokenIdFor(deviceId, hour);
      await expect(gc.connect(oracle).quarantine(deviceId, hour, 4800, 9100, await sign(4800))).to.emit(
        gc,
        "Quarantined",
      );
      expect(await gc.balanceOf(farm.address, id)).to.equal(0n);

      // The device can't get a second try at the same hour with smaller numbers.
      await expect(gc.connect(oracle).issue(deviceId, hour, 2000, 0, await sign(2000))).to.be.revertedWithCustomError(
        gc,
        "AlreadyRecorded",
      );

      await gc.connect(auditor).resolveQuarantine(id, true);
      expect(await gc.balanceOf(farm.address, id)).to.equal(4800n);
    });

    it("rejected readings never mint", async function () {
      const { gc, oracle, auditor, farm, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
      const id = await gc.tokenIdFor(deviceId, hour);
      await gc.connect(oracle).quarantine(deviceId, hour, 4800, 9100, await sign(4800));
      await gc.connect(auditor).resolveQuarantine(id, false);
      expect(await gc.balanceOf(farm.address, id)).to.equal(0n);
      await expect(gc.connect(auditor).resolveQuarantine(id, true)).to.be.revertedWithCustomError(
        gc,
        "NotQuarantined",
      );
    });
  });

  describe("retirement and hourly matching", function () {
    it("credits retirements to the certificate's own hour and computes the hourly match", async function () {
      const { gc, oracle, farm, buyer, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
      const id = await gc.tokenIdFor(deviceId, hour);
      await gc.connect(oracle).issue(deviceId, hour, 3000, 0, await sign(3000));
      await gc.connect(oracle).reportLoad(buyer.address, hour, 4000);
      await gc.connect(oracle).reportLoad(buyer.address, hour + 1, 4000);

      // Farm sells 3000 Wh to the buyer, buyer retires it.
      await gc.connect(farm).safeTransferFrom(farm.address, buyer.address, id, 3000, "0x");
      await expect(gc.connect(buyer).retire(id, 3000, buyer.address))
        .to.emit(gc, "Retired")
        .withArgs(buyer.address, buyer.address, id, hour, 3000);

      expect(await gc.hourlyMatchBps(buyer.address, hour)).to.equal(7500); // 3000 / 4000
      expect(await gc.hourlyMatchBps(buyer.address, hour + 1)).to.equal(0); // a different hour gets no credit

      const [load, matched] = await gc.periodMatch(buyer.address, hour, hour + 2);
      expect(load).to.equal(8000n);
      expect(matched).to.equal(3000n);
    });

    it("can't retire the same certificate twice", async function () {
      const { gc, oracle, farm, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
      const id = await gc.tokenIdFor(deviceId, hour);
      await gc.connect(oracle).issue(deviceId, hour, 1000, 0, await sign(1000));
      await gc.connect(farm).retire(id, 1000, farm.address);
      await expect(gc.connect(farm).retire(id, 1, farm.address)).to.be.revertedWithCustomError(
        gc,
        "ERC1155InsufficientBalance",
      );
    });

    it("caps the hourly match at 100% even if more is retired", async function () {
      const { gc, oracle, farm, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
      const id = await gc.tokenIdFor(deviceId, hour);
      await gc.connect(oracle).issue(deviceId, hour, 5000, 0, await sign(5000));
      await gc.connect(oracle).reportLoad(farm.address, hour, 1000);
      await gc.connect(farm).retire(id, 5000, farm.address);
      expect(await gc.hourlyMatchBps(farm.address, hour)).to.equal(10000);
      const [, matched] = await gc.periodMatch(farm.address, hour, hour + 1);
      expect(matched).to.equal(1000n);
    });

    it("pays GSHIFT for clean energy used in a surplus hour", async function () {
      const { gc, reward, oracle, farm, buyer, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
      const id = await gc.tokenIdFor(deviceId, hour);
      await gc.connect(oracle).issue(deviceId, hour, 2000, 0, await sign(2000));
      await gc.connect(oracle).setSurplusHour(hour, ethers.parseEther("1")); // 1 GSHIFT per kWh
      await gc.connect(farm).safeTransferFrom(farm.address, buyer.address, id, 2000, "0x");
      await gc.connect(buyer).retire(id, 2000, buyer.address);
      expect(await reward.balanceOf(buyer.address)).to.equal(ethers.parseEther("2"));
    });
  });

  describe("device registry", function () {
    it("stops issuance for a deactivated device", async function () {
      const { gc, registry, oracle, deviceId, hour, sign } = await networkHelpers.loadFixture(deploy);
      await registry.setActive(deviceId, false);
      await expect(gc.connect(oracle).issue(deviceId, hour, 100, 0, await sign(100))).to.be.revertedWithCustomError(
        gc,
        "DeviceInactive",
      );
    });

    it("accepts the new key after a signer rotation and rejects the old one", async function () {
      const { gc, registry, oracle, deviceId, hour, sign, meter } = await networkHelpers.loadFixture(deploy);
      const newMeter = ethers.Wallet.createRandom();
      await registry.rotateSigner(deviceId, newMeter.address);
      await expect(
        gc.connect(oracle).issue(deviceId, hour, 100, 0, await sign(100, hour, deviceId, meter)),
      ).to.be.revertedWithCustomError(gc, "BadDeviceSignature");
      await gc.connect(oracle).issue(deviceId, hour, 100, 0, await sign(100, hour, deviceId, newMeter));
    });
  });
});
