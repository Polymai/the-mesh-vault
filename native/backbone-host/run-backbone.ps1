param(
  [string]$ConfigPath = ''
)
$ErrorActionPreference = 'Stop'
$BackboneRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $BackboneRoot
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $BackboneRoot 'backbone-host.json'
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$env:MESHVAULT_BACKBONE_CONFIG = $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  node manager.mjs init
}
if (-not (Test-Path -LiteralPath (Join-Path $BackboneRoot 'node_modules'))) {
  throw 'Run npm install in native/backbone-host before starting the Backbone.'
}
node manager.mjs check
node manager.mjs start
