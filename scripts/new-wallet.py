"""Create a throwaway wallet for the Sepolia testnet and save it to oracle/.env.

    oracle/.venv/bin/python scripts/new-wallet.py

The private key is written only to oracle/.env (git-ignored, readable only by you)
and is never printed. Only the public address is shown, for the faucet.
Use this wallet for testnet ETH only; never send real funds to it.
"""

import os
import stat
import sys
from pathlib import Path

from eth_account import Account

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "oracle" / ".env"
PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com"


def read_env() -> dict[str, str]:
    if not ENV.exists():
        return {}
    out = {}
    for line in ENV.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def main() -> None:
    env = read_env()
    if env.get("GRIDPROOF_PRIVATE_KEY"):
        address = Account.from_key(env["GRIDPROOF_PRIVATE_KEY"]).address
        print(f"oracle/.env already has a wallet: {address}")
        print("Not overwriting it. Delete GRIDPROOF_PRIVATE_KEY from oracle/.env first if you really want a new one.")
        sys.exit(0)

    acct = Account.create()
    ENV.write_text(
        "# Created by scripts/new-wallet.py. Sepolia testnet only. Never commit or share this file.\n"
        "GRIDPROOF_NETWORK=sepolia\n"
        f"GRIDPROOF_RPC_URL={env.get('GRIDPROOF_RPC_URL', PUBLIC_RPC)}\n"
        f"GRIDPROOF_PRIVATE_KEY=0x{acct.key.hex().removeprefix('0x')}\n"
    )
    os.chmod(ENV, stat.S_IRUSR | stat.S_IWUSR)  # 600: only you can read it

    print("New Sepolia test wallet saved to oracle/.env")
    print()
    print(f"  Address: {acct.address}")
    print()
    print("Paste that address into a Sepolia faucet, e.g.")
    print("  https://cloud.google.com/application/web3/faucet/ethereum/sepolia")


if __name__ == "__main__":
    main()
