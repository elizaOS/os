# Linux Restore privileged-helper foundation

Linux Restore is **not available** in the application. This package contains a
native identity-retention gate, separate retained-FD GPT/exFAT primitives, and
an executable TypeScript safety model. The primitives are exercised in disposable
VMs and are not linked into the shipped helper or exposed by the application.

## Current boundary

The native helper:

- accepts one canonical, current-boot-bound request on standard input, capped
  at 2,048 bytes;
- emits one fixed, bounded response on standard output;
- rejects arguments, unknown fields, non-canonical integers, nested `/dev`
  paths, non-root execution, and requests without a separate root-owned exact
  plan authorization;
- opens the requested direct device node once with `O_NOFOLLOW`, retains that
  descriptor, and binds it to `st_rdev`, `BLKGETDISKSEQ`, `BLKGETSIZE64`, and a
  kernel-owned sysfs identity;
- requires the held target to be a removable whole block device; and
- always returns `NATIVE_FD_QUALIFICATION_REQUIRED` after validation. It has no
  mutation subprocess, shell invocation, policy installation, server adapter,
  or UI/capability integration.

`plan_binding` is a SHA-256 integrity binding over the canonical request,
including the exact lowercase kernel boot ID read from
`/proc/sys/kernel/random/boot_id`. It is not authentication. A future
privileged broker must authorize that exact
binding in a root-owned, mode-0600, single-link regular file at
`/run/elizaos-usb-restore/authorized/<plan-id>`. Both `authorized/` and
`consumed/`, and their parent, must already be root-owned directories with no
group or other write bits. The helper never creates this trust root.

The authorization and replay ledger are deliberately boot-scoped under `/run`.
The helper rejects a correctly digest-bound request when its boot ID differs
from the running kernel, so clearing `/run` at boot cannot revive a request from
an earlier boot. A broker must never reissue a plan ID within the same boot.
Before mutation exists, the helper validates authorization and target identity
but does not create a consumed marker. A future mutation path must atomically
create and sync that marker with `O_EXCL` immediately before its first
destructive operation, while retaining the already verified whole-device FD.

Server-side inventory and pathname probes are advisory UX only. They must never
create privileged authorization or substitute for the helper's post-open
identity checks.

## Requirements before production mutation can be enabled

A later change must be reviewed as a new security boundary and must include all
of the following in one testable design:

1. A narrowly scoped privileged broker that authenticates the initiating local
   user and writes one exact, expiring, current-boot authorization. It must
   never reissue a plan ID during that boot. The application must not write the
   trusted state directory directly.
2. Absolute, pinned executable paths and constant argv/environment for every
   tool. No shell, `PATH` lookup, caller-controlled option, or requested device
   pathname may reach a child process.
3. Only retained descriptors passed at fixed child FD numbers. A tool must
   use that descriptor itself; merely passing `/proc/self/fd/<n>` is insufficient
   if it canonicalizes and reopens a mutable device path. All other inherited
   descriptors must be closed.
4. Revalidation of the retained whole-device identity before and after every
   destructive step. Hot-unplug must fail; a new device reusing the original
   `/dev` name must never become the target.
5. A new partition opened without a second `O_EXCL` claim and retained by the
   same helper under the whole disk's existing exclusive claim, with its
   partition number, parent `dev_t`, and disk sequence bound to the still-held
   whole disk. Formatting and verification must use that partition FD, never
   its pathname.
6. A private, bounded progress protocol and explicit cancellation semantics
   that cannot leave the application claiming success after partial mutation.
7. Tests using disposable loop/scsi_debug media for unplug, kernel-name reuse,
   wrong-parent partitions, utility FD behavior, failure at every step, and
   repeat-plan races. These tests require an isolated privileged runner.
8. Physical-media evidence for every supported controller class, plus inspection
   of the produced filesystem and proof that non-target disks were unchanged.
9. Packaging review for the exact helper and utility binaries, their hashes,
   ownership/modes, and the authorization policy. Only then may capability/UI
   exposure be proposed.

The TypeScript `restoreFdQualificationProbe` models a harmless fixed `/usr/bin/stat`
probe solely to make the absolute-executable, fixed-argv, inherited-FD contract
executable in unit tests. It is not invoked by the application.

## Candidate mutation sequence (still disabled)

`linux-restore-helper-model.ts` now records the smallest candidate native
sequence and the exact process shapes which must be qualified. This is review
and qualification data only; the native helper still contains no mutation
subprocess and still returns `NATIVE_FD_QUALIFICATION_REQUIRED`.

Every candidate child uses a null standard input, the constant
`LANG=C`, `LC_ALL=C`, `PATH=/nonexistent` environment, a 15-second parent
deadline ending in `SIGKILL`, and a 256-KiB ceiling on each output stream. The
udev command also has its own 10-second deadline. A future native implementation
must drain stdout and stderr without deadlock while enforcing the ceiling
independently of whether a child exits, fails, or times out.

