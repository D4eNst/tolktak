# Usage from the repository root: powershell -ExecutionPolicy Bypass -File client\e2e\windows\start-stack.ps1
# Needs bin\livekit-server.exe and `uv sync --no-dev` in server\.
$ErrorActionPreference = 'Stop'
$kit = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$bin = Join-Path $kit 'bin'
$data = Join-Path $kit 'data'
New-Item -ItemType Directory -Force $data | Out-Null
# Chromium ignores loopback ICE candidates: advertise the LAN address.
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
$key = 'wintest'
$secret = -join ((48..57) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
@"
port: 7880
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false
  node_ip: $ip
keys:
  ${key}: $secret
webhook:
  api_key: $key
  urls: ["http://127.0.0.1:8080/api/v1/livekit/webhook"]
room:
  # Adds H.264 42001f: Chromium encodes it on the GPU, the default 42e01f only in software.
  enabled_codecs:
    - mime: audio/opus
    - mime: audio/red
    - mime: audio/PCMU
    - mime: audio/PCMA
    - mime: video/H264
      fmtp_line: level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
    - mime: video/H264
    - mime: video/VP8
    - mime: video/VP9
    - mime: video/AV1
    - mime: video/H265
    - mime: video/rtx
logging:
  level: info
"@ | Set-Content -Encoding ascii (Join-Path $data 'livekit.yaml')
# An old stack keeps its old config and secret.
$old = Get-Process livekit-server, tolktak-server -ErrorAction SilentlyContinue
if ($old) {
  $old | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  if (Get-Process livekit-server, tolktak-server -ErrorAction SilentlyContinue) {
    Write-Host "An old livekit-server/tolktak-server is still running and could not be stopped (started as administrator?). Stop it in Task Manager and run this script again."
    exit 1
  }
}
Start-Process -WindowStyle Minimized -FilePath (Join-Path $bin 'livekit-server.exe') -ArgumentList '--config', (Join-Path $data 'livekit.yaml') -RedirectStandardError (Join-Path $data 'livekit.log')
$env:TOLKTAK_DATA_DIR = $data
$env:TOLKTAK_LISTEN = '0.0.0.0:8080'
$env:TOLKTAK_REGISTRATION = 'open'
$env:LIVEKIT_API_KEY = $key
$env:LIVEKIT_API_SECRET = $secret
$env:LIVEKIT_PUBLIC_URL = "ws://${ip}:7880"
$env:LIVEKIT_INTERNAL_URL = 'http://127.0.0.1:7880'
$env:TOLKTAK_SERVER_NAME = 'TolkTak Windows test'
Start-Process -WindowStyle Minimized -FilePath (Join-Path $kit 'server\.venv\Scripts\tolktak-server.exe') -RedirectStandardError (Join-Path $data 'server.log')
Start-Sleep 3
try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8080/healthz" | Out-Null; Write-Host "OK. TT_API=http://${ip}:8080" } catch { Write-Host "server did not start, see $data\server.log"; exit 1 }
