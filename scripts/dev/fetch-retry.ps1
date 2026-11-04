#!/usr/bin/env pwsh
# 诊断：带重试的竞品抓取（代理连接是间歇性的）
#
# ⚠️ 用法：powershell.exe -ExecutionPolicy Bypass -File scripts/dev/fetch-retry.ps1 -Url "..." -Tries 4

param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$Tries = 4,
  [int]$MaxChars = 3000
)

$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
$r = $null

for ($i = 1; $i -le $Tries; $i++) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30 `
         -MaximumRedirection 5 -UserAgent $UA `
         -Headers @{ "Accept" = "text/html" }
    if ($r.StatusCode -eq 200 -and $r.RawContentLength -gt 500) { break }
  } catch {
    Write-Host "  attempt $i failed: $($_.Exception.Message.Split("`n")[0])" -ForegroundColor DarkGray
    # ⚠️ 关掉连接池，避免复用坏连接
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    Start-Sleep -Milliseconds (700 * $i)
  }
}

if (-not $r) { Write-Output "FETCH-FAIL after $Tries tries"; exit 1 }

$html = $r.Content
Write-Output "HTTP $($r.StatusCode) | $($html.Length) bytes"
Write-Output "====="
if ($html -match "<title[^>]*>(.*?)</title>") { Write-Output "TITLE: $($Matches[1].Trim())" }
if ($html -match 'name="description"\s+content="([^"]*)"') { Write-Output "DESC: $($Matches[1])" }
if ($html -match 'property="og:description"\s+content="([^"]*)"') { Write-Output "OG: $($Matches[1])" }
Write-Output "====="

$t = $html -replace '(?s)<script.*?</script>', '' -replace '(?s)<style.*?</style>', '' -replace '(?s)<!--.*?-->', ''
$t = $t -replace '<[^>]+>', ' ' -replace '&nbsp;', ' ' -replace '&#x27;', "'" -replace '&amp;', '&' -replace '&quot;', '"' -replace '\s+', ' '
Write-Output $t.Substring(0, [Math]::Min($MaxChars, $t.Length))
Write-Output ""
Write-Output "===== LINKS ====="
[regex]::Matches($html, 'href="(/[^"#?]*)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique -First 40
