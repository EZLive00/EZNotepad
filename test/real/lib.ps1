# lib.ps1 -- reusable half of the real-window driver.
# Dot-sourced by case.ps1. No param block here (dot-sourcing would rebind it).
# All-ASCII by design: PowerShell 5.1 parses .ps1 in the ANSI code page without a BOM.

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

  public static string Rect(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "none";
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
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
      case "grave": return 0xC0;
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

  public static void RightClickAt(int x, int y) {
    // Same SendInput path as ClickAt; right button flags are 0x0008/0x0010.
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    INPUT d = new INPUT();
    d.type = 0;
    d.u.mi.dwFlags = 0x0008;          // RIGHTDOWN
    SendInput(1, new INPUT[] { d }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(90);
    INPUT u = new INPUT();
    u.type = 0;
    u.u.mi.dwFlags = 0x0010;          // RIGHTUP
    SendInput(1, new INPUT[] { u }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(60);
  }

  public static void ClickAt(int x, int y) {
    // mouse_event only ever produced mousedown (focus) inside WebView2 -- no
    // click event was synthesised, so buttons looked dead. SendInput does it
    // the same way a real mouse does.
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    INPUT d = new INPUT();
    d.type = 0;
    d.u.mi.dwFlags = 0x0002;          // LEFTDOWN
    SendInput(1, new INPUT[] { d }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(90);
    INPUT u = new INPUT();
    u.type = 0;
    u.u.mi.dwFlags = 0x0004;          // LEFTUP
    SendInput(1, new INPUT[] { u }, Marshal.SizeOf(typeof(INPUT)));
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

$script:AppName = "simple-notepad"
$script:AppExe  = "D:\dev\project\EZ\EZNotepad\src-tauri\target\release\simple-notepad.exe"
$script:AppHwnd = [IntPtr]::Zero

function Get-AppHwnd {
  if ($script:AppHwnd -ne [IntPtr]::Zero -and [Win32Drv]::Rect($script:AppHwnd) -ne "none") {
    return $script:AppHwnd
  }
  return [Win32Drv]::FindByName($script:AppName)
}

function Start-App([string]$file, [int]$winW = 1180, [int]$winH = 780) {
  Stop-App
  Start-Sleep -Milliseconds 700
  if ($file -ne "" -and $file -ne "-") {
    $proc = Start-Process -FilePath $script:AppExe -ArgumentList $file -PassThru
  } else {
    $proc = Start-Process -FilePath $script:AppExe -PassThru
  }
  for ($i = 0; $i -lt 150; $i++) {
    $h = [Win32Drv]::Find([uint32]$proc.Id)
    if ($h -ne [IntPtr]::Zero) { $script:AppHwnd = $h; break }
    Start-Sleep -Milliseconds 100
  }
  if ($script:AppHwnd -eq [IntPtr]::Zero) { throw "app window never appeared" }
  $script:AppPid = [int]$proc.Id
  [Win32Drv]::SetWindowPos($script:AppHwnd, [IntPtr]::Zero, 120, 60, $winW, $winH, 0x0040) | Out-Null
  Start-Sleep -Milliseconds 1300
  [Win32Drv]::Focus($script:AppHwnd)
  Start-Sleep -Milliseconds 400
  return $proc.Id
}

function Stop-App {
  Get-Process -Name $script:AppName -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
  $script:AppHwnd = [IntPtr]::Zero
  Start-Sleep -Milliseconds 800
}

# A leftover draft pops a modal on startup that swallows every keystroke.
# Tests need a clean initial state, so wipe localStorage (settings reset too).
function Reset-AppState {
  $base = [Environment]::GetFolderPath('LocalApplicationData')
  if (-not $base) { $base = "C:\Users\51936\AppData\Local" }
  $ls = Join-Path $base "com.simple.notepad\EBWebView\Default\Local Storage"
  if (Test-Path $ls) {
    Remove-Item -Recurse -Force $ls -ErrorAction SilentlyContinue
  }
}

function Shot([string]$path) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $h = Get-AppHwnd
  if ($h -eq [IntPtr]::Zero) { return "no-window" }
  return [Win32Drv]::Shot($h, $path)
}

function AppOrigin {
  $o = [Win32Drv]::Origin((Get-AppHwnd))
  $p = $o.Split(",")
  return @([int]$p[0], [int]$p[1])
}

function RelClick([int]$x, [int]$y) {
  $o = AppOrigin
  [Win32Drv]::ClickAt($o[0] + $x, $o[1] + $y)
  Start-Sleep -Milliseconds 220
}

function RelDClick([int]$x, [int]$y) {
  $o = AppOrigin
  [Win32Drv]::ClickAt($o[0] + $x, $o[1] + $y)
  Start-Sleep -Milliseconds 70
  [Win32Drv]::ClickAt($o[0] + $x, $o[1] + $y)
  Start-Sleep -Milliseconds 280
}

function RelDrag([int]$x1, [int]$y1, [int]$x2, [int]$y2) {
  $o = AppOrigin
  [Win32Drv]::DragTo($o[0] + $x1, $o[1] + $y1, $o[0] + $x2, $o[1] + $y2)
  Start-Sleep -Milliseconds 320
}

function TypeB64([string]$b64) {
  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  [Win32Drv]::TypeText($text)
  Start-Sleep -Milliseconds 140
}

# ---------------------------------------------------------------------------
# UI Automation helpers.
# Pixel clicking is unreliable in here: the menu bar and the block gutters do
# not answer the coordinate you aimed at (a click meant for the item at x=105
# opened the one whose label sits at x=35), while sidebar rows land exactly.
# So ask the accessibility tree where a control really is, then click its
# centre. Chromium also exposes the panels and list rows as named elements,
# which is the only way to drive a right-click menu.
# ---------------------------------------------------------------------------
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes } catch { }

function Uia-Root {
  $h = Get-AppHwnd
  if ($h -eq [IntPtr]::Zero) { return $null }
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

# Exact name first (cheap), then one full walk. The walk matters: Chromium
# builds the accessibility subtree lazily, so a freshly opened panel is
# invisible to a targeted FindFirst until something enumerates it.
function Uia-Find([string]$name) {
  $root = Uia-Root
  if ($null -eq $root) { return $null }
  $c = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $hit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  if ($null -ne $hit) { return $hit }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $prefix = $null
  foreach ($e in $all) {
    $n = $e.Current.Name
    if (-not $n) { continue }
    if ($n -ceq $name) { return $e }
    if ($null -eq $prefix -and $n.StartsWith($name)) { $prefix = $e }
  }
  return $prefix
}

function Uia-FindItem([string]$name) {
  for ($i = 0; $i -lt 4; $i++) {
    $el = Uia-Find $name
    if ($null -ne $el) {
      $cur = $el.Current
      if ($cur.IsOffscreen -eq $false -and $cur.IsEnabled -eq $true) { return $el }
    }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

# Click the centre of the element's own bounding box. Screen coords come back
# from UIA already, so no client-origin arithmetic is involved.
function Uia-ClickEl($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { return "empty-rect" }
  $x = [int]($r.X + $r.Width / 2)
  $y = [int]($r.Y + $r.Height / 2)
  [Win32Drv]::ClickAt($x, $y)
  Start-Sleep -Milliseconds 250
  return "click"
}

function Uia-Invoke([string]$name) {
  $el = Uia-FindItem $name
  if ($null -eq $el) { return "notfound" }
  return (Uia-ClickEl $el)
}

# Open a menu, then click one of its items. The very first synthesized click
# after launch only activates the window, so the whole thing is retried: if the
# item never shows up the menu was never open.
function Uia-Menu([string]$menu, [string]$item) {
  for ($t = 0; $t -lt 3; $t++) {
    [void](Uia-Invoke $menu)
    Start-Sleep -Milliseconds 400
    $el = Uia-FindItem $item
    if ($null -eq $el) { continue }
    $res = Uia-ClickEl $el
    Start-Sleep -Milliseconds 450
    if ($res -eq "click") { return "ok" }
  }
  return "notfound"
}

function Uia-RClick([string]$name) {
  $el = Uia-FindItem $name
  if ($null -eq $el) { return "notfound" }
  $r = $el.Current.BoundingRectangle
  [Win32Drv]::RightClickAt([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  Start-Sleep -Milliseconds 350
  return "ok"
}

# --- native dialogs -------------------------------------------------------
# The folder picker is a real Win32 window, so PrintWindow on the app returns a
# stale frame while it is up, and keystrokes land wherever the dialog put focus.
# Drive it through its own accessibility tree instead.
function Dlg-Win {
  if (-not $script:AppPid) { return $null }
  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $script:AppPid)
  $wins = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    if ($w.Current.NativeWindowHandle -ne $script:AppHwnd.ToInt64()) { return $w }
  }
  return $null
}

function Dlg-Find([string]$name) {
  $d = Dlg-Win
  if ($null -eq $d) { return $null }
  $c = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}

function Dlg-Names([int]$max) {
  $d = Dlg-Win
  if ($null -eq $d) { return @() }
  $all = $d.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $out = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    $n = $e.Current.Name
    if ($n -and $n.Trim().Length -gt 0) { [void]$out.Add($n) }
    if ($out.Count -ge $max) { break }
  }
  return $out
}

# Put a path into the dialog's first edit box, then press the confirm button.
function Dlg-Pick([string]$path) {
  $d = Dlg-Win
  if ($null -eq $d) { return "nodlg" }
  # Same lazy-tree problem as the web view: nothing is exposed until something
  # enumerates the whole dialog, so walk it once before looking for controls.
  [void]$d.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  Start-Sleep -Milliseconds 200

  $ed = $null
  for ($i = 0; $i -lt 5; $i++) {
    # The path box is the edit inside the folder combo (or a plain edit).
    $ect = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit)
    $ed = $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $ect)
    if ($null -ne $ed) { break }
    [void]$d.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    Start-Sleep -Milliseconds 300
  }
  if ($null -eq $ed) {
    # No edit exposed: the folder box is a combo whose text part is hidden until
    # it is clicked, so click it and type the path with the keyboard.
    $cct = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ComboBox)
    $cb = $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cct)
    if ($null -eq $cb) { return "noedit" }
    [void](Uia-ClickEl $cb)
    Start-Sleep -Milliseconds 300
    [Win32Drv]::TypeText($path)
    Start-Sleep -Milliseconds 400
    [Win32Drv]::Tap("enter")
    Start-Sleep -Milliseconds 700
    # Enter on the path either navigates into the folder or accepts it outright;
    # click the confirm button in case it only navigated.
    $bct2 = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)
    $bs = $d.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bct2)
    foreach ($b in $bs) {
      $n = $b.Current.Name
      if (-not $n) { continue }
      $selKey = ([string][char]0x9009 + [string][char]0x62E9)
      if ($n.Contains($selKey)) {
        [void](Uia-ClickEl $b)
        return "ok-combo"
      }
    }
    return "combo-no-button"
  }

  try {
    $vp = $ed.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($path)
  } catch { return "novalue:" + $_.Exception.Message }
  Start-Sleep -Milliseconds 400

  $confirm = @(
    ([string][char]0x9009 + [string][char]0x62E9),
    ([string][char]0x6253 + [string][char]0x5F00),
    ([string][char]0x786E + [string][char]0x5B9A)
  )
  $bct = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $btns = $d.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bct)
  $label = ""
  foreach ($b in $btns) {
    $n = $b.Current.Name
    if (-not $n) { continue }
    $hit = $false
    foreach ($k in $confirm) { if ($n.Contains($k)) { $hit = $true; break } }
    if ($hit) { $label = $n; break }
  }
  if (-not $label) { return "nobutton" }
  # Click it rather than Invoke: some picker buttons answer Invoke with a
  # generic error while a plain click works.
  $el = $null
  foreach ($b in $btns) {
    if ($b.Current.Name -eq $label) { $el = $b; break }
  }
  [void](Uia-ClickEl $el)
  return "ok"
}

function Dlg-Shot([string]$path) {
  $d = Dlg-Win
  if ($null -eq $d) { return "nodlg" }
  $h = [IntPtr]$d.Current.NativeWindowHandle
  return [Win32Drv]::Shot($h, $path)
}

function Uia-Names([int]$max) {
  $root = Uia-Root
  if ($null -eq $root) { return @() }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $out = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    $n = $e.Current.Name
    if ($n -and $n.Trim().Length -gt 0) {
      [void]$out.Add($n)
      if ($out.Count -ge $max) { break }
    }
  }
  return $out
}
