# Forensics: enumerate visible top-level windows in z-order (1 = topmost) to see who covers the pet
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
if (-not ('WinEnum' -as [type])) { Add-Type -TypeDefinition $src }
$procs = @{}
Get-Process | ForEach-Object { $procs[[uint32]$_.Id] = $_.ProcessName }
$script:idx = 0
$rows = New-Object System.Collections.ArrayList
$cb = [WinEnum+EnumProc]{
  param($h, $l)
  if ([WinEnum]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetWindowText($h, $sb, 256) | Out-Null
    $r = New-Object WinEnum+RECT
    [WinEnum]::GetWindowRect($h, [ref]$r) | Out-Null
    $pid2 = 0
    [WinEnum]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    $ex = [WinEnum]::GetWindowLong($h, -20)
    $script:idx++
    if ($script:idx -le 16) {
      $pname = if ($procs[[uint32]$pid2]) { $procs[[uint32]$pid2] } else { "pid$pid2" }
      $t = $sb.ToString()
      if ($t.Length -gt 24) { $t = $t.Substring(0, 24) }
      $null = $rows.Add(("{0,2}. {1,-12} [{2}] {3}x{4}@({5},{6}) ex=0x{7:X8} '{8}'" -f $script:idx, $pname, $pid2, ($r.R-$r.L), ($r.B-$r.T), $r.L, $r.T, $ex, $t))
    }
  }
  return $true
}
[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
Write-Output "=== visible top-level windows (1 = topmost) ==="
$rows | ForEach-Object { Write-Output $_ }
Write-Output ""
Write-Output "ex flags: 0x8=TOPMOST 0x20=TRANSPARENT 0x80000=LAYERED 0x8000000=NOACTIVATE 0x80=TOOLWINDOW"
