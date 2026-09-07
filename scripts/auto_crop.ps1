# auto crop trio groups by non-white pixel scan (ASCII only, PS5 safe)
param(
  [string]$Src = "shot.png",
  [string]$OutDir = "assets"
)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::new((Resolve-Path $Src).Path)
$W = $bmp.Width
$H = $bmp.Height
$step = 4
$colHit = New-Object 'System.Collections.Generic.List[int]'
for ($x = 0; $x -lt $W; $x += $step) {
  $hit = $false
  for ($y = 0; $y -lt $H; $y += $step) {
    $p = $bmp.GetPixel($x, $y)
    if ($p.A -gt 20 -and (($p.R -lt 240) -or ($p.G -lt 240) -or ($p.B -lt 240))) { $hit = $true; break }
  }
  if ($hit) { $colHit.Add($x) }
}
$segs = @()
$s = -1
$prev = -999
foreach ($x in $colHit) {
  if (($x - $prev) -gt 24) {
    if ($s -ge 0) { $segs += ,@($s, $prev) }
    $s = $x
  }
  $prev = $x
}
if ($s -ge 0) { $segs += ,@($s, $prev) }
Write-Output ("segs=" + (($segs | ForEach-Object { "$($_[0])-$($_[1])" }) -join ";"))
$names = @('panel_airui.png', 'panel_nangong.png', 'panel_qianxia.png')
$k = 0
foreach ($seg in (($segs | Sort-Object { $_[1] - $_[0] } -Descending | Select-Object -First 3) | Sort-Object { $_[0] })) {
  $x0 = $seg[0]; $x1 = $seg[1]
  $minY = $H; $maxY = 0
  for ($y = 0; $y -lt $H; $y += $step) {
    for ($x = $x0; $x -le $x1; $x += $step) {
      $p = $bmp.GetPixel($x, $y)
      if ($p.A -gt 20 -and (($p.R -lt 240) -or ($p.G -lt 240) -or ($p.B -lt 240))) {
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $pad = 12
  $cx = $x0 - $pad; if ($cx -lt 0) { $cx = 0 }
  $cy = $minY - $pad; if ($cy -lt 0) { $cy = 0 }
  $cw = ($x1 - $x0) + 2 * $pad
  $ch = ($maxY - $minY) + 2 * $pad
  $rect = New-Object System.Drawing.Rectangle($cx, $cy, $cw, $ch)
  $crop = $bmp.Clone($rect, $bmp.PixelFormat)
  $out = Join-Path (Resolve-Path $OutDir).Path $names[$k]
  $crop.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  Write-Output ("saved " + $names[$k] + " " + $cx + "," + $cy + " " + $cw + "x" + $ch)
  $k++
}
$bmp.Dispose()
