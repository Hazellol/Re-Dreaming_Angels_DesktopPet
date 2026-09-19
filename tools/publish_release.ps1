# 一键发布 TTS 资源到 GitHub Release（推理环境包 + 三只语音包）
# 前置：已安装并登录 GitHub CLI（gh auth login）
# 用法：pwsh -File tools\publish_release.ps1 [-Repo <owner/name>] [-DryRun]
param(
  [string]$Repo = 'Hazellol/Re-Dreaming_Angels_DesktopPet',
  [string]$RuntimeTag = 'tts-runtime-v1',
  [string]$VoiceTag = 'voices-v1',
  [string]$PkgDir = 'D:\tts_pkg_out',
  [string]$VoiceDir = 'D:\tts_voice_out',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Find-Gh {
  $cands = @("$env:ProgramFiles\GitHub CLI\gh.exe", "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe",
             (Get-Command gh -ErrorAction SilentlyContinue).Source)
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  throw 'gh 未找到，请先安装 GitHub CLI'
}
$gh = Find-Gh
Write-Host "gh: $gh" -ForegroundColor Cyan

# 登录检查（DryRun 时跳过）
if (-not $DryRun) {
  $status = & $gh auth status 2>&1 | Out-String
  if ($status -notmatch 'Logged in') {
    Write-Host '尚未登录 GitHub。请先在你的终端执行：' -ForegroundColor Yellow
    Write-Host '  gh auth login --hostname github.com --git-protocol https --web' -ForegroundColor White
    Write-Host '（会显示一次性验证码 → 浏览器打开 https://github.com/login/device 粘贴即可）' -ForegroundColor Gray
    exit 1
  }
  Write-Host 'GitHub 登录正常 ✓' -ForegroundColor Green
}

# 收集文件
$runtimeFiles = @(Get-ChildItem $PkgDir -Filter 'tts-runtime-part*.zip' -ErrorAction SilentlyContinue | Sort-Object Name)
$manifest = Join-Path $PkgDir 'package-manifest.json'
if (Test-Path $manifest) { $runtimeFiles += Get-Item $manifest }
$voiceFiles = @(Get-ChildItem $VoiceDir -Filter 'tts_voices_*.zip' -ErrorAction SilentlyContinue | Sort-Object Name)

if (-not $runtimeFiles.Count) { throw "未在 $PkgDir 找到 tts-runtime-part*.zip" }
if (-not $voiceFiles.Count) { throw "未在 $VoiceDir 找到 tts_voices_*.zip" }

Write-Host "`n将发布：" -ForegroundColor Cyan
Write-Host ("  [{0}] {1} 个文件，共 {2} GB" -f $RuntimeTag, $runtimeFiles.Count, [math]::Round((($runtimeFiles | Measure-Object Length -Sum).Sum)/1GB, 2))
$runtimeFiles | ForEach-Object { Write-Host ("     - {0}  ({1} MB)" -f $_.Name, [math]::Round($_.Length/1MB,0)) -ForegroundColor Gray }
Write-Host ("  [{0}] {1} 个文件，共 {2} GB" -f $VoiceTag, $voiceFiles.Count, [math]::Round((($voiceFiles | Measure-Object Length -Sum).Sum)/1GB, 2))
$voiceFiles | ForEach-Object { Write-Host ("     - {0}  ({1} MB)" -f $_.Name, [math]::Round($_.Length/1MB,0)) -ForegroundColor Gray }

if ($DryRun) { Write-Host "`n[DryRun] 未实际上传" -ForegroundColor Yellow; exit 0 }

# 幂等：release 已存在则先删掉重传（避免 tag 冲突）
function Ensure-Release([string]$tag, [string]$title, [string]$notes, $files) {
  # ⚠️ gh 在"release 不存在"时会以非零退出码 + stderr 返回——这是**正常情况**，
  #    必须临时放宽错误策略，否则会被当成致命错误中断（实测踩过，用户环境报 release not found）。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $viewOut = (& $gh release view $tag --repo $Repo 2>&1 | Out-String)
  $viewCode = $LASTEXITCODE
  if ($viewCode -eq 0 -and $viewOut -match [regex]::Escape($tag)) {
    Write-Host "release $tag 已存在 → 删除后重建" -ForegroundColor Yellow
    & $gh release delete $tag --repo $Repo --yes --cleanup-tag 2>&1 | Out-Null
  } else {
    Write-Host "release $tag 尚不存在 → 将新建" -ForegroundColor Gray
  }
  $ErrorActionPreference = $prevEap
  Write-Host "`n==> 创建 release $tag 并上传 $($files.Count) 个文件（大文件较慢，请耐心等待）" -ForegroundColor Cyan
  $paths = $files | ForEach-Object { $_.FullName }
  $ErrorActionPreference = 'Continue'
  & $gh release create $tag @paths --repo $Repo --title $title --notes $notes
  $createCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($createCode -ne 0) { throw "release $tag 创建失败（退出码 $createCode）" }
  Write-Host "release $tag 完成 ✓" -ForegroundColor Green
}

Ensure-Release $RuntimeTag 'TTS 推理环境包 v1（v2ProPlus · 精简版）' `
  "GPT-SoVITS v2ProPlus 推理环境（精简仅推理）。解压后由桌宠「控制台 → 设置 → 语音」一键下载并自动配置（自动切换 v2ProPlus 音色配置）。" `
  $runtimeFiles

Ensure-Release $VoiceTag '三小只语音包 v1（爱芮 / 千夏 / 南宫羽）' `
  "三小只的 GPT/SoVITS 权重 + 情绪参考音频 + 情绪映射（emotions.json）。按需下载单只，桌宠会自动装到语音包目录。" `
  $voiceFiles

Write-Host "`n全部完成 🎉  验证：https://github.com/$Repo/releases" -ForegroundColor Green
