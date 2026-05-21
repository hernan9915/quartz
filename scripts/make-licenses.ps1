# Regenerate THIRD_PARTY_LICENSES.html in the repo root.
#
# Runs cargo-about against the Tauri backend's full dependency tree and
# renders the result through src-tauri/about.hbs. Call this after every
# cargo upgrade so the published attributions stay in sync with what
# you actually ship.
#
# Usage:
#   .\scripts\make-licenses.ps1
#
# First-time setup (one-off):
#   cargo install cargo-about --locked

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$srcTauri = Join-Path $root "src-tauri"
$out = Join-Path $root "THIRD_PARTY_LICENSES.html"

Push-Location $srcTauri
try {
    cargo about generate about.hbs --output-file $out
    if ($LASTEXITCODE -ne 0) {
        throw "cargo-about exited with code $LASTEXITCODE"
    }
    Write-Output "Wrote $out"
    Write-Output "  size: $((Get-Item $out).Length) bytes"
}
finally {
    Pop-Location
}
