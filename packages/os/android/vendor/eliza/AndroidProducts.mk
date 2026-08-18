# elizaOS lunch targets.
#
# Cuttlefish: virtual phones. arm64, x86_64, and riscv64 are all declared so
#   the elizaOS AOSP fork has explicit emulator lanes for each supported ABI.
#   riscv64 boot transcripts are gated on a Linux x86_64 build host — see
#   chip/docs/android/cuttlefish-riscv64-bringup.md.
# Physical-device products are intentionally absent. The pinned public AOSP
# manifest contains Cuttlefish but not Pixel BSP projects, and hardware builds
# also require separately licensed vendor binaries. Do not advertise a lunch
# target until those inputs have their own pinned, verified contract.

PRODUCT_MAKEFILES := \
    $(LOCAL_DIR)/products/eliza_cf_arm64_phone.mk \
    $(LOCAL_DIR)/products/eliza_cf_x86_64_phone.mk \
    $(LOCAL_DIR)/products/eliza_cf_riscv64_phone.mk

COMMON_LUNCH_CHOICES := \
    eliza_cf_arm64_phone-trunk_staging-userdebug \
    eliza_cf_x86_64_phone-trunk_staging-userdebug \
    eliza_cf_riscv64_phone-trunk_staging-userdebug
