#requires -RunAsAdministrator
<#
  .SYNOPSIS
    実行エンジンをWindowsタスクスケジューラへ登録する。

  .DESCRIPTION
    指定した実行ユーザーで node engine/dist/run.js を一定間隔ごとに実行するタスクを作成する。
    実行ユーザーは、事前にGitHub Copilot CLIへログイン済み・対象Gitリポジトリへの
    プッシュ用認証情報（Git Credential Manager等）を保存済みであることが前提
    （docs/design/detailed-design.md の「実行環境の前提」を参照）。

    MultipleInstances を IgnoreNew にしているため、前回の実行が終わっていない間は
    タスクスケジューラ自身が次の起動をスキップする（エンジン内部の排他制御と二重の安全策）。

  .PARAMETER RepoRoot
    リポジトリのルートパス（既定: このスクリプトの1つ上の階層）

  .PARAMETER TaskUser
    タスクを実行するWindowsユーザー（例: DOMAIN\svc-devloop）

  .PARAMETER IntervalMinutes
    起動間隔（分）

  .PARAMETER TaskName
    登録するタスク名
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [Parameter(Mandatory = $true)][string]$TaskUser,
    [int]$IntervalMinutes = 30,
    [string]$TaskName = "DevLoopEngine"
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

$engineDir = Join-Path $RepoRoot "engine"
$engineEntry = Join-Path $engineDir "dist\run.js"
if (-not (Test-Path $engineEntry)) {
    Write-Host "[エラー] $engineEntry が見つかりません。先に「npm install && npm run build」を実行してください。" -ForegroundColor Red
    exit 1
}

$configPath = Join-Path $RepoRoot "config\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "[警告] config\config.json がまだありません。config\config.example.json をコピーして編集してください。" -ForegroundColor Yellow
}

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[エラー] node.exe が見つかりません（PATHを確認してください）。" -ForegroundColor Red
    exit 1
}

Write-Host "実行ユーザー '$TaskUser' のパスワードを入力してください。"
Write-Host "（このユーザーであらかじめ GitHub Copilot CLI へのログイン、Gitの認証情報の保存を済ませておくこと）"
$cred = Get-Credential -UserName $TaskUser -Message "タスクスケジューラの実行ユーザー"

$action = New-ScheduledTaskAction -Execute $nodeCmd.Source -Argument "`"$engineEntry`"" -WorkingDirectory $engineDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "既存のタスク '$TaskName' を削除して作り直します。"
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest | Out-Null

Write-Host ""
Write-Host "===================================================================" -ForegroundColor Green
Write-Host " タスク '$TaskName' を登録しました。" -ForegroundColor Green
Write-Host "   実行ユーザー: $($cred.UserName)"
Write-Host "   起動間隔    : $IntervalMinutes 分"
Write-Host "   実行コマンド: node $engineEntry"
Write-Host ""
Write-Host " タスクスケジューラを開き、対象タスクを右クリック→実行 で単体動作を確認してください。" -ForegroundColor Green
Write-Host " 実行結果は data\logs\ 以下のログ、またはWeb管理アプリの画面から確認できます。" -ForegroundColor Green
Write-Host "===================================================================" -ForegroundColor Green
