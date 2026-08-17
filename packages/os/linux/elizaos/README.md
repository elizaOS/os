# elizaOS Debian image

This is the canonical multi-architecture Debian live-build tree for elizaOS.
It produces reproducible Debian trixie images without inheriting Tails package
lists, branding, services, privacy claims, or release machinery.

## Profiles

- `default`: headless base image.
- `gui`: GNOME desktop, elizaOS taskbar, PipeWire, and packaged app/fallback
  browser integration.
The supported architecture contract is `amd64`, `arm64`, and `riscv64`.
An architecture is not release-ready until its current artifact has boot and
runtime evidence. The amd64 GUI profile requires a native packaged Electrobun
app. Other architectures use the explicit Epiphany fallback until matching
native artifacts are published; that fallback is not native-app parity.

## Build

```bash
make build ARCH=amd64 PROFILE=gui PACKAGED_APP=/absolute/path/to/Eliza-dev
make build ARCH=arm64 PROFILE=default
make build ARCH=riscv64 PROFILE=default
```

The build:

1. creates a fresh private source copy in the builder container;
2. configures live-build for the selected Debian architecture/profile;
3. stages the exact packaged app read-only when supplied;
4. builds a hybrid ISO;
5. validates the ISO structure and minimum size;
6. emits SHA-256 and a release manifest under `out/`.

No caches, SDKs, toolchains, signing material, model weights, or local evidence
belong in git.

## Desktop/runtime contract

The `gui` profile boots GDM into GNOME/Xorg and enables one user unit:
`elizaos-launcher.service`. The packaged app owns its embedded local runtime and
the canonical chat overlay. The fallback browser waits for the separate agent
service only when no native package is available.

The GNOME Dash-to-Dock extension supplies the bottom elizaOS taskbar. The app
starts in its translucent chat-pill mode. Its shared mobile chat state is sent
to the native host so the window changes from the resting strip to a centered
chat sheet and then to the complete work area at `MAXIMIZED`.

Always-on voice is enabled for appliance sessions with
`ELIZAOS_ALWAYS_ON_VOICE=1`. A stored user preference remains authoritative.
Actual microphone capture must be proven in the booted image; an environment
variable or unit test alone is not proof.

## Administrative authority

`/usr/local/lib/elizaos/capability-runner` is the only passwordless sudo
boundary. Structured operations validate their arguments. Owner-enabled admin
mode also permits:

```bash
capability-runner exec -- /absolute/executable arg...
```

The runner requires an absolute executable, executes without a shell, uses a
clean root environment, and logs the operation. Disabling
`/etc/elizaos/admin-mode` disables arbitrary root execution. This is deliberate
owner-level authority, not an unaudited `NOPASSWD: ALL` grant.

## Verification

```bash
make lint
scripts/boot-qemu.sh --arch amd64 --firmware bios /absolute/path/to/image.iso
scripts/boot-qemu.sh --arch amd64 --firmware uefi /absolute/path/to/image.iso
```

The image installs `openssh-server`; the QEMU helper forwards the guest's SSH
port to `localhost:2224` by default. This is an actual boot-diagnostics path,
not only a printed hint.

Release proof must be regenerated from the exact image being released. The
multi-architecture checker reports missing evidence as a release failure; it
does not substitute checked-in historical claims. Hardware support for Pixel,
Light Phone, or physical Linux devices requires separate device evidence.
