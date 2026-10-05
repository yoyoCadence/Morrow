@{
    # Pinned toolchain for Morrow. Bump versions and hashes together.
    Node = @{
        Version = '24.19.0'
        Url     = 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip'
        # Matches https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
        Sha256  = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
        Folder  = 'node-v24.19.0-win-x64'
    }
    PostgreSql = @{
        Version = '17.11-1'
        Url     = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip'
        # EDB publishes no checksum file for this archive. This is the hash
        # observed on first download (2026-10-05), pinned so later downloads
        # must match it.
        Sha256  = '6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3'
        Folder  = 'postgresql-17.11-1'
    }
    # Local cluster settings used by pg-local.ps1.
    PgPort  = 54317
    PgMajor = '17'
}
