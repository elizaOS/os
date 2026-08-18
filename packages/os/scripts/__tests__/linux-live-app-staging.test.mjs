import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = join(import.meta.dirname, "../../../..");
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");

const justfile = read("packages/os/linux/Justfile");
const rootBuild = read("packages/os/linux/build.sh");
const makefile = read("packages/os/linux/elizaos/Makefile");
const imageBuild = read("packages/os/linux/elizaos/build.sh");
const autoConfig = read("packages/os/linux/elizaos/auto/config");
const dockerfile = read("packages/os/linux/elizaos/Dockerfile");
const installHook = read(
  "packages/os/linux/elizaos/config/hooks/normal/0010-elizaos-agent.hook.chroot",
);

test("the root Linux entrypoints select only the canonical Debian builder", () => {
  assert.match(rootBuild, /make -C "\$\{HERE\}\/elizaos" build/);
  assert.doesNotMatch(rootBuild, /TAILS_SRC|tails\/auto|build-iso\.sh/);
  assert.match(justfile, /make -C elizaos build/);
  assert.doesNotMatch(justfile, /tails\/config|prepare-elizaos-app-overlay/);
  assert.equal(
    existsSync(join(repositoryRoot, "packages/os/linux/tails")),
    false,
  );
  assert.equal(
    existsSync(join(repositoryRoot, "packages/os/linux/build-iso.sh")),
    false,
  );
  assert.equal(
    existsSync(join(repositoryRoot, ".github/workflows/build-vm-image.yml")),
    false,
  );
});

test("GUI builds mount one prepackaged app read-only into a private build tree", () => {
  assert.match(makefile, /PACKAGED_APP_MOUNT/);
  assert.match(makefile, /\/opt\/elizaos-packaged-app:ro/);
  assert.match(makefile, /-v "\$\(HERE\):\/src:ro"/);
  assert.match(makefile, /rsync -a \/src\//);
  assert.match(imageBuild, /stage_packaged_app_for_live_build/);
  assert.match(imageBuild, /missing executable bin\/launcher/);
  assert.match(imageBuild, /offline runtime dependency closure/);
  assert.match(
    imageBuild,
    /currently published packaged desktop artifact is amd64-only/,
  );
});

test("image builds cannot reuse checked-in or previously staged agent bytes", () => {
  assert.equal(
    existsSync(
      join(
        repositoryRoot,
        "packages/os/linux/elizaos/config/includes.chroot/opt/elizaos-artifacts",
      ),
    ),
    false,
  );
  assert.match(imageBuild, /remove_paths_recursive "\$\{CHROOT_ART\}"/);
  assert.match(
    imageBuild,
    /mount freshly staged agent artifacts or a packaged desktop app/,
  );
  assert.doesNotMatch(makefile, /ELIZAOS_REQUIRE_AGENT_ARTIFACTS/);
});

test("image builds cannot borrow another target's release manifest", () => {
  assert.match(
    imageBuild,
    /no release manifest contract for \$\{ARCH\}:\$\{PROFILE\}/,
  );
  assert.match(imageBuild, /"\$\{ARCH\}:\$\{PROFILE\}" = "riscv64:default"/);
});

test("Debian package inputs are snapshot- and digest-pinned", () => {
  const lock = JSON.parse(
    read("packages/os/linux/elizaos/debian-snapshot.lock.json"),
  );
  assert.match(lock.serial, /^[0-9]{8}T[0-9]{6}Z$/);
  assert.match(lock.baseImage, /^debian:trixie@sha256:[0-9a-f]{64}$/);
  assert.match(dockerfile, /^FROM \$\{DEBIAN_BASE_IMAGE\}$/m);
  assert.match(imageBuild, /snapshot Release digest mismatch/);
  assert.match(autoConfig, /--mirror-chroot-security/);
  assert.match(autoConfig, /Acquire::Check-Valid-Until=false/);
});

test("the image installs the packaged runtime without a duplicate service", () => {
  assert.match(installHook, /PACKAGED_APP=\/usr\/share\/elizaos\/elizaos-app/);
  assert.match(installHook, /ln -sfn "\$\{PACKAGED_APP\}\/bin\/launcher"/);
  assert.match(installHook, /It owns its embedded agent runtime/);
  assert.match(
    read(
      "packages/os/linux/elizaos/config/hooks/normal/0026-app-local-mode.hook.chroot",
    ),
    /removing separate agent services/,
  );
});

test("an explicit cold app build is Linux x64 and uses the upstream desktop builder", () => {
  assert.match(justfile, /Linux:x86_64/);
  assert.match(justfile, /desktop-build\.mjs build --env dev/);
  assert.match(justfile, /bun install --frozen-lockfile/);
  assert.match(justfile, /libelizainference\.so/);
});
