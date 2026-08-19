# Admin: enable signed APT publication

This is the one-time administrator setup for the `elizaOS/os` signed Debian
repository. `publish-apt-repo.yml` fails closed if its signing identity is
missing or inconsistent. It publishes signed `reprepro` metadata to the
`apt-repo` branch and then deploys that exact committed tree through GitHub
Pages.

## 1. Generate a dedicated signing key

Use a dedicated, revocable CI key on a trusted machine:

```sh
gpg --batch --quick-generate-key \
  'elizaOS apt repository <ci@elizaos.ai>' \
  rsa4096 sign 2y
```

Record the full primary-key fingerprint, not a short or 16-character key ID:

```sh
gpg --with-colons --fingerprint \
  'elizaOS apt repository <ci@elizaos.ai>' \
  | awk -F: '$1 == "fpr" { print $10; exit }'
```

The workflow accepts a 40- or 64-hexadecimal-character primary fingerprint
and verifies that the imported private key matches it exactly.

## 2. Export the private key

```sh
gpg --armor --export-secret-keys FULL_PRIMARY_FINGERPRINT \
  > /tmp/elizaos-apt-private.asc
gpg --batch --show-keys /tmp/elizaos-apt-private.asc
```

Treat this file as signing material. Paste it into GitHub once, then securely
delete the local export.

## 3. Configure `elizaOS/os`

At <https://github.com/elizaOS/os/settings/secrets/actions>, configure:

| Secret | Required value |
| --- | --- |
| `DEBIAN_GPG_PRIVATE_KEY` | Complete ASCII-armored private-key export. |
| `DEBIAN_GPG_KEY_ID` | Full primary-key fingerprint from step 1. |
| `DEBIAN_GPG_PASSPHRASE` | Key passphrase, if the key has one; otherwise omit it. |

At <https://github.com/elizaOS/os/settings/pages>, set the build and deployment
source to **GitHub Actions**. The workflow's `github-pages` deployment should
be protected consistently with the `release` environment. Do not configure a
custom domain until its DNS records and certificate are ready; the default
site is `https://elizaos.github.io/os/`.

The workflow requires `contents: write`, `pages: write`, and `id-token: write`.
Its actions are pinned by immutable commit SHA. Organization action policy must
allow those pinned GitHub-owned actions.

## 4. Rehearse through the release coordinator

The normal path is `elizaOS Full OS Release`:

1. Run the coordinator with `publish=false` and inspect the canonical bundle.
   This run also builds and cryptographically verifies a signed APT repository
   rehearsal and checks the GitHub Pages configuration without pushing it.
2. Run it at the same reviewed source with `sign=true` and `publish=true`.
3. The coordinator creates the public GitHub Release only after the signed APT
   rehearsal and all other build gates pass.
4. APT publication then downloads the release's single `.deb`, verifies
   it is a Debian package, binds `SignWith` to the configured fingerprint,
   publishes the signed branch, and deploys Pages.

For an isolated recovery test, the release tag must already exist and contain
exactly one `.deb`:

```sh
gh workflow run publish-apt-repo.yml \
  --repo elizaOS/os \
  --field version=0.1.0-beta.1 \
  --field tag=v0.1.0-beta.1 \
  --field channel=beta
gh run watch --repo elizaOS/os
```

A green run must produce all of the following:

- an `apt-repo` commit containing `dists/<channel>/InRelease`;
- `Release` and `InRelease` metadata signed by the configured fingerprint;
- a non-empty `gpg.key` exporting only that public key;
- a successful `github-pages` deployment.

Missing credentials, a fingerprint mismatch, an unknown channel, zero or
multiple Debian assets, unsigned metadata, or a failed Pages deployment makes
the workflow red.

## 5. Verify from a clean client

For the default Pages domain:

```sh
curl -fsSL https://elizaos.github.io/os/gpg.key \
  | gpg --dearmor \
  | sudo tee /usr/share/keyrings/elizaos-archive-keyring.gpg >/dev/null

echo 'deb [signed-by=/usr/share/keyrings/elizaos-archive-keyring.gpg] https://elizaos.github.io/os beta main' \
  | sudo tee /etc/apt/sources.list.d/elizaos.list

sudo apt update
sudo apt install elizaos-app
```

Check the fetched `InRelease` fingerprint independently before installing. If
`apt.elizaos.ai` is later configured, add its DNS and Pages custom-domain
controls first, then update public instructions only after HTTPS and a clean
client test pass.

## Rotation and compromise

Before expiry, generate a new dedicated key, update all three secrets together,
and run a beta publication plus clean-client verification. Preserve the old
public key during a documented transition. If a private key is exposed, revoke
it immediately, remove the affected release path from service, replace the
secrets, and republish only after reviewing the repository history and signing
evidence.

See also [OS release administration checklist](./os-release-admin-checklist.md)
and the upstream [reprepro documentation](https://salsa.debian.org/brlink/reprepro).
