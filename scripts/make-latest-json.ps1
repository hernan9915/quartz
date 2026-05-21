# Generates the `latest.json` update manifest the Tauri auto-updater
# checks on app launch. Tauri 2 produces the signed `.exe` and detached
# `.sig` automatically (via `createUpdaterArtifacts: true` in
# tauri.conf.json) but does NOT assemble the JSON — that's our job.
#
# Run AFTER `npm run tauri build` succeeds. The output goes next to
# the installer in `src-tauri/target/release/bundle/nsis/latest.json`,
# ready to be uploaded as a GitHub Release asset.
#
# Usage:
#   .\scripts\make-latest-json.ps1
#   .\scripts\make-latest-json.ps1 -Notes "Bug fixes for crossfade"
#
# The version is read from tauri.conf.json so the script stays in sync
# with whatever you just built; no risk of typing the wrong version
# into the manifest.

param(
  [string]$Notes = "",
  [string]$GitHubUser = "hernan9915",
  [string]$Repo = "quartz"
)

$ErrorActionPreference = "Stop"

# Repo root = parent of this script's directory.
$root = Resolve-Path (Join-Path $PSScriptRoot "..")

# Pull version from tauri.conf.json so we never disagree with the binary.
$conf = Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version
if (-not $version) { throw "version field missing in tauri.conf.json" }

# Bundle paths produced by `tauri build`.
$nsisDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
$exeName = "Quartz_${version}_x64-setup.exe"
$exePath = Join-Path $nsisDir $exeName
$sigPath = "$exePath.sig"

foreach ($p in @($exePath, $sigPath)) {
  if (-not (Test-Path $p)) {
    throw "Missing build artifact: $p`nDid you run 'npm run tauri build' first?"
  }
}

# Signature is read verbatim — the .sig file is already base64-armored
# minisign output (4 lines of comments + the binary signature).
$signature = (Get-Content $sigPath -Raw).Trim()

# Public download URL on GitHub Releases. The release tag is assumed to
# be v$version — keep your `git tag` step in line with that.
$downloadUrl = "https://github.com/$GitHubUser/$Repo/releases/download/v$version/$exeName"

$manifest = [ordered]@{
  version   = $version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url       = $downloadUrl
    }
  }
}

$outPath = Join-Path $nsisDir "latest.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content $outPath -Encoding utf8

Write-Output "Wrote $outPath"
Write-Output "  version    : $version"
Write-Output "  url        : $downloadUrl"
Write-Output "  signature  : $($signature.Length) chars"
Write-Output ""
Write-Output "Next: upload these three files as assets of GitHub Release v$version :"
Write-Output "  $exePath"
Write-Output "  $sigPath"
Write-Output "  $outPath"
