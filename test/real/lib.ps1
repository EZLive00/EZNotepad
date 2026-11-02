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
using System.Text;

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
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string cap);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] public static extern IntPtr SendMessageText(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] public static extern IntPtr SendMessageBuf(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessagePtr(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);

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

  // Every window the process owns, as "title<hwnd>" lines. The compare board
  // runs in a second top-level window, so Find(pid) alone is ambiguous.
  public static string Titles(uint pid) {
    StringBuilder outSb = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      outSb.Append(sb.ToString()).Append("#").Append(h.ToInt64()).Append("|");
      return true;
    }, IntPtr.Zero);
    return outSb.ToString();
  }

  public static IntPtr FindTitled(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      if (sb.ToString() == title) { found = h; return false; }
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

  // ---- Native file dialog (Vista+ IFileDialog) channel ----------------------
  // The dialog is a #32770 whose control IDs still follow the old template:
  //   cmb13 = 1148 (0x47C) filename/folder combo, the real Edit hides inside
  //   edt1  = 1152 (0x480) legacy edit
  //   IDOK  = 1            confirm button (Open / Select Folder / Save)
  // UIA exposes the combo's text area unreliably, and the combo's clickable
  // point lands on its dropdown arrow, so paths always go through WM_SETTEXT.
  public static IntPtr DialogEdit(IntPtr dlg) {
    IntPtr combo = GetDlgItem(dlg, 0x47C);
    if (combo != IntPtr.Zero) {
      StringBuilder cls = new StringBuilder(64);
      GetClassNameW(combo, cls, 64);
      string c = cls.ToString();
      if (c == "Edit") return combo;
      if (c == "ComboBox") {
        IntPtr ed = FindWindowEx(combo, IntPtr.Zero, "Edit", null);
        if (ed != IntPtr.Zero) return ed;
      }
    }
    IntPtr edt1 = GetDlgItem(dlg, 0x480);
    if (edt1 != IntPtr.Zero) return edt1;
    IntPtr hit = IntPtr.Zero;
    EnumChildWindows(dlg, delegate(IntPtr h, IntPtr l) {
      StringBuilder cls = new StringBuilder(64);
      GetClassNameW(h, cls, 64);
      if (cls.ToString() == "Edit" && IsWindowVisible(h)) { hit = h; return false; }
      return true;
    }, IntPtr.Zero);
    return hit;
  }

  public static bool SetEditText(IntPtr edit, string text) {
    return SendMessageText(edit, 0x000C, IntPtr.Zero, text) != IntPtr.Zero;  // WM_SETTEXT
  }

  public static string GetEditText(IntPtr edit) {
    StringBuilder sb = new StringBuilder(1024);
    SendMessageBuf(edit, 0x000D, (IntPtr)1024, sb);  // WM_GETTEXT
    return sb.ToString();
  }

  // BM_CLICK via PostMessage on purpose: SendMessage waits for the reply and
  // the dialog destroys itself while handling IDOK, which took down the whole
  // PowerShell process (access violation, real incident).
  public static bool ClickIdOk(IntPtr dlg) {
    IntPtr ok = GetDlgItem(dlg, 1);
    if (ok == IntPtr.Zero) return false;
    return PostMessagePtr(ok, 0x00F5, IntPtr.Zero, IntPtr.Zero);  // BM_CLICK
  }

  // Bring h to the foreground and PROVE it. SendInput goes to whatever is
  // focused / under the cursor -- when another window covers ours, clicks land
  // there silently (real incident: a maximized Chrome ate every click while
  // PrintWindow screenshots kept looking fine). SetForegroundWindow alone is
  // refused for background callers, hence the synthetic ALT trick.
  public static bool ForceFocus(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (GetForegroundWindow() == h) return true;
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero);      // ALT down unlocks the call
    SetForegroundWindow(h);
    keybd_event(0x12, 0, 0x0002, UIntPtr.Zero); // ALT up
    System.Threading.Thread.Sleep(80);
    return GetForegroundWindow() == h;
  }

  // The native file dialog: a visible #32770 owned by the app process. Found
  // with EnumWindows on purpose -- the managed UIA desktop-children query can
  // miss freshly created top-level windows for seconds (real incident: the
  // open dialog sat on screen while RootElement children never listed it).
  public static IntPtr FindDialog(uint pid) {
    IntPtr hit = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      StringBuilder cls = new StringBuilder(64);
      GetClassNameW(h, cls, 64);
      if (cls.ToString() != "#32770") return true;
      hit = h; return false;
    }, IntPtr.Zero);
    return hit;
  }

  // Control inventory for diagnosis: "class#id:<b64 text>" per child, all ASCII.
  public static string DumpDialog(IntPtr dlg, int max) {
    StringBuilder outSb = new StringBuilder();
    int n = 0;
    EnumChildWindows(dlg, delegate(IntPtr h, IntPtr l) {
      StringBuilder cls = new StringBuilder(64);
      GetClassNameW(h, cls, 64);
      StringBuilder txt = new StringBuilder(256);
      SendMessageBuf(h, 0x000D, (IntPtr)256, txt);
      string t = Convert.ToBase64String(Encoding.UTF8.GetBytes(txt.ToString()));
      outSb.Append(cls.ToString() + "#" + GetWindowLongW(h, -12) + ":" + t + " ");
      return ++n < max;
    }, IntPtr.Zero);
    return outSb.ToString();
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

  // Whole desktop, not just one window: a borderless maximized window that
  // covers the taskbar is only visible in a screen grab.
  public static string ShotDesktop(string path) {
    int w = GetSystemMetrics(0);
    int ht = GetSystemMetrics(1);
    if (w <= 0 || ht <= 0) return "bad-metrics";
    using (Bitmap bmp = new Bitmap(w, ht)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        IntPtr dc = g.GetHdc();
        IntPtr src = GetWindowDC(IntPtr.Zero);
        BitBlt(dc, 0, 0, w, ht, src, 0, 0, 0x00CC0020);
        ReleaseDC(IntPtr.Zero, src);
        g.ReleaseHdc(dc);
      }
      bmp.Save(path, ImageFormat.Png);
    }
    return w + "x" + ht;
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
$script:AppExe  = "D:\dev\project\EZ\EZNotepad\src-tauri\target\release\EZNotepad.exe"
$script:AppHwnd = [IntPtr]::Zero

# Make sure the app window really owns the input focus before synthesizing
# clicks or keys. Returns "ok" or a failure word; callers must treat anything
# but "ok" as a failed step -- sending input while unfocused silently lands in
# whatever window covers ours (real incident: a maximized Chrome).
function Focus-App {
  $h = Get-AppHwnd
  if ($h -eq [IntPtr]::Zero) { return "nohwnd" }
  if ([Win32Drv]::ForceFocus($h)) { return "ok" }
  return "blocked"
}

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
  if (-not [Win32Drv]::ForceFocus($script:AppHwnd)) { throw "app window never got focus" }
  Start-Sleep -Milliseconds 400
  return $proc.Id
}

