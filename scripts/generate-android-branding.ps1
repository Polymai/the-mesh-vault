param(
  [string]$Workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourcePath = Join-Path $Workspace 'assets\pwa-icon-512.png'
$resPath = Join-Path $Workspace 'mobile\android-wrapper\android\app\src\main\res'
if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Missing source icon: $sourcePath" }
if (-not (Test-Path -LiteralPath $resPath)) { throw "Missing Android resources: $resPath" }

function New-ResizedBitmap {
  param([System.Drawing.Image]$Source, [int]$Width, [int]$Height)
  $target = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  try {
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($Source, 0, 0, $Width, $Height)
  } finally { $graphics.Dispose() }
  return $target
}

function Save-Png {
  param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

$sourceFile = [System.Drawing.Image]::FromFile($sourcePath)
$source = New-Object System.Drawing.Bitmap $sourceFile
$sourceFile.Dispose()

$foreground = New-Object System.Drawing.Bitmap 512, 512, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt 512; $y++) {
  for ($x = 0; $x -lt 512; $x++) {
    $pixel = $source.GetPixel($x, $y)
    $brightest = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
    if ($brightest -lt 100) { $foreground.SetPixel($x, $y, [System.Drawing.Color]::Transparent) }
    else {
      $alpha = [Math]::Min(255, [Math]::Max(0, [int](($brightest - 80) * 2.2)))
      $foreground.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $pixel.R, $pixel.G, $pixel.B))
    }
  }
}

$densities = @{
  'mdpi' = @{ Icon = 48; Foreground = 108 }
  'hdpi' = @{ Icon = 72; Foreground = 162 }
  'xhdpi' = @{ Icon = 96; Foreground = 216 }
  'xxhdpi' = @{ Icon = 144; Foreground = 324 }
  'xxxhdpi' = @{ Icon = 192; Foreground = 432 }
}

foreach ($density in $densities.Keys) {
  $settings = $densities[$density]
  $directory = Join-Path $resPath "mipmap-$density"
  $icon = New-ResizedBitmap $source $settings.Icon $settings.Icon
  try { Save-Png $icon (Join-Path $directory 'ic_launcher.png') } finally { $icon.Dispose() }

  $adaptive = New-ResizedBitmap $foreground $settings.Foreground $settings.Foreground
  try { Save-Png $adaptive (Join-Path $directory 'ic_launcher_foreground.png') } finally { $adaptive.Dispose() }

  $round = New-ResizedBitmap $source $settings.Icon $settings.Icon
  try { Save-Png $round (Join-Path $directory 'ic_launcher_round.png') } finally { $round.Dispose() }
}

$splashTargets = @{
  'drawable\splash.png' = @(480, 320)
  'drawable-land-mdpi\splash.png' = @(480, 320)
  'drawable-land-hdpi\splash.png' = @(800, 480)
  'drawable-land-xhdpi\splash.png' = @(1280, 720)
  'drawable-land-xxhdpi\splash.png' = @(1600, 960)
  'drawable-land-xxxhdpi\splash.png' = @(1920, 1280)
  'drawable-port-mdpi\splash.png' = @(320, 480)
  'drawable-port-hdpi\splash.png' = @(480, 800)
  'drawable-port-xhdpi\splash.png' = @(720, 1280)
  'drawable-port-xxhdpi\splash.png' = @(960, 1600)
  'drawable-port-xxxhdpi\splash.png' = @(1280, 1920)
}

foreach ($relative in $splashTargets.Keys) {
  $width = $splashTargets[$relative][0]
  $height = $splashTargets[$relative][1]
  $canvas = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(255, 7, 17, 31))
    $side = [int]([Math]::Min($width, $height) * 0.42)
    $left = [int](($width - $side) / 2)
    $top = [int](($height - $side) / 2)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($source, $left, $top, $side, $side)
  } finally { $graphics.Dispose() }
  try { Save-Png $canvas (Join-Path $resPath $relative) } finally { $canvas.Dispose() }
}

$foreground.Dispose()
$source.Dispose()
Write-Output 'Android launcher and splash branding generated from assets/pwa-icon-512.png.'
