#define _GNU_SOURCE
#include "gpt-artifact-store.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

static void artifact_name(const unsigned char digest[32], char name[69]) {
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < 32U; ++i) {
    name[2U * i] = hex[digest[i] >> 4U];
    name[2U * i + 1U] = hex[digest[i] & 15U];
  }
  memcpy(name + 64, ".gpt", 5U);
}
static int storage_guard(int directory, const struct elizaos_gpt_store_identity *id,
                          const struct elizaos_gpt_store_control *control) {
  int rc = control->check(control->context);
  if (rc) return rc < 0 ? rc : -EACCES;
  struct stat st;
  if (fstat(directory, &st) != 0) return -errno;
  if (geteuid() != 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 ||
      (st.st_mode & 07777U) != 0700U || !st.st_nlink) return -EACCES;
  if ((uint64_t)st.st_dev != id->filesystem_device ||
      (uint64_t)st.st_ino != id->directory_inode) return -ESTALE;
  struct statfs filesystem;
  if (fstatfs(directory, &filesystem) != 0) return -errno;
  if (filesystem.f_type != EXT4_SUPER_MAGIC) return -EOPNOTSUPP;
  return 0;
}
static bool safe_file(const struct stat *st, uint64_t device) {
  return S_ISREG(st->st_mode) && st->st_uid == 0 && st->st_gid == 0 &&
    (st->st_mode & 07777U) == 0600U && st->st_nlink == 1 &&
    (uint64_t)st->st_dev == device && st->st_size >= 0 &&
    (uint64_t)st->st_size <= ELIZAOS_GPT_SNAPSHOT_MAX;
}
static int file_binding(int directory, int file, const char *name,
                         const struct stat *original) {
  struct stat held, named;
  if (fstat(file, &held) != 0 || fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0)
    return -errno;
  if (!safe_file(&held, (uint64_t)original->st_dev) ||
      !safe_file(&named, (uint64_t)original->st_dev) ||
      held.st_ino != original->st_ino || named.st_ino != held.st_ino ||
      held.st_size != original->st_size || named.st_size != held.st_size ||
      held.st_mtim.tv_sec != original->st_mtim.tv_sec ||
      held.st_mtim.tv_nsec != original->st_mtim.tv_nsec ||
      held.st_ctim.tv_sec != original->st_ctim.tv_sec ||
      held.st_ctim.tv_nsec != original->st_ctim.tv_nsec) return -ESTALE;
  return 0;
}
static int write_binding(int directory, int file, const char *name,
                          const struct stat *created, size_t size) {
  struct stat current;
  if (fstat(file, &current) != 0) return -errno;
  if (current.st_ino != created->st_ino || current.st_dev != created->st_dev ||
      current.st_size < 0 || (uint64_t)current.st_size != size) return -ESTALE;
  return file_binding(directory, file, name, &current);
}
int elizaos_install_read_gpt_artifact(int directory,
    const struct elizaos_gpt_store_identity *expected,
    const unsigned char binding[32], const unsigned char digest[32],
    const struct elizaos_gpt_store_control *control,
    unsigned char *output, size_t capacity, size_t *length) {
  if (length) *length = 0;
  if (!expected || !binding || !digest || !control || !control->check || !output || !length)
    return -EINVAL;
  const struct elizaos_gpt_store_identity id = *expected;
  const struct elizaos_gpt_store_control hooks = *control;
  unsigned char saved_binding[32], saved_digest[32];
  memcpy(saved_binding, binding, 32U); memcpy(saved_digest, digest, 32U);
  int rc = storage_guard(directory, &id, &hooks);
  if (rc) return rc;
  char name[69]; artifact_name(saved_digest, name);
  const int file = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (file < 0) return -errno;
  unsigned char *copy = NULL;
  struct stat st;
  if (fstat(file, &st) != 0) { rc = -errno; goto finish_read; }
  if (!safe_file(&st, id.filesystem_device) || st.st_size < 128) { rc = -EINVAL; goto finish_read; }
  const size_t size = (size_t)st.st_size;
  if (size > capacity) { rc = -ENOBUFS; goto finish_read; }
  copy = malloc(size);
  if (!copy) { rc = -ENOMEM; goto finish_read; }
  size_t used = 0;
  while (used < size) {
    if ((rc = storage_guard(directory, &id, &hooks))) goto finish_read;
    const size_t amount = size - used < 65536U ? size - used : 65536U;
    const ssize_t got = pread(file, copy + used, amount, (off_t)used);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) { rc = got < 0 ? -errno : -EIO; goto finish_read; }
    used += (size_t)got;
  }
  if ((rc = elizaos_install_verify_gpt_snapshot(copy, size, saved_binding, saved_digest)) ||
      (rc = file_binding(directory, file, name, &st)) ||
      (rc = storage_guard(directory, &id, &hooks))) goto finish_read;
  if (fsync(file) != 0) { rc = -errno; goto finish_read; }
  if ((rc = storage_guard(directory, &id, &hooks))) goto finish_read;
  if (fsync(directory) != 0) { rc = -errno; goto finish_read; }
  if ((rc = file_binding(directory, file, name, &st)) ||
      (rc = storage_guard(directory, &id, &hooks))) goto finish_read;
  memcpy(output, copy, size);
  *length = size;
