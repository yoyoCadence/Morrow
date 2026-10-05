<#
.SYNOPSIS
  Manages the local PostgreSQL cluster Morrow uses.

.DESCRIPTION
  init    Create the cluster, the "morrow" role and the "morrow" and
          "morrow_test" databases, then write the connection strings to .env.
          Safe to re-run.
  start   Start the server.
  stop    Stop the server.
  status  Report whether the server is running.

  The server runs as the current user, listens on 127.0.0.1 only, and is not a
  Windows service: it runs only while started, and stops at logoff or shutdown.
  Data lives outside the repository so "git clean" can never delete it.

  Passwords are generated here and never printed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('init', 'start', 'stop', 'status')]
    [string]$Action,

    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'Morrow')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'dev-env.ps1')
$versions = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'toolchain-versions.psd1')

$port = [int]$versions.PgPort
$dataDir = Join-Path $DataRoot (Join-Path 'pgdata' $versions.PgMajor)
$logFile = Join-Path $DataRoot 'pgdata\postgres.log'
$secretsDir = Join-Path $DataRoot 'secrets'
$superPwFile = Join-Path $secretsDir 'postgres-superuser.pw'
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function New-Password {
    # Alphanumeric only, so it needs no escaping inside a connection URL.
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] 40
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Invoke-PgCtl {
    param([string[]]$Arguments)
    # Start-Process keeps the server from inheriting this shell's output
    # handles; with a plain call, "pg_ctl start" can hang a captured pipeline.
    # WaitForExit waits for pg_ctl alone. "Start-Process -Wait" would also wait
    # for the server it launches, which never exits.
    $process = Start-Process -FilePath 'pg_ctl.exe' -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    $process.WaitForExit()
    return $process.ExitCode
}

function Test-ServerRunning {
    if (-not (Test-Path (Join-Path $dataDir 'PG_VERSION'))) { return $false }
    return (Invoke-PgCtl @('status', '-D', "`"$dataDir`"")) -eq 0
}

function Start-Server {
    if (Test-ServerRunning) { Write-Host "PostgreSQL already running on 127.0.0.1:$port."; return }
    if (-not (Test-Path (Join-Path $dataDir 'PG_VERSION'))) { throw "No cluster at $dataDir. Run: scripts\pg-local.ps1 init" }
    $code = Invoke-PgCtl @('start', '-w', '-D', "`"$dataDir`"", '-l', "`"$logFile`"")
    if ($code -ne 0) { throw "pg_ctl start failed (exit $code). See $logFile" }
    Write-Host "PostgreSQL started on 127.0.0.1:$port."
}

function Stop-Server {
    if (-not (Test-ServerRunning)) { Write-Host 'PostgreSQL is not running.'; return }
    $code = Invoke-PgCtl @('stop', '-w', '-m', 'fast', '-D', "`"$dataDir`"")
    if ($code -ne 0) { throw "pg_ctl stop failed (exit $code). See $logFile" }
    Write-Host 'PostgreSQL stopped.'
}

function Invoke-SuperuserSql {
    param([string]$Sql, [hashtable]$Environment = @{})
    # SQL goes in on stdin and secrets through the environment, so neither
    # shows up on a command line.
    $env:PGPASSWORD = (Get-Content $superPwFile -Raw).Trim()
    foreach ($name in $Environment.Keys) { Set-Item "Env:$name" $Environment[$name] }
    try {
        $output = $Sql | & psql.exe -h 127.0.0.1 -p $port -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 -f -
        if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE)" }
        return $output
    } finally {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
        foreach ($name in $Environment.Keys) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    }
}

function Initialize-Cluster {
    if (Test-Path (Join-Path $dataDir 'PG_VERSION')) {
        Write-Host "Cluster already initialised at $dataDir."
    } else {
        New-Item -ItemType Directory -Force $secretsDir | Out-Null
        New-Item -ItemType Directory -Force (Split-Path $dataDir -Parent) | Out-Null
        [System.IO.File]::WriteAllText($superPwFile, (New-Password), $utf8NoBom)

        # The builtin C.UTF-8 provider keeps text ordering identical on every
        # machine, which replayed results depend on.
        & initdb.exe -D $dataDir -U postgres --auth=scram-sha-256 "--pwfile=$superPwFile" `
            --encoding=UTF8 --locale=C --locale-provider=builtin --builtin-locale=C.UTF-8 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "initdb failed (exit $LASTEXITCODE)" }

        $settings = @('', '# Morrow local settings', "listen_addresses = '127.0.0.1'", "port = $port", "timezone = 'UTC'")
        [System.IO.File]::AppendAllLines((Join-Path $dataDir 'postgresql.conf'), [string[]]$settings, $utf8NoBom)
        Write-Host "Cluster created at $dataDir."
    }

    Start-Server

    $envText = ''
    if (Test-Path $envFile) { $envText = [System.IO.File]::ReadAllText($envFile) }
    $hasUrl = $envText -match '(?m)^MORROW_DATABASE_URL='
    $roleExists = (Invoke-SuperuserSql "SELECT 1 FROM pg_roles WHERE rolname = 'morrow';") -eq '1'

    if ($hasUrl -and $roleExists) {
        Write-Host '.env already has MORROW_DATABASE_URL; leaving the role password alone.'
    } else {
        # Either the role is new, or .env lost its connection string and the
        # old password cannot be recovered. Set a fresh one and record it.
        $appPassword = New-Password
        $verb = 'CREATE'
        if ($roleExists) { $verb = 'ALTER' }
        Invoke-SuperuserSql -Environment @{ MORROW_PG_APP_PASSWORD = $appPassword } -Sql @"
\getenv pw MORROW_PG_APP_PASSWORD
$verb ROLE morrow LOGIN PASSWORD :'pw';
"@ | Out-Null

        $kept = @($envText -split "`r?`n" | Where-Object { $_ -notmatch '^MORROW_(TEST_)?DATABASE_URL=' -and $_ -ne '' })
        $lines = $kept + @(
            "MORROW_DATABASE_URL=postgres://morrow:$appPassword@127.0.0.1:$port/morrow",
            "MORROW_TEST_DATABASE_URL=postgres://morrow:$appPassword@127.0.0.1:$port/morrow_test"
        )
        [System.IO.File]::WriteAllLines($envFile, [string[]]$lines, $utf8NoBom)
        Write-Host 'Role "morrow" is ready; connection strings written to .env.'
    }

    foreach ($database in @('morrow', 'morrow_test')) {
        $exists = (Invoke-SuperuserSql "SELECT 1 FROM pg_database WHERE datname = '$database';") -eq '1'
        if (-not $exists) {
            Invoke-SuperuserSql "CREATE DATABASE $database OWNER morrow;" | Out-Null
            Write-Host "Database `"$database`" created."
        }
    }
}

switch ($Action) {
    'init' { Initialize-Cluster }
    'start' { Start-Server }
    'stop' { Stop-Server }
    'status' {
        if (Test-ServerRunning) { Write-Host "running on 127.0.0.1:$port (data: $dataDir)" }
        else { Write-Host "not running (data: $dataDir)" }
    }
}
