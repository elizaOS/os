# Pixel 11 upstream recheck — September 23, 2026

The host tooling is ready for read-only device intake. A physical installation
is **not qualified**. This review preserves the source/firmware pins and disabled
eligibility; newer source code is not evidence that our image boots.

## GrapheneOS: corrections and changes since the pinned toolchain

The September 1 [official MTE update](https://bsky.app/profile/grapheneos.org/post/3mugn23cpx22l)
corrected the initial suspicion that Pixel 11 lacked hardware MTE entirely:
some hardware support exists, while firmware enablement and performance remain
questions. The [supported-device list](https://grapheneos.org/faq#supported-devices)
still does not list Pixel 11. Do not equate vendor generation with production
support, or use this security discussion as the cause of our boot failures.

On September 16, GrapheneOS [reported](https://bsky.app/profile/grapheneos.org/post/3mvnrhp3vfs26)
that its Android 17 QPR1 code could not yet be released and it was backporting
Pixel firmware, drivers and HALs instead. Such components need coordinated
provenance and functional testing.

The [adevtool comparison](https://github.com/GrapheneOS/adevtool/compare/144f004cc484d7e7234cdd167cee48e5f240288f...e091511f68f1c45ade2ae5d437a7563bc15442df)
contains 20 commits after our pin. Reviewed commit summaries and relevant
configuration contents, not only the unchanged grizzly-specific YAML:

| Upstream change | Consequence for this repository |
| --- | --- |
| September Pixel 11 image index (`5a1ee58779f6570cf35b550addfc8c8ef4db6527`) | Availability of a factory image does not authorize a downgrade or source/firmware substitution. |
| Split firmware backport options and modem backports (`345778abe1e0966b2a6831fa9f09baf6bc73a5b5`, `965f2c86f318649d67312e244d376052e04b37a9`) | Review effective inherited configuration before updating adevtool. |
| Require carrier settings with radio backports (`f9bca58f22f1f000bd09a881b25ce0114e8dca52`) | Radio firmware and Android carrier profiles must be qualified together. |
| Select the carrier source build and backport CarrierSettings (`83a5b47af3a52bac8f69930880e641fd5e683189`, `e68d54e8f68accc85b229b9b92f5d1076313bd02`) | Upstream diagnosed mismatched IMS media payload assignments and failed Wi-Fi calls. Our hardware matrix must check outgoing/incoming calling and DTMF as well as registration. |
| Validate carrier download origin (`c92cc4b418982a837deece175f13604ff1868731`) | Match the intended HTTPS origin, not a path substring, when qualifying future extraction tools. |

At latest inspected commit `e091511f68f1c45ade2ae5d437a7563bc15442df`,
[grizzly.yml](https://github.com/GrapheneOS/adevtool/blob/e091511f68f1c45ade2ae5d437a7563bc15442df/config/device/grizzly.yml)
still includes `common/gen11pixel.yml`, which includes `pixel.yml` and retains
`CD1A.260714.001.A9`. However,
[common/pixel.yml](https://github.com/GrapheneOS/adevtool/blob/e091511f68f1c45ade2ae5d437a7563bc15442df/config/device/common/pixel.yml)
now enables radio backports from `CP3A.260905.009`, carrier configuration and
`wfc-pkt-router`. Those settings were absent from our pinned common file.
**Inference:** bumping only adevtool could change grizzly's inherited inputs even
without a grizzly-file diff. Effective merge behavior, factory availability,
module outputs and matching carrier/radio versions must be checked on a real
regeneration before any upgrade; this review did not perform that regeneration.
The compare API file list can be truncated, so its file listing was not treated
as a complete audit of every changed binary.

The inspected vendor_state branch still ends at our pinned
`afd6a0c9f6ca13d395f00e98227a0866cc14de07`. No coordinated new grizzly baseline
was established by these upstream checks. Preserve the existing pins until
regeneration, exact-source builds, artifact inspection and physical testing
justify a single coherent update.

## LineageOS

Checked the official [wiki inventory](https://github.com/LineageOS/lineage_wiki/tree/1f4f944688ff75b3f9e13708e485f39a445b8cc4/_data/devices)
(740 entries) and [build targets](https://github.com/LineageOS/hudson/blob/5a29838ce6108a764b6d6809ce08e841baecbf08/lineage-build-targets).
Neither lists `cubs`, `grizzly`, `kodiak`, or `yogi`. The wiki's latest inspected
changes include additional device support and recovery-key instructions, but
provide no official Pixel 11 install procedure to adopt. This does not rule out
unofficial development; it does rule out treating a different Pixel's guide as
qualification for this phone.

## Required physical evidence after connection

First collect exact product/SKU, firmware, lock/slot state and incident logs
without rebooting or writing. Then establish the matching stock recovery path
and resolve the previous failures. Keep installation disabled while the exact
grizzly image build and hardware qualification are missing.

For cellular qualification, retain carrier identity and matched radio/carrier
profile provenance; test incoming/outgoing calls, LTE/5G and Wi-Fi calling where
supported, DTMF, SMS and mobile data. A registered modem or a single successful
boot is insufficient. Do not place emergency test calls without the appropriate
coordinated test procedure. Keep personal modem/bugreport data outside Git.

The complete status and previously retained simulator evidence are in the
[readiness report](pixel11-readiness-2026-09-23.md). Host validation and Cuttlefish
evidence cannot certify retail bootloader behavior or guarantee zero brick risk.
