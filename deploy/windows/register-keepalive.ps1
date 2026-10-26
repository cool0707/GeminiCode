# Registers a logon task that keeps WSL running (run in Windows PowerShell).
#   powershell -ExecutionPolicy Bypass -File register-keepalive.ps1 [-Distro Ubuntu]
#
# WSL shuts down once no Windows-side client is using it. Running `sleep infinity`
# in the background from logon keeps the distro (and its systemd services) alive.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8
# as the ANSI code page, which garbles non-ASCII text and breaks string quoting.
param([string]$Distro = "Ubuntu")

$taskName = "GeminiCode keep WSL alive"
# conhost --headless starts it without a console window
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d $Distro --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Registered task: $taskName (distro: $Distro)"
Write-Host "Check: 'wsl -l -v' should show $Distro as Running."
