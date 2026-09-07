# crop screenshot region and scale up (ASCII only, GDI+)
param(
  [string]$Src = "shot_black_xinlei.png",
  [string]$Out = "crop.png",
  [int]$X = 1500,
  [int]$Y = 500,
  [int]$W = 520,
  [int]$H = 620,
  [double]$Scale = 1.2
)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap((Resolve-Path $Src).Path)
$rect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$bmp.Dispose()
$nw = [int]($W * $Scale)
$nh = [int]($H * $Scale)
$big = New-Object System.Drawing.Bitmap($nw, $nh)
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.DrawImage($crop, 0, 0, $nw, $nh)
$g.Dispose()
$crop.Dispose()
if ([System.IO.Path]::IsPathRooted($Out)) { $full = $Out } else { $full = Join-Path (Get-Location) $Out }
$big.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()
Write-Output "saved $Out ${nw}x${nh}"
