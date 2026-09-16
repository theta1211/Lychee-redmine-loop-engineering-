#requires -RunAsAdministrator
<#
  .SYNOPSIS
    Web管理アプリ用のIISサイト・アプリケーションプールを構築する。

  .DESCRIPTION
    Windows 11(Pro/Enterprise/Education)を対象とする。Home エディションはIIS自体が
    提供されないため、この時点で明示的にエラーにする。

    - IISに必要なWindowsのオプション機能（Windows認証を含む）を有効化
      （Enable-WindowsOptionalFeature。Windows Serverの「役割と機能の追加」に相当する、
      クライアントSKU向けの操作）
    - アプリケーションプール(No Managed Code / AlwaysRunning)を作成
    - IISサイトをwebapp/フォルダを物理パスとして作成
    - サイト単位でWindows認証を有効化・匿名認証を無効化
    - data/フォルダにアプリケーションプールIDの書き込み権限を付与

    iisnode・URL Rewrite モジュールはWindowsのオプション機能ではなく別配布のMSIのため、
    このスクリプトでは自動導入しない（導入されていない場合は警告のみ表示する）。

  .PARAMETER Port
    サイトが待ち受けるポート番号（既定: 8080）

  .PARAMETER RepoRoot
    リポジトリのルートパス（既定: このスクリプトの1つ上の階層）

  .PARAMETER SiteName
    作成するIISサイト名

  .PARAMETER AppPoolName
    作成するアプリケーションプール名
#>
[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$SiteName = "DevLoopWebApp",
    [string]$AppPoolName = "DevLoopAppPool"
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-Host "[エラー] 管理者権限のPowerShellから実行してください。" -ForegroundColor Red
    exit 1
}

# --- Windows 11に必要なIIS関連オプション機能を有効化する ---
# Windows ServerのInstall-WindowsFeature（ServerManagerモジュール）はクライアントSKUには
# 存在しないため、クライアント向けのEnable-WindowsOptionalFeatureを使う。
$requiredFeatures = @(
    "IIS-WebServerRole",
    "IIS-WebServer",
    "IIS-CommonHttpFeatures",
    "IIS-HttpErrors",
    "IIS-StaticContent",
    "IIS-DefaultDocument",
    "IIS-HttpLogging",
    "IIS-RequestFiltering",
    "IIS-Security",
    "IIS-WindowsAuthentication",
    "IIS-ApplicationDevelopment",
    "IIS-ISAPIExtensions",
    "IIS-ISAPIFilter",
    "IIS-ManagementConsole",
    "IIS-ManagementScriptingTools"
)

Write-Host "--- Windowsのオプション機能(IIS)を確認しています ---"
$missing = @()
foreach ($feature in $requiredFeatures) {
    $state = Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction SilentlyContinue
    if (-not $state) {
        $missing += $feature
    } elseif ($state.State -ne "Enabled") {
        $missing += $feature
    }
}

if ($missing.Count -gt 0) {
    # IIS-WebServerRole自体が見つからない = このエディションにIISが存在しない
    # (Windows 11 Home はIISを提供しない)
    $roleAvailable = Get-WindowsOptionalFeature -Online -FeatureName "IIS-WebServerRole" -ErrorAction SilentlyContinue
    if (-not $roleAvailable) {
        Write-Host "[エラー] このWindowsエディションにはIISが含まれていません。" -ForegroundColor Red
        Write-Host "        Windows 11 Home はIISをサポートしません。Pro/Enterprise/Educationが必要です。" -ForegroundColor Red
        exit 1
    }

    Write-Host "未有効化の機能を有効化します: $($missing -join ', ')"
    Enable-WindowsOptionalFeature -Online -FeatureName $missing -All -NoRestart | Out-Null
    Write-Host "IIS関連機能を有効化しました。" -ForegroundColor Green
    Write-Host "初回導入の場合、Windowsの再起動が必要になることがあります。" -ForegroundColor Yellow
    Write-Host "再起動が必要な場合は、再起動後にこのスクリプトを再実行してください。" -ForegroundColor Yellow
} else {
    Write-Host "必要なIIS機能はすべて有効化済みです。"
}

