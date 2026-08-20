# Internal installer issue ledger

These are implementation issues, not claims of completed installation support.
The current package produces deterministic plans with `executable: false` and
contains a fail-closed authorization/journal orchestration boundary. No
root-owned service or privileged operation backend is connected, so the
package never changes a partition table.

## P0 — trusted inventory and execution boundary

- **Implement the privileged inventory service.** Return whole-disk stable ID,
  current-boot ancestry, sector geometry, GPT primary/backup validity, exact
  partition/free extents, filesystem health, mount state, encryption state,
  hibernation/Fast Startup state, and shrink minimums. The typed planner and
  executor already bind serial, optional WWN, firmware/sysfs path, logical
  sector size, and GPT disk GUID. The Linux provider now resolves stable IDs
  itself and populates those fields plus exact partition boundaries from fixed
  read-only `lsblk`, `udevadm`, `sfdisk --verify`, and `sgdisk --verify` calls.
  Redundant GPT main/backup integrity is now report-parsed, required, and
  plan-bound; an exit-zero in-memory recovery is rejected. Add boot ancestry
  through stacked devices and the
  filesystem/encryption/hibernation/shrink probes before connecting it to the
  root service.
- **Connect plan revalidation and authorization to the root service.** The
  library now reproduces the initial inventory/plan ID, verifies an expiring
  owner credential, re-enumerates before every typed action, and stops on
  identity, journal, or inventory drift. Its file-backed journal durably syncs
  every record and directory update, serializes and head-checks appends, and
  fails closed on unsafe files or interrupted locks. Provision its owner-only
  state directory, implement the OS credential verifier, and ensure the service
  accepts no renderer-supplied commands or device paths.
- **Implement recoverable GPT mutation.** Save and verify both GPT headers and
  partition entries to separate recovery media/state, perform typed operations,
  reread the kernel partition table, and prove rollback after every injected
  failure boundary.

## P0 — install-alongside platform lanes

- **Windows/UEFI.** Detect BitLocker, WinRE, dynamic disks, Storage Spaces,
  dirty NTFS, and hibernation. Preparation must run in Windows when required.
  Test NTFS shrink, ESP coexistence, Windows Boot Manager preservation, Secure
  Boot, Windows update, elizaOS removal, and recovery-key prompts.
- **Intel macOS/EFI.** Support only pre-created unallocated space in v1; never
  shrink APFS from Debian. Preserve Apple APFS containers, Preboot/Recovery, and
  EFI files. Test FileVault, macOS updates, Startup Manager, NVRAM reset, elizaOS
  removal, and Internet Recovery on named Intel Mac models.
- **Linux/UEFI.** Test ext4 and btrfs shrink with unmounted healthy filesystems;
  reject XFS/LUKS automatic shrink. Preserve other distributions' boot entries
  without taking ownership of their root filesystems. Test GRUB, systemd-boot,
  Secure Boot, encrypted hosts, and uninstall recovery.
- **Apple Silicon.** Keep the generic planner blocked. Create a separate
  Asahi/m1n1-style installation design, firmware/version matrix, recovery flow,
  and hardware test lane before advertising support.

## P0 — image installation and boot

- Stream the already verified mkosi expanded image into planned root/recovery
  partitions, verify exact hashes, regenerate machine ID/host keys, create the
  owner and persistent state, and install architecture-appropriate boot assets.
- Reuse an ESP only through namespaced files and explicit NVRAM entries. Test a
  full/undersized/read-only ESP and firmware that discards or reorders entries.
- Boot the installed system, recovery entry, and preserved host OS after normal
  install, cancellation, forced power loss, and an intentionally corrupt image.

## P1 — UX and qualification

- Show a before/after partition map, exact preserved/destroyed objects, required
  host-OS preparation, encryption/recovery implications, and a printed/exported
  recovery plan before confirmation.
- Add keyboard/screen-reader installation, low-battery/power checks, disk-health
  warnings, progress derived from verified bytes, and a no-agent safe recovery
  mode.
- Qualify whole-disk and alongside installs on the published x86_64, arm64, and
  riscv64 hardware matrix. QEMU planning evidence alone is not an installation
  or hardware-support claim.
