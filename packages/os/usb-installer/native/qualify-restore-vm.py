#!/usr/bin/env python3
"""Run retained-FD restore qualification on disposable Debian/QEMU disks.

Requires qemu-system-x86_64, qemu-img, genisoimage, and fdisk. The optional
container supplies only image/ISO tools; it has no privileges or host devices.
Inputs are independently digest-checked. Evidence stays outside the repository.
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import time
from pathlib import Path
import struct
import subprocess
import sys
import uuid
import zlib

IMAGE_URL = "https://cloud.debian.org/images/cloud/trixie/20260914-2601/debian-13-genericcloud-amd64-20260914-2601.qcow2"
IMAGE_SHA512 = "95e110dfcdbd0ed8a82a75ed9579802f9950cabf51a810dcc6388e81bc778188713878b9f28d583a0ea602fbf48b35996ae9ad37f584166d8fbd6489df248f53"
SOURCE_URL = "https://codeload.github.com/exfatprogs/exfatprogs/tar.gz/3e87676349387a119cadacd68661d2966796b7fd"
SOURCE_SHA256 = "2c342bb1a4a9fb5ace61020bb6fae1784cb48e98577b18e271691d9de85fa337"
NATIVE = Path(__file__).resolve().parent
SIZE = 512 * 1024 * 1024


def file_hash(path, algorithm="sha256"):
    result = hashlib.new(algorithm)
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def inspect_target(output, sector_size):
    # fdisk supports explicit regular-file sector size on older hosts too;
    # sfdisk's --sector-size option is not available on Ubuntu 24.04.
    inspection = subprocess.check_output(
        ["fdisk", "-b", str(sector_size), "-l", str(output / "target.raw")],
        text=True, timeout=15)
    (output / "partition-map.log").write_text(inspection)
    with (output / "target.raw").open("rb") as stream:
        stream.seek(sector_size)
        header = bytearray(stream.read(sector_size))
        stored_crc = struct.unpack_from("<I", header, 16)[0]
        struct.pack_into("<I", header, 16, 0)
        if (header[:8] != b"EFI PART" or struct.unpack_from("<I", header, 12)[0] != 92
                or zlib.crc32(header[:92]) != stored_crc
                or struct.unpack_from("<II", header, 80) != (128, 128)):
            raise RuntimeError("host GPT header verification failed")
        stream.seek(struct.unpack_from("<Q", header, 72)[0] * sector_size)
        entries = stream.read(16384)
    if len(entries) != 16384 or zlib.crc32(entries) != struct.unpack_from("<I", header, 88)[0]:
        raise RuntimeError("host GPT entry checksum mismatch")
    parts = []
    for index in range(128):
        entry = entries[index * 128:(index + 1) * 128]
        if any(entry[:16]):
            start, end = struct.unpack_from("<QQ", entry, 32)
            parts.append({"number": index + 1, "start": start, "end": end,
                          "type": str(uuid.UUID(bytes_le=entry[:16])),
                          "uuid": str(uuid.UUID(bytes_le=entry[16:32])),
                          "name": entry[56:128].decode("utf-16-le").rstrip("\0")})
    if (len(parts) != 1 or parts[0]["start"] != 1024 * 1024 // sector_size
            or parts[0]["end"] != SIZE // sector_size - 16384 // sector_size - 2
            or parts[0]["type"].upper() != "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7"
            or parts[0]["name"] != "ELIZAOS"):
        raise RuntimeError("host GPT inspection failed")
    return parts


class Qmp:
    """Local VM control only. Preserve acknowledgements and asynchronous events."""

    def __init__(self, path, transcript):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(30)
        self.stream = None
        try:
            self.socket.connect(str(path))
            self.stream = self.socket.makefile("rb")
        except BaseException:
            self.socket.close()
            raise
        self.transcript = transcript
        self.messages = []
        self.sequence = 0
        try:
            if "QMP" not in self.receive():
                raise RuntimeError("missing QMP greeting")
            self.execute("qmp_capabilities")
        except BaseException:
            self.close()
            raise

    def receive(self):
        line = self.stream.readline(65537)
        if not line or len(line) > 65536:
            raise RuntimeError("missing or oversized QMP response")
        message = json.loads(line)
        if not isinstance(message, dict):
            raise RuntimeError("QMP response is not an object")
        self.messages.append(message)
        self.transcript.write(json.dumps({"received": message}) + "\n")
        self.transcript.flush()
        return message

    def execute(self, name, arguments=None):
        self.sequence += 1
        request = {"execute": name, "id": self.sequence}
        if arguments is not None:
            request["arguments"] = arguments
        self.transcript.write(json.dumps({"sent": request}) + "\n")
        self.transcript.flush()
        self.socket.sendall((json.dumps(request) + "\n").encode())
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            self.socket.settimeout(max(0.001, deadline - time.monotonic()))
            reply = self.receive()
            if reply.get("id") != self.sequence:
                continue
            if "error" in reply or "return" not in reply:
                raise RuntimeError(f"QMP {name} failed: {reply}")
            return reply["return"]
        raise RuntimeError(f"QMP {name} acknowledgement timed out")

    def remove_restore_device(self):
        self.execute("device_del", {"id": "restore-device"})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            for message in self.messages:
                if message.get("data", {}).get("device") != "restore-device":
                    continue
                if message.get("event") == "DEVICE_UNPLUG_GUEST_ERROR":
                    raise RuntimeError("guest refused virtual device removal")
                if message.get("event") == "DEVICE_DELETED":
                    return message
            self.socket.settimeout(max(0.001, deadline - time.monotonic()))
            self.receive()
        raise RuntimeError("QMP did not confirm virtual device removal")

    def close(self):
        self.stream.close()
        self.socket.close()


def run_vm(qemu, output):
    # No host disk is exposed; QMP can remove only the named disposable fixture.
    removal = None
    target_before = None
    control = None
    with (output / "qemu.log").open("w") as log, (output / "qmp.log").open("w") as qmp_log:
        process = subprocess.Popen(qemu, cwd=output, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 900
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise RuntimeError("qualification VM timed out")
                guest_log = output / "guest.log"
                if removal is None and guest_log.exists():
                    transcript = guest_log.read_text(errors="replace")
                    if "ELIZAOS_RESTORE_READY_FOR_REMOVAL" in transcript.splitlines():
                        target_before = file_hash(output / "target.raw")
                        control = Qmp(output / "qmp.sock", qmp_log)
                        removal = control.remove_restore_device()
                time.sleep(0.1)
            if process.returncode != 0:
                raise RuntimeError(f"qualification VM exited {process.returncode}")
            if removal is None or target_before is None:
                raise RuntimeError("VM never completed the device-removal handshake")
            target_after = file_hash(output / "target.raw")
            if target_before != target_after:
                raise RuntimeError("removed target changed during stale-FD refusal checks")
            return {"event": removal, "targetSha256Before": target_before,
                    "targetSha256After": target_after}
        finally:
            if control is not None:
                control.close()
            if process.poll() is None:
                process.kill()
            process.wait()


def main():
    host_runner_sha256 = file_hash(Path(__file__))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-image", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sector-size", choices=(512, 4096), type=int, required=True)
    parser.add_argument("--accelerator", choices=("kvm", "tcg"), default="kvm")
    parser.add_argument("--container-tools-image")
    args = parser.parse_args()
    base = args.base_image.resolve(strict=True)
    source = args.source_archive.resolve(strict=True)
    output = args.output_dir.resolve()
    if file_hash(base, "sha512") != IMAGE_SHA512 or file_hash(source) != SOURCE_SHA256:
        raise RuntimeError("qualification input digest mismatch")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)

    def image_tool(argv):
        command = argv
        if args.container_tools_image:
            command = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                       "-v", f"{output}:{output}", "-v", f"{base}:{base}:ro",
                       "-w", str(output), args.container_tools_image, *argv]
        subprocess.run(command, cwd=output, check=True, timeout=60)

    sources = {name: (NATIVE / name).read_bytes() for name in (
        "restore-gpt-fd.c", "restore-gpt-fd.h", "exfatprogs-fd.patch",
        "restore-tool-runner.c", "restore-tool-runner.h", "restore-tool-runner.test.c",
        "build-exfat-fd.sh", "qualify-restore-fd.py",
    )}
    data = """#cloud-config
