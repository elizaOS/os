#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 ELIZA_SOURCE_ROOT" >&2
    exit 64
fi

ELIZA_ROOT=$(cd "$1" && pwd)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PATCH_FILE="${SCRIPT_DIR}/../patches/eliza-runtime-copy-required-flag.patch"

test -d "${ELIZA_ROOT}/.git" || {
    echo "Eliza source is not a Git checkout: ${ELIZA_ROOT}" >&2
    exit 66
}
test -f "${PATCH_FILE}" || {
    echo "Missing compatibility patch: ${PATCH_FILE}" >&2
    exit 66
}

if git -C "${ELIZA_ROOT}" apply --check "${PATCH_FILE}" 2>/dev/null; then
    git -C "${ELIZA_ROOT}" apply "${PATCH_FILE}"
    echo "Applied Eliza runtime-copy required/optional compatibility patch."
elif git -C "${ELIZA_ROOT}" apply --reverse --check "${PATCH_FILE}" 2>/dev/null; then
    echo "Eliza runtime-copy compatibility patch is already applied."
else
    echo "Eliza source no longer matches the reviewed runtime-copy compatibility patch." >&2
    echo "Refusing to build against an unreviewed source shape." >&2
    exit 65
fi
