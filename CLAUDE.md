# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要
ブラウザ上で動く、ローカル実行前提のマルチトラック動画・音声エディタ（プロトタイプ）。バックエンドは Flask、フロントエンドは単一の Vanilla JS ファイル（バンドラー・フレームワーク・ビルド工程なし）。コードのコメント、UI の文言、エラーメッセージはすべて日本語なので、新しく書くものも日本語に揃えること。

## コマンド
- インストール: `pip install -r requirements.txt`（**ffmpeg** が PATH 上に必要。pydub と moviepy が内部で呼び出す）
- 起動: `python app.py` → http://127.0.0.1:5000（debug=True, threaded=True。Python の変更は Flask が自動リロードし、JS/CSS の変更はブラウザの再読み込みで反映される）
- テスト、リンター、フォーマッターは設定されていない。
- 任意: `.env` に `MAGIC_HOUR_API_KEY` を記入する（`.env.example` 参照）。アプリの「⚙ 設定」パネルから実行中に設定することもでき、その場合は `POST /api/settings/magic-hour-key` 経由で `.env` に書き込まれる。AI 機能の呼び出しは Magic Hour の実クレジットを消費する。

## アーキテクチャ

**編集は非破壊で、すべてブラウザ側で管理している。** サーバーがやることは次の 2 つだけ。(a) アップロードされた素材や AI 生成素材を `uploads/` に `<uuid hex>.<ext>` として保存し、素材のメタデータを返す。(b) `POST /api/export` で受け取ったクリップ情報のフラットなリストから最終出力を書き出す。タイムラインの状態はサーバー側に一切保存されないので、ページを再読み込みするとプロジェクトは失われる。

**素材レスポンスの形式**（`app.py` の `_build_{image,video,audio}_asset_response`）は `/api/upload` とすべての `/api/ai/*` エンドポイントで共通: `{id, ext, kind, filename, url, duration, maxDuration, width?, height?}`。フロントエンドは `addTrackFromAssetResponse`（`static/script.js`）でこれをクリップに変換する。画像には元の長さがないため、`duration=5秒`、`maxDuration=600秒` が与えられる。

**クリップのモデル**（フロントエンドの `state.tracks[].clips[]`）: `trimStart`/`trimEnd` は元ファイル内での位置（秒）、`timelineStart` はタイムライン上の開始位置、`srcDuration` は右トリムハンドルで伸ばせる上限。種類は `audio | image | video | text`。テキストクリップは `fileId`/`ext` を持たず、代わりに `text`、`fontKey`、`fontSize`、`position {x,y}`（中心点の相対座標 0〜1）を持つ。書き出しリクエストの形式は `app.py` の `export()` の docstring に記載されている。

**トラック**: 2 種類ある。`media`（アップロードや AI 生成で作られ、空になると自動で消える）と `overlay`（ユーザーが作成し、空になっても残る）。どの種類のクリップもどのトラックにも置け、トラックをまたいだドラッグ移動もできる。`state.tracks` の並び順 = 画面上の並び順 = 重なり順（後ろのトラックほど手前に描画される）。media トラックは最初の overlay の手前に挿入される。

**書き出し**（`app.py`）:
- 音声（wav/mp3）: `build_audio_segments` が音声クリップと動画クリップに埋め込まれた音声を集め、`mix_audio_segments` がすべてを最大のサンプリングレートに揃えてから無音の上に重ねる。
- 動画（mp4）: 1280×720・30fps 固定の黒キャンバス上に moviepy の `CompositeVideoClip` で合成する。画像・動画クリップは `_fit_and_place` でレターボックス配置し、テキストクリップはトラックに関係なく常に最前面に置く。ミックスした音声を付けて書き出す。再生互換性のため `-movflags +faststart -pix_fmt yuv420p` を指定してエンコードしている。
- 出力は `exports/` に保存される。フロントエンドはそれをダウンロードした後、`DELETE /api/exports/<name>` を呼んで削除する。

**プレビュー／再生**（フロントエンド）: 音声クリップは Web Audio API で再生し、再生ヘッド位置の画像・動画フレームとテキストは `<canvas>` に描画する（`updatePreview`）。動画クリップに埋め込まれた音声はプレビューでは意図的に再生しない（書き出しには含まれる）。

**Magic Hour**（`magic_hour_client.py`）: `requests` を直接使った薄いラッパー（公式 SDK はモデル一覧がドキュメントより古かったため、意図的に使っていない）。どの呼び出しも「アップロード URL 取得 → 素材を PUT → ジョブ作成 → `/v1/{image,video}-projects/{id}` をポーリング → 結果をダウンロード」という流れ。エンドポイントは最大で画像 3 分、動画 8 分ブロックするため、Flask を threaded で動かしている。エラーはユーザーに表示できるメッセージを付けた `MagicHourError` で送出し、ルート側で HTTP 502 に変換する。

## 同期を保つ必要があるもの
- **テキスト描画の定数とフォント**は、プレビューと書き出しの見た目を一致させるため `app.py` と `static/script.js` の両方に重複して定義されている: `FONT_REGISTRY` のキー、`DEFAULT/MIN/MAX_TEXT_FONT_SIZE`、`TEXT_MARGIN_PX`、`TEXT_MAX_WIDTH_RATIO`、`DEFAULT_TEXT_POSITION`、およびテキストの折り返し処理（`_wrap_text_to_width` と `wrapTextToWidth` の両方で 1 文字単位）。フォントを追加するときは、`static/fonts/` への TTF 配置、`style.css` への `@font-face` 追加、両方のレジストリへの登録がすべて必要。可変フォントは一部の Pillow/FreeType 環境で読み込みに失敗するため、静的な TTF を使うこと（`static/fonts/README.md` 参照）。
- `script.js` の `PX_PER_SEC` は `style.css` の `--px-per-sec` と一致させること。
- アップロードされた画像は、EXIF の向き情報をピクセルデータに焼き込んで保存し直している（`_normalize_image_orientation`）。ブラウザは EXIF を反映するが、moviepy は EXIF を無視するため。

## 規約
- API のエラーはすべて JSON `{error: "..."}` で返す。グローバルな `@app.errorhandler(Exception)` により、Werkzeug の HTML ではなく必ず JSON が返るので、フロントエンドの `res.json()` が失敗しない。
- README の「制限事項」はコードより古い場合がある（例: トラックをまたいだドラッグ移動は現在は対応済み）。
