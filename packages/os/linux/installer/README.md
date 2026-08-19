# elizaOS internal-disk installer planning boundary

This package is the deterministic, non-mutating planning foundation for the
GNOME installer launched from a persistent mkosi USB image. It supports two
product choices:

- guided whole-disk installation;
- guided installation alongside an existing Windows, Intel macOS, or Linux
  installation.

`createInstallPlan()` never edits a disk and every returned plan has
`executable: false`. A future privileged executor must re-enumerate the disk,
revalidate its stable identity, sector size, partition boundaries, filesystem
health and encryption state, and compare a newly generated plan id immediately
before each mutation. The owner confirmation token includes a canonical digest
of the complete reviewed partition/free-space inventory, so any intervening
layout or probe-evidence change requires a new review and acknowledgement.
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

Before any release can mutate a real internal disk, add and hardware-test:

1. an authenticated root-owned installer service with a typed operation API;
2. whole-disk stable identity (serial/WWN/unique id), not a mutable device path;
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
