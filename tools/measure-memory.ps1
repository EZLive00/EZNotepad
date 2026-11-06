# Measure the resident memory of an EZNotepad instance, process tree included.
#
# Why this exists: the numbers people quote ("500 MB!") come from different
# columns and are not comparable. This script prints both:
#   WS  = WorkingSet (sum over processes, shared pages counted many times)
#   WSP = WorkingSetPrivate (this is what Task Manager's "Memory" column shows)
#
# Two traps it avoids, both hit for real while writing docs/proposals/native-shell.md:
#   1. Recursing ParentProcessId naively pulls in dwm.exe / LogonUI.exe when a
#      browser PID gets recycled. Filter by image name.
#   2. Get-Counter per process is slow and throws on the first missing counter,
#      which kills the whole row. Read Win32_PerfRawData_PerfProc_Process once.
#
# Usage:
#   .\tools\measure-memory.ps1              # default label
#   .\tools\measure-memory.ps1 -Label "E1"  # tag this run
param([string]$Label = "EZNotepad")

$names = @('EZNotepad.exe', 'msedgewebview2.exe')
$app = Get-Process EZNotepad -ErrorAction SilentlyContinue
if (-not $app) { "$Label : app not running"; exit 1 }

function Get-Tree([int]$rootPid) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$rootPid" -ErrorAction SilentlyContinue
  $out = @()
  foreach ($c in $children) { $out += $c; $out += Get-Tree ([int]$c.ProcessId) }
  return $out
}

$all = @()
foreach ($r in $app) {
  $all += Get-CimInstance Win32_Process -Filter "ProcessId=$($r.Id)"
  $all += Get-Tree ([int]$r.Id)
}

$perf = Get-CimInstance Win32_PerfRawData_PerfProc_Process -ErrorAction SilentlyContinue
$rows = foreach ($p in $all) {
  if ($names -notcontains $p.Name) { continue }
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $type = 'browser'
  if ($p.CommandLine -match '--type=([a-zA-Z-]+)') { $type = $Matches[1] }
  if ($p.Name -eq 'EZNotepad.exe') { $type = 'app' }
  $pf = $perf | Where-Object { $_.IDProcess -eq $p.ProcessId }
  $wsp = if ($pf) { [math]::Round($pf.WorkingSetPrivate / 1MB, 1) } else { 0 }
  [pscustomobject]@{
    Type = $type
    Pid  = $p.ProcessId
    WS   = [math]::Round($proc.WorkingSet64 / 1MB, 1)
    WSP  = $wsp
  }
}

"===== $Label ====="
$rows | Sort-Object WS -Descending | Format-Table -AutoSize | Out-String
"processes {0} | total WS {1} MB | total WSP {2} MB" -f `
  $rows.Count, `
  [math]::Round((($rows | Measure-Object WS -Sum).Sum), 1), `
  [math]::Round((($rows | Measure-Object WSP -Sum).Sum), 1)
