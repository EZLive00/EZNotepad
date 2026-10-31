param(
  [Parameter(Mandatory=$true)][string]$Script,
  [string]$Tag = "case"
)

# Executes one base64-encoded action script against the real packaged window.
# One PowerShell invocation == one app lifetime, because the host kills the
# whole process tree when the call returns (verified: the window dies between
# invocations). So every case is start -> act -> screenshot -> quit.
. "$PSScriptRoot\lib.ps1"

$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Script))
$lines = $text -split "`r?`n"

$log = New-Object System.Collections.ArrayList
$failed = $false
$script:TargetFile = ""

foreach ($raw in $lines) {
  $line = $raw.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) { continue }
  $sp = $line.IndexOf(" ")
  if ($sp -lt 0) { $verb = $line; $rest = "" } else { $verb = $line.Substring(0, $sp); $rest = $line.Substring($sp + 1).Trim() }
  [void]$log.Add(">> " + $line)
  try {
    switch ($verb) {
      "launch"   {
        # launch <file> [fresh|keep]
        $parts = $rest.Split(" ")
        $file = $parts[0]
        $mode = "fresh"
        if ($parts.Length -gt 1) { $mode = $parts[1] }
        $script:TargetFile = $file
        $pid2 = Start-App $file
        [void]$log.Add("   pid=$pid2 " + [Win32Drv]::Status((Get-AppHwnd)))
      }
      "relclick" { $p = $rest.Split(" "); RelClick ([int]$p[0]) ([int]$p[1]) }
      "reldclick"{ $p = $rest.Split(" "); RelDClick ([int]$p[0]) ([int]$p[1]) }
      "relbr"    {
        # relbr <dx> <dy> -- click measured from the window's bottom-right corner
        $p = $rest.Split(" ")
        $r = [Win32Drv]::Rect((Get-AppHwnd)).Split(",")
        [Win32Drv]::ClickAt([int]$r[2] - [int]$p[0], [int]$r[3] - [int]$p[1])
        Start-Sleep -Milliseconds 250
      }
      "reldrag"  { $p = $rest.Split(" "); RelDrag ([int]$p[0]) ([int]$p[1]) ([int]$p[2]) ([int]$p[3]) }
      "type"     { TypeB64 $rest }
      "key"      { [Win32Drv]::Tap($rest); Start-Sleep -Milliseconds 110 }
      "combo"    { $r = [Win32Drv]::Combo($rest); if ($r -ne "ok") { [void]$log.Add("   !! combo " + $r) } Start-Sleep -Milliseconds 260 }
      "save"     { $r = [Win32Drv]::Combo("ctrl+s"); Start-Sleep -Milliseconds 500 }
      "sleep"    { Start-Sleep -Milliseconds ([int]$rest) }
      "focus"    { [Win32Drv]::Focus((Get-AppHwnd)); Start-Sleep -Milliseconds 250 }
      "shot"     { $sz = Shot $rest; [void]$log.Add("   shot " + $rest + " " + $sz) }
      "check" {
        # check <label> <b64expected> [path] -- compare on-disk bytes, print ASCII verdict
        $parts = $rest.Split(" ")
        $label = $parts[0]
        $exp = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
        $path = $script:TargetFile
        if ($parts.Length -gt 2) { $path = $parts[2] }
        $act = ""
        if (Test-Path $path) { $act = [IO.File]::ReadAllText($path) }
        $expN = $exp.Replace("`r`n", "`n")
        $actN = $act.Replace("`r`n", "`n")
        if ($expN -ceq $actN) {
          Write-Output ("CHECK " + $label + " PASS")
        } else {
          $eb = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expN))
          $ab = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actN))
          Write-Output ("CHECK " + $label + " FAIL exp=" + $eb + " act=" + $ab)
        }
      }
      "dump" {
        # dump <label> [path] -- emit the on-disk bytes so the caller can assert exactly
        $parts = $rest.Split(" ")
        $label = $parts[0]
        $path = $script:TargetFile
        if ($parts.Length -gt 1) { $path = $parts[1] }
        if (Test-Path $path) {
          $bytes = [IO.File]::ReadAllBytes($path)
          $b64 = [Convert]::ToBase64String($bytes)
          Write-Output ("DUMP " + $label + " " + $b64)
        } else {
          Write-Output ("DUMP " + $label + " MISSING")
        }
      }
      "win" {
        # win <base64 title> -- retarget all relative verbs at that window
        $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($rest))
        $h = [Win32Drv]::FindTitled([uint32]$script:AppPid, $t)
        if ($h -eq [IntPtr]::Zero) {
          [void]$log.Add("   !! no window titled " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))
          $failed = $true
        } else {
          $script:AppHwnd = $h
          [Win32Drv]::Focus($h)
          Start-Sleep -Milliseconds 350
          [void]$log.Add("   win " + [Win32Drv]::Status($h))
        }
      }
      "startcmp" {
        # startcmp <b64 title> <b64 left> <b64 right> -- boot straight into compare
        $p = $rest.Split(" ")
        $ti = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[0]))
        $lf = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
        $rt = ""
        if ($p.Length -gt 2 -and $p[2] -ne "-") { $rt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])) }
        $st = Start-Compare $lf $rt $ti
        [void]$log.Add("   cmp " + $st)
      }
      "wins" {
        # list every window the process owns, so a missing one is obvious
        Write-Output ("WINS " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Win32Drv]::Titles([uint32]$script:AppPid))))
      }
      "fullshot" {
        # whole-screen grab: proves whether a maximized borderless window
        # covered the taskbar or not
        $sz = [Win32Drv]::ShotDesktop($rest)
        [void]$log.Add("   fullshot " + $rest + " " + $sz)
      }
      "kill"     { Stop-App }
      "uia" {
        # uia <base64 name> -- click a named control through the accessibility tree
        $nm = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($rest))
        $r = Uia-Invoke $nm
        Write-Output ("UIA " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nm)) + " " + $r)
        Start-Sleep -Milliseconds 350
      }
      "menu" {
        # menu <base64 menu> <base64 item> -- open a menu, click one of its items
        $parts = $rest.Split(" ")
        $m = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[0]))
        $it = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
        $r = Uia-Menu $m $it
        $tag2 = $m + "/" + $it
        Write-Output ("MENU " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tag2)) + " " + $r)
        Start-Sleep -Milliseconds 400
      }
      "uirclick" {
        # uirclick <base64 name> -- right-click the named control
        $nm = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($rest))
        $r = Uia-RClick $nm
        Write-Output ("UIA " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nm)) + " " + $r)
        Start-Sleep -Milliseconds 300
      }
      "dlgnames" {
        $ns = Dlg-Names ([int]$rest)
        if ($ns.Count -eq 0) { Write-Output "DLG none" }
        foreach ($n in $ns) { Write-Output ("DLG " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($n))) }
      }
      "dlgshot" {
        Write-Output ("DLGSHOT " + (Dlg-Shot $rest))
      }
      "dlgpick" {
        # dlgpick <base64 path> -- put the path in the dialog's edit box and confirm
        $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($rest))
        Write-Output ("DLGPICK " + (Dlg-Pick $path))
        Start-Sleep -Milliseconds 900
      }
      "uianames" {
        # uianames <max> -- dump the accessible names present right now
        $ns = Uia-Names ([int]$rest)
        foreach ($n in $ns) { Write-Output ("UIA " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($n))) }
      }
      default    { [void]$log.Add("   !! unknown " + $verb); $failed = $true }
    }
  } catch {
    [void]$log.Add("   !! " + $_.Exception.Message)
    $failed = $true
  }
}

Stop-App
foreach ($l in $log) { Write-Output $l }
if ($failed) { Write-Output "RESULT fail $Tag"; exit 2 } else { Write-Output "RESULT ok $Tag"; exit 0 }
