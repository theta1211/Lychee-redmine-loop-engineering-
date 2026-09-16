@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo  Redmine連携 自動開発ループ - 環境構築
echo ============================================================
echo  詳細手順は docs\setup\windows-setup.md を参照してください。
echo ============================================================
echo.

:MENU
echo  1. 前提確認 + 依存関係インストール + ビルド (npm install / build)
echo  2. config\config.json の雛形を作成して編集する
echo  3. IISサイトを構築する            [要: 管理者権限]
echo  4. タスクスケジューラへ登録する    [要: 管理者権限]
echo  5. 1〜4をすべて実行する
echo  0. 終了
echo.
set "CHOICE="
set /p CHOICE="番号を選択してください: "

if "%CHOICE%"=="1" goto BUILD
if "%CHOICE%"=="2" goto CONFIG
if "%CHOICE%"=="3" goto IIS
if "%CHOICE%"=="4" goto TASK
if "%CHOICE%"=="5" goto RUNALL
if "%CHOICE%"=="0" goto END
echo 無効な選択です。もう一度入力してください。
echo.
goto MENU

:RUNALL
set "RUNALL=1"
goto BUILD

:BUILD
echo.
echo --- 前提条件の確認 ---
where node >nul 2>&1
if errorlevel 1 (
  echo [エラー] Node.jsが見つかりません。https://nodejs.org/ からLTS版をインストールしてください。
  goto AFTER_BUILD
)
for /f "delims=" %%v in ('node -v') do echo   Node.js : %%v

where git >nul 2>&1
if errorlevel 1 (
  echo [警告] Gitが見つかりません。対象リポジトリの操作に必要です。
) else (
  for /f "delims=" %%v in ('git --version') do echo   Git     : %%v
)

where copilot >nul 2>&1
if errorlevel 1 (
  echo [警告] GitHub Copilot CLI(copilotコマンド)が見つかりません。
  echo         実行エンジンを動かすユーザーで別途インストール・ログインしてください。
) else (
  echo   GitHub Copilot CLI : 検出されました
)
echo.

echo --- npm install ---
call npm install
if errorlevel 1 (
  echo [エラー] npm install に失敗しました。
  goto AFTER_BUILD
)
echo.

echo --- npm run build ---
call npm run build
if errorlevel 1 (
  echo [エラー] npm run build に失敗しました。
  goto AFTER_BUILD
)

echo.
echo 依存関係のインストールとビルドが完了しました。

:AFTER_BUILD
if defined RUNALL goto CONFIG
goto MENU

:CONFIG
echo.
echo --- config\config.json の作成 ---
if exist "config\config.json" (
  echo config\config.json は既に存在するため作成をスキップします。
) else (
  if not exist "config\config.example.json" (
    echo [エラー] config\config.example.json が見つかりません。
    goto AFTER_CONFIG
  )
  copy /y "config\config.example.json" "config\config.json" >nul
  echo config\config.json を雛形から作成しました。以下を編集してください：
  echo   - redmine.url / redmine.apiKey  （既存Redmineの接続情報）
  echo   - git.repoPath                  （実装対象リポジトリのローカルパス）
  echo   - dataDir                       （既定 .\data のままで通常は問題ありません）
  echo.
  echo メモ帳で開きます。保存して閉じたら続行してください。
  notepad "config\config.json"
)

:AFTER_CONFIG
if defined RUNALL goto IIS
goto MENU

:IIS
echo.
echo --- IISサイトの構築 ---
echo ※ IIS本体・iisnode・URL Rewriteモジュールが導入済みで、
echo    このウィンドウ自体が管理者権限で実行されている必要があります。
if not exist "webapp\dist\server.js" (
  echo [エラー] webapp\dist\server.js が見つかりません。先に「1」でビルドしてください。
  goto AFTER_IIS
)
set "SITEPORT="
set /p SITEPORT="待受ポート番号 (既定: 8080、Enterで既定値): "
if "%SITEPORT%"=="" set "SITEPORT=8080"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-iis.ps1" -Port %SITEPORT% -RepoRoot "%~dp0"
if errorlevel 1 (
  echo [エラー] IISセットアップに失敗しました。管理者権限で実行しているか確認してください。
)

:AFTER_IIS
if defined RUNALL goto TASK
goto MENU

:TASK
echo.
echo --- タスクスケジューラへの登録 ---
echo ※ このウィンドウ自体が管理者権限で実行されている必要があります。
echo    実行ユーザーは、事前にGitHub Copilot CLIへのログインとGitの認証情報の保存を
echo    済ませた専用ユーザーを指定してください（例: DOMAIN\svc-devloop）。
if not exist "engine\dist\run.js" (
  echo [エラー] engine\dist\run.js が見つかりません。先に「1」でビルドしてください。
  goto AFTER_TASK
)
set "TASKUSER="
set /p TASKUSER="実行ユーザー (例: DOMAIN\svc-devloop): "
if "%TASKUSER%"=="" (
  echo 実行ユーザーが未入力のため中止しました。
  goto AFTER_TASK
)
set "INTERVAL="
set /p INTERVAL="起動間隔（分, Enterで既定30分）: "
if "%INTERVAL%"=="" set "INTERVAL=30"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-task.ps1" -RepoRoot "%~dp0" -TaskUser "%TASKUSER%" -IntervalMinutes %INTERVAL%
if errorlevel 1 (
  echo [エラー] タスク登録に失敗しました。管理者権限で実行しているか確認してください。
)

:AFTER_TASK
goto MENU

:END
echo.
echo 終了します。
endlocal
exit /b 0