The candidate sequence is deliberately linear:

1. Revalidate the retained whole-device FD and durably consume the plan.
2. Create one GPT Microsoft Basic Data partition with
   `elizaos_restore_create_gpt()` from `native/restore-gpt-fd.c`. It calls
   libfdisk's `fdisk_assign_device_by_fd()` on the existing descriptor, checks
   identity before writing, fsyncs, and validates the actual primary and backup
   headers and partition arrays. The byte-level verifier checks both CRCs,
   matching disk GUIDs and arrays, the protective MBR, exact 1 MiB start and
   last usable sector, type/name/attributes, and absence of extra partitions.
   It never accepts libfdisk's in-memory repair as valid on-disk redundancy.
3. Revalidate, issue `BLKRRPART` on the retained FD, run the fixed bounded
   `/usr/bin/udevadm settle --timeout=10`, then open partition 1 and bind its
   sysfs parent and disk sequence back to the retained whole device.
4. After another cancellation check and identity validation, create exFAT with
   `/usr/libexec/elizaos-mkfs-exfat-fd` and verify it read-only with
   `/usr/libexec/elizaos-fsck-exfat-fd`. Both proposed helper binaries take
   **no arguments**, reject missing/non-block FD 4, and duplicate the inherited
   descriptor. They never open a device pathname. The formatter always creates
   label `ELIZAOS-USB`; the checker always uses read-only `-n` semantics.
5. Sync and revalidate both retained identities before success is possible.

Cancellation is checked immediately before and after every bounded child,
after revalidating the retained identity appropriate to that boundary.
Cancellation before the durable consumed marker is `untouched`. Cancellation,
timeout, signal, malformed or oversized child output, nonzero exit, unplug, or
identity drift after that marker is always terminal `incomplete`; it can never
be translated to success. Cancellation is observed between bounded tools, not
by pretending an interrupted partition or filesystem write was rolled back.

## Native dependencies and qualification

Real Debian 13 block-device testing rejected the earlier proposed command
sequence: `parted` canonicalized the descriptor path and reopened `/dev/vdb`,
the proposed `mkfs.exfat` flags were unsupported, and ordinary `mkfs.exfat`
requested a second `O_EXCL` claim that conflicts with the held whole-device
claim. Regular-file tests did not expose those defects and have been replaced
by the VM lane.

`native/build-exfat-fd.sh` builds only the formatter/checker from
[exfatprogs 1.2.9, commit 3e87676349387a119cadacd68661d2966796b7fd](https://github.com/exfatprogs/exfatprogs/tree/3e87676349387a119cadacd68661d2966796b7fd).
It verifies the archive SHA-256 before extraction and applies the checked-in
`exfatprogs-fd.patch` without fuzz. The patch restricts both entrypoints to fixed
options and changes device acquisition to `F_DUPFD_CLOEXEC` on FD 4. Build output
includes the upstream GPL license and binary digests. It installs nothing and
requires a new output directory. The GPT primitive requires libfdisk >= 2.35
for its [descriptor API](https://www.kernel.org/pub/linux/utils/util-linux/v2.41/libfdisk-docs/libfdisk-Context.html#fdisk-assign-device-by-fd).

The CI `Restore retained-FD VM` jobs run `native/qualify-restore-vm.py` with both
512-byte and 4096-byte logical sectors. Supply the pinned Debian qcow2 and
exfatprogs source archive listed in that script, a new evidence directory, and
`--sector-size 512` or `4096`. Host dependencies are `qemu-system-x86_64`,
`qemu-img`, `genisoimage`, `fdisk`, and Python 3. KVM is preferred; `--accelerator
tcg` is supported. An optional `--container-tools-image` supplies only qemu-img
and genisoimage in an unprivileged container. No host block device is passed
to QEMU or Docker.

The runner independently verifies both input digests, boots an isolated guest,
and builds the checked-in sources. The guest refuses any fixture other than
the named 512 MiB virtio target and canary, with its OS on a separate disk. It
checks wrong identity rejection without writes, corrupt primary/backup GPT
refusal, kernel reread, partition identity, and exFAT verification. It replaces
the original device nodes with nodes pointing to the canary and still completes
through the held descriptors. Both the guest and host verify the entire canary
digest is unchanged; the host also inspects the resulting partition map.
The report binds source, binary, input-image, and transcript hashes. Logs and
disk images stay outside source control.

This proves the tested native operations and name replacement behavior, not
physical USB unplug behavior or production restore. The authorization broker,
bounded child supervision, cancellation/failure checkpoint matrix, packaging,
and physical-media qualification above remain required before enabling restore.
