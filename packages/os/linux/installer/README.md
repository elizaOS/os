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
probe output emits no shrink claim. Dedicated btrfs and Windows-native health,
encryption, hibernation, and minimum-size probes are still required.
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

The package intentionally does not yet provide the root service, OS-native
inventory probes, filesystem tools, GPT writer, image extractor, or bootloader
backend. Those implementations and disposable-block-device qualification are
required before the typed operation adapter may be connected to a real disk.
Tests must use inventory fixtures or disposable virtual block devices only.

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

1. the authenticated root-owned service behind the existing typed operation
   API;
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
```
