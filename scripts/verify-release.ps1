# Machine-checkable release gate (the parts of DoD D1/D8 that do not need a VM).
#
#   powershell -ExecutionPolicy Bypass -File scripts/verify-release.ps1
#
# Checks:
#   - portable exe exists and is <= 10 MB (D1)
#   - version resource matches package.json, company/license present
#   - stage holds exactly the shippable files (no session/userdata/smoke residue)
#   - host exe + allinone.dll import only Windows system DLLs (D8)
#   - WebView2Loader.dll is staged
#   - a pristine copy of the stage passes --smoke (page -> host -> engine)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$stage = Join-Path $root 'native\host\stage'
$exe = Join-Path $root "release\All-In-One Finder $version.exe"
$objdump = 'C:\msys64\ucrt64\bin\objdump.exe'
$allow = @(
    'KERNEL32.dll', 'USER32.dll', 'GDI32.dll', 'SHELL32.dll', 'ole32.dll', 'comdlg32.dll',
    'advapi32.dll', 'oleaut32.dll', 'shlwapi.dll'
)
$apiPrefix = 'api-ms-win-crt-'

$failures = New-Object System.Collections.Generic.List[string]
function Check($name, [bool]$ok, $detail) {
    if ($ok) { Write-Host ("PASS  {0}  {1}" -f $name, $detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $name, $detail); $failures.Add($name) | Out-Null }
}

Check 'D1 size' ((Test-Path $exe) -and ((Get-Item $exe).Length -le 10MB)) `
    ("{0:N2} MB" -f ((Get-Item $exe -ErrorAction SilentlyContinue).Length / 1MB))

$vi = (Get-Item $exe -ErrorAction SilentlyContinue).VersionInfo
Check 'version' ($vi -and $vi.FileVersion -eq $version -and $vi.ProductVersion -eq $version) `
    "FileVersion=$($vi.FileVersion) ProductVersion=$($vi.ProductVersion)"
Check 'metadata' ($vi -and $vi.CompanyName -and $vi.LegalCopyright -eq 'GPL-3.0-only') `
    "Company='$($vi.CompanyName)' License='$($vi.LegalCopyright)'"

$expectedTop = @('All-In-One Finder.exe', 'allinone.dll', 'WebView2Loader.dll', 'LICENSE.txt')
$actualTop = @(Get-ChildItem $stage -File | Select-Object -ExpandProperty Name)
$extra = $actualTop | Where-Object { $expectedTop -notcontains $_ }
$missing = $expectedTop | Where-Object { $actualTop -notcontains $_ }
Check 'stage files' (($extra.Count -eq 0) -and ($missing.Count -eq 0)) `
    ("extra=[{0}] missing=[{1}]" -f ($extra -join ','), ($missing -join ','))
Check 'stage dirs' ((Test-Path (Join-Path $stage 'dist\index.html')) -and (Test-Path (Join-Path $stage 'web\bridge.js'))) 'dist/ + web/'

if (Test-Path $objdump) {
    foreach ($name in @('All-In-One Finder.exe', 'allinone.dll')) {
        $path = Join-Path $stage $name
        $imports = & $objdump -p $path | Select-String 'DLL Name' |
            ForEach-Object { ($_.Line -split ':')[1].Trim() }
        $bad = $imports | Where-Object { ($allow -notcontains $_) -and (-not $_.StartsWith($apiPrefix)) }
        Check "imports $name" ($bad.Count -eq 0) ("non-system: " + (($bad | Select-Object -Unique) -join ', '))
    }
} else {
    Write-Host "SKIP  imports  objdump not found at $objdump"
}

$probe = Join-Path $env:TEMP ('aio-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
Copy-Item $stage $probe -Recurse -Force
try {
    $out = Join-Path $probe 'smoke.txt'
    # The host is a GUI-subsystem exe: `&` would not wait for it, so use
    # Start-Process with redirects and check the real exit code.
    $errFile = Join-Path $probe 'smoke.err.txt'
    $child = Start-Process -FilePath (Join-Path $probe 'All-In-One Finder.exe') `
        -ArgumentList @('--smoke', '--portable-dir', $probe) `
        -WorkingDirectory $probe -Wait -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $errFile
    $code = $child.ExitCode
    $log = (Get-Content $out -Raw) + (Get-Content $errFile -Raw)
    Check 'smoke' (($code -eq 0) -and ($log -match 'engine round-trip OK')) "exit=$code"
} finally {
    Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures.Count -eq 0) {
    Write-Host "verify-release OK ($version)"
    exit 0
}
Write-Host ("verify-release FAILED: " + ($failures -join ', '))
exit 1
