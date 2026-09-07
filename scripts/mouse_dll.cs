using System;
using System.Runtime.InteropServices;

public static class RMouse
{
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    public const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;

    public static void Move(int x, int y) { SetCursorPos(x, y); }
    public static void Down() { mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); }
    public static void Up() { mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero); }
    public static void RDown() { mouse_event(RIGHTDOWN, 0, 0, 0, UIntPtr.Zero); }
    public static void RUp() { mouse_event(RIGHTUP, 0, 0, 0, UIntPtr.Zero); }
}
