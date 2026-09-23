#!/usr/bin/env python3
"""Root helper qualification on one named emulated USB disk inside the VM."""
import concurrent.futures
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading

spec = importlib.util.spec_from_file_location(
    "fd_proof", Path(__file__).with_name("qualify-restore-fd.py"))
fd_proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fd_proof)
require, identity, digest = fd_proof.require, fd_proof.identity, fd_proof.digest
Identity = fd_proof.Identity
HELPER = Path("/usr/libexec/elizaos-restore-helper-test")
SHIM = Path("/root/linux-restore-helper-qualification.so")
STATE = Path("/run/elizaos-usb-restore")


def main():
    require(sys.argv[1:] == ["--disposable-vm"], "disposable VM flag is required")
    require(os.geteuid() == 0, "guest root is required")
    require(Path("/sys/class/dmi/id/sys_vendor").read_text().strip() == "QEMU", "QEMU is required")
    block = Path("/sys/class/block/sda")
    require(block.joinpath("removable").read_text().strip() == "1", "fixture is not removable")
    require(block.joinpath("size").read_text().strip() == "1048576", "wrong fixture capacity")
    ancestors = list(block.resolve().parents)
    require(any((p / "serial").is_file() and
                (p / "serial").read_text().strip() == "ELIZAOS-HELPER-TEST"
                for p in ancestors), "named USB fixture is missing")
    require(any(p.name.startswith("usb") for p in ancestors), "fixture is not USB")
    require(fd_proof.command(["/usr/bin/findmnt", "-n", "-o", "SOURCE", "/"]).strip().startswith("/dev/vda"),
            "guest must use its separate OS disk")
    descriptor = os.open("/dev/sda", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    expected = identity(descriptor)
    before = digest(descriptor, expected.size_bytes)
    os.close(descriptor)
    require(not STATE.exists() and not STATE.is_symlink(), "state fixture already exists")
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    counter = 0
    cases = []

    def request(**overrides):
        nonlocal counter
        counter += 1
        fields = {"plan_id": f"{counter:032x}", "boot_id": boot_id, "device_path": "/dev/sda",
                  "expected_major": expected.major, "expected_minor": expected.minor,
                  "expected_diskseq": expected.diskseq, "expected_size_bytes": expected.size_bytes}
        fields.update(overrides)
        lines = ["ELIZAOS_USB_RESTORE_REQUEST_V1", "operation=restore"]
        lines += [f"{key}={value}" for key, value in fields.items()]
        lines += ["partition_number=1", "filesystem=exfat", "label=ELIZAOS-USB", "acknowledgement=ERASE", "END"]
        binding = hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()
        lines.insert(3, f"plan_binding={binding}")
        return fields["plan_id"], binding, ("\n".join(lines) + "\n").encode()

    def authorize(plan):
        path = STATE / "authorized" / plan[0]
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            require(os.write(fd, (plan[1] + "\n").encode()) == 65, "short authorization fixture write")
            os.fsync(fd)
        finally:
            os.close(fd)
        return path

    def check(name, plan, code, unprivileged=False):
        options = {"user": 65534, "group": 65534, "extra_groups": []} if unprivileged else {}
        result = subprocess.run([str(HELPER)], input=plan[2], capture_output=True, timeout=3,
                                env={"LANG": "C", "LC_ALL": "C", "PATH": "/nonexistent"}, **options)
        response = result.stdout.decode()
        require(result.returncode != 0 and f"code={code}\n" in response and "status=ok" not in response,
                f"{name}: unexpected response {result.returncode}: {response}")
        require(len(result.stdout) < 1024 and len(result.stderr) < 1024, "unbounded helper response")
        cases.append({"case": name, "code": code, "exitStatus": result.returncode})

    plan = request()
    check("missing-state", plan, "STATE_UNAVAILABLE")
    STATE.mkdir(mode=0o700)
    (STATE / "authorized").mkdir(mode=0o700)
    (STATE / "consumed").mkdir(mode=0o700)
    check("missing-authorization", plan, "PLAN_NOT_AUTHORIZED")
    auth = authorize(plan)
    check("exact-authorization-still-disabled", plan, "NATIVE_FD_QUALIFICATION_REQUIRED")
    check("non-root", plan, "PRIVILEGE_REQUIRED", True)
    check("previous-boot", request(boot_id="00000000-0000-0000-0000-000000000001"), "BOOT_ID_MISMATCH")
    for field in ("major", "minor", "diskseq", "size_bytes"):
        wrong = request(**{f"expected_{field}": getattr(expected, field) + 1})
        authorize(wrong)
        check(f"wrong-{field}", wrong, "TARGET_IDENTITY_MISMATCH")
    os.chmod(auth, 0o644)
    check("readable-authorization", plan, "PLAN_NOT_AUTHORIZED")
    os.chmod(auth, 0o600)
    os.chown(auth, 65534, 65534)
    check("non-root-authorization-owner", plan, "PLAN_NOT_AUTHORIZED")
    os.chown(auth, 0, 0)
    saved = auth.with_name("saved-authorization")
    auth.rename(saved)
    auth.symlink_to(saved)
    check("authorization-symlink", plan, "PLAN_NOT_AUTHORIZED")
    auth.unlink()
    os.link(saved, auth)
    check("authorization-hardlink", plan, "PLAN_NOT_AUTHORIZED")
    auth.unlink()
    os.mkfifo(auth, 0o600)
    check("authorization-fifo", plan, "PLAN_NOT_AUTHORIZED")
    auth.unlink()
    auth.mkdir(mode=0o700)
    check("authorization-directory", plan, "PLAN_NOT_AUTHORIZED")
    auth.rmdir()
    saved.rename(auth)
    auth.write_text("0" * 64 + "\n")
    check("wrong-binding", plan, "PLAN_NOT_AUTHORIZED")
    auth.write_text(plan[1] + "\ntrailing\n")
    check("trailing-authorization-bytes", plan, "PLAN_NOT_AUTHORIZED")
    auth.write_text(plan[1] + "\n")
    for directory in (STATE, STATE / "authorized", STATE / "consumed"):
        os.chmod(directory, 0o770)
        check(f"writable-state-{directory.name}", plan, "STATE_UNAVAILABLE")
        os.chmod(directory, 0o700)
    marker = STATE / "consumed" / plan[0]
    marker.write_text("consumed\n")
    check("consumed-marker", plan, "PLAN_ALREADY_CONSUMED")
    marker.unlink()
    marker.symlink_to("/nonexistent")
    check("consumed-symlink", plan, "PLAN_ALREADY_CONSUMED")
    marker.unlink()
    marker.mkdir(mode=0o700)
    check("consumed-directory", plan, "PLAN_ALREADY_CONSUMED")
    marker.rmdir()
    alias = Path("/dev/elizaos-helper-alias")
    alias.symlink_to("/dev/sda")
    alias_plan = request(device_path=str(alias))
    authorize(alias_plan)
    check("device-symlink", alias_plan, "TARGET_IDENTITY_MISMATCH")
    alias.unlink()
    canary = os.open("/dev/vdc", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    canary_identity = identity(canary)
    os.close(canary)
    internal = request(device_path="/dev/vdc", **{
        f"expected_{field}": getattr(canary_identity, field) for field, _ in Identity._fields_})
    authorize(internal)
    check("non-removable-disk", internal, "TARGET_IDENTITY_MISMATCH")
    require(not list((STATE / "consumed").iterdir()), "disabled helper consumed a plan")
    descriptor = os.open("/dev/sda", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    after_gate = digest(descriptor, expected.size_bytes)
    os.close(descriptor)
    require(after_gate == before, "identity gate changed the USB fixture")

    library = ctypes.CDLL(str(SHIM))
    consume = library.elizaos_qualify_consume
    consume.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    consume.restype = ctypes.c_int
    race = request()
    authorize(race)
    barrier = threading.Barrier(16, timeout=5)

    def race_consume(_):
        barrier.wait()
        return consume(race[0].encode(), race[1].encode())

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as workers:
        results = list(workers.map(race_consume, range(32)))
    require(results.count(0) == 1 and results.count(1) == 31, f"single-use race failed: {results}")
    marker = STATE / "consumed" / race[0]
    metadata = marker.stat()
    require(marker.read_bytes() == b"consumed\n" and metadata.st_uid == 0 and
            stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_nlink == 1,
            "consumed marker content or metadata is invalid")

    # The only mutation in this script creates a GPT on the named disposable USB.
    descriptor = os.open("/dev/sda", os.O_RDWR | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        gpt = ctypes.CDLL("/root/restore-gpt-fd.so")
        create = gpt.elizaos_restore_create_gpt
        create.argtypes = [ctypes.c_int, ctypes.POINTER(Identity)]
        create.restype = ctypes.c_int
        require(create(descriptor, ctypes.byref(expected)) == 0, "USB fixture GPT failed")
        fcntl.ioctl(descriptor, 0x125F)
        fd_proof.command(["/usr/bin/udevadm", "settle", "--timeout=10"])
        bind = library.elizaos_qualify_partition
        bind.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_uint32,
                         ctypes.c_uint64, ctypes.c_uint64]
        bind.restype = ctypes.c_int

        def open_partition():
            return bind(descriptor, b"/dev/sda", expected.major, expected.minor,
                        expected.diskseq, expected.size_bytes)

        partition = open_partition()
        require(partition >= 0, "native partition binding rejected the correct USB partition")
        part_identity = identity(partition)
        os.close(partition)
        original = Path("/dev/sda1")
        saved_node = Path("/dev/elizaos-helper-saved-partition")
        original.rename(saved_node)
        original.symlink_to(saved_node)
        require(open_partition() < 0, "native partition binding accepted a symlink")
        original.unlink()
        os.mknod(original, stat.S_IFBLK | 0o600, os.makedev(canary_identity.major, canary_identity.minor))
        require(open_partition() < 0, "native partition binding accepted a different disk")
        original.unlink()
        saved_node.rename(original)
        partition = open_partition()
        require(partition >= 0 and bytes(identity(partition)) == bytes(part_identity),
                "restored partition binding changed")
        os.close(partition)
        final_digest = digest(descriptor, expected.size_bytes)
    finally:
        os.close(descriptor)
    report = {"status": "pass", "cases": cases, "gateSha256Before": before,
              "gateSha256After": after_gate, "finalUsbSha256": final_digest,
              "singleUseResults": {"accepted": results.count(0), "rejected": results.count(1)},
              "partitionBinding": ["valid partition", "symlink refused", "wrong disk refused"],
              "binaries": {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in (HELPER, SHIM)},
              "limits": ["emulated USB only", "no production authorization broker",
                         "no power-loss durability proof", "production helper remains disabled"]}
    print("ELIZAOS_RESTORE_HELPER_REPORT " + json.dumps(report, sort_keys=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ELIZAOS_RESTORE_HELPER_REPORT " + json.dumps({"status": "fail", "error": str(error)}), flush=True)
        sys.exit(1)
