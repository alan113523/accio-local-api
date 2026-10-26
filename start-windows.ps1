$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-install.json') -Raw | ConvertFrom-Json
$env:ACCIO_API_STATE_DIR = $settings.stateDirectory
$env:ACCIO_DESKTOP_EXE = $settings.accioExecutable
$env:ACCIO_APP_VERSION = $settings.accioVersion
$server = Join-Path $PSScriptRoot 'src\server.mjs'
function Wait-Api {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18437/health' -TimeoutSec 1
            if ($health.status -eq 'running') { return }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    throw 'Accio Local API did not become ready; check its private service logs'
}
$pidPath = Join-Path $settings.stateDirectory 'server.pid'
if (Test-Path -LiteralPath $pidPath) {
    $savedId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$savedId)) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$savedId" -ErrorAction SilentlyContinue
        if ($existing -and $existing.ExecutablePath -eq $settings.nodeExecutable -and $existing.CommandLine.Contains($server)) { Wait-Api; return }
    }
}
$child = Start-Process -FilePath $settings.nodeExecutable -ArgumentList ('"' + $server + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $settings.stateDirectory 'server.log') -RedirectStandardError (Join-Path $settings.stateDirectory 'server-error.log') -PassThru
[IO.File]::WriteAllText($pidPath, [string]$child.Id)
Wait-Api
