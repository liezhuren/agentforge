# One-command run for a REAL-LLM delivery, printing the verdict at the end.
#
# Why this script exists instead of asking you to type the node command:
# 2026-10-24 the command I handed over was
#     node .../cli-run.ts --brief (Get-Content -Raw brief.txt)
# PowerShell did not evaluate the parentheses, so the brief became the literal
# "(Get-Content" (13 chars). The engine accepted it, ran 5 gates, and reported
# "complete delivery" -- with zero lines of application code.
# Both ends are fixed now (brief pre-flight + empty-delivery gate), but the
# cheapest fix is to never put long text on a command line: this script reads
# the file itself and passes a variable.
#
# Usage:
#   .\scripts\deliver-one.ps1                       # small project, 10-20 min
#   .\scripts\deliver-one.ps1 -Name my-run
#   .\scripts\deliver-one.ps1 -BriefFile <path>     # coffee-break: workspace\_scratch\brief.txt
#   .\scripts\deliver-one.ps1 -Port 8788            # A6 probe port (default: auto-pick free port)
#
# NOTE: all console output is intentionally ASCII. Windows consoles disagree on
# encodings (GBK vs UTF-8), and a garbled status line is not worth the risk --
# the run itself is unaffected either way. Chinese comments stay for reference.

param(
  [string]$Name = "",
  [string]$BriefFile = "",
  [int]$Port = 0
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ErrorActionPreference = 'Stop'
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$root = 'E:\github\agentforge'
Set-Location $root

if ([string]::IsNullOrWhiteSpace($Name)) { $Name = "deliv-$(Get-Date -Format 'HHmmss')" }
if ([string]::IsNullOrWhiteSpace($BriefFile)) {
  $BriefFile = Join-Path $root 'workspace\_scratch\brief-small.txt'
}
if (-not (Test-Path $BriefFile)) { throw "Brief file not found: $BriefFile" }

# Read into a variable first -- never put long text on a command line.
$brief = [System.IO.File]::ReadAllText($BriefFile)
if ($brief.Trim().Length -lt 20) {
  throw "Brief file too short ($($brief.Trim().Length) chars): $BriefFile"
}

$ws = Join-Path $root "workspace\$Name"
if (Test-Path $ws) { Remove-Item -Recurse -Force $ws }

Write-Host "=== [1/3] seeding toolchain (real tsc / real tests / real probe) ===" -ForegroundColor Cyan
$preseedArgs = @('scripts/preseed-llm-workspace.ts', "workspace/$Name")
if ($Port -gt 0) { $preseedArgs += "$Port" }
& node @preseedArgs
if ($LASTEXITCODE -ne 0) { throw "Seeding failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "=== [2/3] running (real LLM; 10-20 min small project, 25-40 min coffee-break) ===" -ForegroundColor Cyan
Write-Host "brief: $BriefFile ($($brief.Length) chars)"
Write-Host ("-" * 60)
$log = Join-Path $root "workspace\course\$Name-run.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
& node packages/orchestrator/src/cli-run.ts --name $Name --brief $brief 2>&1 | Tee-Object -FilePath $log
$code = $LASTEXITCODE
Write-Host ("-" * 60)

Write-Host ""
Write-Host "=== [3/3] verdict ===" -ForegroundColor Cyan
$dec = Join-Path $ws 'decisions.jsonl'
if (-not (Test-Path $dec)) {
  Write-Host "No decision log produced -- the run may not have started. Log: $log" -ForegroundColor Red
  exit $code
}

$lines = Get-Content -Encoding utf8 $dec | ForEach-Object { $_ | ConvertFrom-Json }
$gates = $lines | Where-Object { $_.kind -eq 'gate.evaluated' }
$finished = $lines | Where-Object { $_.kind -eq 'run.finished' }

Write-Host "gates: $($gates.Count)"
foreach ($g in $gates) {
  $p = $g.payload
  $a = ($p.anchors | ForEach-Object { "$($_.id):$($_.verdict)" }) -join ' '
  Write-Host ("  {0,-12} seq{1}  {2}  -> {3}" -f $p.stage, $p.sequence, $a, $p.nextAction.kind)
}

if ($finished) {
  $p = $finished[0].payload
  Write-Host ""
  Write-Host "final stage: $($p.stage)   delivery: $($p.delivery)   techDebt: $($p.techDebt)" -ForegroundColor Green
  if ($p.delivery -eq 'complete') {
    Write-Host "==> COMPLETE DELIVERY (mechanical axis passed)" -ForegroundColor Green
  } else {
    Write-Host "==> NOT a complete delivery: $($p.delivery)" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "Requirement verdicts (two-axis):"
  Write-Host "  node scripts/show-verdict.ts $ws"
} else {
  Write-Host ""
  Write-Host "Run did NOT finish normally (no run.finished)" -ForegroundColor Yellow
  $hb = Join-Path $ws '.agentforge\heartbeat.json'
  if (Test-Path $hb) { Write-Host "last heartbeat: $((Get-Content -Encoding utf8 $hb -Raw).Trim())" }
  $abort = Select-String -Path $dec -Pattern 'run.aborted' -Quiet
  Write-Host "run.aborted = $abort  (false + no run.finished = hard-killed)"
  Write-Host "Tip: a hard kill means the process died with its parent session."
  Write-Host "     Running this script in YOUR OWN terminal avoids that."
}

Write-Host ""
Write-Host "Next:"
Write-Host "  node scripts/run-progress.ts workspace/$Name"
Write-Host "  node workspace/_scratch/export-gates.mjs workspace/$Name out.txt"
exit $code
