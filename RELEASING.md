# Releasing Quartz

End-to-end flow for cutting a new release that the auto-updater can install
on existing installs.

## One-time setup (done)

A signing keypair lives at:

```
C:\Users\Hernan\.tauri\quartz.key       (private — keep offline, never commit)
C:\Users\Hernan\.tauri\quartz.key.pub   (public — already pasted into tauri.conf.json)
```

If you lose the private key you can't ship updates — existing installs will
reject any new release because the signature won't verify. **Back the file
up to a password manager / encrypted USB.** A one-line copy is enough:

```powershell
Get-Content $env:USERPROFILE\.tauri\quartz.key
```

Paste the resulting text into 1Password / Bitwarden as a secure note.

The keypair was generated without a password (acceptable for personal use;
the security boundary is the file on disk). If you want a password later:

```powershell
npx @tauri-apps/cli signer generate -w $env:USERPROFILE\.tauri\quartz.key -f
```

`-f` overwrites the existing key. Note that any installed app with the
*old* pubkey baked in will then reject updates signed by the *new* key —
so plan to ship one final update under the old key that includes the new
pubkey before rotating.

## Cutting a release

1. **Bump the version** in three places (they must match):
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`

2. **Write the changelog** entry at the top of `CHANGELOG.md`.

3. **Set the signing env vars** for this shell:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\quartz.key" -Raw
   # Tauri prompts for a password even when the key has none — set this
   # to empty string to skip the prompt. If your key DOES have a password,
   # paste it here instead.
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   ```

   On this machine both are already set persistently for the user, so
   any new shell inherits them automatically and you can skip this step.

4. **Build + sign**:

   ```powershell
   npm run tauri build
   ```

   Successful output produces two files under
   `src-tauri\target\release\bundle\nsis\`:

   | File | What it is |
   |---|---|
   | `Quartz_X.Y.Z_x64-setup.exe` | The installer end users download |
   | `Quartz_X.Y.Z_x64-setup.exe.sig` | Detached signature (binary integrity proof) |

5. **Generate the update manifest**. Tauri 2 doesn't auto-create
   `latest.json` — we have a small script for it:

   ```powershell
   .\scripts\make-latest-json.ps1 -Notes "Short summary of this release"
   ```

   That reads the version from `tauri.conf.json`, picks up the
   freshly-built `.sig`, and writes `latest.json` next to the installer.

6. **Tag the commit** locally:

   ```powershell
   git tag -a vX.Y.Z -m "Quartz X.Y.Z"
   git push origin vX.Y.Z
   ```

7. **Create a GitHub Release** for the tag, attaching all three artifacts:

   ```powershell
   gh release create vX.Y.Z `
     --title "Quartz X.Y.Z" `
     --notes-file (Resolve-Path .\CHANGELOG.md) `
     "src-tauri\target\release\bundle\nsis\Quartz_X.Y.Z_x64-setup.exe" `
     "src-tauri\target\release\bundle\nsis\Quartz_X.Y.Z_x64-setup.exe.sig" `
     "src-tauri\target\release\bundle\nsis\latest.json"
   ```

   The `releases/latest/download/latest.json` URL in `tauri.conf.json`
   automatically resolves to the new release — no DNS change, no manual
   redirect to update.

8. **Sanity check**: open `https://github.com/hernan9915/quartz/releases/latest/download/latest.json`
   in a browser; should download the JSON. Open it; the version field
   should match what you just released.

## What existing installs do

On launch, after a 4 s grace period, the app fetches that `latest.json`,
compares the version to its own, and if newer:

- Downloads the `.exe` referenced in the manifest
- Verifies the `.sig` against the public key embedded at build time
- Shows the in-app prompt → user clicks Install → swaps binary → relaunches

If the network is offline or the endpoint is unreachable, the check
silently fails and retries on the next launch — the user is never bothered
with "couldn't check for updates" toasts.

## Reverting a bad release

You can't unship a signed release — once a user has installed `X.Y.Z`
there's no remote kill switch. The fix is to immediately ship `X.Y.Z+1`
that reverts the change. The auto-updater will pull users up to it on
their next launch.

If the new release breaks startup entirely, users have to download the
previous installer manually from the Releases page — keep older
installers in their release for at least a few versions back.

## CI option (later)

When you're ready, a `release.yml` GitHub Action can do steps 3–6
automatically on tag push. The signing private key + password go in
GitHub repo secrets (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Then `git push origin vX.Y.Z`
is the only manual step.
