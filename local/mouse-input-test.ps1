Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawMouse {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint d; public uint f; public uint t; public IntPtr e; }
  public static void Move(int x, int y) {
    var a = new INPUT[1]; a[0].type=0; a[0].mi.dx=x; a[0].mi.dy=y; a[0].mi.f=1;
    SendInput(1, a, System.Runtime.InteropServices.Marshal.SizeOf(a[0]));
  }
}
"@
[RawMouse]::Move(200, 0)
Write-Host "OK"
