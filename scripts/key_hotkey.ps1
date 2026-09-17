# 底层热键模拟（验证全局快捷键）：默认发送 Ctrl+Alt+Z（keybd_event，最接近真实按键）
# VK: Ctrl=17, Alt=18, Z=90
param(
  [int]$VK1 = 17,
  [int]$VK2 = 18,
  [int]$VK3 = 90
)
$src = 'using System; using System.Runtime.InteropServices; public static class KB1 { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); public static void K(byte v){ keybd_event(v,0,0,UIntPtr.Zero); } public static void U(byte v){ keybd_event(v,0,2,UIntPtr.Zero); } }'
if (-not ('KB1' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }
[KB1]::K($VK1); Start-Sleep -Milliseconds 60
[KB1]::K($VK2); Start-Sleep -Milliseconds 60
[KB1]::K($VK3); Start-Sleep -Milliseconds 80
[KB1]::U($VK3); Start-Sleep -Milliseconds 60
[KB1]::U($VK2); Start-Sleep -Milliseconds 60
[KB1]::U($VK1)
Write-Output "hotkey sent: VK $VK1 + $VK2 + $VK3"
