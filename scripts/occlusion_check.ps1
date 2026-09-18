# Occlusion check (handle-based). Counts only *real opaque application windows* as occluders:
# excludes layered/transparent/tool/no-activate overlays (e.g. NVIDIA Overlay) and shell windows.
# Usage: occlusion_check.ps1 -Hwnd <decimal-hwnd>
# Output: OCCLUDED=1 (fully covered) / OCCLUDED=0
param([long]$Hwnd = 0)
$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Occ3 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  static string ClassOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(128);
    GetClassName(h, sb, 128);
    return sb.ToString();
  }
  // 是否是"真正会挡住视觉的普通应用窗口"
  static bool IsOpaqueApp(IntPtr h, int w, int hh) {
    if (w < 40 || hh < 40) return false;
    int ex = GetWindowLong(h, -20);
    if ((ex & 0x80000) != 0) return false;      // WS_EX_LAYERED    （透明覆盖层 / overlay）
    if ((ex & 0x20) != 0) return false;         // WS_EX_TRANSPARENT（点击穿透的覆盖层）
    if ((ex & 0x80) != 0) return false;         // WS_EX_TOOLWINDOW （工具窗口，一般不是遮挡物）
    if ((ex & 0x08000000) != 0) return false;   // WS_EX_NOACTIVATE
    string cls = ClassOf(h);
    if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" ||
        cls == "Shell_SecondaryTrayWnd" || cls == "SysShadow" || cls == "Windows.UI.Core.CoreWindow") return false;
    if (cls.IndexOf("Overlay", StringComparison.OrdinalIgnoreCase) >= 0) return false;
    return true;
  }

  public static string Check(IntPtr pet) {
    RECT pr; GetWindowRect(pet, out pr);
    long area = (long)(pr.R - pr.L) * (pr.B - pr.T);
    if (area <= 0) return "OCCLUDED=0 REASON=bad-rect";
    var list = new List<IntPtr>();
    bool found = false;
    EnumWindows((h, l) => {
      if (h == pet) { found = true; return true; }   // z-order: everything collected before = above the pet
      if (!found) {
        if (!IsWindowVisible(h) || IsIconic(h)) return true;
        RECT r; GetWindowRect(h, out r);
        if (IsOpaqueApp(h, r.R - r.L, r.B - r.T)) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    if (!found) return "OCCLUDED=0 REASON=pet-not-found";
    int tol = 10;
    foreach (IntPtr h in list) {
      RECT r; GetWindowRect(h, out r);
      if (r.L <= pr.L + tol && r.T <= pr.T + tol && r.R >= pr.R - tol && r.B >= pr.B - tol) return "OCCLUDED=1";
      int ox = Math.Max(0, Math.Min(r.R, pr.R) - Math.Max(r.L, pr.L));
      int oy = Math.Max(0, Math.Min(r.B, pr.B) - Math.Max(r.T, pr.T));
      if ((long)ox * oy >= area * 98 / 100) return "OCCLUDED=1";
    }
    return "OCCLUDED=0";
  }
}
'@
if (-not ('Occ3' -as [type])) { Add-Type -TypeDefinition $src }
if ($Hwnd -le 0) { Write-Output "OCCLUDED=0 REASON=no-hwnd"; exit 0 }
Write-Output ([Occ3]::Check([IntPtr]$Hwnd))
