# Internal installer issue ledger

These are implementation issues, not claims of completed installation support.
The current package produces deterministic plans with `executable: false` and
never changes a partition table.

## P0 — trusted inventory and execution boundary

- **Implement the privileged inventory service.** Return whole-disk stable ID,
  current-boot ancestry, sector geometry, GPT primary/backup validity, exact
  partition/free extents, filesystem health, mount state, encryption state,
  hibernation/Fast Startup state, and shrink minimums. Validate its serialized
  schema before creating a plan.
- **Implement plan revalidation and authorization.** Immediately before every
  mutation, reproduce the inventory fingerprint and plan ID, require the active
  local owner's confirmation, and reject any path, size, identity, geometry, or
  evidence drift. Do not accept renderer-supplied commands or device paths.
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
