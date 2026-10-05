<#
.SYNOPSIS
  Puts the Morrow toolchain on PATH for the current PowerShell session.

.DESCRIPTION
  Dot-source it:   . .\scripts\dev-env.ps1

  Only the current process is affected. Nothing is persisted, so a new shell
  needs it again. If node and psql are already on PATH from a regular install,
  this script leaves them alone.
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

foreach ($candidate in $candidates) {
    if (Get-Command $candidate.Probe -ErrorAction SilentlyContinue) { continue }
    if (-not (Test-Path $candidate.Path)) {
        Write-Warning "$($candidate.Probe) is not on PATH and $($candidate.Path) does not exist. Run scripts\setup-toolchain.ps1 first."
        continue
    }
    $env:PATH = "$($candidate.Path);$env:PATH"
}
