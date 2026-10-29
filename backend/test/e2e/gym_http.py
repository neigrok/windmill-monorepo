import json
import os
from pathlib import Path


CONTRACT_DIR = Path(os.environ["WM_API_CONTRACT_DIR"]) if "WM_API_CONTRACT_DIR" in os.environ else \
    Path(__file__).resolve().parents[3] / "packages/api-contract"
REGISTRY = CONTRACT_DIR / "sync/gym.registry.json"
try:
    SCHEMA = str(json.loads(REGISTRY.read_text())["version"])
except FileNotFoundError as failure:
    raise RuntimeError(f"Gym HTTP carrier registry is missing at {REGISTRY}; set WM_API_CONTRACT_DIR to the api-contract package") from failure


def gym_headers(path):
    return {"Sync-Schema": SCHEMA} if path.startswith("/v1/gym/") else {}
