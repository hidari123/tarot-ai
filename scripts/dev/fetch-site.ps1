#!/usr/bin/env pwsh
# 诊断：抓取竞品站点（走系统代理）
#
# ⚠️ 用法：pwsh -File scripts/dev/fetch-site.ps1 <url> [maxChars]
# ⚠️ 为什么单独写脚本：web_fetch 对这些域名做 fake-ip 校验会拒绝，
#    而 Node 的 fetch 不走系统代理 —— 只有 PowerShell 的 Invoke-WebRequest
#    走系统代理且能通过 fake-ip。

param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$MaxChars = 4000
)

$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

try {
  $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30 `
       -MaximumRedirection 5 -UserAgent $UA `
       -Headers @{
         "Accept-Language" = "en-US,en;q=0.9,zh-CN;q=0.8"
         # ⚠️ Accept 头是必须的：代理的 MIME 嗅探在没有它时会返回 502
         #   （实测 tarotoo / tarot.run 缺这个头就失败，加上就 200）
         "Accept" = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
       }
} catch {
  Write-Output "FETCH-FAIL: $($_.Exception.Message.Split("`n")[0])"
  exit 1
}

$html = $r.Content
Write-Output "HTTP $($r.StatusCode) | $($html.Length) bytes | $($r.BaseResponse.ResponseUri)"
Write-Output "====="

# 标题与描述
if ($html -match "<title[^>]*>(.*?)</title>") { Write-Output "TITLE: $($Matches[1].Trim())" }
if ($html -match 'name="description"\s+content="([^"]*)"') { Write-Output "DESC: $($Matches[1])" }
if ($html -match 'property="og:description"\s+content="([^"]*)"') { Write-Output "OG: $($Matches[1])" }
Write-Output "====="

# 可见文本
$t = $html -replace '(?s)<script.*?</script>', '' -replace '(?s)<style.*?</style>', '' -replace '(?s)<!--.*?-->', ''
$t = $t -replace '<[^>]+>', ' ' -replace '&nbsp;', ' ' -replace '&#x27;', "'" -replace '&amp;', '&' -replace '&quot;', '"' -replace '\s+', ' '
Write-Output $t.Substring(0, [Math]::Min($MaxChars, $t.Length))
Write-Output ""
Write-Output "===== LINKS ====="
[regex]::Matches($html, 'href="(/[^"#?]*)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique -First 40
