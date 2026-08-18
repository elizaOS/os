# elizaOS Linux — unified multi-arch ISO build entrypoint.
#
# Usage:
#   make build ARCH=amd64
#   make build ARCH=arm64
#   make build ARCH=riscv64
#   make build ARCH=riscv64 PROFILE=gui
#   make build ARCH=riscv64 DEBIAN_MIRROR=https://ftp.debian.org/debian
#
#   make qemu-boot ARCH=riscv64
#   make release-check-strict ARCH=riscv64
#   make brand-assets

SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

ARCH    ?= amd64
PROFILE ?= default
DEBIAN_MIRROR ?= https://mirrors.kernel.org/debian
HERE    := $(shell pwd)
OUT     := $(HERE)/out
SNAPSHOT_LOCK := $(HERE)/debian-snapshot.lock.json
DEBIAN_BASE_IMAGE := $(shell python3 -c 'import json; print(json.load(open("$(SNAPSHOT_LOCK)"))["baseImage"])')
DEBIAN_SNAPSHOT_SERIAL := $(shell python3 -c 'import json; print(json.load(open("$(SNAPSHOT_LOCK)"))["serial"])')
CONTAINER_BUILD_DIR := /work/elizaos-linux
AGENT_ARTIFACTS ?= $(HERE)/artifacts/$(ARCH)
AGENT_ARTIFACTS_MOUNT := $(if $(wildcard $(AGENT_ARTIFACTS)),-v "$(AGENT_ARTIFACTS):/opt/elizaos-artifacts:ro",)
PACKAGED_APP ?=
PACKAGED_APP_MOUNT := $(if $(PACKAGED_APP),-v "$(PACKAGED_APP):/opt/elizaos-packaged-app:ro",)
BUILD_LOG ?= $(OUT)/elizaos-linux-$(ARCH)-$(PROFILE)-build.log
BUN_SOURCE ?=
BUN_RISCV64_ZIP ?= $(HERE)/../../toolchains/bun-riscv64/dist/bun-linux-riscv64-musl.zip
RISCV64_MUSL_RUNTIME ?= $(HERE)/artifacts/riscv64/elizaos-app/musl-runtime
RISCV64_ICU_DATA ?=
RISCV64_RUNTIME ?= bun
ISO ?=
EVIDENCE ?= $(HERE)/evidence/qemu_virt_boot.report.json
QEMU_EVIDENCE ?= $(HERE)/evidence/qemu_virt_boot.json
QEMU_TRANSCRIPT ?= $(HERE)/evidence/qemu_virt_boot.transcript.log
QEMU_MEMORY ?= 4096
QEMU_CPUS ?= 4
QEMU_TIMEOUT ?= 600
RISCV64_AGENT_RUNTIME_REPORT ?= $(HERE)/evidence/riscv64_agent_runtime_smoke.json
RISCV64_AGENT_RUNTIME_TRANSCRIPT ?= $(HERE)/evidence/riscv64_agent_runtime_smoke.log
ARM64_QEMU_EVIDENCE ?= $(HERE)/evidence/arm64_qemu_virt_boot.json
ARM64_QEMU_TRANSCRIPT ?= $(HERE)/evidence/arm64_qemu_virt_boot.transcript.log
REMOVE_PATH_RECURSIVE ?= node ../../../scripts/rm-path-recursive.mjs

SUPPORTED_ARCHES := amd64 arm64 riscv64
SUPPORTED_PROFILES := default gui

.PHONY: help build builder stage-agent-artifacts riscv64-agent-runtime-smoke qemu-boot release-check-strict release-check check-arch brand-assets clean lint

help:
	@echo "elizaOS Linux build targets:"
	@echo "  make build [ARCH=amd64|arm64|riscv64] [PROFILE=default|gui]"
	@echo "  make stage-agent-artifacts ARCH=<arch> [BUN_SOURCE=<path>|BUN_RISCV64_ZIP=<path>|RISCV64_RUNTIME=node]"
	@echo "  make riscv64-agent-runtime-smoke"
	@echo "  make qemu-boot ARCH=<arch>"
	@echo "  make release-check ARCH=riscv64"
	@echo "  make release-check-strict ARCH=riscv64"
	@echo "  make brand-assets       # regenerate PNG branding from SVG sources"
	@echo "  make lint               # static smoke checks"
	@echo "  make clean              # remove out/ and live-build state"
	@echo
	@echo "ARCH: $(SUPPORTED_ARCHES)"
	@echo "PROFILE: $(SUPPORTED_PROFILES)"
	@echo "default=headless, gui=GNOME desktop"

