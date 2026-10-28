# Build the C engine DLL (allinone.dll) with CMake + Ninja.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-engine.ps1
#
# Requires MSYS2 UCRT64 (gcc/g++/cmake/ninja) and the cubiomes submodules:
#   git submodule update --init --recursive
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolchain = 'C:\msys64\ucrt64\bin'
$build = Join-Path $root 'native\build-engine'
$env:PATH = "$toolchain;$env:PATH"

if (-not (Test-Path (Join-Path $toolchain 'g++.exe'))) { throw "g++ not found in $toolchain" }

Write-Host "configuring $build"
& cmake -S (Join-Path $root 'native') -B $build -G Ninja `
    -DCMAKE_BUILD_TYPE=Release `
    -DCMAKE_C_COMPILER=C:/msys64/ucrt64/bin/gcc.exe `
    -DCMAKE_CXX_COMPILER=C:/msys64/ucrt64/bin/g++.exe
if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }

Write-Host 'building allinone.dll'
& cmake --build $build
if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }

Get-Item (Join-Path $build 'allinone.dll') | Select-Object FullName, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }
Write-Host 'engine build OK'
