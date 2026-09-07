# real mouse simulation via user32 (ASCII only, single-line C# string)
param(
  [string]$Action = "drag",
  [int]$X1 = 200,
  [int]$Y1 = 200,
  [int]$X2 = 400,
  [int]$Y2 = 160,
  [int]$Steps = 20,
  [int]$DelayMs = 20
)
$src = 'using System; using System.Runtime.InteropServices; public static class RM1 { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr x); public static void Move(int x, int y){ SetCursorPos(x, y); } public static void Dn(){ mouse_event(2, 0, 0, 0, UIntPtr.Zero); } public static void Up(){ mouse_event(4, 0, 0, 0, UIntPtr.Zero); } public static void Rdn(){ mouse_event(8, 0, 0, 0, UIntPtr.Zero); } public static void Rup(){ mouse_event(16, 0, 0, 0, UIntPtr.Zero); } }'
if (-not ('RM1' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }
switch ($Action) {
  "drag" {
    [RM1]::Move($X1, $Y1)
    Start-Sleep -Milliseconds 120
    [RM1]::Dn()
    Start-Sleep -Milliseconds 80
    for ($i = 1; $i -le $Steps; $i++) {
      [RM1]::Move([int]($X1 + ($X2 - $X1) * $i / $Steps), [int]($Y1 + ($Y2 - $Y1) * $i / $Steps))
      Start-Sleep -Milliseconds $DelayMs
    }
    Start-Sleep -Milliseconds 60
    [RM1]::Up()
    Write-Output "drag ok"
  }
  "click" {
    [RM1]::Move($X1, $Y1)
    Start-Sleep -Milliseconds 120
    [RM1]::Dn()
    Start-Sleep -Milliseconds 60
    [RM1]::Up()
    Write-Output "click ok"
  }
  "rightclick" {
    [RM1]::Move($X1, $Y1)
    Start-Sleep -Milliseconds 120
    [RM1]::Rdn()
    Start-Sleep -Milliseconds 60
    [RM1]::Rup()
    Write-Output "rightclick ok"
  }
  default { Write-Output "unknown action" }
}
