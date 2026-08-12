Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
  throw "vswhere.exe is required at $vswhere"
}

$version = & $vswhere `
  -latest `
  -products '*' `
  -version '[17.0,18.0)' `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationVersion
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^17\.') {
  throw 'Electron 41 requires Visual Studio 2022/17.x with the x86/x64 C++ toolchain'
}

Write-Host "Visual Studio toolchain: $version"