finish_read:
  if (close(file) != 0 && !rc) rc = -EIO;
  if (rc) *length = 0;
  free(copy);
  return rc;
}
static void progress(const struct elizaos_gpt_store_control *control,
                       enum elizaos_gpt_store_step step) {
  if (control->progress) control->progress(control->context, step);
}
int elizaos_install_store_gpt_artifact(int directory,
    const struct elizaos_gpt_store_identity *expected,
    const unsigned char binding[32], const unsigned char *data, size_t length,
    const unsigned char digest[32], const struct elizaos_gpt_store_control *control,
    struct elizaos_gpt_store_result *result) {
  if (!result) return -EINVAL;
  memset(result, 0, sizeof(*result)); result->error = -EINVAL;
  if (!expected || !binding || !data || !digest || !control || !control->check ||
      length < 128U || length > ELIZAOS_GPT_SNAPSHOT_MAX) return result->error;
  const struct elizaos_gpt_store_identity id = *expected;
  const struct elizaos_gpt_store_control hooks = *control;
  unsigned char saved_binding[32], saved_digest[32];
  memcpy(saved_binding, binding, 32U); memcpy(saved_digest, digest, 32U);
  unsigned char *copy = malloc(length);
  if (!copy) { result->error = -ENOMEM; return result->error; }
  memcpy(copy, data, length);
  int file = -1;
  int rc = elizaos_install_verify_gpt_snapshot(copy, length, saved_binding, saved_digest);
  if (rc || (rc = storage_guard(directory, &id, &hooks))) goto finish_store;
  char name[69]; artifact_name(saved_digest, name);
  result->create_attempted = 1;
  file = openat(directory, name, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (file < 0) { rc = -errno; goto finish_store; }
  result->created = 1;
  struct stat st;
  if (fstat(file, &st) != 0) { rc = -errno; goto finish_store; }
  if (!safe_file(&st, id.filesystem_device) || st.st_size != 0) { rc = -EACCES; goto finish_store; }
  progress(&hooks, ELIZAOS_GPT_STORE_CREATED);
  size_t used = 0;
  while (used < length) {
    if ((rc = storage_guard(directory, &id, &hooks)) ||
        (rc = write_binding(directory, file, name, &st, used))) goto finish_store;
    const size_t amount = length - used < 65536U ? length - used : 65536U;
    const ssize_t wrote = pwrite(file, copy + used, amount, (off_t)used);
    if (wrote < 0 && errno == EINTR) continue;
    if (wrote <= 0) { rc = wrote < 0 ? -errno : -EIO; goto finish_store; }
    used += (size_t)wrote;
    result->bytes_written += (uint64_t)wrote;
  }
  progress(&hooks, ELIZAOS_GPT_STORE_WRITTEN);
  if ((rc = storage_guard(directory, &id, &hooks)) ||
      (rc = write_binding(directory, file, name, &st, length))) goto finish_store;
  if (fsync(file) != 0) { rc = -errno; goto finish_store; }
  result->file_synced = 1;
  progress(&hooks, ELIZAOS_GPT_STORE_FILE_SYNCED);
  if ((rc = storage_guard(directory, &id, &hooks)) ||
      (rc = write_binding(directory, file, name, &st, length))) goto finish_store;
  if (fsync(directory) != 0) { rc = -errno; goto finish_store; }
  result->directory_synced = 1;
  progress(&hooks, ELIZAOS_GPT_STORE_DIRECTORY_SYNCED);
  if ((rc = storage_guard(directory, &id, &hooks)) ||
      (rc = write_binding(directory, file, name, &st, length))) goto finish_store;
  if (close(file) != 0) { file = -1; rc = -EIO; goto finish_store; }
  file = -1;
  size_t read_length = 0;
  rc = elizaos_install_read_gpt_artifact(directory, &id, saved_binding, saved_digest,
                                        &hooks, copy, length, &read_length);
  if (!rc && read_length != length) rc = -ESTALE;
  if (!rc) {
    result->verified = 1;
    progress(&hooks, ELIZAOS_GPT_STORE_VERIFIED);
  }
finish_store:
  if (file >= 0 && close(file) != 0 && !rc) rc = -EIO;
  free(copy);
  result->error = rc;
  return rc;
}
