/** Read-only checks against the same authenticated release used to install. */
import { requireThat } from "./release-contract.mjs";
export function verifyPostBoot(release, shell, expectedSlot) {
  const prop = (k) => shell(["getprop", k]).trim();
  requireThat(prop("sys.boot_completed") === "1", "Android boot not complete");
  requireThat(
    prop("ro.product.device") === release.target.codename &&
      prop("ro.build.fingerprint") === release.buildFingerprint,
    "booted wrong device/image",
  );
  requireThat(
    prop("ro.boot.slot_suffix") === `_${expectedSlot}`,
    "boot fell back to a different slot",
  );
  requireThat(
    shell(["getenforce"]).trim() === "Enforcing",
    "SELinux not enforcing",
  );
  requireThat(
    shell(["getconf", "PAGESIZE"]).trim() === String(release.target.pageSize),
    "wrong kernel page size",
  );
  const apk = "/system/priv-app/Eliza/Eliza.apk";
  requireThat(
    shell(["pm", "path", "ai.elizaos.app"]).trim() === `package:${apk}`,
    "wrong privileged app path",
  );
  requireThat(
    shell(["sha256sum", apk]).trim().split(/\s+/)[0] ===
      release.sources.applicationSha256,
    "installed APK digest mismatch",
  );
  for (const role of ["HOME", "ASSISTANT"])
    requireThat(
      shell([
        "cmd",
        "role",
        "get-role-holders",
        `android.app.role.${role}`,
      ]).trim() === "ai.elizaos.app",
      `missing ${role} role`,
    );
  requireThat(
    /^\d+(?:\s+\d+)*$/.test(shell(["pidof", "ai.elizaos.app"]).trim()),
    "agent process missing",
  );
  // Fixed command only: no manifest/device data is interpolated into shell code.
  const response = shell([
    "sh",
    "-c",
    "'printf \"GET /api/health HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n\" | toybox nc -w 5 127.0.0.1 31337'",
  ]);
  requireThat(
    /^HTTP\/1\.[01] 200(?: |\r?\n)/.test(response),
    "agent health HTTP failure",
  );
  const boundary = response.indexOf("\r\n\r\n");
  requireThat(boundary >= 0, "invalid health HTTP response");
  const body = JSON.parse(response.slice(boundary + 4));
  requireThat(
    ["ready", "ok", "healthy"].includes(body.status),
    "agent health not ready",
  );
  return {
    status: "pass",
    checks: [
      "exact-image",
      "exact-slot",
      "selinux",
      "page-size",
      "privileged-apk-digest",
      "home",
      "assistant",
      "agent-health",
    ],
  };
}
