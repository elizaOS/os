# Linux Restore privileged-helper foundation

Linux Restore is **not available** in the application. This package contains a
native identity-retention gate and an executable TypeScript safety model so the
future privileged boundary can be reviewed and tested without exposing a
destructive capability.

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

## Requirements before mutation can be implemented

A later change must be reviewed as a new security boundary and must include all
of the following in one testable design:

1. A narrowly scoped privileged broker that authenticates the initiating local
   user and writes one exact, expiring, current-boot authorization. It must
   never reissue a plan ID during that boot. The application must not write the
   trusted state directory directly.
2. Absolute, pinned executable paths and constant argv/environment for every
   tool. No shell, `PATH` lookup, caller-controlled option, or requested device
   pathname may reach a child process.
3. Only retained descriptors passed at fixed child FD numbers. Every tool must
   address the target as `/proc/self/fd/<n>`. All other inherited descriptors
   must be closed.
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
2. Create one GPT Microsoft Basic Data partition using `/usr/sbin/parted` and
   verify the table using `/usr/sbin/sfdisk`, both through
   `/proc/self/fd/3`.
3. Revalidate, issue `BLKRRPART` on the retained FD, run the fixed bounded
   `/usr/bin/udevadm settle --timeout=10`, then open partition 1 and bind its
   sysfs parent and disk sequence back to the retained whole device.
4. After another cancellation check and identity validation, create exFAT with
   `/usr/sbin/mkfs.exfat` and verify it read-only with
   `/usr/sbin/fsck.exfat`, both through `/proc/self/fd/4`.
5. Sync and revalidate both retained identities before success is possible.

Cancellation is checked immediately before and after every bounded child,
after revalidating the retained identity appropriate to that boundary.
Cancellation before the durable consumed marker is `untouched`. Cancellation,
timeout, signal, malformed or oversized child output, nonzero exit, unplug, or
identity drift after that marker is always terminal `incomplete`; it can never
be translated to success. Cancellation is observed between bounded tools, not
by pretending an interrupted partition or filesystem write was rolled back.

The default unit test can prove that the exact `parted`, `sfdisk`,
`mkfs.exfat`, and `fsck.exfat` builds installed on a runner accept inherited
regular-file descriptors, and that the constant udev settle command completes.
That is useful pathname/argv evidence but **not block-device qualification**.
The production gate remains closed until an isolated privileged job repeats the
exact process shapes on disposable loop or `scsi_debug` media and exercises
kernel reread, partition-FD retention, unplug, name reuse, timeout, signal, and
every failure boundary. No real disk is an acceptable qualification target.
