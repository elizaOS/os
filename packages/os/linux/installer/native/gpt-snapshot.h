#ifndef ELIZAOS_INSTALL_GPT_SNAPSHOT_H
#define ELIZAOS_INSTALL_GPT_SNAPSHOT_H
#include <stddef.h>
#include <stdint.h>

#define ELIZAOS_GPT_SNAPSHOT_MAX (128U + 3U * 4096U + 2U * 4194304U)
struct elizaos_install_disk_identity {
  uint32_t major;
  uint32_t minor;
  uint64_t diskseq;
  uint64_t size_bytes;
  uint32_t sector_bytes;
};

/* Read-only internal primitive, not installed or an authorization API. Caller
 * authenticates the exact plan, excludes mounted/current-boot targets and holds
 * the exclusive whole-device claim throughout capture. binding is the trusted
 * original inventory/plan binding, not caller IPC. Output is not yet a durable
 * backup: the backend must store it on verified independent recovery media,
 * fsync file and directory, and retain its digest/identity in the journal.
 * Returns 0 or negative errno; output length is valid only on success. */
int elizaos_install_capture_gpt(int fd,
    const struct elizaos_install_disk_identity *expected,
    const unsigned char binding[32], unsigned char *output, size_t capacity,
    size_t *length, unsigned char digest[32]);

/* Verify exact artifact digest, binding, envelope and both raw GPT copies.
 * This does not verify the storage medium, target hardware, authorization,
 * filesystem payloads or successful persistence. No device is written. */
int elizaos_install_verify_gpt_snapshot(const unsigned char *data, size_t length,
    const unsigned char binding[32], const unsigned char digest[32]);
#endif
