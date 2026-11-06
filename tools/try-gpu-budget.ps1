# Launch EZNotepad with a capped GPU tile budget, for measuring on a big/high-DPR screen.
#
# Why: on a large screen the compositor rasterises tiles ahead of scrolling, and tile
# memory tracks viewport *device pixel area*. Measured on this repo: 2.22 Mpx window
# costs ~45 MB more GPU commit than a 0.27 Mpx one, which extrapolates to ~230 MB of
# area-driven cost on a 4K screen (a work machine reported 300 MB for the GPU process).
# Chromium treats integrated-GPU "VRAM" as elastic (borrowed from system RAM), so its
# default budget can be far too generous.
#
# WHAT WAS ACTUALLY MEASURED (2026-11-06, 1918x1160 window, one 190 KB document):
#
#   --force-gpu-mem-available-mb=64   -> no change (90.5 MB texture, same as baseline)
#   --max-tiles-for-interest-area=64  -> no change
#   --force-gpu-mem-available-mb=16   -> 90.5 -> 66.5 MB texture, GPU commit 127 -> 110
#                                        scroll frame time 18.5 -> 18.8 ms (no regression)
#
# So the flag is NOT a hard cap: it only engages when the budget is several times
# *below* actual usage (ratio ~1/7 here). A 128 or 192 MB budget on a machine whose
# GPU process sits at 300 MB may well do nothing -- test a low value directly.
#
# Trade-off: tiles may need re-rasterising while scrolling, which can show up as
# dropped frames or slightly soft text. Compare with your eyes, not just the MB number.
#
# NOTE: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS *overrides* the args in tauri.conf.json
# rather than appending. The base string below must therefore stay in sync with
# src-tauri/tauri.conf.json, or you will reintroduce the WebView2 sandbox crash.
#
# Usage:
#   .\tools\try-gpu-budget.ps1 -BudgetMB 0        # 0 = baseline, run this FIRST
#   .\tools\try-gpu-budget.ps1 -BudgetMB 32
#   .\tools\try-gpu-budget.ps1 -BudgetMB 16 -Files "D:\notes\big.md"
param(
  [int]$BudgetMB = 32,
  [string[]]$Files = @()
)

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'EZNotepad\EZNotepad.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\EZNotepad\EZNotepad.exe'),
  (Join-Path $env:ProgramFiles 'EZNotepad\EZNotepad.exe')
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) {
  "EZNotepad.exe not found. Pass the path explicitly or install it first."
  exit 1
}

$base = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-sandbox'
if ($BudgetMB -gt 0) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "$base --force-gpu-mem-available-mb=$BudgetMB"
  "GPU tile budget capped at $BudgetMB MB"
} else {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $base
  "baseline: no tile budget cap"
}

if ($Files.Count -gt 0) {
  Start-Process -FilePath $exe -ArgumentList $Files
} else {
  Start-Process -FilePath $exe
}

"started: $exe"
@"

Now watch Task Manager (Details tab, sort by Working set):
  - GPU process (msedgewebview2.exe --type=gpu-process)
  - scroll a long document up and down
Compare $BudgetMB MB against -BudgetMB 0. If the GPU process no longer climbs past
the cap, the number is fixed by policy, not by our code -- and no rewrite is needed
to recover it.

If $BudgetMB changes nothing, the budget was not low enough to engage. Go lower
(half it) rather than higher -- see the measurements at the top of this file.
"@
