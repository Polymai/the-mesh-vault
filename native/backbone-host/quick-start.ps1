param(
  [Parameter(Mandatory = $true)][string]$ServerName,
  [Parameter(Mandatory = $true)][string]$InstanceId
)
$ErrorActionPreference = 'Stop'
$BackboneRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$MeshRoot = Join-Path $env:LOCALAPPDATA 'TheMeshVault'
$HostIdPath = Join-Path $MeshRoot 'physical-host-id.txt'
$ConfigPath = Join-Path $BackboneRoot 'backbone-host.json'
New-Item -ItemType Directory -Path $MeshRoot -Force | Out-Null

if (Test-Path -LiteralPath $HostIdPath) {
  $PhysicalHostId = (Get-Content -LiteralPath $HostIdPath -Raw).Trim()
} else {
  $PhysicalHostId = [guid]::NewGuid().ToString()
  [IO.File]::WriteAllText($HostIdPath, $PhysicalHostId, [Text.UTF8Encoding]::new($false))
}

$BestDrive = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -gt 3GB -and $_.Root } | Sort-Object Free -Descending | Select-Object -First 1
if (-not $BestDrive) { throw 'No local disk with at least 3 GB free was found.' }
$DataPath = Join-Path $BestDrive.Root ("TheMeshVault\BackboneData\$InstanceId")
New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
$Drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($DataPath))
$ReserveBytes = 2GB
$QuotaBytes = [Math]::Min(100GB, [Math]::Max(1GB, $Drive.AvailableFreeSpace - $ReserveBytes))
if ($Drive.AvailableFreeSpace -lt 3GB) { throw 'At least 3 GB of free space is required to start a Backbone server.' }

function Test-Port([int]$Port) {
  try {
    $Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $Listener.Start()
    $Listener.Stop()
    return $true
  } catch { return $false }
}
$Port = 3717
while ($Port -le 3817 -and -not (Test-Port $Port)) { $Port += 1 }
if ($Port -gt 3817) { throw 'No free local Backbone port was found between 3717 and 3817.' }

$Config = [ordered]@{
  protocolVersion = 3
  physicalHostId = $PhysicalHostId
  label = $ServerName
  listen = [ordered]@{ host = '127.0.0.1'; port = $Port }
  publicUrl = ''
  tls = [ordered]@{ certificatePath = ''; privateKeyPath = '' }
  supabase = [ordered]@{
    url = 'https://pfnlebwkbhblytpvaokd.supabase.co'
    publishableKey = 'sb_publishable_O8CemBWuZAjQDC6gSkNq9Q_wAmDtHiv'
    heartbeatMs = 600000
  }
  reserveBytesPerPool = 1GB
  storagePools = @([ordered]@{ id = 'primary'; path = $DataPath; physicalDeviceId = 'auto' })
  instances = @([ordered]@{ id = $InstanceId; label = $ServerName; poolId = 'primary'; quotaBytes = [long]$QuotaBytes })
}
[IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Write-Host "$ServerName will share up to $([Math]::Round($QuotaBytes / 1GB, 1)) GB from $DataPath on port $Port." -ForegroundColor Cyan
& (Join-Path $BackboneRoot 'setup-and-start.ps1')
