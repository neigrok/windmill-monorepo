import json
from pathlib import Path


SCHEMA = str(json.loads((Path(__file__).resolve().parents[3] /
                         "packages/api-contract/sync/gym.registry.json").read_text())["version"])


def gym_headers(path):
    return {"Sync-Schema": SCHEMA} if path.startswith("/v1/gym/") else {}
