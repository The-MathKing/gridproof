"""Talks to the GridProof contracts on any EVM network.

The oracle signs every transaction itself with its own key, so the same code runs
on the local Hardhat chain and on a public testnet. Meter readings are signed
separately with each device's own key, exactly as a meter would, and the contract
checks that signature.

Configuration (environment, or oracle/.env):
    GRIDPROOF_NETWORK      localhost (default) or sepolia; picks deployments/<network>.json
    GRIDPROOF_RPC_URL      RPC endpoint; defaults to the deployment's public RPC
    GRIDPROOF_PRIVATE_KEY  the operator wallet's key; on localhost defaults to Hardhat's test account #0.
                           Without it on a public network the client is read-only.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent.parent
KIND = {"solar": 0, "wind": 1}
# Public test mnemonic every Hardhat node funds; only ever valid on a local chain.
HARDHAT_MNEMONIC = "test test test test test test test test test test test junk"


def _load_dotenv() -> None:
    path = ROOT / "oracle" / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def current_network() -> str:
    return os.environ.get("GRIDPROOF_NETWORK", "localhost")


class TxFailed(RuntimeError):
    pass


class Chain:
    def __init__(self, network: str | None = None, rpc: str | None = None):
        self.network = network or current_network()
        dep_path = ROOT / "deployments" / f"{self.network}.json"
        if not dep_path.exists():
            raise SystemExit(f"No deployment for {self.network}. Deploy the contracts first ({dep_path}).")
        self.deployment = json.loads(dep_path.read_text())
        self.rpc = rpc or os.environ.get("GRIDPROOF_RPC_URL") or self.deployment.get("publicRpc", "http://127.0.0.1:8545")
        self.w3 = Web3(Web3.HTTPProvider(self.rpc, request_kwargs={"timeout": 60}))
        self.chain_id = self.deployment["chainId"]
        if self.w3.eth.chain_id != self.chain_id:
            raise SystemExit(f"RPC is on chain {self.w3.eth.chain_id}, deployment is for {self.chain_id}.")

        c = self.deployment["contracts"]
        self.registry = self.w3.eth.contract(address=c["DeviceRegistry"]["address"], abi=c["DeviceRegistry"]["abi"])
        self.gc = self.w3.eth.contract(address=c["GranularCertificate"]["address"], abi=c["GranularCertificate"]["abi"])
        self.reward = self.w3.eth.contract(address=c["ShiftReward"]["address"], abi=c["ShiftReward"]["abi"])

        self.account = self._operator_account()
        self.operator = self.account.address if self.account else self.deployment["oracle"]
        if self.account and self.operator != self.deployment["oracle"]:
            raise SystemExit(
                f"GRIDPROOF_PRIVATE_KEY is for {self.operator}, but the contracts were deployed by "
                f"{self.deployment['oracle']}. Use the same wallet for both."
            )
        self._nonce: int | None = None
        self.gas_used = 0
        self.fees_wei = 0
        self.tx_count = 0
        self.max_tx_gas = 0

    def _operator_account(self):
        key = os.environ.get("GRIDPROOF_PRIVATE_KEY")
        if key:
            return Account.from_key(key)
        if self.network != "localhost":
            return None  # read-only: enough for the dashboard, not for the pipeline
        Account.enable_unaudited_hdwallet_features()
        return Account.from_mnemonic(HARDHAT_MNEMONIC, account_path="m/44'/60'/0'/0/0")

    # ------------------------------------------------------------ sending

    def _send(self, fn, label: str = ""):
        """Sign locally, send, and wait for the receipt. Raises if the transaction reverts."""
        if self.account is None:
            raise SystemExit(f"Set GRIDPROOF_PRIVATE_KEY (in oracle/.env) to send transactions on {self.network}.")
        if self._nonce is None:
            self._nonce = self.w3.eth.get_transaction_count(self.operator, "pending")
        tx = fn.build_transaction({"from": self.operator, "nonce": self._nonce, "chainId": self.chain_id})
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        self._nonce += 1
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)
        self.tx_count += 1
        self.gas_used += receipt["gasUsed"]
        self.max_tx_gas = max(self.max_tx_gas, receipt["gasUsed"])
        self.fees_wei += receipt["gasUsed"] * receipt.get("effectiveGasPrice", 0)
        if receipt["status"] != 1:
            raise TxFailed(f"{label or 'transaction'} reverted: {tx_hash.to_0x_hex()}")
        if self.network != "localhost" and label:
            print(f"    {label}: {self.explorer_tx(tx_hash.to_0x_hex())} (gas {receipt['gasUsed']:,})")
        return receipt

    def explorer_tx(self, tx_hash: str) -> str | None:
        base = self.deployment.get("explorer")
        return f"{base}/tx/{tx_hash}" if base else None

    @staticmethod
    def _chunks(items: list, size: int):
        for i in range(0, len(items), size):
            yield items[i : i + size]

    # ------------------------------------------------------------ helpers

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

    def sign_reading(self, meter, device_id: int, hour: int, wh: int) -> bytes:
        msg = encode_defunct(primitive=self.reading_digest(device_id, hour, wh))
        return meter.sign_message(msg).signature

    # ------------------------------------------------------------ writes

    def register_device(self, owner: str, meter_address: str, capacity_w: int, kind: str, lat: float, lon: float, name: str):
        return self._send(
            self.registry.functions.registerDevice(
                owner, meter_address, capacity_w, KIND[kind], round(lat * 1e4), round(lon * 1e4), name
            ),
            f"register {name}",
        )

    def submit_readings(self, readings: list[tuple[int, int, int, int, bytes]], batch: int = 25):
        """readings: (device_id, hour, wh, anomaly_bps, device_sig). Issued or quarantined on-chain by score."""
        for i, chunk in enumerate(self._chunks(readings, batch)):
            self._send(self.gc.functions.submitReadings([list(r) for r in chunk]), f"readings batch {i + 1}")

    def resolve(self, token_id: int, release: bool):
        return self._send(self.gc.functions.resolveQuarantine(token_id, release), "auditor decision")

    def report_loads(self, consumer: str, from_hour: int, whs: list[int], batch: int = 72):
        for i, chunk in enumerate(self._chunks(whs, batch)):
            self._send(self.gc.functions.reportLoads(consumer, from_hour + i * batch, chunk), "buyer load")

    def set_surplus_hours(self, hours: list[int], bonus_per_kwh_wei: int):
        if hours:
            self._send(self.gc.functions.setSurplusHours(sorted(hours), bonus_per_kwh_wei), "surplus hours")

    def retire_batch(self, retirements: list[tuple[int, int, str]], batch: int = 50):
        """retirements: (token_id, wh, beneficiary), retired from the operator's own balance."""
        for i, chunk in enumerate(self._chunks(retirements, batch)):
            ids, whs, bens = zip(*chunk)
            self._send(self.gc.functions.retireBatch(list(ids), list(whs), list(bens)), f"retire batch {i + 1}")

    # ------------------------------------------------------------ reads

    def device_count(self) -> int:
        return self.registry.functions.deviceCount().call()

    def statuses(self, token_ids: list[int]) -> list[str]:
        names = ["none", "issued", "quarantined", "rejected"]
        out = []
        for chunk in self._chunks(token_ids, 300):
            out += [names[s] for s in self.gc.functions.statusesOf(chunk).call()]
        return out

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

    def balance_eth(self) -> float:
        return self.w3.eth.get_balance(self.operator) / 1e18
