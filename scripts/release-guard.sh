#!/usr/bin/env bash
# Refuse to tag a commit that is not on origin/main (v0.6.3 was once tagged on a commit no branch held). Usage: release-guard.sh [rev]  (default HEAD)
set -euo pipefail
rev="${1:-HEAD}"
git fetch -q origin main 2>/dev/null || true
if ! git merge-base --is-ancestor "$rev" origin/main; then
  echo "release: $(git rev-parse --short "$rev") is not on origin/main; merge and push it first, then tag" >&2
  exit 1
fi