Import-Module WebAdministration -ErrorAction SilentlyContinue
if (-not (Get-Module WebAdministration)) {
    Write-Host "[エラー] WebAdministrationモジュールを読み込めません。" -ForegroundColor Red
    Write-Host "        直前に機能を有効化した場合はWindowsを再起動してから再実行してください。" -ForegroundColor Red
    exit 1
}

$webappPath = Join-Path $RepoRoot "webapp"
$serverJs = Join-Path $webappPath "dist\server.js"
if (-not (Test-Path $serverJs)) {
    Write-Host "[エラー] $serverJs が見つかりません。先に「npm install && npm run build」を実行してください。" -ForegroundColor Red
    exit 1
}

$webConfig = Join-Path $webappPath "web.config"
if (-not (Test-Path $webConfig)) {
    Write-Host "[エラー] $webConfig が見つかりません。リポジトリのwebapp/web.configが欠落しています。" -ForegroundColor Red
    exit 1
}

# --- iisnodeモジュールの存在確認（未導入でも致命的ではないが警告する） ---
$iisnodeInstalled = Test-Path "$env:ProgramFiles\iisnode" -PathType Container
if (-not $iisnodeInstalled) {
    Write-Host "[警告] iisnodeが見つかりません。https://github.com/Azure/iisnode/releases から" -ForegroundColor Yellow
    Write-Host "        該当バージョン（x64等）をインストールしてから、このサイトへアクセスしてください。" -ForegroundColor Yellow
}

# --- アプリケーションプール ---
if (-not (Test-Path "IIS:\AppPools\$AppPoolName")) {
    New-WebAppPool -Name $AppPoolName | Out-Null
    Write-Host "アプリケーションプール '$AppPoolName' を作成しました。"
} else {
    Write-Host "アプリケーションプール '$AppPoolName' は既に存在するため再利用します。"
}
Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name managedRuntimeVersion -Value ""
Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name startMode -Value "AlwaysRunning"

# --- サイト ---
if (-not (Test-Path "IIS:\Sites\$SiteName")) {
    New-Website -Name $SiteName -PhysicalPath $webappPath -ApplicationPool $AppPoolName -Port $Port | Out-Null
    Write-Host "サイト '$SiteName' をポート $Port ・物理パス $webappPath で作成しました。"
} else {
    Write-Host "サイト '$SiteName' は既に存在するため、物理パス・ポートは変更していません。"
}

# --- Windows認証を有効化、匿名認証を無効化（web.configにも同設定があるが、サイト単位でも明示する） ---
Set-WebConfigurationProperty -Filter "/system.webServer/security/authentication/windowsAuthentication" `
    -Name enabled -Value $true -PSPath "IIS:\Sites\$SiteName"
Set-WebConfigurationProperty -Filter "/system.webServer/security/authentication/anonymousAuthentication" `
    -Name enabled -Value $false -PSPath "IIS:\Sites\$SiteName"
Write-Host "Windows認証を有効化し、匿名認証を無効化しました。"

# --- data フォルダをアプリケーションプールIDが読み書きできるようにする ---
$dataPath = Join-Path $RepoRoot "data"
if (-not (Test-Path $dataPath)) { New-Item -ItemType Directory -Path $dataPath | Out-Null }
if (-not (Test-Path (Join-Path $dataPath "logs"))) { New-Item -ItemType Directory -Path (Join-Path $dataPath "logs") | Out-Null }
$identity = "IIS AppPool\$AppPoolName"
& icacls $dataPath /grant "${identity}:(OI)(CI)M" /T | Out-Null
Write-Host "data フォルダに $identity の変更権限を付与しました。"

Write-Host ""
Write-Host "===================================================================" -ForegroundColor Green
Write-Host " IISセットアップが完了しました。" -ForegroundColor Green
Write-Host " http://localhost:$Port/ にアクセスして画面が表示されるか確認してください。" -ForegroundColor Green
Write-Host " ブラウザで /api/whoami を開き、自分のWindowsアカウント名が返ることを確認してください。" -ForegroundColor Green
Write-Host "===================================================================" -ForegroundColor Green
