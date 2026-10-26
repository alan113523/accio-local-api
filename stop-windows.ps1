$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-install.json') -Raw | ConvertFrom-Json
$pidPath = Join-Path $settings.stateDirectory 'server.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { exit 0 }
$savedId = 0
if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$savedId)) { throw 'Invalid bridge PID file' }
$server = Join-Path $PSScriptRoot 'src\server.mjs'
$existing = Get-CimInstance Win32_Process -Filter "ProcessId=$savedId" -ErrorAction SilentlyContinue
if ($existing -and $existing.ExecutablePath -eq $settings.nodeExecutable -and $existing.CommandLine.Contains($server)) { Stop-Process -Id $savedId }