# Start the app straight into the compare window: "exe --compare L R".
# The compare board lives in its own top-level window, so this waits for the
# title rather than for "any window of the process".
function Start-Compare([string]$left, [string]$right, [string]$title) {
  Stop-App
  Start-Sleep -Milliseconds 800
  $argList = @('--compare', ('"' + $left + '"'))
  if ($right -ne "") { $argList += ('"' + $right + '"') }
  $proc = Start-Process -FilePath $script:AppExe -ArgumentList $argList -PassThru
  $script:AppPid = [int]$proc.Id
  $script:AppHwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 160; $i++) {
    $h = [Win32Drv]::FindTitled([uint32]$proc.Id, $title)
    if ($h -ne [IntPtr]::Zero) { $script:AppHwnd = $h; break }
    Start-Sleep -Milliseconds 100
  }
  if ($script:AppHwnd -eq [IntPtr]::Zero) { throw "compare window never appeared" }
  Start-Sleep -Milliseconds 1600
  if (-not [Win32Drv]::ForceFocus($script:AppHwnd)) { throw "compare window never got focus" }
  Start-Sleep -Milliseconds 400
  return [Win32Drv]::Status($script:AppHwnd)
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

# Invoke the index-th element whose name matches (0-based). Buttons in the web
# overlay can share names (two "Select Folder"), so the index disambiguates.
function Uia-InvokeAt([string]$name, [int]$idx) {
  $root = Uia-Root
  if ($null -eq $root) { return "noroot" }
  # Lazy tree: enumerate once so the web view exposes its subtree.
  [void]$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $c = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)
  if ($els.Count -le $idx) { return "notfound" + $els.Count }
  return (Uia-ClickEl $els[$idx])
}

