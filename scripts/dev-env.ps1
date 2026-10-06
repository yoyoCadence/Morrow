<#
.SYNOPSIS
  Puts the Morrow toolchain on PATH for the current PowerShell session.

.DESCRIPTION
  Dot-source it:   . .\scripts\dev-env.ps1

  Only the current process is affected. Nothing is persisted, so a new shell
  needs it again. If node and psql are already on PATH from a regular install,
  this script leaves them alone, unless that node is a version package.json
  would refuse. Then the pinned copy goes first on PATH for this shell only, so
  the system-wide install, and every other project using it, stays as it is.
#>
[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'Morrow\toolchain')
)

$versions = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'toolchain-versions.psd1')

$candidates = @(
    @{ Probe = 'node'; Path = (Join-Path $Root $versions.Node.Folder) },
    @{ Probe = 'psql'; Path = (Join-Path $Root (Join-Path $versions.PostgreSql.Folder 'pgsql\bin')) }
)

# Mirrors package.json "engines": the pinned version or later, same major.
function Test-MorrowNodeVersion {
    try { $found = [version]((& node --version).Trim().TrimStart('v')) } catch { return $false }
    $pinned = [version]$versions.Node.Version
    return ($found.Major -eq $pinned.Major) -and ($found -ge $pinned)
}

foreach ($candidate in $candidates) {
    $onPath = [bool](Get-Command $candidate.Probe -ErrorAction SilentlyContinue)
    if ($onPath -and ($candidate.Probe -ne 'node' -or (Test-MorrowNodeVersion))) { continue }
    if (-not (Test-Path $candidate.Path)) {
        $problem = 'is not on PATH'
        if ($onPath) { $problem = "on PATH is not $($versions.Node.Version) or a later $(([version]$versions.Node.Version).Major).x" }
        Write-Warning "$($candidate.Probe) $problem and $($candidate.Path) does not exist. Run scripts\setup-toolchain.ps1 first."
        continue
    }
    $env:PATH = "$($candidate.Path);$env:PATH"
}
