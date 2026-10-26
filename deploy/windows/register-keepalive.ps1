# WSL を常時起動しておくためのタスクを登録する（Windows の PowerShell で実行）
#   powershell -ExecutionPolicy Bypass -File register-keepalive.ps1 [-Distro Ubuntu]
# WSL は、WSL 内のプロセスを使う Windows 側のクライアントがいなくなると止まる。
# ログオン時に `sleep infinity` を裏で動かし続けることで、systemd 上のサービスを生かし続ける。
param([string]$Distro = "Ubuntu")

$taskName = "GeminiCode keep WSL alive"
# conhost --headless でコンソール窓を出さずに起動する
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d $Distro --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "登録しました: $taskName（ディストリビューション: $Distro）"
Write-Host "確認: wsl -l -v で $Distro が Running になっていること"
