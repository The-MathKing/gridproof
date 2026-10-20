"""Talks to the GridProof contracts.

On the local Hardhat node, accounts are unlocked, so the node signs transactions.
Meter readings are still signed here with each device's own key, exactly as a
meter would, and the contract checks that signature.
"""

from __future__ import annotations

import json
from pathlib import Path

from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent.parent
KIND = {"solar": 0, "wind": 1}


class Chain:
    def __init__(self, network: str = "localhost", rpc: str = "http://127.0.0.1:8545"):
        dep = json.loads((ROOT / "deployments" / f"{network}.json").read_text())
        self.w3 = Web3(Web3.HTTPProvider(rpc))
        self.chain_id = dep["chainId"]
        c = dep["contracts"]
        self.registry = self.w3.eth.contract(address=c["DeviceRegistry"]["address"], abi=c["DeviceRegistry"]["abi"])
        self.gc = self.w3.eth.contract(address=c["GranularCertificate"]["address"], abi=c["GranularCertificate"]["abi"])
        self.reward = self.w3.eth.contract(address=c["ShiftReward"]["address"], abi=c["ShiftReward"]["abi"])
        accounts = self.w3.eth.accounts
        self.admin, self.oracle = dep["admin"], dep["oracle"]
        # Demo parties on the local node: accounts 2-5 own devices, 6-8 are buyers.
        self.owner_accounts = accounts[2:6]
        self.buyer_accounts = accounts[6:9]
        self._last_tx = None

    # ------------------------------------------------------------ helpers

    def _send(self, fn, sender: str):
        self._last_tx = fn.transact({"from": sender})
        return self._last_tx

    def wait(self):
        if self._last_tx is not None:
            self.w3.eth.wait_for_transaction_receipt(self._last_tx, timeout=120)

    @staticmethod
    def token_id(device_id: int, hour: int) -> int:
        return (device_id << 32) | hour

    def reading_digest(self, device_id: int, hour: int, wh: int) -> bytes:
        return keccak(
            encode(
                ["uint256", "address", "uint64", "uint32", "uint32"],
                [self.chain_id, self.gc.address, device_id, hour, wh],
            )
        )

    def sign_reading(self, meter: Account, device_id: int, hour: int, wh: int) -> bytes:
        msg = encode_defunct(primitive=self.reading_digest(device_id, hour, wh))
        return meter.sign_message(msg).signature

    # ------------------------------------------------------------ writes

    def register_device(self, owner: str, meter_address: str, capacity_w: int, kind: str, lat: float, lon: float, name: str):
        return self._send(
            self.registry.functions.registerDevice(
                owner, meter_address, capacity_w, KIND[kind], round(lat * 1e4), round(lon * 1e4), name
            ),
            self.oracle,
        )

    def issue(self, device_id: int, hour: int, wh: int, anomaly_bps: int, sig: bytes):
        return self._send(self.gc.functions.issue(device_id, hour, wh, anomaly_bps, sig), self.oracle)

    def quarantine(self, device_id: int, hour: int, wh: int, anomaly_bps: int, sig: bytes):
        return self._send(self.gc.functions.quarantine(device_id, hour, wh, anomaly_bps, sig), self.oracle)

    def resolve(self, token_id: int, release: bool):
        tx = self._send(self.gc.functions.resolveQuarantine(token_id, release), self.admin)
        self.wait()
        return tx

    def report_load(self, consumer: str, hour: int, wh: int):
        return self._send(self.gc.functions.reportLoad(consumer, hour, wh), self.oracle)

    def set_surplus(self, hour: int, bonus_per_kwh_wei: int):
        return self._send(self.gc.functions.setSurplusHour(hour, bonus_per_kwh_wei), self.oracle)

    def transfer(self, owner: str, to: str, token_id: int, wh: int):
        return self._send(self.gc.functions.safeTransferFrom(owner, to, token_id, wh, b""), owner)

    def retire(self, holder: str, token_id: int, wh: int, beneficiary: str):
        return self._send(self.gc.functions.retire(token_id, wh, beneficiary), holder)

    # ------------------------------------------------------------ reads

    def device_count(self) -> int:
        return self.registry.functions.deviceCount().call()

    def certificate(self, token_id: int) -> dict:
        status, wh, anomaly, issued_at, retired = self.gc.functions.certificates(token_id).call()
        return {
            "status": ["none", "issued", "quarantined", "rejected"][status],
            "wh": wh,
            "anomaly_bps": anomaly,
            "issued_at": issued_at,
            "retired_wh": retired,
        }

    def matched(self, consumer: str, hour: int) -> tuple[int, int]:
        return (
            self.gc.functions.loadWh(consumer, hour).call(),
            self.gc.functions.matchedWh(consumer, hour).call(),
        )

    def shift_balance(self, who: str) -> float:
        return self.reward.functions.balanceOf(who).call() / 1e18