builder:
	docker build \
		--build-arg DEBIAN_BASE_IMAGE="$(DEBIAN_BASE_IMAGE)" \
		--build-arg DEBIAN_SNAPSHOT_SERIAL="$(DEBIAN_SNAPSHOT_SERIAL)" \
		-t elizaos-linux-builder "$(HERE)"

build: builder check-arch
	mkdir -p "$(OUT)"
	docker run --rm --privileged --network host \
		-e ELIZAOS_ARCH="$(or $(ARCH),amd64)" \
		-e ELIZAOS_PROFILE="$(or $(PROFILE),default)" \
		-e ELIZAOS_OUT_DIR=/out \
		-e ELIZAOS_PACKAGED_APP_DIR=/opt/elizaos-packaged-app \
		$(AGENT_ARTIFACTS_MOUNT) \
		$(PACKAGED_APP_MOUNT) \
		-v "$(HERE):/src:ro" \
		-v "$(OUT):/out" \
		--entrypoint bash \
		elizaos-linux-builder -lc 'set -eu; rm -rf "$(CONTAINER_BUILD_DIR)"; mkdir -p "$(CONTAINER_BUILD_DIR)"; rsync -a /src/ "$(CONTAINER_BUILD_DIR)/" --exclude out --exclude cache --exclude chroot --exclude binary; cd "$(CONTAINER_BUILD_DIR)"; exec ./build.sh' \
		2>&1 | tee "$(BUILD_LOG)"

stage-agent-artifacts: check-arch
ifeq ($(ARCH),riscv64)
ifeq ($(RISCV64_RUNTIME),node)
	scripts/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" --skip-build
else
	scripts/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" --riscv64-bun-zip "$(BUN_RISCV64_ZIP)" --riscv64-musl-runtime "$(RISCV64_MUSL_RUNTIME)" $(if $(RISCV64_ICU_DATA),--riscv64-icu-data "$(RISCV64_ICU_DATA)",)
endif
else
	scripts/stage-agent-artifacts.sh --arch "$(ARCH)" --out "$(AGENT_ARTIFACTS)" $(if $(BUN_SOURCE),--bun-source "$(BUN_SOURCE)",)
endif

riscv64-agent-runtime-smoke:
	RISCV64_AGENT_RUNTIME_REPORT="$(RISCV64_AGENT_RUNTIME_REPORT)" RISCV64_AGENT_RUNTIME_TRANSCRIPT="$(RISCV64_AGENT_RUNTIME_TRANSCRIPT)" scripts/check-riscv64-agent-runtime-artifact.sh "$(HERE)/artifacts/riscv64"

qemu-boot: check-arch
	@test -n "$(ISO)" || { echo "Set ISO=/absolute/path/to/image.iso" >&2; exit 64; }
	ELIZAOS_QEMU_MEMORY="$(QEMU_MEMORY)" ELIZAOS_QEMU_CPUS="$(QEMU_CPUS)" \
		scripts/boot-qemu.sh --arch "$(ARCH)" "$(ISO)"

release-check:
	python3 scripts/check_release_manifest.py

release-check-strict:
	python3 scripts/check_release_manifest.py --strict

lint:
	scripts/static-smoke.sh
	python3 -c 'import ast,pathlib; ast.parse(pathlib.Path("scripts/check-multiarch-boot-contract.py").read_text())'
	PYTHONDONTWRITEBYTECODE=1 python3 scripts/test_check_multiarch_boot_contract.py

clean:
	$(REMOVE_PATH_RECURSIVE) "$(OUT)" cache chroot binary*.iso config/binary config/bootstrap config/chroot config/source

check-arch:
	@case " $(SUPPORTED_ARCHES) " in \
	    *" $(ARCH) "*) ;; \
	    *) echo "ERROR: ARCH=$(ARCH) not in: $(SUPPORTED_ARCHES)" >&2; exit 64 ;; \
	esac
