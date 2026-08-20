# Verifying an elizaOS release

Download every file from the GitHub Release into one directory, then run:

```sh
bash packages/os/scripts/verify-release.sh path/to/downloads
```

For release-engineering approval, also require exact agreement with the
populated manifest (replace the manifest filename with the downloaded one):

```sh
node packages/os/scripts/verify-release-checksums.mjs \
  --manifest path/to/downloads/elizaos-os-v0.1.0-beta.1-manifest.json \
  --artifact-root path/to/downloads \
  --checksums path/to/downloads/SHA256SUMS
```

This second check rejects missing, extra, or duplicate checksum entries and
requires manifest digest, byte size, checksum record, and actual file bytes to
agree.

The `v0.1.0-beta.1` bundle contains three signed persistent mkosi `raw.zst`
images and their SPDX SBOMs, three architecture-specific Debian packages,
three Setup bundles, the Linux USB Installer, the signed image-discovery
manifest, the populated release manifest, and `SHA256SUMS`. The downloaded
populated manifest is authoritative; do not infer release contents from this
summary.

The verifier fails if `SHA256SUMS` is absent or malformed, contains no files,
names an unsafe path, or names any payload that is missing, empty, symlinked,
or checksum-invalid. It does not use checksum tools' `--ignore-missing` mode.

When the GitHub CLI is installed, the verifier also requires every payload,
`SHA256SUMS`, and the release manifest to have a valid GitHub artifact
attestation from the `elizaOS` owner:

```sh
gh attestation verify elizaos-0.1.0-beta.1-x86_64.raw.zst --owner elizaOS
gh attestation verify SHA256SUMS --owner elizaOS
```

The release manifest supplies the authoritative filename, platform,
architecture, byte size, SHA-256, download URL, and completed evidence for each
payload. Treat any disagreement between the manifest, `SHA256SUMS`, downloaded
files, or attestations as a failed verification.

Exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Every available required verification passed. |
| `1` | Required payload or checksum verification failed. |
| `2` | An attestation or optional cryptographic verification failed. |

The verifier reports when `gh` or GPG tooling is unavailable. For release
engineering approval, run it with `gh` authenticated so provenance is actually
verified.
