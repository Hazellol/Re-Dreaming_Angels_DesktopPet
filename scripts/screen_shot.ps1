# 全屏截图工具（层级验证用）：截取整个桌面到文件（文件流保存，避免 GDI+ 路径问题）
param([string]$OutPath = "screen.png")
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$abs = Join-Path (Get-Location) $OutPath
$fs = [System.IO.File]::Create($abs)
$bmp.Save($fs, [System.Drawing.Imaging.ImageFormat]::Png)
$fs.Close()
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $abs ($($b.Width)x$($b.Height))"
