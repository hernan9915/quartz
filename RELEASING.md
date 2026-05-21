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

3. **Build + sign + manifest in one command**:

   ```powershell
   .\scripts\build-release.ps1 -Notes "Short summary of this release"
   ```

   The script:
   - Reads the signing key + password from your User-scope env vars
     (which Windows doesn't always re-propagate to existing shells —
     this is the foolproof path)
   - Runs `npm run tauri build` to compile, bundle, and sign
   - Runs `make-latest-json.ps1` to assemble the update manifest

   Successful output produces three coherent files under
   `src-tauri\target\release\bundle\nsis\`:

   | File | What it is |
   |---|---|
   | `Quartz_X.Y.Z_x64-setup.exe` | The installer end users download |
   | `Quartz_X.Y.Z_x64-setup.exe.sig` | Detached signature (binary integrity proof) |
   | `latest.json` | Update manifest the running app fetches |

   ⚠️ **Don't run plain `npm run tauri build` directly** — fresh
   PowerShell windows on Windows often don't inherit User-scope env
   vars, so the signing step will hang or fail. The wrapper above
   sources the vars explicitly to avoid that trap.

4. **Tag the commit** locally:

   ```powershell
   git tag -a vX.Y.Z -m "Quartz X.Y.Z"
   git push origin vX.Y.Z
   ```

5. **Create a GitHub Release** for the tag, attaching all three artifacts:

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

6. **Sanity check**: open `https://github.com/hernan9915/quartz/releases/latest/download/latest.json`
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
