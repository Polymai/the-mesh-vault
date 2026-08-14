param(
  [Parameter(Mandatory = $true)][string]$ServerNamePrefix,
  [Parameter(Mandatory = $true)][ValidateRange(1, 9999)][int]$FirstServerNumber,
  [Parameter(Mandatory = $true)][ValidateRange(1, 32)][int]$InstanceCount,
  [Parameter(Mandatory = $true)][string]$HostId,
  [ValidateRange(3717, 3817)][int]$PortHint = 3717
)
$ErrorActionPreference = 'Stop'
$BackboneRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$MeshRoot = Join-Path $env:LOCALAPPDATA 'TheMeshVault'
$HostIdPath = Join-Path $MeshRoot 'physical-host-id.txt'
$ConfigPath = Join-Path $BackboneRoot 'backbone-host.json'
New-Item -ItemType Directory -Path $MeshRoot -Force | Out-Null

if (Test-Path -LiteralPath $ConfigPath) {
  try {
    $ExistingConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($ExistingConfig.protocolVersion -eq 3 -and $ExistingConfig.launcherHostId -eq $HostId) {
      Write-Host "Restarting $($ExistingConfig.instances.Count) existing logical server(s)." -ForegroundColor Cyan
      & (Join-Path $BackboneRoot 'setup-and-start.ps1')
      exit $LASTEXITCODE
    }
  } catch {
    Write-Host 'The previous quick-start configuration could not be reused; creating a fresh configuration.' -ForegroundColor Yellow
  }
}

if (Test-Path -LiteralPath $HostIdPath) {
  $PhysicalHostId = (Get-Content -LiteralPath $HostIdPath -Raw).Trim()
} else {
  $PhysicalHostId = [guid]::NewGuid().ToString()
  [IO.File]::WriteAllText($HostIdPath, $PhysicalHostId, [Text.UTF8Encoding]::new($false))
}

$BestDrive = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -gt 3GB -and $_.Root } | Sort-Object Free -Descending | Select-Object -First 1
if (-not $BestDrive) { throw 'No local disk with at least 3 GB free was found.' }
$DataPath = Join-Path $BestDrive.Root ("TheMeshVault\BackboneData\$HostId")
New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
$Drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($DataPath))
$ReserveBytes = [int64]2GB
$AvailableBytes = [int64]$Drive.AvailableFreeSpace
$SafeBytes = $AvailableBytes - $ReserveBytes
if ($Drive.AvailableFreeSpace -lt 3GB) { throw 'At least 3 GB of free space is required to start a Backbone server.' }
$DesiredBytes = [int64]100GB * [int64]$InstanceCount
$TotalQuotaBytes = if ($SafeBytes -lt $DesiredBytes) { $SafeBytes } else { $DesiredBytes }
$QuotaBytes = [int64][Math]::Floor([double]$TotalQuotaBytes / [double]$InstanceCount)
if ($QuotaBytes -lt [int64]1GB) { throw 'Each logical server needs at least 1 GB of safe free space.' }

function Test-Port([int]$Port) {
  try {
    $Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $Listener.Start()
    $Listener.Stop()
    return $true
  } catch { return $false }
}
$Port = $PortHint
while ($Port -le 3817 -and -not (Test-Port $Port)) { $Port += 1 }
if ($Port -gt 3817) { throw 'No free local Backbone port was found between 3717 and 3817.' }

$Config = [ordered]@{
  protocolVersion = 3
  launcherHostId = $HostId
  physicalHostId = $PhysicalHostId
  label = if ($InstanceCount -eq 1) { "$ServerNamePrefix $FirstServerNumber" } else { "$ServerNamePrefix $FirstServerNumber-$($FirstServerNumber + $InstanceCount - 1)" }
  listen = [ordered]@{ host = '127.0.0.1'; port = $Port }
  publicUrl = ''
  tls = [ordered]@{ certificatePath = ''; privateKeyPath = '' }
  supabase = if ($env:MESHVAULT_BACKBONE_SKIP_SUPABASE -eq '1') {
    [ordered]@{ url = ''; publishableKey = ''; heartbeatMs = 600000 }
  } else {
    [ordered]@{ url = 'https://pfnlebwkbhblytpvaokd.supabase.co'; publishableKey = 'sb_publishable_O8CemBWuZAjQDC6gSkNq9Q_wAmDtHiv'; heartbeatMs = 600000 }
  }
  reserveBytesPerPool = 1GB
  storagePools = @([ordered]@{ id = 'primary'; path = $DataPath; physicalDeviceId = 'auto' })
  instances = @(for ($Index = 0; $Index -lt $InstanceCount; $Index += 1) {
    [ordered]@{
      id = [guid]::NewGuid().ToString()
      label = "$ServerNamePrefix $($FirstServerNumber + $Index)"
      poolId = 'primary'
      quotaBytes = [int64]$QuotaBytes
    }
  })
}
[IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Write-Host "$InstanceCount logical server(s) will share up to $([Math]::Round(($QuotaBytes * $InstanceCount) / 1GB, 1)) GB from $DataPath on port $Port." -ForegroundColor Cyan
Write-Host 'They remain one physical failure domain because they run on this computer.' -ForegroundColor DarkGray
& (Join-Path $BackboneRoot 'setup-and-start.ps1')
