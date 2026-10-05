<#
.SYNOPSIS
  Installs the pinned Node.js and PostgreSQL binaries for Morrow into the
  current user's profile.

.DESCRIPTION
  Needs no administrator rights. Does not touch PATH, the registry, or any
  Windows service. Everything lands under %LOCALAPPDATA%\Morrow\toolchain, so
  deleting that folder removes it again.

  Use this when Node.js 24 and PostgreSQL 17 are not already installed. If they
  are on PATH already, skip this script.
#>
[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'Morrow\toolchain')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$versions = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'toolchain-versions.psd1')
$downloads = Join-Path $Root 'downloads'
New-Item -ItemType Directory -Force $downloads | Out-Null

function Get-VerifiedArchive {
    param([hashtable]$Package)

    $file = Join-Path $downloads (Split-Path $Package.Url -Leaf)
    if (-not (Test-Path $file)) {
        Write-Host "Downloading $($Package.Url)"
        Invoke-WebRequest -Uri $Package.Url -OutFile $file -UseBasicParsing
    }
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Package.Sha256) {
        throw "SHA-256 mismatch for $file. Expected $($Package.Sha256), got $actual. Delete the file and retry; do not use it."
    }
    return $file
}

function Expand-Package {
    param([string]$Archive, [string]$Target, [string[]]$Exclude = @())

    # Extract next to the target and rename, so an interrupted run never
    # leaves a half-populated folder that looks installed.
    $staging = "$Target.partial"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force $staging | Out-Null

    $tarArgs = @('-xf', $Archive, '-C', $staging)
    foreach ($pattern in $Exclude) { $tarArgs += @('--exclude', $pattern) }
    & tar.exe @tarArgs
    if ($LASTEXITCODE -ne 0) { throw "tar failed for $Archive (exit $LASTEXITCODE)" }

    Move-Item $staging $Target
}

# Node.js: the archive contains a single top-level folder named like the release.
$nodeHome = Join-Path $Root $versions.Node.Folder
if (Test-Path (Join-Path $nodeHome 'node.exe')) {
    Write-Host "Node.js $($versions.Node.Version) already present."
} else {
    $archive = Get-VerifiedArchive $versions.Node
    $unpacked = Join-Path $Root 'node.unpack'
    if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
    Expand-Package -Archive $archive -Target $unpacked
    Move-Item (Join-Path $unpacked $versions.Node.Folder) $nodeHome
    Remove-Item -Recurse -Force $unpacked
    Write-Host "Installed Node.js $($versions.Node.Version)."
}

# PostgreSQL: the archive contains pgsql\. pgAdmin, StackBuilder, debug symbols
# and HTML docs are skipped; Morrow only needs the server and client binaries.
$pgHome = Join-Path $Root $versions.PostgreSql.Folder
if (Test-Path (Join-Path $pgHome 'pgsql\bin\postgres.exe')) {
    Write-Host "PostgreSQL $($versions.PostgreSql.Version) already present."
} else {
    $archive = Get-VerifiedArchive $versions.PostgreSql
    Expand-Package -Archive $archive -Target $pgHome -Exclude @(
        'pgsql/pgAdmin 4', 'pgsql/StackBuilder', 'pgsql/symbols', 'pgsql/doc'
    )
    Write-Host "Installed PostgreSQL $($versions.PostgreSql.Version)."
}

Write-Host ''
Write-Host "Toolchain root: $Root"
Write-Host 'Next: dot-source scripts\dev-env.ps1 to put it on PATH for this shell.'
