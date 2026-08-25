#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../../../.." && pwd)"
RM_PATH_RECURSIVE="$REPO_ROOT/packages/scripts/rm-path-recursive.mjs"
TMP_DIR="$(mktemp -d)"
cleanup() {
  node "$RM_PATH_RECURSIVE" "$TMP_DIR"
}
trap cleanup EXIT

pass() {
  echo "ok - $*"
}

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local needle="$2"
  grep -Fq -- "$needle" "$file" || {
    echo "missing expected text: $needle" >&2
    echo "--- output ---" >&2
    sed -n '1,200p' "$file" >&2
    fail "assert_contains failed"
  }
}

BIN_DIR="$TMP_DIR/bin"
ARTIFACT_DIR="$TMP_DIR/artifacts"
mkdir -p "$BIN_DIR" "$ARTIFACT_DIR"
printf 'boot-image-fixture\n' >"$ARTIFACT_DIR/boot.img"
printf 'vendor-boot-image-fixture\n' >"$ARTIFACT_DIR/vendor_boot.img"
printf 'vendor-kernel-boot-image-fixture\n' >"$ARTIFACT_DIR/vendor_kernel_boot.img"
printf 'super-image-fixture\n' >"$ARTIFACT_DIR/super.img"

cat >"$BIN_DIR/adb" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"devices -l"*) printf 'List of devices attached\nTEST123 device usb:1-1 product:test model:Test device:tegu\n' ;;
  *"get-state"*) echo device ;;
  *"getprop ro.product.device"*) echo tegu ;;
  *"getprop ro.build.fingerprint"*) echo 'elizaOS/eliza_tegu_phone/tegu:15/example:userdebug/test-keys' ;;
  *"getprop ro.boot.slot_suffix"*) echo '_a' ;;
  *"getprop sys.boot_completed"*) echo 1 ;;
  *"pm path ai.elizaos.app"*) echo 'package:/system/priv-app/Eliza/Eliza.apk' ;;
  *"cmd role get-role-holders android.app.role.HOME"*) echo 'ai.elizaos.app' ;;
  *"cmd package resolve-activity"*) echo 'ai.elizaos.app/.MainActivity' ;;
  *"dumpsys package ai.elizaos.app"*) echo 'Package [ai.elizaos.app]' ;;
  *"dumpsys activity activities"*) echo 'mResumedActivity: ai.elizaos.app/.MainActivity' ;;
  *"pidof ai.elizaos.app"*) echo 31337 ;;
  *"toybox nc -w 5 127.0.0.1 31337"*)
    if [[ "${FAKE_AGENT_HEALTH_STATUS:-200}" == 200 ]]; then
      health_body="${FAKE_AGENT_HEALTH_BODY:-}"
      [[ -n "$health_body" ]] || health_body='{"status":"ready","agentId":"fixture"}'
      printf 'HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n%s\n' \
        "$health_body"
    else
      printf 'HTTP/1.0 %s Unavailable\r\nContent-Type: application/json\r\n\r\n{"status":"unhealthy"}\n' "$FAKE_AGENT_HEALTH_STATUS"
    fi
    ;;
  *"logcat -d"*) echo 'logcat clean' ;;
  *"settings get global adb_enabled"*) echo 1 ;;
  *) echo "fake adb $*" ;;
esac
EOF

cat >"$BIN_DIR/fastboot" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"getvar unlocked"*) echo 'unlocked: yes' >&2 ;;
  *"getvar product"*) echo 'product: tegu' >&2 ;;
  *) echo "fake fastboot $*" ;;
esac
EOF

cat >"$BIN_DIR/timeout" <<'EOF'
#!/usr/bin/env bash
shift
exec "$@"
EOF

chmod +x "$BIN_DIR/adb" "$BIN_DIR/fastboot" "$BIN_DIR/timeout"
export PATH="$BIN_DIR:$PATH"

INSTALL_OUT="$TMP_DIR/install.out"
"$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" >"$INSTALL_OUT"
assert_contains "$INSTALL_OUT" "Dry-run only. No commands were executed."
assert_contains "$INSTALL_OUT" "fastboot flash boot"
assert_contains "$INSTALL_OUT" "fastboot flash vendor_boot"
assert_contains "$INSTALL_OUT" "fastboot flash vendor_kernel_boot"
assert_contains "$INSTALL_OUT" "fastboot flash super"
pass "installer dry-run plans discovered images"

