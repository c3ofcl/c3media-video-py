#!/bin/bash
# C3動画編集を起動する(Mac用)。Finderでダブルクリックするとターミナルが開いて実行される。
# 初回だけ、プロジェクト内に仮想環境(.venv)を作って必要なパッケージを入れる。
cd "$(dirname "$0")" || exit 1

# macOSはAirPlayレシーバーがポート5000を使っているため、5001で起動する
PORT=5001
URL="http://127.0.0.1:$PORT"

# Finderから起動するとHomebrewの場所がPATHに入っていないことがあるため足す
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() {
  echo ""
  echo "$1"
  read -r -p "Enterキーを押すと閉じます"
  exit 1
}

command -v python3 > /dev/null || fail "Python 3が見つかりません。https://www.python.org/downloads/ からインストールしてください。"
command -v ffmpeg > /dev/null || fail "ffmpegが見つかりません。ターミナルで brew install ffmpeg を実行してインストールしてください。"

if [ ! -x ".venv/bin/python" ]; then
  echo "初回のセットアップをしています(数分かかります)..."
  python3 -m venv .venv || fail "仮想環境(.venv)を作れませんでした。"
  .venv/bin/python -m pip install -r requirements.txt || {
    rm -rf .venv
    fail "パッケージのインストールに失敗しました。ネット接続を確認して、もう一度ダブルクリックしてください。"
  }
fi

if lsof -nP -iTCP:$PORT -sTCP:LISTEN > /dev/null 2>&1; then
  fail "ポート$PORTが使用中のため起動できません。ほかのウィンドウやアカウントでサーバーが動いていないか確認してください。"
fi

echo "サーバーを起動しています。終了するときは、このウィンドウで Ctrl+C を押すか、ウィンドウを閉じてください。"
# サーバーが立ち上がるのを少し待ってからブラウザを開く
(sleep 4; open "$URL") &
PORT=$PORT .venv/bin/python app.py
