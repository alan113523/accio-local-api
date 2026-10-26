$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-windows.ps1')
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-install.json') -Raw | ConvertFrom-Json
$env:ACCIO_API_STATE_DIR = $settings.stateDirectory
$url = & $settings.nodeExecutable (Join-Path $PSScriptRoot 'src\cli.mjs') login
if ($LASTEXITCODE -ne 0) { throw 'Unable to start bridge login' }
$login = [Uri]$url.Trim()
if ($login.Scheme -ne 'https' -or $login.Host -ne 'www.accio.com' -or $login.AbsolutePath -ne '/login') { throw 'Unexpected login URL' }
$chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
if (Test-Path -LiteralPath $chrome) { Start-Process -FilePath $chrome -ArgumentList $login.AbsoluteUri }
else { Start-Process -FilePath $login.AbsoluteUri }
Write-Output 'Complete the official Accio sign-in in your browser. This login link expires in ten minutes.'
