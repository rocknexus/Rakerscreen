# Builds the APK and publishes it as GitHub release v<version> (version from web/main.js).
# Installed Rakerscreen apps find it on their next update check.
#   powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Notes "What changed"
# Needs the GitHub CLI (gh) signed in with access to the repository, and the original signing key.
param(
    [string]$Notes = "",
    [string]$Repo = "rocknexus/Rakerscreen"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path "$root\pocketscreen-debug.keystore")) {
    throw "pocketscreen-debug.keystore is missing. Restore the original key first: an APK signed with a new key can't update existing installs."
}
& "$root\build.ps1"
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "build failed" }

$m = Select-String -Path "$root\web\main.js" -Pattern 'const VERSION = "(\d+\.\d+\.\d+)"' | Select-Object -First 1
$ver = $m.Matches[0].Groups[1].Value
$apk = Join-Path $root "releases\Rakerscreen-v$ver.apk"
if (-not (Test-Path $apk)) { throw "$apk not found" }

& gh release view "v$ver" --repo $Repo *> $null
if ($LASTEXITCODE -eq 0) { throw "Release v$ver already exists. Bump VERSION in web/main.js first." }

if (-not $Notes) { $Notes = "Rakerscreen $ver" }
& gh release create "v$ver" $apk --repo $Repo --title "v$ver" --notes $Notes --latest
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
Write-Host "Published v$ver to https://github.com/$Repo/releases/tag/v$ver"
