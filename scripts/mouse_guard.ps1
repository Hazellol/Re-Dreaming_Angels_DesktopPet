# Mouse guard: report physical left-button state + foreground window (for detecting stuck drag / foreign capture)
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MG1 {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetCapture();
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  public static bool LeftDown() { return (GetAsyncKeyState(0x01) & 0x8000) != 0; }
  public static string Fg() {
    IntPtr h = GetForegroundWindow();
    uint pid = 0; GetWindowThreadProcessId(h, out pid);
    StringBuilder sb = new StringBuilder(128); GetWindowText(h, sb, 128);
    string t = sb.ToString().Replace("\"", "'");
    if (t.Length > 40) t = t.Substring(0, 40);
    return h.ToInt64() + "|" + pid + "|" + t;
  }
}
'@
if (-not ('MG1' -as [type])) { Add-Type -TypeDefinition $src }
$left = if ([MG1]::LeftDown()) { 'DOWN' } else { 'UP' }
$fg = [MG1]::Fg()
Write-Output ("LEFT={0} FG={1}" -f $left, $fg)
