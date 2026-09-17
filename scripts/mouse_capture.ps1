# 模拟截图工具的鼠标行为：全屏置顶窗口 + SetCapture（鼠标捕获）N 秒 → 释放并关闭
# 用于复现"QQ 截图(Ctrl+Alt+A→回车)后桌宠点击失效"的场景
param([int]$HoldMs = 3000)
Add-Type -AssemblyName System.Windows.Forms
$src = 'using System;using System.Runtime.InteropServices;public static class CAP1{[DllImport("user32.dll")]public static extern IntPtr SetCapture(IntPtr h);[DllImport("user32.dll")]public static extern bool ReleaseCapture();}'
if (-not ('CAP1' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.WindowState = 'Maximized'
$f.TopMost = $true
$f.Opacity = 0.3
$f.BackColor = '#AA0000'
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $HoldMs
$timer.Add_Tick({
  [CAP1]::ReleaseCapture() | Out-Null
  $timer.Stop()
  $f.Close()
})
$f.Add_Shown({
  [CAP1]::SetCapture($f.Handle) | Out-Null
  $timer.Start()
})
[System.Windows.Forms.Application]::Run($f)
Write-Output "capture window closed"
