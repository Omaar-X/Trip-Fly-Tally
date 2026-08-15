$ErrorActionPreference = 'Stop'

$mysqlBase = 'C:\Program Files\MySQL\MySQL Server 8.4'
$mysqld = Join-Path $mysqlBase 'bin\mysqld.exe'
$config = 'C:\ProgramData\MySQL\MySQL Server 8.4\my.ini'

if (-not (Test-Path -LiteralPath $mysqld)) {
  throw "MySQL server binary not found at $mysqld"
}

if (-not (Test-Path -LiteralPath $config)) {
  throw "MySQL config not found at $config"
}

$listening = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "MySQL is already listening on port 3306."
  exit 0
}

$existing = Get-Process mysqld -ErrorAction SilentlyContinue
if (-not $existing) {
  $proc = Start-Process -FilePath $mysqld -ArgumentList "--defaults-file=`"$config`"" -WindowStyle Hidden -PassThru
  Write-Host "Started MySQL process $($proc.Id)."
}

for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 1
  $listening = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Host "MySQL is ready on 127.0.0.1:3306."
    exit 0
  }
}

throw 'MySQL did not start listening on port 3306 in time.'
