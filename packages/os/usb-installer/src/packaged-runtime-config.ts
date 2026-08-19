// Resolves durable per-user state for the packaged installer's rollback guard.
import { homedir } from "node:os";
import path from "node:path";
import { RELEASE_SEQUENCE_STATE_PATH_ENV } from "./backend/release-sequence-store";

export function configurePackagedReleaseSequenceState(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string {
  const configured = env[RELEASE_SEQUENCE_STATE_PATH_ENV];
  if (configured) return configured;

  let stateRoot: string;
  if (platform === "darwin") {
    stateRoot = path.join(userHome, "Library", "Application Support");
  } else if (platform === "win32") {
    stateRoot = env.LOCALAPPDATA || path.join(userHome, "AppData", "Local");
  } else {
    stateRoot = env.XDG_STATE_HOME || path.join(userHome, ".local", "state");
  }

  if (!path.isAbsolute(stateRoot)) {
    throw new Error("Packaged release sequence state root must be absolute.");
  }
  const statePath = path.join(
    stateRoot,
    "elizaOS",
    "usb-installer",
    "release-sequence.json",
  );
  env[RELEASE_SEQUENCE_STATE_PATH_ENV] = statePath;
  return statePath;
}
