// Ed25519 trust primitives shared by release-manifest and image verification.
import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
} from "node:crypto";

export const RELEASE_PUBLIC_KEY_ENV =
  "ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64";
export const RELEASE_PUBLIC_KEY_BUILD_DEFINE =
  "__ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__";
declare const __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__:
  | string
  | undefined;
const ED25519_SIGNATURE_BYTES = 64;

function decodeStrictBase64(value: string, label: string): Buffer {
  const compact = value.trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      compact,
    )
  ) {
    throw new Error(`${label} must be canonical base64.`);
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64") !== compact) {
    throw new Error(`${label} must be canonical base64.`);
  }
  return decoded;
}

export function loadPinnedEd25519PublicKey(
  env: NodeJS.ProcessEnv = process.env,
): KeyObject {
  const compiledKey =
    typeof __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__ === "string"
      ? __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__
      : undefined;
  const encoded = compiledKey ?? env[RELEASE_PUBLIC_KEY_ENV];
  if (!encoded) {
    throw new Error(
      `Missing pinned release key: ${RELEASE_PUBLIC_KEY_ENV} is required. Production release discovery is disabled.`,
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: decodeStrictBase64(encoded, RELEASE_PUBLIC_KEY_ENV),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    throw new Error(`Invalid pinned Ed25519 release key: ${String(error)}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Pinned release key must be an Ed25519 SPKI public key.");
  }
  return key;
}

export function decodeDetachedEd25519Signature(bytes: Uint8Array): Buffer {
  if (bytes.byteLength === ED25519_SIGNATURE_BYTES) return Buffer.from(bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  const decoded = decodeStrictBase64(text, "Detached Ed25519 signature");
  if (decoded.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error(
      "Detached Ed25519 signature must decode to exactly 64 bytes.",
    );
  }
  return decoded;
}

export function assertEd25519Signature(
  data: Uint8Array,
  signatureBytes: Uint8Array,
  publicKey: KeyObject,
  label: string,
): void {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} verification requires an Ed25519 public key.`);
  }
  const signature = decodeDetachedEd25519Signature(signatureBytes);
  if (!verify(null, data, publicKey, signature)) {
    throw new Error(`${label} Ed25519 signature verification failed.`);
  }
}

export function publicKeyFingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}
