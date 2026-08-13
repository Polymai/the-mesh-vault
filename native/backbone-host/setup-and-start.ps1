$ErrorActionPreference = 'Stop'
$BackboneRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $BackboneRoot

function Stop-WithMessage([string]$Message) {
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  throw $Message
}

Write-Host 'TheMeshVault Backbone setup' -ForegroundColor Cyan
Write-Host "Server folder: $BackboneRoot"

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
  Stop-WithMessage 'Node.js was not found. Install Node.js 20 or newer from https://nodejs.org and run this file again.'
}
$NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $NpmCommand) {
  Stop-WithMessage 'npm was not found. Reinstall Node.js 20 or newer with npm included, then run this file again.'
}
$NodeVersion = (node --version).TrimStart('v')
if ([int]($NodeVersion.Split('.')[0]) -lt 20) {
  Stop-WithMessage "Node.js $NodeVersion is too old. Install Node.js 20 or newer and run this file again."
}
Write-Host "Node.js $NodeVersion found." -ForegroundColor Green

$ConfigPath = Join-Path $BackboneRoot 'backbone-host.json'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  $Downloads = Join-Path $env:USERPROFILE 'Downloads'
  $Candidate = Get-ChildItem -LiteralPath $Downloads -Filter 'backbone-host*.json' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($Candidate) {
    Write-Host "Using the newest downloaded configuration: $($Candidate.FullName)"
    Copy-Item -LiteralPath $Candidate.FullName -Destination $ConfigPath
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    $Picker = New-Object System.Windows.Forms.OpenFileDialog
    $Picker.Title = 'Choose the backbone-host.json downloaded from TheMeshVault'
    $Picker.Filter = 'TheMeshVault configuration (backbone-host*.json)|backbone-host*.json|JSON files (*.json)|*.json'
    if ($Picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      Stop-WithMessage 'No configuration was selected. Download it from Backbone in TheMeshVault, then run this file again.'
    }
    Copy-Item -LiteralPath $Picker.FileName -Destination $ConfigPath
  }
}
Write-Host 'Configuration ready.' -ForegroundColor Green

if (-not (Test-Path -LiteralPath (Join-Path $BackboneRoot 'node_modules\ws'))) {
  Write-Host 'Installing the small WebSocket dependency. This happens only on first start...'
  & npm.cmd install --omit=dev
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'npm install failed. Check the network connection and try again.' }
}

$env:MESHVAULT_BACKBONE_CONFIG = $ConfigPath
Write-Host 'Checking storage folders and limits...'
& node manager.mjs check
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'The configuration check failed. Correct the message above and try again.' }

Write-Host ''
Write-Host 'Backbone running. Keep this window open.' -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop it.'
& node manager.mjs start
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'The Backbone process stopped with an error.' }
