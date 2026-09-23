/** Read-only checks against the same authenticated release used to install. */
import fs from "node:fs";
import { requireThat } from "./release-contract.mjs";
export function readHealthToken(file) {
  requireThat(
    file,
    "--health-token-file required for authenticated boot validation",
  );
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireThat(
      stat.isFile() &&
        stat.nlink === 1 &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 4096,
      "health token must be a private regular file",
    );
    const token = fs.readFileSync(fd, "utf8").trim();
    requireThat(
      /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(token),
      "invalid health token",
    );
    return token;
  } finally {
    fs.closeSync(fd);
  }
}
export function verifyPostBoot(release, shell, expectedSlot, healthToken) {
  requireThat(
    typeof healthToken === "string" &&
      /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(healthToken),
    "health token required",
  );
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
  // Keep credentials out of argv and journals; send only over adb stdin.
  let response;
  try {
    response = shell(
      [
        "sh",
        "-c",
        '\'IFS= read -r token; printf "GET /api/health HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\nAuthorization: Bearer %s\\r\\n\\r\\n" "$token" | toybox nc -w 5 127.0.0.1 31337\'',
      ],
      { input: `${healthToken}\n` },
    );
  } catch {
    throw new Error("authenticated agent health transport failed");
  }
  requireThat(
    /^HTTP\/1\.[01] 200(?: |\r?\n)/.test(response),
    "agent health HTTP failure",
  );
  const boundary = response.indexOf("\r\n\r\n");
  requireThat(boundary >= 0, "invalid health HTTP response");
  let body;
  try {
    body = JSON.parse(response.slice(boundary + 4));
  } catch {
    throw new Error("invalid agent health JSON");
  }
  requireThat(body.ready === true, "agent health not ready");
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
