# Check physical mouse button state (GetAsyncKeyState) - used to verify "stuck left button" hypothesis
$src = @'
using System;
using System.Runtime.InteropServices;
public static class KS1 {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  public static bool Down(int v) { return (GetAsyncKeyState(v) & 0x8000) != 0; }
}
'@
if (-not ('KS1' -as [type])) { Add-Type -TypeDefinition $src }
$l = [KS1]::Down(0x01)   # VK_LBUTTON
$r = [KS1]::Down(0x02)   # VK_RBUTTON
$m = [KS1]::Down(0x04)   # VK_MBUTTON
Write-Output ("physical buttons: LEFT={0} RIGHT={1} MIDDLE={2}" -f $l, $r, $m)
if ($l) { Write-Output "RESULT: LEFT BUTTON IS STUCK DOWN (system thinks it is still pressed)" }
else { Write-Output "RESULT: left button is up (normal)" }
