#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

SOURCE="${TMP}/eliza"
LOCK="${TMP}/lock.json"
git init -q "${SOURCE}"
git -C "${SOURCE}" config user.name fixture
git -C "${SOURCE}" config user.email fixture@example.invalid
printf 'fixture\n' >"${SOURCE}/README.md"
git -C "${SOURCE}" add README.md
git -C "${SOURCE}" commit -qm fixture
COMMIT="$(git -C "${SOURCE}" rev-parse HEAD)"

cat >"${LOCK}" <<JSON
{
  "schema": "eliza.os.tails.app-source-lock.v1",
  "repository": "https://github.com/elizaOS/eliza",
  "commit": "${COMMIT}"
}
JSON

ELIZAOS_ELIZA_ROOT="${SOURCE}" \
ELIZAOS_ELIZA_SOURCE_LOCK="${LOCK}" \
  node "${ROOT}/scripts/verify-eliza-source-lock.mjs" >/dev/null

sed -i.bak "s/${COMMIT}/0000000000000000000000000000000000000000/" "${LOCK}"
if ELIZAOS_ELIZA_ROOT="${SOURCE}" \
  ELIZAOS_ELIZA_SOURCE_LOCK="${LOCK}" \
  node "${ROOT}/scripts/verify-eliza-source-lock.mjs" >/dev/null 2>&1; then
  echo "mismatched source checkout unexpectedly passed" >&2
  exit 1
fi

echo "eliza source lock contracts passed"
