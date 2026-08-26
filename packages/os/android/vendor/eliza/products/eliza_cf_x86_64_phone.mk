$(call inherit-product, device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk)

PRODUCT_NAME := eliza_cf_x86_64_phone
PRODUCT_DEVICE := vsoc_x86_64_only
PRODUCT_MODEL := elizaOS Cuttlefish Phone

# Set before inheriting eliza_common.mk so the brand property can pin
# this image to its lunch target.
ELIZA_PRODUCT_TAG := eliza_cf_x86_64_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)

# The E1 NPU simulator belongs to a separately provisioned device tree and is
# not part of the pinned elizaOS AOSP checkout. Keep the canonical launcher
# image buildable from this repository alone; dedicated chip bring-up lanes may
# opt in only after staging that tree explicitly.
ifeq ($(ELIZA_ENABLE_E1_NPU_SIM),true)
$(call inherit-product, device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk)
endif
