param(
  [string]$BindHost = '127.0.0.1',
  [int]$Port = 4184
)

$displayHost = if ($BindHost -eq '0.0.0.0') { '127.0.0.1' } else { $BindHost }
$env:KLING_UI_HOST = "$BindHost"
$env:KLING_UI_PORT = "$Port"
Write-Host "Kling web UI: http://$displayHost:$Port/"
python "$PSScriptRoot\server.py"
