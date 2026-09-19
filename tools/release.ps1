# 一键发布脚本：提交代码 → 推送到 GitHub → 创建 Release
#
# 前置条件：
#   1. 已安装 GitHub CLI（gh）
#   2. 已执行 gh auth login 完成登录
#
# 用法：
#   tools\release.ps1                          # 提交并推送 + 按 package.json 版本创建 Release
#   tools\release.ps1 -Message "fix: xxx"      # 自定义提交信息
#   tools\release.ps1 -SkipPush                # 只提交，不推送
#   tools\release.ps1 -SkipRelease             # 推送但不创建 Release
#   tools\release.ps1 -DryRun                  # 只打印将要执行的操作
param(
  [string]$Repo = 'Hazellol/Re-Dreaming_Angels_DesktopPet',
  [string]$Message = '',
  [switch]$SkipPush,
  [switch]$SkipRelease,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Write-Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Find-Gh {
  $cands = @("$env:ProgramFiles\GitHub CLI\gh.exe", "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe",
             (Get-Command gh -ErrorAction SilentlyContinue).Source)
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  throw '未找到 GitHub CLI，请先安装：winget install --id GitHub.cli'
}
$gh = Find-Gh
$projRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projRoot

# ---------- 0. 环境检查 ----------
Write-Step '环境检查'
if (-not $DryRun) {
  $status = & $gh auth status 2>&1 | Out-String
  if ($status -notmatch 'Logged in') {
    Write-Host '尚未登录 GitHub，请先执行：gh auth login --hostname github.com --git-protocol https --web' -ForegroundColor Yellow
    exit 1
  }
  Write-Host 'GitHub 登录状态：正常'
}

$pkg = Get-Content (Join-Path $projRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"
Write-Host "项目：$($pkg.name)　版本：$version　标签：$tag"

# ---------- 1. 配置 remote 与 git 凭据 ----------
Write-Step '配置远程仓库'
$remote = ''
$prevEap2 = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $remote = (git remote get-url origin 2>$null) } catch { $remote = '' }
$ErrorActionPreference = $prevEap2
if (-not $remote) {
  $url = "https://github.com/$Repo.git"
  if ($DryRun) { Write-Host "[DryRun] git remote add origin $url" } else { git remote add origin $url; Write-Host "已添加远程仓库：$url" }
} else {
  Write-Host "当前远程仓库：$remote"
}
if (-not $DryRun) {
  # 让 git 使用 gh 的凭据（避免重复输入用户名密码）
  & $gh auth setup-git 2>$null | Out-Null
  Write-Host 'git 凭据已配置（使用 gh 登录信息）'
}

# ---------- 2. 提交 ----------
Write-Step '提交代码'
$changes = git status --porcelain
if (-not $changes) {
  Write-Host '工作区无改动，跳过提交'
} else {
  $count = ($changes -split "`n" | Where-Object { $_.Trim() }).Count
  Write-Host "检测到 $count 项改动"
  if (-not $Message) { $Message = "release: v$version" }
  if ($DryRun) {
    Write-Host "[DryRun] git add -A && git commit -m `"$Message`""
  } else {
    git add -A
    git commit -m $Message | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'git commit 失败' }
  }
}

# ---------- 3. 推送 ----------
if ($SkipPush) {
  Write-Host "`n已跳过推送（-SkipPush）"
} else {
  Write-Step '推送到 GitHub'
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($DryRun) {
    Write-Host "[DryRun] git push -u origin $branch"
  } else {
    git push -u origin $branch
    if ($LASTEXITCODE -ne 0) { throw 'git push 失败（请检查网络或凭据）' }
    Write-Host "已推送分支：$branch"
  }
}

# ---------- 4. 创建 Release（发布说明取自 CHANGELOG.md） ----------
if ($SkipRelease) {
  Write-Host "`n已跳过创建 Release（-SkipRelease）"
  exit 0
}
Write-Step "创建 Release $tag"

$changelog = Join-Path $projRoot 'CHANGELOG.md'
$notes = ''
if (Test-Path $changelog) {
  $text = Get-Content $changelog -Raw -Encoding UTF8
  $pattern = "(?s)##\s*\[$([regex]::Escape($version))\][^\n]*\n(.*?)(?=\n##\s*\[|\z)"
  $m = [regex]::Match($text, $pattern)
  if ($m.Success) { $notes = $m.Groups[1].Value.Trim() }
}
if (-not $notes) { $notes = "版本 $version" }
Write-Host '发布说明（取自 CHANGELOG.md）：'
Write-Host ('-' * 60)
Write-Host $notes
Write-Host ('-' * 60)

if ($DryRun) {
  Write-Host "[DryRun] gh release create $tag --repo $Repo --title `"$tag`" --notes <上方内容>"
  exit 0
}

# 已存在同名 release → 删除后重建
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$view = & $gh release view $tag --repo $Repo 2>&1 | Out-String
$viewCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($viewCode -eq 0) {
  Write-Host "Release $tag 已存在，将删除后重建" -ForegroundColor Yellow
  $ErrorActionPreference = 'Continue'
  & $gh release delete $tag --repo $Repo --yes --cleanup-tag 2>&1 | Out-Null
  $ErrorActionPreference = $prevEap
}

$notesFile = Join-Path $env:TEMP "release_notes_$version.md"
[System.IO.File]::WriteAllText($notesFile, $notes, [System.Text.UTF8Encoding]::new($false))
$ErrorActionPreference = 'Continue'
& $gh release create $tag --repo $Repo --title "妄想天使桌宠 $tag" --notes-file $notesFile
$createCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
Remove-Item $notesFile -Force -ErrorAction SilentlyContinue

if ($createCode -ne 0) { throw "Release 创建失败（退出码 $createCode）" }
Write-Host "`n发布完成：https://github.com/$Repo/releases/tag/$tag" -ForegroundColor Green
