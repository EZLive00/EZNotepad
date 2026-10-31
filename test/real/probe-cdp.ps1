param([string]$Out = "D:/tmp/ez-real/cdp-probe.txt")

# Why this exists: opening the compare window from the main window's menu gives a
# blank white surface, while "exe --compare L R" renders fine. Same binary, same
# URL. The only difference is that the compare webview is then the SECOND webview
# in the process. This probe turns that into facts: it boots the app with the
# WebView2 debugging port open, drives the menu, then asks the browser which
# targets exist and what they are pointing at.

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib.ps1"

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
$lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$lines.Add([string]$s) }

try {
  $pid2 = Start-App "D:/tmp/ez-real/work/w.md"
  Say ("pid=" + $pid2)
  Start-Sleep -Milliseconds 1200

  # open the compare board through the real menu path
  $r = Uia-Menu "工具" "文本对比…"
  Say ("menu=" + $r)
  Start-Sleep -Milliseconds 4000

  Say ("wins=" + [Win32Drv]::Titles([uint32]$pid2))
  Say ("rect=" + [Win32Drv]::Status((Get-AppHwnd)))

  # every CDP target the browser knows about
  try {
    $list = Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 "http://127.0.0.1:9333/json/list"
    $arr = $list.Content | ConvertFrom-Json
    foreach ($t in $arr) {
      Say ("target " + $t.type + " | " + $t.title + " | " + $t.url + " | " + $t.id)
    }
  } catch {
    Say ("cdp-list-failed: " + $_.Exception.Message)
  }
} finally {
  try { Stop-App } catch { }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $null
  $lines -join "`r`n" | Set-Content -Encoding utf8 $Out
}
Get-Content $Out
