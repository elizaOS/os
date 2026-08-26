# OS release administration checklist

The source tree fails closed when these repository controls are absent, but a
maintainer must configure them in GitHub before the first publication.

## Repository settings

Configure `elizaOS/os`, not the application repository:

1. Enable Actions to create pull requests so the Eliza source-lock and vendor
   checksum updaters can open reviewable PRs. Enable GitHub's requirement that
   external Actions use full-length commit SHAs; the repository tests enforce
   the same invariant.
2. Create a protected GitHub environment named `release`. Require a maintainer
   reviewer and prevent self-review. Store release credentials at environment
   scope where practical.
3. Protect `develop`. Require OS verification, Linux static/mkosi contract
   checks, release validation, the canonical three-architecture mkosi build and
   qualification workflow once implemented, all three native Debian packages, Setup, USB
   Installer, and applicable RISC-V checks. Do not make the retired ISO or dead
   VM producer required checks. Require the branch to be current and block
   force pushes and deletion.
4. Retain GitHub Actions artifacts and attestations for the release audit
   period. Do not allow untrusted fork workflows to receive signing secrets.
5. Set Pages to **GitHub Actions**, protect the `github-pages` environment, and
   verify the default Pages URL before adding any APT custom domain.
6. Grant the Cloudflare token below Pages Read and Pages Write access only to
   the account containing `elizaos-homepage`. Verify that its production branch
   is `main` and that `os.elizacloud.ai` resolves to the successful production
   deployment.

The authenticated 2026-08-17 audit found all of these controls absent: Actions
PR creation is disabled, there are no environments, `develop` is unprotected,
and Pages is disabled. Treat each item as required setup rather than a
confirmation-only step.

## Required publication secrets

| Secret | Purpose |
| --- | --- |
| `MACOS_CERTIFICATE_P12` | Base64 Developer ID Application `.p12` used for macOS distribution signing. |
| `MACOS_CERTIFICATE_PASSWORD` | Export password for that `.p12`. |
| `ELECTROBUN_DEVELOPER_ID` | Exact `Developer ID Application: …` identity passed to `codesign`. |
| `APP_STORE_API_KEY_ID` | App Store Connect API key ID used by notarization. |
| `APP_STORE_API_ISSUER_ID` | Issuer ID paired with the API key. |
| `APP_STORE_API_KEY_P8` | Full private `.p8` contents paired with the API key. |
| `WINDOWS_SIGN_CERT_BASE64` | Base64 Authenticode `.pfx`. |
| `WINDOWS_SIGN_CERT_PASSWORD` | Export password for the `.pfx`. |
| `ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64` | Canonical DER SPKI public key embedded into every production USB Installer for signed manifest and image verification. |
| `ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256` | Independently reviewed lowercase SHA-256 of the canonical Ed25519 DER SPKI; the image verifier rejects a supplied key that does not match this separate pin. |
| `ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64` | Offline-origin Ed25519 PKCS#8 private key made available only to the protected image/manifest signing job; never cache or upload it. |
| `ELIZA_ARTIFACT_TOKEN` | Fine-grained token with Actions read access to the pinned `elizaOS/eliza` desktop-artifact producer run. |
| `ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY_SPKI_SHA256` | Independently reviewed SHA-256 of the desktop-artifact Ed25519 DER SPKI trust root consumed by mkosi. |
| `DEBIAN_GPG_PRIVATE_KEY` | Armored private key for signed APT metadata. |
| `DEBIAN_GPG_KEY_ID` | Full 40- or 64-hex primary-key fingerprint configured in the APT distribution. |
| `DEBIAN_GPG_PASSPHRASE` | Passphrase when the APT key has one. |
| `CLOUDFLARE_ACCOUNT_ID` | Account containing the `elizaos-homepage` Pages project. |
| `CLOUDFLARE_API_TOKEN` | Least-privilege token with Pages Read and Pages Write for that account. |

During emergency key revocation, set the protected optional secret
`ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S` to a sorted, unique,
comma-separated list of revoked SPKI digests. A matching signing key is denied
before release metadata is parsed. Removing a digest requires the same
protected-environment review as changing the active public key or its pin.

The desktop workflows import certificates into temporary runner storage,
verify Apple notarization or Windows Authenticode after packaging, and remove
temporary credential files in `always()` cleanup steps. Missing or incomplete
credentials fail a `sign=true` run. Their reusable build jobs bind the
`release` environment only when signing is required, so keep these values at
environment scope; ordinary pull-request builds remain unsigned and do not
request deployment approval.

The two Ed25519 trust domains are deliberately distinct contracts. The
release-manifest key authenticates public image metadata and compressed image
signature payloads consumed by the USB Installer. The desktop-artifact key
authenticates the GTK/WebKit payload staged inside mkosi. Generate and retain
their private roots offline, expose private material only to the protected
signing job, and embed or pin only reviewed public material elsewhere.

The authenticated 2026-08-17 audit found none of the secrets above at
repository or environment scope. Organization secrets visible to this
repository were unrelated to OS signing. Provision the complete set before a
signed rehearsal; secret names alone do not prove that the key material is
valid.

## Rehearsal and publication

1. Merge only after every required PR check is green.
2. Dispatch `elizaOS Full OS Release` only with a reviewed candidate manifest
   that passes `assert-canonical-linux-release.mjs`. The tracked beta candidate
   now declares the canonical signed asset set but remains non-publishable
   until every exact-digest qualification record exists. Use `sign=true` and
   `publish=false` for the first complete rehearsal.
3. Download `elizaos-release-bundle`; verify every checksum, signature,
   notarization result, attestation, installer launch, mkosi UEFI/QEMU,
   persistence and installation result, Debian install, signed APT rehearsal,
   and physical-hardware qualification record.
4. Re-run at the same source SHA with `sign=true` and `publish=true`. Approve
   the protected environment only after comparing the rehearsal evidence.
5. Verify the GitHub Release, signed APT repository, and
   `https://os.elizacloud.ai/downloads/elizaos-beta-manifest.json` from a clean
   client. The homepage manifest must contain the promoted download URLs and
   the same `SHA256SUMS` URL used by the release.

Publication must never be used as the first complete test of the release path.