# Open a menu, then click one of its items. Look for the item FIRST each
# iteration: the dropdown may already be open from the previous iteration, and
# re-clicking the top entry toggles it shut (this made the old retry loop
# flaky). The very first synthesized click after launch only activates the
# window, so retrying is still needed.
function Uia-Menu([string]$menu, [string]$item) {
  for ($t = 0; $t -lt 4; $t++) {
    $el = Uia-FindItem $item
    if ($null -ne $el) {
      $res = Uia-ClickEl $el
      Start-Sleep -Milliseconds 450
      if ($res -eq "click") { return "ok" }
    }
    [void](Uia-Invoke $menu)
    Start-Sleep -Milliseconds 500
  }
  $root = Uia-Root
  $dbg = "tree=?"
  if ($null -ne $root) {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    $dbg = "tree=" + $all.Count
  }
  return "notfound $dbg"
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
  $h = [Win32Drv]::FindDialog([uint32]$script:AppPid)
  if ($h -eq [IntPtr]::Zero) { return $null }
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

function Dlg-Hwnd {
  $d = Dlg-Win
  if ($null -eq $d) { return [IntPtr]::Zero }
  return [IntPtr]$d.Current.NativeWindowHandle
}

# The path box of a native file dialog, via Win32 only (UIA is unreliable here).
function Dlg-EditHwnd {
  $hDlg = Dlg-Hwnd
  if ($hDlg -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  return [Win32Drv]::DialogEdit($hDlg)
}

function Dlg-Dump {
  $hDlg = Dlg-Hwnd
  if ($hDlg -eq [IntPtr]::Zero) { return "nodlg" }
  return [Win32Drv]::DumpDialog($hDlg, 60)
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
# Put $path into the file dialog and confirm it.
#
# Route 1 (preferred): pure Win32. The Vista+ IFileDialog keeps the legacy
# control IDs, so GetDlgItem(1148) + the Edit child inside the combo always
# exist and answer WM_SETTEXT, no matter what UIA decides to expose. Read the
# text back to prove it stuck.
# Route 2 (fallback): the old UIA dance (ValuePattern on an exposed Edit, or
# click the combo and type). Kept because it sometimes still works.
# Confirm via UIA button first (names are readable), else BM_CLICK on IDOK.
function Dlg-Pick([string]$path) {
  $d = Dlg-Win
  if ($null -eq $d) { return "nodlg" }
  $hDlg = Dlg-Hwnd
  if (-not [Win32Drv]::ForceFocus($hDlg)) { return "nofocus" }
  Start-Sleep -Milliseconds 200

  # ---- route 1: Win32 -------------------------------------------------------
  $ed = Dlg-EditHwnd
  if ($ed -ne [IntPtr]::Zero) {
    # The folder picker rejects forward slashes ("invalid folder name"
    # banner, dialog stays open); always hand it a backslash path.
    $win = $path.Replace('/', '\')
    [void][Win32Drv]::SetEditText($ed, $win)
    Start-Sleep -Milliseconds 300
    if ([Win32Drv]::GetEditText($ed) -eq $win) {
      $r = Dlg-Confirm
      if ($r -ne "") { return (Dlg-WaitClosed "ok-win32") }
      if ([Win32Drv]::ClickIdOk($hDlg)) { return (Dlg-WaitClosed "ok-win32-idok") }
      return "filled-no-confirm"
    }
  }

  # ---- route 2: UIA fallback ------------------------------------------------
  # Same lazy-tree problem as the web view: nothing is exposed until something
  # enumerates the whole dialog, so walk it once before looking for controls.
  [void]$d.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  Start-Sleep -Milliseconds 200

  $ed2 = $null
  for ($i = 0; $i -lt 5; $i++) {
    $ect = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit)
    $ed2 = $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $ect)
    if ($null -ne $ed2) { break }
    [void]$d.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    Start-Sleep -Milliseconds 300
  }
  if ($null -eq $ed2) {
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
    $r = Dlg-Confirm
    if ($r -ne "") { return "ok-combo" }
    return "combo-no-button"
  }

  try {
    $vp = $ed2.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($path)
  } catch { return "novalue:" + $_.Exception.Message }
  Start-Sleep -Milliseconds 400
  $r = Dlg-Confirm
  if ($r -ne "") { return "ok-uia" }
  return "nobutton"
}

# The dialog validates the path asynchronously: a bad one shows a warning
# banner and stays open; a save over an existing file parks a "replace it?"
# prompt on top. Wait for the stack to actually clear before reporting
# success, or "ok" would be a lie. One auto-answer for the replace prompt.
function Dlg-WaitClosed([string]$ok) {
  $yes = [string][char]0x662F        # yes
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 200
    if ($null -eq (Dlg-Win)) { return $ok }
    if ($i -eq 4) { [void](Dlg-ClickNamed $yes) }
  }
  return "rejected"
}

# Click the first visible button whose name contains $part, in the top dialog.
function Dlg-ClickNamed([string]$part) {
  $d = Dlg-Win
  if ($null -eq $d) { return $false }
  $bct = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $btns = $d.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bct)
  foreach ($b in $btns) {
    $n = $b.Current.Name
    if ($n -and $n.Contains($part)) { [void](Uia-ClickEl $b); return $true }
  }
  return $false
}

# Click the confirm button ("Select Folder" / "Open" / "Save" / "OK") via UIA.
# Returns its label, or "" when no confirm button is exposed.
function Dlg-Confirm {  $d = Dlg-Win
  if ($null -eq $d) { return "" }
  $confirm = @(
    ([string][char]0x9009 + [string][char]0x62E9),
    ([string][char]0x6253 + [string][char]0x5F00),
    ([string][char]0x4FDD + [string][char]0x5B58),
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
    foreach ($k in $confirm) {
      if ($n.Contains($k)) { $label = $n; break }
    }
    if ($label) { break }
  }
  if (-not $label) { return "" }
  # Click it rather than Invoke: some picker buttons answer Invoke with a
  # generic error while a plain click works.
  $el = $null
  foreach ($b in $btns) {
    if ($b.Current.Name -eq $label) { $el = $b; break }
  }
  [void](Uia-ClickEl $el)
  return $label
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