FLASH_REFUSAL_OUT="$TMP_DIR/flash-refusal.out"
if "$ROOT/install-elizaos-android.sh" \
  --artifact-dir "$ARTIFACT_DIR" \
  --execute --confirm-flash >"$FLASH_REFUSAL_OUT" 2>&1; then
  fail "installer accepted a flash without a release manifest"
fi
assert_contains "$FLASH_REFUSAL_OUT" "--confirm-flash requires --manifest"
pass "installer refuses unmanifested flashing"

CANDIDATE_REFUSAL_OUT="$TMP_DIR/candidate-refusal.out"
if "$ROOT/install-elizaos-android.sh" \
  --artifact-dir "$ARTIFACT_DIR" \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute --confirm-flash >"$CANDIDATE_REFUSAL_OUT" 2>&1; then
  fail "installer accepted a non-lab-validated device manifest"
fi
assert_contains "$CANDIDATE_REFUSAL_OUT" "no lab-validated device codename"
pass "installer refuses candidate-only hardware manifests"

VALIDATE_OUT="$TMP_DIR/validate.out"
"$ROOT/scripts/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  >"$VALIDATE_OUT"
assert_contains "$VALIDATE_OUT" "Dry-run only. No ADB commands were executed."
assert_contains "$VALIDATE_OUT" "ro.product.device=tegu"
assert_contains "$VALIDATE_OUT" "ro.build.fingerprint^=elizaOS/eliza_tegu_phone/tegu:"
pass "post-flash validator dry-run reads manifest expectations"

VALIDATE_EXEC_OUT="$TMP_DIR/validate-exec.out"
"$ROOT/scripts/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute \
  >"$VALIDATE_EXEC_OUT"
assert_contains "$VALIDATE_EXEC_OUT" "+ adb -s TEST123 get-state"
assert_contains "$VALIDATE_EXEC_OUT" "cmd role get-role-holders android.app.role.HOME"
assert_contains "$VALIDATE_EXEC_OUT" "toybox nc -w 5 127.0.0.1 31337"
if grep -Fq "shell curl" "$VALIDATE_EXEC_OUT"; then
  fail "post-flash validator still depends on an on-device curl binary"
fi
pass "post-flash validator execute path works with fake adb"

UNHEALTHY_OUT="$TMP_DIR/validate-unhealthy.out"
if FAKE_AGENT_HEALTH_STATUS=503 "$ROOT/scripts/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute >"$UNHEALTHY_OUT" 2>&1; then
  fail "post-flash validator accepted a non-200 agent health response"
fi
assert_contains "$UNHEALTHY_OUT" "agent health probe did not return HTTP 200"
pass "post-flash validator rejects unhealthy HTTP status"

UNHEALTHY_BODY_OUT="$TMP_DIR/validate-unhealthy-body.out"
if FAKE_AGENT_HEALTH_BODY='{"status":"unhealthy"}' "$ROOT/scripts/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute >"$UNHEALTHY_BODY_OUT" 2>&1; then
  fail "post-flash validator accepted an unhealthy HTTP 200 agent response body"
fi
assert_contains "$UNHEALTHY_BODY_OUT" "agent health probe body did not return ready/ok/healthy"
pass "post-flash validator rejects unhealthy HTTP 200 body"

UNSAFE_HEALTH_OUT="$TMP_DIR/validate-unsafe-health-url.out"
if "$ROOT/scripts/validate-post-flash.sh" \
  --agent-health-url https://example.com/api/health \
  >"$UNSAFE_HEALTH_OUT" 2>&1; then
  fail "post-flash validator accepted a non-local agent health URL"
fi
assert_contains "$UNSAFE_HEALTH_OUT" "must be an explicit http://127.0.0.1:PORT/PATH endpoint"
pass "post-flash validator rejects non-local health endpoints"

MANIFEST_OUT="$TMP_DIR/manifest.out"
node "$ROOT/scripts/validate-release-manifest.mjs" \
  "$ROOT/manifests/android-release-manifest.example.json" \
  >"$MANIFEST_OUT"
assert_contains "$MANIFEST_OUT" "manifest ok: elizaos-android-example-2026.05.0"
pass "manifest validator accepts example manifest"

