# One-shot release build for Quartz.
#
# Loads the signing env vars from User scope (so we never depend on the
# shell having inherited them), runs `tauri build`, and regenerates
# latest.json with the fresh signature. Output is a coherent
# (exe, sig, latest.json) trio under
# src-tauri\target\release\bundle\nsis\, ready to upload as a GitHub
# Release.
#
# Usage:
#   .\scripts\build-release.ps1
#   .\scripts\build-release.ps1 -Notes "Bug fixes for crossfade"

param(
  [string]$Notes = ""
)

$ErrorActionPreference = "Stop"

# Always pull the signing creds from User-scope so a fresh shell
# (which Windows doesn't always re-propagate User env vars to)
# still gets the right values.
$key = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "User")
$pw  = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "User")

if ([string]::IsNullOrWhiteSpace($key)) {
  Write-Error @"
TAURI_SIGNING_PRIVATE_KEY isn't set in User scope. Re-run:

  [Environment]::SetEnvironmentVariable(
    "TAURI_SIGNING_PRIVATE_KEY",
    (Get-Content "`$env:USERPROFILE\.tauri\quartz.key" -Raw),
    "User"
  )

…or set it inline for this shell before running this script.
"@
  exit 1
}

$env:TAURI_SIGNING_PRIVATE_KEY          = $key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $root
try {
  Write-Output "[1/2] Building + signing Tauri bundles…"
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }

  Write-Output ""
  Write-Output "[2/2] Generating latest.json manifest…"
  if ($Notes) {
    & "$PSScriptRoot\make-latest-json.ps1" -Notes $Notes
  } else {
    & "$PSScriptRoot\make-latest-json.ps1"
  }
  if ($LASTEXITCODE -ne 0) { throw "make-latest-json failed (exit $LASTEXITCODE)" }

  Write-Output ""
  Write-Output "Release artifacts are ready under:"
  Write-Output "  src-tauri\target\release\bundle\nsis\"
} finally {
  Pop-Location
}
