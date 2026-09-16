#requires -RunAsAdministrator
<#
  .SYNOPSIS
    Web管理アプリ用のIISサイト・アプリケーションプールを構築する。

  .DESCRIPTION
    - アプリケーションプール(No Managed Code / AlwaysRunning)を作成
    - IISサイトをwebapp/フォルダを物理パスとして作成
    - サイト単位でWindows認証を有効化・匿名認証を無効化
    - data/フォルダにアプリケーションプールIDの書き込み権限を付与

    前提として IIS本体・iisnode・URL Rewrite モジュールが導入済みであること。
    導入されていない場合はエラーメッセージに従ってインストールしてから再実行する。

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

Import-Module WebAdministration -ErrorAction SilentlyContinue
if (-not (Get-Module WebAdministration)) {
    Write-Host "[エラー] WebAdministrationモジュールが見つかりません。" -ForegroundColor Red
    Write-Host "        IISの役割（Webサーバー(IIS) > Webサーバー > セキュリティ > Windows認証 を含む）が" -ForegroundColor Red
    Write-Host "        インストールされているか確認してください。" -ForegroundColor Red
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
