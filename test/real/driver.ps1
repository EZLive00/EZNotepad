param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$A1 = "",
  [string]$A2 = "",
  [string]$A3 = "",
  [string]$A4 = "",
  [string]$Out = "D:/tmp/ez-real/shot.png",
  [int]$Rel = 0
)

# All-ASCII by design: Windows PowerShell 5.1 reads .ps1 in the ANSI code page
# unless the file carries a BOM, so Chinese text here would turn into mojibake.
# Text to type is passed as base64 (see the "type" action) for the same reason.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not ("Win32Drv" -as [type])) {
$refs = @([System.Drawing.Bitmap].Assembly.Location, [System.Object].Assembly.Location)
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION {
  [FieldOffset(0)] public MOUSEINPUT mi;
  [FieldOffset(0)] public KEYBDINPUT ki;
}

[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION u; }

public class Win32Drv {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        RECT r;
        GetWindowRect(h, out r);
        if ((r.Right - r.Left) > 200 && (r.Bottom - r.Top) > 200) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindByName(string name) {
    foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName(name)) {
      IntPtr h = Find((uint)p.Id);
      if (h != IntPtr.Zero) return h;
    }
    return IntPtr.Zero;
  }

  public static string Origin(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "0,0";
    return r.Left + "," + r.Top;
  }

  public static string Status(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "none";
    string fg = (GetForegroundWindow() == h) ? "1" : "0";
    return "rect=" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom
         + " size=" + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " fg=" + fg;
  }

  public static string Shot(IntPtr h, string path) {
    RECT r;
    GetWindowRect(h, out r);
    int w = r.Right - r.Left;
    int ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) return "bad-rect";
    using (Bitmap bmp = new Bitmap(w, ht)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        IntPtr dc = g.GetHdc();
        PrintWindow(h, dc, 2);
        g.ReleaseHdc(dc);
      }
      bmp.Save(path, ImageFormat.Png);
    }
    return w + "x" + ht;
  }

  public static void Focus(IntPtr h) {
    ShowWindow(h, 9);
    SetForegroundWindow(h);
  }

  // ---- input ----

  static void SendOne(INPUT i) {
    SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void KeyCode(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = 0;
    i.u.ki.dwFlags = up ? (uint)2 : (uint)0;
    i.u.ki.time = 0;
    i.u.ki.dwExtraInfo = IntPtr.Zero;
    SendOne(i);
  }

  static void UniChar(char c, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = 0;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = 4 | (up ? 2u : 0u);
    i.u.ki.time = 0;
    i.u.ki.dwExtraInfo = IntPtr.Zero;
    SendOne(i);
  }

  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\n') { KeyCode(0x0D, false); KeyCode(0x0D, true); }
      else if (c == '\t') { KeyCode(0x09, false); KeyCode(0x09, true); }
      else { UniChar(c, false); UniChar(c, true); }
      System.Threading.Thread.Sleep(14);
    }
  }

  public static byte Vk(string name) {
    string n = name.ToLower();
    if (n.Length == 1) {
      char c = n[0];
      if (c >= 'a' && c <= 'z') return (byte)(0x41 + (c - 'a'));
      if (c >= '0' && c <= '9') return (byte)(0x30 + (c - '0'));
      if (c == '-') return 0xBD;
      if (c == '=') return 0xBB;
      if (c == ',') return 0xBC;
      if (c == '.') return 0xBE;
      if (c == '/') return 0xBF;
      if (c == '[') return 0xDB;
      if (c == ']') return 0xDD;
      if (c == ';') return 0xBA;
      if (c == 39) return 0xDE;
      if (c == 92) return 0xDC;
    }
    switch (n) {
      case "enter": return 0x0D;
      case "tab": return 0x09;
      case "esc": return 0x1B;
      case "space": return 0x20;
      case "backspace": return 0x08;
      case "delete": return 0x2E;
      case "insert": return 0x2D;
      case "up": return 0x26;
      case "down": return 0x28;
      case "left": return 0x25;
      case "right": return 0x27;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": return 0x21;
      case "pagedown": return 0x22;
      case "ctrl": return 0x11;
      case "shift": return 0x10;
      case "alt": return 0x12;
      case "plus": return 0xBB;
      case "minus": return 0xBD;
      case "comma": return 0xBC;
    }
    if (n.Length >= 2 && n[0] == 'f') {
      int k;
      if (int.TryParse(n.Substring(1), out k) && k >= 1 && k <= 12) return (byte)(0x70 + k - 1);
    }
    return 0;
  }

  public static void Tap(string name) {
    byte vk = Vk(name);
    if (vk == 0) return;
    KeyCode(vk, false);
    System.Threading.Thread.Sleep(35);
    KeyCode(vk, true);
  }

  // "ctrl+shift+p" -> press left to right, release right to left
  public static string Combo(string spec) {
    string[] parts = spec.ToLower().Split('+');
    byte[] keys = new byte[parts.Length];
    for (int i = 0; i < parts.Length; i++) {
      keys[i] = Vk(parts[i]);
      if (keys[i] == 0) return "bad-key:" + parts[i];
    }
    for (int i = 0; i < keys.Length; i++) { KeyCode(keys[i], false); System.Threading.Thread.Sleep(28); }
    System.Threading.Thread.Sleep(35);
    for (int i = keys.Length - 1; i >= 0; i--) { KeyCode(keys[i], true); System.Threading.Thread.Sleep(28); }
    return "ok";
  }

  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(70);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(55);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }

  public static void DragTo(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1);
    System.Threading.Thread.Sleep(90);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(90);
    int steps = 14;
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
      System.Threading.Thread.Sleep(25);
    }
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@ -ReferencedAssemblies $refs
}