hostname: elizaos-restore-qualification
package_update: true
packages: [gcc, make, autoconf, automake, libtool, patch, libc6-dev, libfdisk-dev, fdisk, python3, strace]
write_files:
"""
    for name, content in {**sources, "exfat.tar.gz": source.read_bytes()}.items():
        data += (f"  - path: /root/{name}\n    permissions: '0600'\n    encoding: b64\n"
                 f"    content: {base64.b64encode(content).decode()}\n")
    guest_script = """#!/bin/sh
set -eu
bash /root/build-exfat-fd.sh /root/exfat.tar.gz /root/exfat-tools
install -m 0755 /root/exfat-tools/elizaos-mkfs-exfat-fd /root/exfat-tools/elizaos-fsck-exfat-fd /usr/libexec/
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 -shared -fPIC /root/restore-gpt-fd.c /root/restore-tool-runner.c -lfdisk -o /root/restore-gpt-fd.so
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 /root/restore-tool-runner.test.c -o /root/restore-tool-runner-test
/root/restore-tool-runner-test
status=0
strace -f -e trace=openat,fcntl,ioctl -o /root/restore.trace python3 /root/qualify-restore-fd.py --disposable-vm --library /root/restore-gpt-fd.so --tools /root/exfat-tools || status=$?
cat /root/restore.trace
exit "$status"
"""
    data += ("  - path: /root/run-qualification.sh\n    permissions: '0700'\n    encoding: b64\n"
             f"    content: {base64.b64encode(guest_script.encode()).decode()}\n")
    data += "runcmd:\n  - [sh, -c, '/root/run-qualification.sh > /dev/ttyS0 2>&1']\n  - [poweroff]\n"
    (output / "user-data").write_text(data)
    (output / "meta-data").write_text("instance-id: elizaos-restore-fd-test\n")
    image_tool(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(base),
                str(output / "guest.qcow2"), "8G"])
    image_tool(["genisoimage", "-quiet", "-output", str(output / "seed.iso"),
                "-volid", "cidata", "-joliet", "-rock", "user-data", "meta-data"])
    for disk in ("target.raw", "canary.raw"):
        with (output / disk).open("xb") as stream:
            stream.truncate(SIZE)
    before = file_hash(output / "canary.raw")
    qemu = ["qemu-system-x86_64", "-accel", args.accelerator,
            "-cpu", "host" if args.accelerator == "kvm" else "max",
            "-m", "2048", "-smp", "2", "-display", "none", "-monitor", "none",
            "-qmp", "unix:qmp.sock,server=on,wait=off",
            "-serial", f"file:{output / 'guest.log'}", "-no-reboot", "-boot", "order=c",
            "-drive", "file=guest.qcow2,if=none,id=os,format=qcow2",
            "-device", "virtio-blk-pci,drive=os,bootindex=1",
            "-drive", "file=target.raw,if=none,id=restore,format=raw",
            "-device", ("virtio-blk-pci,id=restore-device,drive=restore,serial=ELIZAOS-RESTORE-TEST,"
                        f"logical_block_size={args.sector_size},physical_block_size={args.sector_size}"),
            "-drive", "file=canary.raw,if=none,id=canary,format=raw",
            "-device", "virtio-blk-pci,drive=canary,serial=ELIZAOS-CANARY",
            "-drive", "file=seed.iso,media=cdrom,readonly=on", "-netdev", "user,id=n0",
            "-device", "virtio-net-pci,netdev=n0"]
    print(f"Booting isolated {args.sector_size}-byte sector qualification VM: {output}", flush=True)
    removal = run_vm(qemu, output)
    transcript = (output / "guest.log").read_text(errors="replace")
    reports = [json.loads(line.split("ELIZAOS_RESTORE_FD_REPORT ", 1)[1])
               for line in transcript.splitlines() if line.startswith("ELIZAOS_RESTORE_FD_REPORT ")]
    if len(reports) != 1 or reports[0].get("status") != "pass":
        raise RuntimeError(f"guest did not qualify: {reports}; inspect {output / 'guest.log'}")
    after = file_hash(output / "canary.raw")
    if before != after or reports[0].get("sectorBytes") != args.sector_size:
        raise RuntimeError("host canary digest or sector geometry mismatch")
    parts = inspect_target(output, args.sector_size)
    if not reports[0].get("deviceRemoval", {}).get("sysfsRemoved"):
        raise RuntimeError("guest did not prove stale-FD rejection after removal")
    if file_hash(Path(__file__)) != host_runner_sha256:
        raise RuntimeError("host runner changed during qualification")
    result = {"deviceRemoval": removal, "hostRunnerSha256": host_runner_sha256,
              "guest": reports[0], "partitions": parts,
              "canarySha256Before": before, "canarySha256After": after,
              "imageSha512": IMAGE_SHA512, "exfatSourceSha256": SOURCE_SHA256,
              "sourceSha256": {name: hashlib.sha256(content).hexdigest() for name, content in sources.items()},
              "transcriptSha256": file_hash(output / "guest.log"), "qemuCommand": qemu}
    (output / "qualification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"PASS: {output / 'qualification.json'}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