INELIGIBLE_MANIFEST="$TMP_DIR/ineligible-lab-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$INELIGIBLE_MANIFEST" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
manifest.supportedDevices[0].tier = 'lab-validated';
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
INELIGIBLE_OUT="$TMP_DIR/ineligible-lab.out"
if node "$ROOT/scripts/validate-release-manifest.mjs" \
  "$INELIGIBLE_MANIFEST" >"$INELIGIBLE_OUT" 2>&1; then
  fail "manifest validator promoted an installer-ineligible hardware target"
fi
assert_contains "$INELIGIBLE_OUT" "cannot be lab-validated while this target is installer-ineligible"
pass "manifest validator refuses inventory-bypassing lab promotion"

INCOMPLETE_EVIDENCE_MANIFEST="$TMP_DIR/incomplete-evidence-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$INCOMPLETE_EVIDENCE_MANIFEST" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
manifest.validation.requiredValidationTokens = ['pm path'];
manifest.buildFingerprint = 'elizaOS/wrong/tegu:15/example:userdebug/test-keys';
delete manifest.rollback.previousReleaseId;
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
INCOMPLETE_EVIDENCE_OUT="$TMP_DIR/incomplete-evidence.out"
if node "$ROOT/scripts/validate-release-manifest.mjs" \
  "$INCOMPLETE_EVIDENCE_MANIFEST" >"$INCOMPLETE_EVIDENCE_OUT" 2>&1; then
  fail "manifest validator accepted incomplete runtime/rollback evidence"
fi
assert_contains "$INCOMPLETE_EVIDENCE_OUT" 'must include "cmd role get-role-holders"'
assert_contains "$INCOMPLETE_EVIDENCE_OUT" "must start with elizaOS/eliza_tegu_phone/tegu:"
assert_contains "$INCOMPLETE_EVIDENCE_OUT" "must identify a retained known-good release"
pass "manifest validator enforces runtime and rollback evidence contracts"

HASH_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/boot.img")"
HASH_VENDOR_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/vendor_boot.img")"
HASH_VENDOR_KERNEL_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/vendor_kernel_boot.img")"
HASH_SUPER="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/super.img")"
ARTIFACT_MANIFEST="$TMP_DIR/release-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$ARTIFACT_MANIFEST" "$HASH_BOOT" "$HASH_VENDOR_BOOT" "$HASH_VENDOR_KERNEL_BOOT" "$HASH_SUPER" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target, bootHash, vendorBootHash, vendorKernelBootHash, superHash] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
manifest.artifacts[0].sha256 = bootHash;
manifest.artifacts[1].sha256 = vendorBootHash;
manifest.artifacts[2].sha256 = vendorKernelBootHash;
manifest.artifacts[3].sha256 = superHash;
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

ARTIFACT_VALIDATE_OUT="$TMP_DIR/artifact-validate.out"
node "$ROOT/scripts/validate-release-manifest.mjs" \
  "$ARTIFACT_MANIFEST" \
  --artifact-dir "$ARTIFACT_DIR" \
  >"$ARTIFACT_VALIDATE_OUT"
assert_contains "$ARTIFACT_VALIDATE_OUT" "artifacts ok: $ARTIFACT_DIR"
pass "manifest validator checks artifact size and hashes"

EXTRA_ARTIFACT_DIR="$TMP_DIR/artifacts-with-extra-image"
mkdir -p "$EXTRA_ARTIFACT_DIR"
cp "$ARTIFACT_DIR/boot.img" "$EXTRA_ARTIFACT_DIR/boot.img"
cp "$ARTIFACT_DIR/vendor_boot.img" "$EXTRA_ARTIFACT_DIR/vendor_boot.img"
cp "$ARTIFACT_DIR/vendor_kernel_boot.img" "$EXTRA_ARTIFACT_DIR/vendor_kernel_boot.img"
cp "$ARTIFACT_DIR/super.img" "$EXTRA_ARTIFACT_DIR/super.img"
printf 'undeclared-dtbo-image\n' >"$EXTRA_ARTIFACT_DIR/dtbo.img"
EXTRA_ARTIFACT_OUT="$TMP_DIR/extra-artifact.out"
if node "$ROOT/scripts/validate-release-manifest.mjs" \
  "$ARTIFACT_MANIFEST" \
  --artifact-dir "$EXTRA_ARTIFACT_DIR" >"$EXTRA_ARTIFACT_OUT" 2>&1; then
  fail "manifest validator accepted an undeclared image that the installer would flash"
fi
assert_contains "$EXTRA_ARTIFACT_OUT" "dtbo.img: image is not declared by the release manifest"
pass "manifest validator refuses undeclared flash images"
