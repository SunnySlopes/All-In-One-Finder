# Development loop: Vite dev server + the WebView2 host pointed at it.
#
#   powershell -ExecutionPolicy Bypass -File scripts/dev-host.ps1
#
# The host loads http://127.0.0.1:5173 instead of the bundled dist/, so renderer
# edits hot-reload. Requires a previously built engine DLL (scripts/build-engine.ps1).
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$hostExe = Join-Path $root 'native\host\build\aio-host.exe'
$dataDir = Join-Path $root 'userdata'

& (Join-Path $root 'scripts\build-host.ps1')
if ($LASTEXITCODE -ne 0) { throw 'host build failed' }
if (-not (Test-Path $hostExe)) { throw "host exe missing: $hostExe" }
if (-not (Test-Path (Join-Path $root 'native\build-engine\allinone.dll'))) {
    throw 'engine DLL missing: run scripts/build-engine.ps1 first'
}
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Copy-Item (Join-Path $root 'native\build-engine\allinone.dll') (Join-Path $root 'native\host\build\allinone.dll') -Force

$vite = Start-Process -FilePath 'npm' -ArgumentList @('exec', 'vite', '--', '--port', '5173', '--strictPort') `
    -WorkingDirectory $root -NoNewWindow -PassThru
try {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $probe = Test-NetConnection 127.0.0.1 -Port 5173 -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($probe) { break }
        Start-Sleep -Milliseconds 300
    }
    Start-Process -FilePath $hostExe -ArgumentList @("--dev", "http://127.0.0.1:5173", "--portable-dir", $dataDir) -Wait
} finally {
    if (-not $vite.HasExited) { $vite.Kill() }
}
