@echo off
chcp 65001 > nul
rem C3動画編集を起動する。どのアカウントからでも使えるよう、
rem プロジェクト内の仮想環境(.venv)のPythonと、C:\直下のffmpegを使う。
cd /d "%~dp0"

rem ffmpegのPATHはこのウィンドウの中だけに足す(アカウントの設定は変えない)
set "PATH=C:\ffmpeg-7.1.1-essentials_build\bin;%PATH%"

if not exist ".venv\Scripts\python.exe" (
  echo 仮想環境^(.venv^)が見つかりません。セットアップをやり直してください。
  pause
  exit /b 1
)

netstat -ano | findstr ":5000 " | findstr "LISTENING" > nul
if not errorlevel 1 (
  echo ポート5000が使用中のため起動できません。
  echo ほかのアカウントやウィンドウでサーバーが動いていないか確認してください。
  pause
  exit /b 1
)

echo サーバーを起動しています。終了するときは、このウィンドウを閉じてください。
rem サーバーが立ち上がるのを少し待ってからブラウザを開く
start "" /b cmd /c "timeout /t 4 /nobreak > nul & start "" http://127.0.0.1:5000"
".venv\Scripts\python.exe" app.py
pause
