#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

SOURCE_ROOT="${TMP_DIR}/eliza"
TARGET="${SOURCE_ROOT}/packages/app-core/scripts/copy-runtime-node-modules.ts"
mkdir -p "$(dirname "${TARGET}")"
git -C "${TMP_DIR}" init --quiet eliza

python3 - "${TARGET}" <<'PY'
from pathlib import Path
import sys

target = Path(sys.argv[1])
lines = [f"// filler {index}\n" for index in range(1, 2770)]
replacements = {
    2610: "      const request = queue.shift();\n",
    2611: "      if (!request) continue;\n",
    2612: "\n",
    2613: "      const { name, spec, optional, requesterDir, requesterDestDir } = request;\n",
    2614: "      if (\n",
    2615: "        !name ||\n",
    2616: "        DEP_SKIP.has(name) ||\n",
    2621: "\n",
    2622: "      const resolved = resolvePackage(name, spec, requesterDir);\n",
    2623: "      if (!resolved) {\n",
    2624: "        (optional ? missingOptional : missingRequired).add(name);\n",
    2625: "        continue;\n",
    2626: "      }\n",
    2627: "\n",
    2673: "          targetDist,\n",
    2674: "        )\n",
    2675: "      ) {\n",
    2676: "        (optional ? missingOptional : missingRequired).add(name);\n",
    2677: "        continue;\n",
    2678: "      }\n",
    2679: "\n",
}
for line_number, value in replacements.items():
    lines[line_number - 1] = value
target.write_text("".join(lines), encoding="utf-8")
PY

"${SCRIPT_DIR}/apply-eliza-compat-patches.sh" "${SOURCE_ROOT}"
grep -Fq 'const { name, spec, required, requesterDir, requesterDestDir } = request;' "${TARGET}"
test "$(grep -Fc '(required ? missingRequired : missingOptional).add(name);' "${TARGET}")" -eq 2

# A clean rerun must recognize the already-applied patch without changing it.
FIRST_SHA=$(shasum -a 256 "${TARGET}" | awk '{print $1}')
"${SCRIPT_DIR}/apply-eliza-compat-patches.sh" "${SOURCE_ROOT}"
SECOND_SHA=$(shasum -a 256 "${TARGET}" | awk '{print $1}')
test "${FIRST_SHA}" = "${SECOND_SHA}"

# Unexpected upstream source must fail closed rather than applying a partial patch.
sed -i.bak 's/const request = queue.shift()/const request = requests.shift()/' "${TARGET}"
rm -f "${TARGET}.bak"
if "${SCRIPT_DIR}/apply-eliza-compat-patches.sh" "${SOURCE_ROOT}" >/dev/null 2>&1; then
    echo "Compatibility patch unexpectedly accepted an unreviewed source shape." >&2
    exit 1
fi

echo "Eliza compatibility patch contract passed."
