# elizaOS internal-disk installer planning boundary

This package is the deterministic, non-mutating planning foundation for the
GNOME installer launched from a persistent mkosi USB image. It supports two
product choices:

- guided whole-disk installation;
- guided installation alongside an existing Windows, Intel macOS, or Linux
  installation.

`createInstallPlan()` never edits a disk and every returned plan has
`executable: false`. `authorizeInstallPlan()` can convert that exact reviewed
plan into an executable capability only after a fresh inventory reproduces the
plan id and an expiring local-owner credential verifies. Plans and inventory
fingerprints bind the disk serial, optional WWN, firmware/sysfs path, logical
sector size, and GPT disk GUID in addition to its stable id, path, size, and
partition boundaries. The execution orchestrator then re-enumerates that exact
disk identity before every typed action,
requires a verified GPT backup, and writes a digest-chained durable journal
before and after each operation. An interrupted or inconsistent journal stops
with `InstallRecoveryRequiredError`; actions are never guessed or replayed.

`DurableFileInstallJournal` is the Linux file-backed implementation for that
boundary. It requires a pre-provisioned, canonical, owner-only directory; uses
an exclusive per-plan writer lock; appends bounded JSONL records with `fsync`
on both the file and containing directory; and refuses partial records,
symlinks, hard links, unsafe modes, stale locks, and path-like plan IDs. A lock
left by interruption is never silently removed: recovery must inspect it and
the journal before execution can continue.

`PrivilegedInstallService` is the root-side object core for a local IPC adapter.
`parseLocalInstallExecutionFrame()` accepts only raw bytes, bounds them before
JSON decoding, and accepts only the typed `execute-reviewed-plan` request. The
production adapter
must frame exactly one request per connection and reject trailing frames or
bytes. The daemon itself must run as root and requires kernel-authenticated Unix
peer credentials for a non-root process in the active, unlocked owner session.
The adapter must atomically bind those credentials to a kernel-owned,
non-reusable process-liveness handle such as `SO_PEERPIDFD`, reject transferred
connected file descriptors, and never decode that handle from request JSON. A
numeric PID followed by a `/proc` lookup is not this boundary because PID reuse
can occur between those operations. The
owner/session binding and OS credential are rechecked immediately before the
partition-table backup and every privileged disk mutation. Authorizations are
single-use, and every plan targeting the same physical disk is serialized even
when its plan id or `/dev/disk/by-id` alias differs.

`DurableFileInstallServiceState` supplies the replay and target-lock storage
for that boundary. Its pre-provisioned state topology must be owner-only and
must be reached only through trusted, non-symlink directory ancestors;
single-use owner/nonce claims are atomically created and synced without
persisting credentials. Claims have strict field bounds and a durably
serialized hard capacity; consumed records are never automatically removed,
because deletion could permit replay. Capacity exhaustion fails closed pending
an explicit recovery policy. Target locks require and use normalized serial as
their immutable physical identity. WWN remains bound into reviewed plans and
inventory fingerprints but does not select the lock namespace, so transient
WWN presence cannot split one disk across two locks. Duplicate serials
conservatively share a lock. Locks record the plan-bound kernel device
generation when available and
remain after any failed operation or process interruption for explicit
recovery. The production Unix socket adapter must obtain peer PID/UID/GID and
process liveness from the kernel and active-session membership from logind or
an equivalent OS authority; none may come from request JSON.

`LinuxInstallInventoryProvider` is the read-only Linux whole-disk probe. It
accepts only a whole-disk stable ID, resolves it through `/dev/disk/by-id`,
requires the result to be a block device, and invokes absolute-path `lsblk`,
`udevadm`, `sfdisk --verify`, and `sgdisk --verify` commands with fixed argv, a
sanitized environment, and no shell. Its parser binds serial, WWN,
firmware path, sector size, GPT and partition UUIDs, redundant GPT main/backup
integrity, exact byte boundaries,
reported mountpoints, read-only/removable state, and conservative filesystem
and encryption classifications. Unmounted ext4 filesystems are checked with
read-only `dumpe2fs`, `e2fsck -f -n`, and `resize2fs -P` probes. Clean 4 KiB
filesystems receive bounded minimum-size evidence; dirty and unhealthy ext4
filesystems protect the disk, while missing, malformed, non-4-KiB, or failed
probe output emits no shrink claim. Windows-native encryption/preparation
evidence and a separately reviewed btrfs minimum-size boundary remain required.
Unmounted btrfs filesystems are classified with `btrfs check --readonly`; only
an exit-zero report containing the clean marker and no failure diagnostics is
healthy. This deliberately emits no resize minimum because the native
minimum-device-size command requires a mounted path, which would violate this
probe's unmounted safety boundary.
Unmounted NTFS uses `ntfsresize --info --no-action --no-progress-bar`, whose
info path opens with the upstream read-only forensic flag. Successful output
must bind the exact device size before it supplies health, dirty-off, and
byte-exact minimum-size evidence. The read-only mount path does not perform the
upstream hibernation-file check, so successful output never fabricates a
hibernation-off or Fast-Startup-off claim. It also does not infer that BitLocker
is off from an NTFS signature. The planner requires independent explicit
hibernation-off evidence for any alongside plan and BitLocker-off or suspended
evidence before shrinking. Detected hibernation and dirty-journal diagnostics
remain explicit refusal state; missing tooling, malformed output, or failed
probes supply no resize claim. Opaque BitLocker volumes are classified as
Windows and refused because they cannot supply NTFS evidence.
The GPT verifier parses diagnostics as well as exit status because `sgdisk`
may report exit zero after reconstructing a corrupt backup header in memory.
The provider also resolves `/` with `findmnt` and walks its complete inverse
`lsblk` dependency list, so a target backing dm-crypt, LVM, MD RAID, or another
stacked root is protected even when `/` is not mounted directly on a partition.
An overlay, network root, failed ancestry command, or incomplete chain remains
explicitly unresolved and protects every otherwise ambiguous target.
Mount state is propagated from dm/LVM/MD descendants back to their containing
partition and is independently bound into the inventory fingerprint. Any
filesystem-specific resize evidence must agree with that observed mount state.
The provider captures a second complete hardware, GPT, partition, mount, and
boot-ancestry snapshot after all filesystem probes and requires its fingerprint
to match the first snapshot. Re-resolving only the stable symlink is not enough:
the kernel block-device number and generation sequence are also held constant,
so a same-path device replacement, repartition, mount, or protection-state
change invalidates the entire inspection instead of returning mixed-time
evidence.

