#!/usr/bin/env python3
import hashlib
import subprocess
import sys

# Backend CI builds every image again for each commit, and no two builds share a content ID, so an image's ID cannot
# say whether anything it is built from changed. The commit can. Each unit deploy-production.sh keeps or deploys on
# its own is built from the paths its rules count: the longest rule naming a path decides, and Markdown never counts.
# Given a commit, this prints each unit's fingerprint, the sha256 of the git tree entries its rules count there, as the
# .env lines the deploy workflow renders (README.md, "What a deploy replaces").
RECIPE = ".github/workflows/backend.yml"
UNITS = {
    # The server and its migration, one image, and the embedder. Of deploy/ and its tests, only the generator of the
    # image's compatibility manifest is built into it; backend/Dockerfile copies the whole contract.
    "BACKEND_INPUTS": {
        "backend/": True,
        "backend/deploy/": False,
        "backend/deploy/sync_compatibility.py": True,
        "backend/test/deploy/": False,
        "services/embedder/": True,
        "packages/api-contract/": True,
        RECIPE: True,
    },
    "SUBSCRIPTIONS_INPUTS": {"services/subscriptions/": True, RECIPE: True},
    "AI_INPUTS": {"services/ai/": True, RECIPE: True},
}


def counts(rules, path):
    if path.endswith(".md"):
        return False
    naming = [rule for rule in rules if path == rule or (rule.endswith("/") and path.startswith(rule))]
    return bool(naming) and rules[max(naming, key=len)]


def main():
    listing = subprocess.run(["git", "ls-tree", "-r", "-z", "--full-tree", sys.argv[1]],
                             check=True, capture_output=True).stdout
    entries = [entry for entry in listing.split(b"\0") if entry]
    for unit, rules in UNITS.items():
        counted = [entry for entry in entries
                   if counts(rules, entry.partition(b"\t")[2].decode("utf-8", "surrogateescape"))]
        print(unit + "=" + hashlib.sha256(b"\0".join(counted)).hexdigest())


if __name__ == "__main__":
    main()
