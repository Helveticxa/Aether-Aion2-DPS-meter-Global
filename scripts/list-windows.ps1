# Lists a process's top-level windows the way OBS's Window Capture sees them:
# title, window class, extended styles, and whether OBS would list it. Used to
# check that only "Aether | DPS Overlay" has the class "Tauri Window".
#   powershell -ExecutionPolicy Bypass -File scripts/list-windows.ps1 -TargetPid (Get-Process Aether).Id
param([int]$TargetPid)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static List<string> Dump(uint target) {
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      long style = (long)GetWindowLongPtr(h, -16), ex = (long)GetWindowLongPtr(h, -20);
      uint aff = 999; bool affOk = GetWindowDisplayAffinity(h, out aff);
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      bool visible = IsWindowVisible(h);
      bool tool = (ex & 0x80) != 0, child = (style & 0x40000000) != 0;
      bool obs = visible && !IsIconic(h) && cloaked == 0 && !tool && !child;
      rows.Add(String.Format("{0,-34} class={1,-28} visible={2,-5} tool={3,-5} layered={4,-5} noactivate={5,-5} noredir={6,-5} affinity={7} cloaked={8} OBS-LISTS={9}",
        "\"" + t + "\"", c, visible, tool, (ex & 0x80000) != 0, (ex & 0x8000000) != 0, (ex & 0x200000) != 0,
        affOk ? aff.ToString() : "?", cloaked, obs));
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@
[W]::Dump([uint32]$TargetPid) | Where-Object { $_ -notmatch '^""' } | ForEach-Object { $_ }
