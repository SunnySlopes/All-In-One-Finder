# Build the Windows portable package for the WebView2 host.
#
#   powershell -ExecutionPolicy Bypass -File scripts/package-host.ps1
#
# Prerequisites (all produced by earlier steps):
#   native/host/build/aio-host.exe      (host; scripts/build-host.ps1)
#   native/build-engine/allinone.dll    (scripts/build-engine.ps1)
#   native/host/build/WebView2Loader.dll (SDK)
#   dist/                               (npm run build)
#
# Output: release/All-In-One Finder <version>.exe
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$stage = Join-Path $root 'native\host\stage'
$release = Join-Path $root 'release'

function Need($path, $hint) {
    if (-not (Test-Path $path)) { throw "missing $path`n  -> $hint" }
}

Need (Join-Path $root 'native\host\build\aio-host.exe') 'build the host first'
$dll = Join-Path $root 'native\build-engine\allinone.dll'
if (-not (Test-Path $dll)) { $dll = Join-Path $root 'native\build-dll\allinone.dll' }
if (-not (Test-Path $dll)) { $dll = Join-Path $root 'native\build\allinone.dll' }
Need $dll 'run: npm run engine'
Need (Join-Path $root 'native\host\build\WebView2Loader.dll') 'copy WebView2Loader.dll from the SDK'
Need (Join-Path $root 'dist\index.html') 'run: npm run build'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage 'web'), (Join-Path $stage 'dist') | Out-Null

Copy-Item (Join-Path $root 'native\host\build\aio-host.exe') (Join-Path $stage 'All-In-One Finder.exe')
Copy-Item $dll (Join-Path $stage 'allinone.dll')
Copy-Item (Join-Path $root 'native\host\build\WebView2Loader.dll') (Join-Path $stage 'WebView2Loader.dll')
Copy-Item (Join-Path $root 'native\host\web\bridge.js') (Join-Path $stage 'web\bridge.js')
Copy-Item (Join-Path $root 'dist\*') (Join-Path $stage 'dist') -Recurse -Force
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $stage 'LICENSE.txt')

$sizes = Get-ChildItem $stage -Recurse -File | Measure-Object -Property Length -Sum
Write-Host ("stage: {0:N1} MB in {1} files" -f ($sizes.Sum / 1MB), $sizes.Count)

New-Item -ItemType Directory -Force -Path $release | Out-Null
$makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
if (-not $makensis) {
    $makensis = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1-1mx3n\makensis.exe'
}
if (-not (Test-Path $makensis)) { throw 'makensis not found: install NSIS (winget install NSIS.NSIS) or set it on PATH' }

Push-Location (Join-Path $root 'native\host')
try {
    & $makensis "/DAPP_VERSION=$version" "/DOUTDIR=$release" 'portable.nsi'
    if ($LASTEXITCODE -ne 0) { throw "makensis failed with $LASTEXITCODE" }
} finally {
    Pop-Location
}

$out = Join-Path $release ("All-In-One Finder {0}.exe" -f $version)
Get-Item $out | Select-Object FullName, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }




