# Linux Restore privileged-helper foundation

Linux Restore is **not available** in the application. This package contains a
native identity-retention gate, separate retained-FD GPT/exFAT primitives, a
fixed-tool process runner, and
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
   **no arguments**, reject missing/non-partition FD 4, and duplicate the inherited
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
options and changes device acquisition to `F_DUPFD_CLOEXEC` on FD 4. Missing or
invalid partition offset, device size, or sector geometry fails instead of
using the upstream regular-file defaults. Build output
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

This proves the tested native operations, name replacement, and virtual device
removal behavior, not physical USB unplug behavior or production restore. The authorization broker,
production integration of the qualified child runner, the cancellation/failure
checkpoint matrix, packaging,
and physical-media qualification above remain required before enabling restore.


## Fixed-tool native process runner

`native/restore-tool-runner.c` implements the three fixed child shapes above.
Its public API accepts only a tool enum, the already-validated partition FD (or
`-1` for udev settle), and a result record. It accepts no executable pathname,
argv, environment, or adjustable limits. Executable ownership, hashes and
packaging remain the responsibility of the future trusted helper deployment.
The runner is not linked into the shipped helper.

The child receives `/dev/null` as stdin, separate stdout/stderr pipes, and only
partition FD 4 when appropriate. It closes every other inherited descriptor,
resets signal dispositions and the signal mask, uses the fixed environment,
and executes the absolute executable without a shell. The caller's descriptor
is duplicated before pipe allocation so a closed descriptor cannot accidentally
refer to one of the runner's own pipes. A separate close-on-exec error pipe
distinguishes execution/setup failure from the utility's own nonzero status.

The parent drains both output pipes fairly, discards their content, and counts
bytes independently. Neither stream may exceed 256 KiB. Output is diagnostic
utility text, not a trusted progress protocol. A monotonic 15-second deadline,
output overflow, I/O failure, signal, or nonzero exit produces failure. The
runner creates a child process group, kills remaining group members after the
leader exits, and retains the leader unreaped until cleanup to prevent PID
reuse. It rejects non-default `SIGCHLD` disposition or `SA_NOCLDWAIT`; the future
helper must remain single-threaded with no competing child reaper.

The deadline triggers `SIGKILL`; the runner then waits for the leader to be
reaped before returning. Uninterruptible kernel I/O may delay that wait. The
caller must retain its physical-target lock throughout it. Cancellation remains
checked before and after each tool, as specified above, and must never translate
partial mutation into success or a claimed rollback. Process-group cleanup
covers the fixed trusted utilities; it is not a sandbox for arbitrary programs
that deliberately escape their group. A complete progress/cancellation protocol,
broker integration, and power-loss recovery remain unfinished.

`native/restore-tool-runner.test.c` executes harmless fixtures with no block
devices. It checks descriptor and environment isolation, stdin EOF, exact-limit
output on both streams, independent floods, hangs with open and closed pipes,
signals, nonzero exit, missing executables, invalid descriptors, invalid API
selectors, incompatible reaping policy, and descendant cleanup. CI runs it
unprivileged and again inside the disposable guest. Both sector-size VM lanes
also call the native runner for real udev settle, formatting and read-only
checking, then retain independent filesystem inspection and unchanged-canary
proof. The generic fixture entrypoint is private to the test translation unit;
it is not part of the public runtime API.


## Removal while descriptors remain open

Both VM lanes now remove the actual virtio target through a private local QMP
socket after successful formatting, checking and fsync. The guest keeps its
original whole-disk and partition descriptors open throughout removal. The
host requires the matching `DEVICE_DELETED` event, not merely a successful
`device_del` reply: [QEMU documents removal as asynchronous](https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html#command-device_del).
The guest independently waits for the original whole-disk and partition sysfs
objects to disappear. It then requires GPT create/verify to fail and both
filesystem utilities to exit nonzero through the native supervisor. A setup
error or missing executable does not count as a utility refusal.

The host hashes the entire target before removal and after the guest finishes;
stale-descriptor refusal must leave it unchanged. Both host and guest also
check the complete non-target canary digest. Reports retain the QMP completion
event, refusal results and hashes; `qmp.log` contains the handshake. The host
runner records its own source hash and refuses evidence if that file changes
mid-run. Handshake tests reject acknowledgement without removal, removal of a
different device, guest refusal, and command errors, while accepting either
ordering of the completion event and command acknowledgement.

This covers Linux virtio hot removal at a completed-operation boundary. It does
not claim physical USB electrical unplug, removal during an in-flight write,
replacement-device reuse, power-loss recovery, or the complete cancellation
checkpoint matrix. Those remain required for production qualification.


## Root helper and emulated removable USB qualification

The VM now uses the pinned Debian **generic** image, whose kernel contains USB
host/storage drivers; the previous genericcloud kernel intentionally omits them.
A separate named 512 MiB QEMU USB-storage fixture is exposed through an emulated
xHCI controller with its removable bit set. Neither a physical USB device nor a
host block device is passed through. The existing virtio target and canary retain
their roles in formatting and hot-removal tests.

`native/qualify-restore-helper.py` runs the actual disabled helper binary against
this USB fixture. It checks exact private root authorization, non-root callers,
previous-boot requests, missing state, incorrect identity, unsafe authorization
ownership/modes, symlinks, hard links, FIFOs, directories, wrong/trailing binding
bytes, writable state directories, consumed markers and device symlinks. A
correctly authorized non-removable disk remains refused. Even a valid removable
disk request must return `NATIVE_FD_QUALIFICATION_REQUIRED`, create no consumed
marker, and leave the entire USB fixture unchanged.

This testing exposed a blocking FIFO open in authorization acquisition. The
helper now opens authorization files with `O_NONBLOCK` before checking they are
private, root-owned, single-link regular files. A special file therefore fails
validation without waiting for a FIFO writer. This does not relax the ownership,
type, mode, link-count, or exact-binding checks.

The qualification-only `linux-restore-helper.qualify.c` wrapper includes the
same native helper source to exercise its private functions; it is compiled only
for the test VM and is not installed or linked into the production application.
Thirty-two attempts from sixteen synchronized workers exercise the actual
single-use marker code:
exactly one succeeds, the others report consumed, and the resulting root-owned
0600 marker contains the expected bytes. File and directory fsync calls are
retained in the syscall transcript. This proves the tested concurrent filesystem
behavior, not persistence through a power cut.

The test then creates a GPT on the disposable USB fixture and exercises the
native partition opener under its held whole-device exclusive claim. It accepts
the correct partition and rejects both a symlink and a replacement node pointing
to another disk. The host independently inspects the resulting USB GPT and
matches its final full-disk digest to the guest report. Reports bind the helper
and test-wrapper binary hashes and record each refusal case. `helper.trace` is
included in the guest transcript. This still supplies no production broker,
credential verifier, UI capability, or mutation path in the shipped helper.
