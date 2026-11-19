# Builds releases\Rakerscreen-v<version>.apk with the Android SDK command-line tools only (no Gradle).
# The version comes from `const VERSION = "x.y.z"` (or "x.y.z-dev" for a dev build) in web/main.js, the single place to bump it.
# Requirements: Android SDK (platform + build-tools) and a JDK 17+ (Android Studio's bundled JBR works).
#   powershell -ExecutionPolicy Bypass -File build.ps1
param(
    [string]$Sdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }),
    [string]$JavaHome = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Android\Android Studio\jbr" })
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "build"

$m = Select-String -Path "$root\web\main.js" -Pattern 'const VERSION = "(\d+)\.(\d+)\.(\d+)(-dev(?:\.(\d+))?)?"' | Select-Object -First 1
if (-not $m) { throw "VERSION not found in web/main.js" }
$g = $m.Matches[0].Groups
$VersionName = "$($g[1].Value).$($g[2].Value).$($g[3].Value)$($g[4].Value)"
# monotonically increasing versionCode so every new version installs over the previous one:
# (major*10000 + minor*100 + patch)*100, plus 50 for a plain release, so x.y.z-dev comes before x.y.z
# (and x.y.z-dev.N, if ever used, before that). Until 0.4.3 it was major*10000 + minor*100 + patch (last: 403).
$suffix = if (-not $g[4].Success) { 50 } elseif ($g[5].Success) { [Math]::Min(49, [int]$g[5].Value) } else { 0 }
$VersionCode = ([int]$g[1].Value * 10000 + [int]$g[2].Value * 100 + [int]$g[3].Value) * 100 + $suffix
Write-Host "Version: $VersionName (code $VersionCode)"

$platform = Get-ChildItem "$Sdk\platforms" | Sort-Object { [version](($_.Name -replace '^android-', '') -replace '[^0-9.]', '') } | Select-Object -Last 1
$bt = Get-ChildItem "$Sdk\build-tools" | Sort-Object { [version]$_.Name } | Select-Object -Last 1
$androidJar = Join-Path $platform.FullName "android.jar"
$aapt2 = Join-Path $bt.FullName "aapt2.exe"
$d8 = Join-Path $bt.FullName "d8.bat"
$zipalign = Join-Path $bt.FullName "zipalign.exe"
$apksigner = Join-Path $bt.FullName "apksigner.bat"
$javac = Join-Path $JavaHome "bin\javac.exe"
$keytool = Join-Path $JavaHome "bin\keytool.exe"
$env:JAVA_HOME = $JavaHome
$env:PATH = "$JavaHome\bin;$env:PATH"
Write-Host "Platform: $($platform.Name)  Build-tools: $($bt.Name)  JDK: $JavaHome"

function Run($exe, [string[]]$argv) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) failed with exit code $LASTEXITCODE" }
}

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force "$out\res", "$out\classes", "$out\dex", "$out\assets\web" | Out-Null

# 1. Assets: the web UI
Copy-Item -Recurse "$root\web\*" "$out\assets\web\"

# 2. Resources
Run $aapt2 @("compile", "--dir", "$root\android\res", "-o", "$out\res\res.zip")
Run $aapt2 @("link", "-I", $androidJar, "--manifest", "$root\android\AndroidManifest.xml",
    "--min-sdk-version", "21", "--target-sdk-version", "35",
    "--version-code", "$VersionCode", "--version-name", $VersionName,
    "-o", "$out\unsigned.apk", "$out\res\res.zip")
# (assets are added in step 4: aapt2 -A on Windows writes "assets/web\file" entry names, which Android can't find)

# 3. Java -> class -> dex
$sources = Get-ChildItem -Recurse "$root\android\src" -Filter *.java | ForEach-Object { $_.FullName }
Run $javac (@("--release", "11", "-classpath", $androidJar, "-d", "$out\classes", "-encoding", "UTF-8", "-Xlint:-options") + $sources)
$classes = Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object { $_.FullName }
Run $d8 (@("--release", "--min-api", "21", "--lib", $androidJar, "--output", "$out\dex") + $classes)

# 4. Add classes.dex to the APK
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\unsigned.apk", "Update")
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", "classes.dex") | Out-Null
$assetRoot = (Resolve-Path "$out\assets").Path
foreach ($f in Get-ChildItem -Recurse -File $assetRoot) {
    $name = "assets/" + $f.FullName.Substring($assetRoot.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $name) | Out-Null
}
$bad = @($zip.Entries | Where-Object { $_.FullName.Contains('\') })
$zip.Dispose()
if ($bad.Count) { throw "APK contains entries with backslashes: $($bad[0].FullName)" }

# 5. Align and sign (debug key, generated once and kept next to the script)
Run $zipalign @("-p", "-f", "4", "$out\unsigned.apk", "$out\aligned.apk")
$ks = Join-Path $root "pocketscreen-debug.keystore"
if (-not (Test-Path $ks)) {
    Run $keytool @("-genkeypair", "-keystore", $ks, "-storepass", "android", "-keypass", "android", "-alias", "pocketscreen",
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Rakerscreen Debug")
}
New-Item -ItemType Directory -Force "$root\releases" | Out-Null
$apk = Join-Path $root "releases\Rakerscreen-v$VersionName.apk"
Run $apksigner @("sign", "--v4-signing-enabled", "false", "--ks", $ks, "--ks-pass", "pass:android", "--key-pass", "pass:android", "--ks-key-alias", "pocketscreen", "--out", $apk, "$out\aligned.apk")
Run $apksigner @("verify", "--print-certs", $apk)
Write-Host "`nBuilt $apk ($([math]::Round((Get-Item $apk).Length / 1KB)) KB)"
