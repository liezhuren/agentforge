# 一条命令跑完一次真实 LLM 交付，并把结论打出来。
#
# 为什么要有这个脚本（而不是让你手敲 node 命令）：
# 2026-10-24 我给的那条命令是
#     node .../cli-run.ts --brief (Get-Content -Raw brief.txt)
# PowerShell 没把括号当表达式，brief 变成字面量 "(Get-Content"（13 字符）。
# 系统当时接受了它，跑完 5 个门禁报「完整交付」，而一行业务代码都没有。
# 那个坑现在两端都补了（诉求 pre-flight + 空交付闸门），
# 但**更省事的做法**是不再把长文本塞进命令行 —— 这个脚本自己读文件、自己传变量。
#
# 用法：
#   .\scripts\deliver-one.ps1                        # 默认跑小项目（10-15 分钟）
#   .\scripts\deliver-one.ps1 -Name my-run           # 指定 run 名字
#   .\scripts\deliver-one.ps1 -BriefFile <路径>      # 换一份诉求
#
# 输出：结束时会打印「是否完整交付 / 需求达成几条 / 每关锚点 / 下一步看什么」。

param(
  [string]$Name = "deliv-$(Get-Date -Format 'HHmmss')",
  [string]$BriefFile = "",
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$root = 'E:\github\agentforge'
Set-Location $root

if ([string]::IsNullOrWhiteSpace($BriefFile)) {
  $BriefFile = Join-Path $root 'workspace\_scratch\brief-small.txt'
}
if (-not (Test-Path $BriefFile)) {
  throw "找不到诉求文件：$BriefFile"
}

# 关键：先读成变量，再传给 node —— 绝不把长文本写进命令行
$brief = [System.IO.File]::ReadAllText($BriefFile)
if ($brief.Trim().Length -lt 20) {
  throw "诉求文件内容过短（$($brief.Trim().Length) 字符），请检查 $BriefFile"
}

$ws = Join-Path $root "workspace\$Name"
if (Test-Path $ws) { Remove-Item -Recurse -Force $ws }

Write-Host "=== 1/3 预置工具链（真 tsc / 真测试 / 真探针）===" -ForegroundColor Cyan
$preseedArgs = @('scripts/preseed-llm-workspace.ts', "workspace/$Name")
if ($Port -gt 0) { $preseedArgs += "$Port" }
& node @preseedArgs
if ($LASTEXITCODE -ne 0) { throw "预置失败（退出码 $LASTEXITCODE）" }

Write-Host ""
Write-Host "=== 2/3 跑 run（真实 LLM，可能要 10-20 分钟）===" -ForegroundColor Cyan
Write-Host "诉求来源：$BriefFile（$($brief.Length) 字符）"
$log = Join-Path $root "workspace\course\$Name-run.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
& node packages/orchestrator/src/cli-run.ts --name $Name --brief $brief 2>&1 | Tee-Object -FilePath $log
$code = $LASTEXITCODE

Write-Host ""
Write-Host "=== 3/3 结论 ===" -ForegroundColor Cyan
$dec = Join-Path $ws 'decisions.jsonl'
if (-not (Test-Path $dec)) {
  Write-Host "没有产生决策日志 —— run 可能没启动成功。日志：$log" -ForegroundColor Red
  exit $code
}

$lines = Get-Content -Encoding utf8 $dec | ForEach-Object { $_ | ConvertFrom-Json }
$gates = $lines | Where-Object { $_.kind -eq 'gate.evaluated' }
$finished = $lines | Where-Object { $_.kind -eq 'run.finished' }

Write-Host "门禁轮数：$($gates.Count)"
foreach ($g in $gates) {
  $p = $g.payload
  $a = ($p.anchors | ForEach-Object { "$($_.id):$($_.verdict)" }) -join ' '
  Write-Host ("  {0,-12} seq{1}  {2}  -> {3}" -f $p.stage, $p.sequence, $a, $p.nextAction.kind)
}

if ($finished) {
  $p = $finished[0].payload
  Write-Host ""
  Write-Host "结束阶段：$($p.stage)   交付：$($p.delivery)   技术债：$($p.techDebt)" -ForegroundColor Green
  if ($p.delivery -eq 'complete') {
    Write-Host "==> 完整交付（机械轴通过）" -ForegroundColor Green
  } else {
    Write-Host "==> 带债/待人工（不是完整交付）：$($p.delivery)" -ForegroundColor Yellow
  }
} else {
  Write-Host ""
  Write-Host "本次 run 没有正常结束（没有 run.finished）" -ForegroundColor Yellow
  $hb = Join-Path $ws '.agentforge\heartbeat.json'
  if (Test-Path $hb) { Write-Host "最后心跳：$((Get-Content -Encoding utf8 $hb -Raw).Trim())" }
  $abort = Select-String -Path $dec -Pattern 'run.aborted' -Quiet
  Write-Host "run.aborted = $abort（false 且无 run.finished = 被外部硬杀）"
}

Write-Host ""
Write-Host "下一步："
Write-Host "  node scripts/run-progress.ts workspace/$Name      # 看进度与上下文审计"
Write-Host "  node workspace/_scratch/export-gates.mjs workspace/$Name out.txt   # 导出锚点轨迹"
exit $code
