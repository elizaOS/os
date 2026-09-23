#!/usr/bin/env python3
"""Read-only native GPT capture proof; fixture writes are confined to QEMU vdd."""
import argparse
import base64
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import uuid
import zlib

MAXIMUM = 128 + 3 * 4096 + 2 * 4194304
SIZE = 512 * 1024 * 1024
MIB = 1024 * 1024
BINDING = hashlib.sha256(b"disposable GPT snapshot qualification plan").digest()


class Identity(ctypes.Structure):
    _fields_ = [("major", ctypes.c_uint32), ("minor", ctypes.c_uint32),
                ("diskseq", ctypes.c_uint64), ("size_bytes", ctypes.c_uint64),
                ("sector_bytes", ctypes.c_uint32)]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(fd):
    h = hashlib.sha256()
    for offset in range(0, SIZE, MIB):
        block = os.pread(fd, MIB, offset)
        require(len(block) == MIB, "short fixture read")
        h.update(block)
    return h.hexdigest()


def identity(fd):
    st = os.fstat(fd)
    return Identity(os.major(st.st_rdev), os.minor(st.st_rdev),
                    struct.unpack("Q", fcntl.ioctl(fd, 0x80081280, bytes(8)))[0],
                    struct.unpack("Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0],
                    struct.unpack("I", fcntl.ioctl(fd, 0x1268, bytes(4)))[0])


def fixture(sector, count=128, stride=128, moved=False, fault=None):
    last = SIZE // sector - 1
    span = ((count * stride + sector - 1) // sector) * sector
    first_array = 8 if moved else 2
    last_array = last - span // sector - (4 if moved else 0)
    first_usable, last_usable = first_array + span // sector, last_array - 1
    entries = bytearray(span)
    for index, (start, end, kind, name) in enumerate([
        (MIB // sector, 65 * MIB // sector - 1, "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", "EFI fixture"),
        (128 * MIB // sector, 256 * MIB // sector - 1, "0fc63daf-8483-4772-8e79-3d69d8477de4", "Linux fixture"),
    ]):
        if fault == "overlap" and index == 1:
            start = MIB // sector + 8
        if fault == "outside-usable" and index == 0:
            start = first_usable - 1
        offset = index * stride
        entries[offset:offset + 16] = uuid.UUID(kind).bytes_le
        guid_index = 0 if fault == "duplicate-guid" else index
        entries[offset + 16:offset + 32] = uuid.UUID(int=guid_index + 11).bytes_le
        struct.pack_into("<QQQ", entries, offset + 32, start, end, 0)
        encoded = name.encode("utf-16-le")
        entries[offset + 56:offset + 56 + len(encoded)] = encoded
    if fault == "reserved-entry" and stride > 128:
        entries[128] = 1
    array_crc = zlib.crc32(entries[:count * stride])

    def header(current, other, array, secondary):
        h = bytearray(sector)
        struct.pack_into("<8sIIIIQQQQ16sQIII", h, 0, b"EFI PART", 0x10000, 92, 0, 0,
                         current, other, first_usable, last_usable,
                         uuid.UUID(int=99 if secondary and fault == "different-disk-guid" else 9).bytes_le,
                         array, count, stride, array_crc)
        struct.pack_into("<I", h, 16, zlib.crc32(h[:92]))
        return h

    mbr = bytearray(sector)
    mbr[:16] = b"test boot code!!"
    # Exercise a valid protective record outside the first MBR slot too.
    slot = 2 if moved else 0
    mbr[446 + slot * 16 + 4] = 0xee
    struct.pack_into("<II", mbr, 446 + slot * 16 + 8, 1, last)
    mbr[510:512] = b"\x55\xaa"
    return [(0, mbr), (sector, header(1, last, first_array, False)),
            (first_array * sector, entries), (last_array * sector, entries),
            (last * sector, header(last, 1, last_array, True))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disposable-vm", action="store_true", required=True)
    parser.add_argument("--sector-size", type=int, choices=[512, 4096], required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0 and Path("/sys/class/dmi/id/sys_vendor").read_text().strip() == "QEMU",
            "QEMU root fixture required")
    require(Path("/sys/class/block/vdd/serial").read_text().strip() == "ELIZAOS-GPT-TEST" and
            Path("/sys/class/block/vdd/size").read_text().strip() == "1048576", "wrong GPT fixture")
    require(Path("/sys/class/block/vdc/serial").read_text().strip() == "ELIZAOS-CANARY", "wrong canary")
    root = subprocess.check_output(["/usr/bin/findmnt", "-n", "-o", "SOURCE", "/"], text=True, timeout=10)
    require(root.strip().startswith("/dev/vda"), "wrong VM root disk")
    library = ctypes.CDLL("/root/gpt-snapshot.so")
    capture = library.elizaos_install_capture_gpt
    capture.argtypes = [ctypes.c_int, ctypes.POINTER(Identity), ctypes.c_void_p, ctypes.c_void_p,
                        ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p]
    capture.restype = ctypes.c_int
    verify = library.elizaos_install_verify_gpt_snapshot
    verify.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    verify.restype = ctypes.c_int
    output, result_digest = ctypes.create_string_buffer(MAXIMUM), ctypes.create_string_buffer(32)
    fd = os.open("/dev/vdd", os.O_RDWR | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    canary = os.open("/dev/vdc", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    before_canary = digest(canary)
    expected = identity(fd)
    require(expected.size_bytes == SIZE and expected.sector_bytes == args.sector_size, "wrong geometry")
    cases = []

    def snapshot(want=0, test_identity=None, capacity=MAXIMUM, descriptor=None):
        length = ctypes.c_size_t(123)
        rc = capture(fd if descriptor is None else descriptor,
                     ctypes.byref(test_identity or expected), BINDING, output, capacity,
                     ctypes.byref(length), result_digest)
        require(rc == want, f"capture returned {rc}, expected {want}")
        if rc:
            require(length.value == 0, "failed capture advertised usable bytes")
            return None
        artifact = output.raw[:length.value]
        require(hashlib.sha256(artifact).digest() == result_digest.raw, "native digest differs")
        require(verify(artifact, len(artifact), BINDING, result_digest) == 0, "native snapshot verification failed")
        return artifact

    def write_regions(regions):
        for offset, data in regions:
            require(os.pwrite(fd, data, offset) == len(data), "short GPT fixture write")
        os.fsync(fd)

    layouts = []
    for count, stride, moved in [(128, 128, False), (256, 256, True), (129, 128, True)]:
        regions = fixture(args.sector_size, count, stride, moved)
        write_regions(regions)
        before = digest(fd)
        artifact = snapshot()
        cursor = 128
        for _, data in regions:
            require(artifact[cursor:cursor + len(data)] == data, "snapshot changed original GPT bytes")
            cursor += len(data)
        require(cursor == len(artifact) and digest(fd) == before, "capture changed target or artifact extent")
        layouts.append({"entries": count, "entryBytes": stride, "relocatedArrays": moved,
                        "artifactBytes": len(artifact), "unchanged": True})
    for fault in ["overlap", "outside-usable", "duplicate-guid", "different-disk-guid", "reserved-entry"]:
        write_regions(fixture(args.sector_size, 256, 256, True, fault))
        before = digest(fd)
        snapshot(want=-errno.EUCLEAN)
        require(digest(fd) == before, "rejected capture changed disk")
        cases.append(fault)
    regions = fixture(args.sector_size)
    write_regions(regions)
    artifact = snapshot()
    for offset, region in regions:
        changed = bytearray(region)
        changed[16 if region[:8] == b"EFI PART" else 0 if offset else 510] ^= 1
        os.pwrite(fd, changed, offset)
        os.fsync(fd)
        snapshot(want=-errno.EUCLEAN)
        os.pwrite(fd, region, offset)
        os.fsync(fd)
        cases.append(f"raw-corruption-{offset}")
    for field in ["major", "minor", "diskseq", "size_bytes", "sector_bytes"]:
        wrong = Identity.from_buffer_copy(expected)
        setattr(wrong, field, (4096 if args.sector_size == 512 else 512) if field == "sector_bytes"
                else getattr(wrong, field) + (args.sector_size if field == "size_bytes" else 1))
        snapshot(want=-errno.ESTALE, test_identity=wrong)
        cases.append(f"identity-{field}")
    snapshot(want=-errno.ENOBUFS, capacity=1)
    cases.append("small-output")
    regular = os.open("/root/gpt-regular-fixture", os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        snapshot(want=-errno.ENOTBLK, descriptor=regular)
    finally:
        os.close(regular)
    cases.append("regular-file")
    corrupted = bytearray(artifact)
    corrupted[-1] ^= 1
    require(verify(bytes(corrupted), len(corrupted), BINDING, hashlib.sha256(artifact).digest()) == -errno.EBADMSG,
            "changed artifact digest accepted")
    require(verify(artifact, len(artifact), bytes(32), hashlib.sha256(artifact).digest()) < 0,
            "wrong binding accepted")
    for malformed in [artifact[:-1], artifact + b"trailing"]:
        require(verify(malformed, len(malformed), BINDING, hashlib.sha256(malformed).digest()) < 0,
                "rehashed malformed envelope accepted")
    cases += ["artifact-digest", "artifact-binding", "truncated-envelope", "trailing-envelope"]
    fcntl.ioctl(fd, 0x125f)  # BLKRRPART, fixture only; native capture never issues it.
    subprocess.run(["/usr/bin/udevadm", "settle", "--timeout=10"], check=True, timeout=15)
    partition = os.open("/dev/vdd1", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        snapshot(want=-errno.EINVAL, descriptor=partition, test_identity=identity(partition))
    finally:
        os.close(partition)
    cases.append("partition-descriptor")
    final = digest(fd)
    os.close(fd)
    fd = os.open("/dev/vdd", os.O_RDONLY | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    require(snapshot() == artifact and digest(fd) == final, "read-only descriptor capture differs")
    os.close(fd)
    fd = os.open("/dev/vdd", os.O_WRONLY | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    snapshot(want=-errno.EACCES)
    os.close(fd)
    cases.append("write-only")
    require(digest(canary) == before_canary, "non-target canary changed")
    os.close(canary)
    print("ELIZAOS_GPT_SNAPSHOT_REPORT " + json.dumps({
        "status": "pass", "sectorBytes": args.sector_size, "layouts": layouts, "refusals": cases,
        "targetSha256": final, "canarySha256": before_canary,
        "artifactBase64": base64.b64encode(artifact).decode(),
        "artifactSha256": hashlib.sha256(artifact).hexdigest(),
        "binding": BINDING.hex(), "binarySha256": hashlib.sha256(Path("/root/gpt-snapshot.so").read_bytes()).hexdigest(),
        "limits": ["read-only snapshot, not durable backup storage", "no restore or power-loss qualification", "not installed"]
    }, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