$exe = "D:\dev\project\EZ\EZNotepad\src-tauri\target\release\EZNotepad.exe"
$procName = "simple-notepad"

function Get-Hwnd {
  $h = [Win32Drv]::FindByName($procName)
  if ($h -eq [IntPtr]::Zero) { throw "no-window" }
  return $h
}

function Wait-Hwnd([int]$procId, [int]$tries = 120) {
  for ($i = 0; $i -lt $tries; $i++) {
    foreach ($p in @(Get-Process -Name $procName -ErrorAction SilentlyContinue)) {
      if ($p.Id -eq $procId) {
        $h = [Win32Drv]::Find([uint32]$procId)
        if ($h -ne [IntPtr]::Zero) { return $h }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  return [IntPtr]::Zero
}

function Get-OriginParts {
  $o = [Win32Drv]::Origin((Get-Hwnd))
  $p = $o.Split(",")
  return @([int]$p[0], [int]$p[1])
}

function Invoke-Cmd([string]$line) {
  $line = $line.Trim()
  if ($line -eq "") { return }
  $sp = $line.IndexOf(" ")
  if ($sp -lt 0) { $verb = $line; $rest = "" } else { $verb = $line.Substring(0, $sp); $rest = $line.Substring($sp + 1) }
  switch ($verb) {
    "sleep" { Start-Sleep -Milliseconds ([int]$rest) }
    "focus" { [Win32Drv]::Focus((Get-Hwnd)); Start-Sleep -Milliseconds 200 }
    "type" {
      # payload is base64 so the shell never has to carry non-ASCII
      $bytes = [Convert]::FromBase64String($rest)
      $text = [Text.Encoding]::UTF8.GetString($bytes)
      [Win32Drv]::TypeText($text)
      Start-Sleep -Milliseconds 120
    }
    "key" { [Win32Drv]::Tap($rest.Trim()); Start-Sleep -Milliseconds 90 }
    "combo" { [void][Win32Drv]::Combo($rest.Trim()); Start-Sleep -Milliseconds 200 }
    "click" {
      $p = $rest.Split(" ")
      $x = [int]$p[0]; $y = [int]$p[1]
      if ($Rel -eq 1) { $o = Get-OriginParts; $x += $o[0]; $y += $o[1] }
      [Win32Drv]::ClickAt($x, $y)
      Start-Sleep -Milliseconds 200
    }
    "dclick" {
      $p = $rest.Split(" ")
      $x = [int]$p[0]; $y = [int]$p[1]
      if ($Rel -eq 1) { $o = Get-OriginParts; $x += $o[0]; $y += $o[1] }
      [Win32Drv]::ClickAt($x, $y); Start-Sleep -Milliseconds 70; [Win32Drv]::ClickAt($x, $y)
      Start-Sleep -Milliseconds 250
    }
    "drag" {
      $p = $rest.Split(" ")
      $x1 = [int]$p[0]; $y1 = [int]$p[1]; $x2 = [int]$p[2]; $y2 = [int]$p[3]
      if ($Rel -eq 1) { $o = Get-OriginParts; $x1 += $o[0]; $y1 += $o[1]; $x2 += $o[0]; $y2 += $o[1] }
      [Win32Drv]::DragTo($x1, $y1, $x2, $y2)
      Start-Sleep -Milliseconds 300
    }
    "shot" {
      $p = [Win32Drv]::Shot((Get-Hwnd), $rest.Trim())
      Write-Output "  shot $rest $p"
    }
    default { Write-Output "  WARN unknown-cmd $verb" }
  }
}

switch ($Action) {
  "launch" {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    Start-Sleep -Milliseconds 600
    if ($A1 -ne "") {
      $proc = Start-Process -FilePath $exe -ArgumentList $A1 -PassThru
    } else {
      $proc = Start-Process -FilePath $exe -PassThru
    }
    $hwnd = Wait-Hwnd $proc.Id
    if ($hwnd -eq [IntPtr]::Zero) { Write-Output "FAIL no-window pid=$($proc.Id)"; exit 1 }
    [Win32Drv]::SetWindowPos($hwnd, [IntPtr]::Zero, 120, 60, 1180, 780, 0x0040) | Out-Null
    Start-Sleep -Milliseconds 1200
    [Win32Drv]::Focus($hwnd)
    Start-Sleep -Milliseconds 400
    Write-Output "OK pid=$($proc.Id) $([Win32Drv]::Status($hwnd))"
  }
  "info" {
    Write-Output "OK $([Win32Drv]::Status((Get-Hwnd)))"
  }
  "shot" {
    New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
    $size = [Win32Drv]::Shot((Get-Hwnd), $Out)
    Write-Output "OK $Out $size"
  }
  "focus" {
    [Win32Drv]::Focus((Get-Hwnd))
    Start-Sleep -Milliseconds 250
    Write-Output "OK $([Win32Drv]::Status((Get-Hwnd)))"
  }
  "seq" {
    # sequence of commands separated by " | "
    [Win32Drv]::Focus((Get-Hwnd))
    Start-Sleep -Milliseconds 250
    foreach ($part in $A1.Split("|")) { Invoke-Cmd $part }
    Write-Output "OK seq"
  }
  "kill" {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    Write-Output "OK killed"
  }
  default { Write-Output "FAIL unknown-action $Action"; exit 1 }
}
