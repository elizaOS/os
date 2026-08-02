# OS release workflows

This directory owns AOSP, Debian/Linux image, installer, update-manifest, and
OS release automation. Android/iOS application builds remain in `elizaOS/eliza`;
the Cuttlefish lane checks out that repository only to produce the application
APK that is staged into the system image.

`elizaos-os-full-release.yml` is the only configured automatic OS artifact and
manifest writer. It is currently startup-invalid and is not a working release
authority until its reusable-workflow permissions and end-to-end repair are
completed.

`update-os-release-manifest.yml` is the manual recovery boundary for existing
release assets. It binds the base, tag, release, exact asset inventory, and
downloaded bytes before opening an evidenced draft pull request; it never
pushes directly to `develop`.
