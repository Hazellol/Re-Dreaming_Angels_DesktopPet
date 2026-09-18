# Occlusion check (handle-based, no Chinese literals to avoid PS5.1 encoding issues)
# Usage: occlusion_check.ps1 -Hwnd <decimal-hwnd>
# Output: OCCLUDED=1 (fully covered) / OCCLUDED=0
param([long]$Hwnd = 0)
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Occ2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static string Check(IntPtr pet) {
    RECT pr; GetWindowRect(pet, out pr);
    long area = (long)(pr.R - pr.L) * (pr.B - pr.T);
    if (area <= 0) return "OCCLUDED=0 REASON=bad-rect";
    var list = new List<IntPtr>();
    bool found = false;
    EnumWindows((h, l) => {
      if (h == pet) { found = true; return true; }        // z-order: everything collected before this is ABOVE the pet
      if (!found) {
        if (!IsWindowVisible(h) || IsIconic(h)) return true;
        RECT r; GetWindowRect(h, out r);
        int w = r.R - r.L, hh = r.B - r.T;
        if (w >= 40 && hh >= 40) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    if (!found) return "OCCLUDED=0 REASON=pet-not-found";
    int tol = 10;
    foreach (IntPtr h in list) {
      RECT r; GetWindowRect(h, out r);
      if (r.L <= pr.L + tol && r.T <= pr.T + tol && r.R >= pr.R - tol && r.B >= pr.B - tol) return "OCCLUDED=1";
      // partial cover: compute overlap ratio
      int ox = Math.Max(0, Math.Min(r.R, pr.R) - Math.Max(r.L, pr.L));
      int oy = Math.Max(0, Math.Min(r.B, pr.B) - Math.Max(r.T, pr.T));
      if ((long)ox * oy >= area * 98 / 100) return "OCCLUDED=1";
    }
    return "OCCLUDED=0";
  }
}
'@
if (-not ('Occ2' -as [type])) { Add-Type -TypeDefinition $src }
if ($Hwnd -le 0) { Write-Output "OCCLUDED=0 REASON=no-hwnd"; exit 0 }
Write-Output ([Occ2]::Check([IntPtr]$Hwnd))