`createUnixInstallServer()` provides a bounded, one-request-per-connection
AF_UNIX adapter. Its four-byte big-endian length prefix is checked before JSON
decoding; partial frames, oversized frames, and trailing bytes are rejected.
Peer PID/UID/GID must come from a trusted `LinuxUnixPeerCredentialProvider`;
the production implementation must synchronously and atomically capture Linux
`getsockopt(SO_PEERCRED)` plus a kernel-bound `SO_PEERPIDFD`/pidfd handle on the
socket accepted by this process, before any asynchronous work. Numeric-PID-only
implementations do not satisfy the interface. The logind adapter checks that
same handle before and after resolving the process's session and before and
after one `Properties.GetAll` transaction containing the session id, user,
class, state, active, locked, remote, and seat properties. It never constructs
authorization from a sequence of independently read properties. The systemd
templates own
a root-owned `0660` socket for the separately provisioned `elizaos-installer`
group and harden the service. Production listening requires
exactly one systemd-activated listener with `LISTEN_FDNAMES=installer`;
an absent descriptor name is rejected, and the adapter does not accept a
connected descriptor supplied by a caller. Connections have bounded size and
concurrency. Framing has a separate five-second default deadline. Execution
uses a configurable six-hour default bounded to one second through 24 hours,
so admitted installation work is not constrained by the framing deadline.
Execution is accepted only through an
AbortSignal-aware service declaring `confirmed-stop-or-lock-retained`: after a
timeout it must either confirm that work stopped or retain the fail-closed
physical-target lock until work reaches a known terminal state. Transport
execution timeout never claims an unabortable disk mutation was cancelled. The adapter
retains its bounded handler slot and kernel process handle until the handler
actually settles, even after the client socket is destroyed.

The package now contains a Linux N-API `SO_PEERCRED`/`SO_PEERPIDFD` provider and
a bounded `busctl`-based logind D-Bus resolver. Packaging must still build,
install, and qualify the native module, and supply dedicated group membership,
an OS credential verifier, AbortSignal-aware lock-retaining root-service
composition, and an entry point. Until all are supplied,
`/usr/libexec/elizaos-installer-service` and these unit templates must not be
installed. The package intentionally does not yet provide the OS
credential verifier, filesystem tools, GPT writer, image extractor, or
bootloader backend. Those implementations and
disposable-block-device qualification are required before the typed operation
adapter may be connected to a real disk. A production mutation backend must
open and authenticate the whole-disk block device inside its privileged method,
retain that verified descriptor through the write, and mutate through that
descriptor; reopening an inventory pathname after validation would leave a
device-replacement TOCTOU window. Tests must use inventory fixtures or
disposable virtual block devices only.

## Alongside support contract

- GPT plus UEFI is required. Intel Macs use their existing EFI System
  Partition and require preparation from macOS when APFS space must be freed.
- Windows, Intel macOS, and Linux are supported when sufficiently large,
  aligned unallocated space already exists. Existing partitions are preserved.
- Automatic shrinking is modeled only for healthy, unmounted, unencrypted NTFS,
  ext4, and btrfs volumes with trusted minimum-size evidence. Windows must have
  Fast Startup/hibernation disabled and BitLocker off or suspended.
- The planner refuses to shrink APFS, FileVault, BitLocker, LUKS, XFS, mounted,
  dirty, unhealthy, or insufficiently measured filesystems. The UI must direct
  the owner to prepare unallocated space from the existing OS, then rescan.
- Apple Silicon is not a generic EFI/APFS target. Supporting it requires a
  separate Asahi/m1n1-style boot-chain integration and hardware recovery tests;
  this planner rejects that claim for v1 until that implementation exists.

## Required executor gates

Before any release can mutate a real internal disk, implement and
hardware-test:

1. the production Unix peer-credential/logind and owner-credential adapters
   around the root-owned service core behind the existing typed operation API;
2. whole-disk inventory probes using serial/WWN/unique id, not a mutable device
   path;
3. OS-native filesystem probes and shrink tools with post-resize checks;
4. redundant partition-table backup and recovery instructions;
5. bootloader/NVRAM handling for Windows Boot Manager, Intel Mac EFI, and Linux;
6. signed mkosi image verification before extraction and expanded-root hash
   verification after installation;
7. power-loss, full-disk, cancellation, BitLocker/FileVault/LUKS, Secure Boot,
   and restore testing on each supported platform.

Run the planner checks with:

```bash
bun run --cwd packages/os/linux/installer test
bun run --cwd packages/os/linux/installer typecheck
bun run verify:installer-native
```

`verify:installer-native` is the compile/load ABI gate and performs no kernel
qualification. The dedicated Linux CI qualification uses a real cross-process
accepted AF_UNIX connection and must prove peer PID/UID/GID and pidfd live,
exited, and closed states without treating a denied syscall as a skip. A
restricted local sandbox may therefore pass the compile gate while remaining
explicitly non-qualified for the kernel boundary.
