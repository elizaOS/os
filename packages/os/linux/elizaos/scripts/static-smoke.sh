#!/usr/bin/env bash
# Lint pass over the variant tree: yaml, json, shebangs, exec bits, sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${HERE}"

fail=0

# JSON files parse.
while IFS= read -r f; do
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${f}" \
        || { echo "INVALID JSON: ${f}"; fail=1; }
done < <(find . \
    \( -path "./out" -o -path "./cache" -o -path "./chroot" -o -path "./binary" -o -path "./artifacts" \) -prune \
    -o -name "*.json" -print)

# Hooks must be executable and start with a shebang.
for f in config/hooks/normal/*.hook.chroot; do
    [ -e "${f}" ] || continue
    [ -x "${f}" ] || { echo "NOT EXECUTABLE: ${f}"; fail=1; }
    head -1 "${f}" | grep -q '^#!' || { echo "MISSING SHEBANG: ${f}"; fail=1; }
done

# Shell scripts parse with their declared interpreter. Several harnesses use
# bash arrays/process substitution and are intentionally not POSIX sh.
while IFS= read -r f; do
    first_line="$(head -1 "${f}")"
    if printf '%s\n' "${first_line}" | grep -q 'bash'; then
        bash -n "${f}" 2>/dev/null || { echo "BASH PARSE FAIL: ${f}"; fail=1; }
    else
        sh -n "${f}" 2>/dev/null || { echo "SH PARSE FAIL: ${f}"; fail=1; }
    fi
done < <(find scripts config/includes.chroot/usr/local/lib/elizaos config/includes.chroot/usr/lib/elizaos \
    \( -name "*.sh" -o -name "first-boot.sh" -o -name "start-launcher" -o -name "start-chat-overlay" \) \
    2>/dev/null)

# Release-check Make targets must stay wired to the checked-in Python gate.
# This is intentionally source-only: it catches stale deleted helper paths
# without requiring a local ISO, QEMU transcript, or release artifact.
python3 -c 'import ast,pathlib; ast.parse(pathlib.Path("scripts/check_release_manifest.py").read_text())' \
    || { echo "PY COMPILE FAIL: scripts/check_release_manifest.py"; fail=1; }
if ! make -n release-check ARCH=riscv64 2>/dev/null | grep -q 'scripts/check_release_manifest.py'; then
    echo "BAD RELEASE CHECK TARGET: release-check must invoke scripts/check_release_manifest.py"
    fail=1
fi
if make -n release-check ARCH=riscv64 2>/dev/null | grep -q 'scripts/release-check.sh'; then
    echo "STALE RELEASE CHECK TARGET: release-check references deleted scripts/release-check.sh"
    fail=1
fi

# The image package contract is explicit. live-build's firmware discovery has
# previously pulled unrelated astronomy and telephony packages, plus mutable
# installer packages that download blobs during the build.
grep -q '^FIRMWARE_OPTIONS="--firmware-chroot false --firmware-binary false"$' auto/config \
    || { echo "FIRMWARE DISCOVERY ENABLED: declare firmware explicitly"; fail=1; }
if grep -R -E -n '^(indi-dsi|dahdi-firmware-nonfree|firmware-b43-installer|firmware-b43legacy-installer)$' config/package-lists config/profiles 2>/dev/null; then
    echo "UNBOUNDED FIRMWARE PACKAGE: remove unrelated or mutable installer package"
    fail=1
fi
if grep -R -E -n '^pulseaudio$' config/package-lists config/profiles 2>/dev/null; then
    echo "CONFLICTING AUDIO DAEMON: use pipewire-pulse plus pulseaudio-utils"
    fail=1
fi
grep -q '^openssh-server$' config/package-lists/elizaos-common.list.chroot \
    || { echo "UNWIRED QEMU SSH: common image must install openssh-server"; fail=1; }
for generated in config/package-lists/elizaos-gui.list.chroot config/package-lists/live.list.chroot; do
    [ ! -e "${generated}" ] || { echo "GENERATED PROFILE LEAK: ${generated}"; fail=1; }
done
[ ! -d mkosi ] || { echo "STALE BUILD PATH: mkosi/ must not coexist with canonical live-build"; fail=1; }

# Systemd unit files have [Unit] + [Install] (or are .path/.target).
for f in $(find config/includes.chroot/etc/systemd -name "*.service" 2>/dev/null); do
    grep -q '^\[Unit\]' "${f}" || { echo "BAD UNIT: ${f}"; fail=1; }
done

if [ "${fail}" -eq 0 ]; then
    echo "OK: static smoke passed"
else
    echo "FAIL: static smoke had errors" >&2
fi
exit "${fail}"
