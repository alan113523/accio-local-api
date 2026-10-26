param(
    [Parameter(Mandatory=$true)][string]$AccioExecutable,
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Accio Local API'),
    [switch]$NoStart,
    [switch]$NoStartup
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw 'Destination exists; preserve it and choose a new installation directory' }
if (-not (Test-Path -LiteralPath $AccioExecutable)) { throw 'Official Accio executable not found' }
$AccioExecutable = (Resolve-Path -LiteralPath $AccioExecutable).Path
$Destination = [IO.Path]::GetFullPath($Destination)
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Accio Local API.lnk'
if (-not $NoStartup -and (Test-Path -LiteralPath $shortcutPath)) { throw 'An Accio Local API startup shortcut already exists' }
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$accioVersion = (Get-Item -LiteralPath $AccioExecutable).VersionInfo.FileVersion
$stateDirectory = Join-Path $Destination 'state'
New-Item -ItemType Directory -Path $Destination | Out-Null
$files = @('package.json','README.md','README-WINDOWS.md','start-windows.ps1','stop-windows.ps1','login-windows.ps1')
foreach ($relative in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Destination (Join-Path $Destination $relative) }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src') -Destination (Join-Path $Destination 'src') -Recurse
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $stateDirectory /inheritance:r /grant:r (('*'+$sid)+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict bridge state directory ACL' }
$settings = @{ stateDirectory=$stateDirectory; nodeExecutable=$nodeExecutable; accioExecutable=$AccioExecutable; accioVersion=$accioVersion }
[IO.File]::WriteAllText((Join-Path $Destination 'windows-install.json'), ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
if (-not $NoStartup) {
$shell = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Accio Local API.lnk'
if (Test-Path -LiteralPath $shortcutPath) { throw 'An Accio Local API startup shortcut already exists' }
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Destination 'start-windows.ps1') + '"'
$shortcut.WorkingDirectory = $Destination
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start the current user Accio Local API on loopback only'
$shortcut.Save()
}
if (-not $NoStart) { & (Join-Path $Destination 'start-windows.ps1') }
Write-Output ('Installed: ' + $Destination)
Write-Output ('State: ' + $stateDirectory)
Write-Output 'Endpoint: http://127.0.0.1:18437'
