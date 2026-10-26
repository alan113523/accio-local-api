param([ValidateSet('get','put')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$stateDirectory = $env:ACCIO_API_STATE_DIR
if (-not $stateDirectory) { $stateDirectory = Join-Path $env:LOCALAPPDATA 'Accio Local API' }
$path = Join-Path $stateDirectory 'oauth.dpapi'
$entropy = [Text.Encoding]::UTF8.GetBytes('com.local.accio-api.oauth.v1')
try {
    if ($Action -eq 'get') {
        if (-not [IO.File]::Exists($path)) { [Console]::Out.Write('null'); exit 0 }
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
    } else {
        $payload = [Console]::In.ReadToEnd()
        if (-not $payload -or [Text.Encoding]::UTF8.GetByteCount($payload) -gt 65536) { exit 2 }
        $null = $payload | ConvertFrom-Json
        $encrypted = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($payload), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
        $temporaryPath = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        [IO.File]::WriteAllBytes($temporaryPath, $encrypted)
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporaryPath, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporaryPath, $path) }
    }
} catch { [Console]::Error.Write('Bridge credential storage failed'); exit 1 }
