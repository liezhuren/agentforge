# 复算这次交付的判定（不联网、不花一分钱、不起模型）
# 用法：右键"使用 PowerShell 运行"，或在终端里  .\verify.ps1
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path "$PSScriptRoot\..\..\..")
node scripts/show-verdict.ts workspace/brief-s3
Write-Host ""
Write-Host "门禁轨迹："
node workspace/_scratch/export-gates.mjs workspace/brief-s3 -
