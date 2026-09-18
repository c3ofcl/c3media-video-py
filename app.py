"""
マルチトラック動画・音声エディタ - Flaskバックエンド

機能:
  - 複数の音声ファイル・画像ファイルのアップロード（トラック化）
    画像は「静止画を一定時間再生する動画クリップ」として扱う
  - Magic Hour API (https://docs.magichour.ai) を使ったAI生成
      - 参考画像生成 (AI Image Editor)  : 既存の画像をプロンプトで編集した新しい画像を作る
      - 画像 -> 動画生成 (Image-to-Video): 画像クリップを、そのクリップの長さ(秒)のまま
        AI動画に変換し、タイムライン上で元の画像クリップと置き換える
    生成結果はどちらも通常のアップロード素材と同じ扱いでタイムラインに追加され、
    トリミング・カット・移動・他クリップとの結合ができる。
  - タイムライン情報(開始位置・トリム範囲)に基づく書き出し
      - 音声のみ(WAV/MP3): 音声クリップ(+ 動画クリップに埋め込まれた音声)をミックスダウン
      - 動画(MP4): 画像・動画クリップを合成した映像トラックと、音声トラックを1つの動画に書き出す
    (トリミング / カット / 結合はフロントエンド側で非破壊的に管理し、
     書き出し時にpydub(音声)・moviepy(映像)で実際の処理を行う)

事前準備:
  pip install -r requirements.txt
  ffmpeg がシステムにインストールされている必要があります
    - macOS: brew install ffmpeg
    - Ubuntu/Debian: sudo apt install ffmpeg
    - Windows: https://ffmpeg.org/download.html からダウンロードしPATHに追加
  AI生成機能を使う場合は、アプリ起動後に画面右上の「⚙ 設定」からAPIキーを入力するか、
  プロジェクト直下に .env ファイルを作り
    MAGIC_HOUR_API_KEY=あなたのAPIキー
  を記入してください（.env.example を参照）。設定しなくても他の機能は使えます。

起動:
  python app.py
  ブラウザで http://127.0.0.1:5000 を開く
"""

import os
import uuid

from dotenv import load_dotenv, set_key, unset_key

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, ".env")
load_dotenv(ENV_PATH)

from flask import Flask, request, jsonify, send_from_directory, render_template
from pydub import AudioSegment
from PIL import Image, ImageOps, ImageFont
from moviepy import ImageClip, VideoFileClip, ColorClip, CompositeVideoClip, AudioFileClip, TextClip

import magic_hour_client

UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
EXPORT_DIR = os.path.join(BASE_DIR, "exports")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)

AUDIO_EXT = {"mp3", "wav", "ogg", "m4a", "flac", "aac", "wma"}
IMAGE_EXT = {"jpg", "jpeg", "png", "gif", "webp", "bmp"}
VIDEO_EXT = {"mp4", "m4v", "mov", "webm"}
ALLOWED_EXT = AUDIO_EXT | IMAGE_EXT | VIDEO_EXT
MAX_CONTENT_LENGTH = 300 * 1024 * 1024  # 300MB

# 画像クリップの初期表示秒数と、右ハンドルで伸ばせる上限秒数。
# 画像には音声のような「元の長さ」が無いため、アップロード時にこの初期値を
# trimEndの初期値として、上限をsrcDuration相当としてフロントエンドへ返す。
DEFAULT_IMAGE_DURATION_SEC = 5.0
MAX_IMAGE_DURATION_SEC = 600.0

# 動画書き出し時のキャンバスサイズ(16:9)とフレームレート。
# 各画像はアスペクト比を保ったままこのサイズに収まるよう縮小し(レターボックス)、
# 余白は黒で埋める。
VIDEO_CANVAS_SIZE = (1280, 720)
VIDEO_FPS = 30

# ---------- テキストクリップ ----------
# プレビュー(ブラウザのcanvas)と書き出し(下記TextClip)の両方で同じフォントファイルを
# 直接参照することで、見た目が食い違わないようにしている。キーはフロントエンドの
# script.js内のFONT_REGISTRYと対応しているので、増減する場合は両方を変更すること。
FONTS_DIR = os.path.join(BASE_DIR, "static", "fonts")
FONT_REGISTRY = {
    "noto-sans-jp": "NotoSansJP-Variable.ttf",
    "noto-serif-jp": "NotoSerifJP-Variable.ttf",
    "dela-gothic-one": "DelaGothicOne-Regular.ttf",
    "zen-maru-gothic": "ZenMaruGothic-Bold.ttf",
}
DEFAULT_FONT_KEY = "noto-sans-jp"
DEFAULT_TEXT_DURATION_SEC = 5.0
MAX_TEXT_DURATION_SEC = 600.0
TEXT_FONT_SIZE = 48
TEXT_MARGIN_PX = 40
TEXT_MAX_WIDTH_RATIO = 0.86  # キャンバス幅に対する、テキストボックスの最大幅の割合(はみ出し防止の折り返し用)
DEFAULT_TEXT_POSITION = (0.5, 0.82)  # プレビュー上でドラッグする前の初期位置(中心点の相対座標)


def _font_path(font_key):
    filename = FONT_REGISTRY.get(font_key) or FONT_REGISTRY[DEFAULT_FONT_KEY]
    return os.path.join(FONTS_DIR, filename)


def _text_center_xy(pos_x, pos_y, clip_w, clip_h, canvas_w, canvas_h):
    """
    pos_x, pos_y: プレビュー画面をドラッグして決めた、テキストブロック中心点の相対座標(0〜1)。
    テキストクリップの左上座標(x, y)を返す。
    """
    if pos_x is None:
        pos_x = DEFAULT_TEXT_POSITION[0]
    if pos_y is None:
        pos_y = DEFAULT_TEXT_POSITION[1]
    pos_x = max(0.0, min(1.0, float(pos_x)))
    pos_y = max(0.0, min(1.0, float(pos_y)))

    x = pos_x * canvas_w - clip_w / 2
    y = pos_y * canvas_h - clip_h / 2
    return (x, y)

if not os.environ.get("MAGIC_HOUR_API_KEY", "").strip():
    print("[情報] MAGIC_HOUR_API_KEYが未設定です。AI画像生成/動画生成機能を使う場合は、")
    print("       アプリ起動後に画面右上の「⚙ 設定」からAPIキーを入力してください。")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


def ext_kind(ext: str) -> str:
    """拡張子から "audio" / "image" / "video" を判定する"""
    ext = (ext or "").lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    return "audio"


@app.route("/")
def index():
    return render_template("index.html")


def _normalize_image_orientation(path):
    """
    スマホ等で撮った写真は、ピクセルデータ自体は横向きのまま
    EXIFのOrientationタグで「表示時に回転・反転する」向きだけが指定されている
    ことが多い。ブラウザの<img>やcanvasはこのEXIFを見て自動的に正しい向きで
    表示するが、書き出し処理で使うmoviepyのImageClipはEXIFを見ずにピクセル
    データをそのまま読み込むため、そこだけ画像が横倒しになったり、本来と違う
    向き・アスペクト比でレターボックスされてしまう(プレビューでは正しく見える
    のに、書き出した動画だけおかしくなる)。

    ここでアップロード直後にEXIFの向きをピクセルデータそのものに焼き込んで
    保存し直すことで、以降はどこで読み込んでも同じ向きになるようにする。
    """
    with Image.open(path) as img:
        fixed = ImageOps.exif_transpose(img)
        if fixed.mode in ("RGBA", "P") and path.lower().endswith((".jpg", ".jpeg")):
            fixed = fixed.convert("RGB")
        fixed.save(path)


def _build_image_asset_response(file_id, ext, path, filename):
    # PIL.Image.verify()は壊れた画像の検出用。呼び出し後はオブジェクトを
    # 使い回せない仕様のため、都度開き直す。
    with Image.open(path) as img:
        img.verify()
    _normalize_image_orientation(path)
    with Image.open(path) as img:
        width, height = img.size

    return {
        "id": file_id,
        "ext": ext,
        "kind": "image",
        "filename": filename,
        "url": f"/uploads/{file_id}.{ext}",
        "duration": DEFAULT_IMAGE_DURATION_SEC,
        "maxDuration": MAX_IMAGE_DURATION_SEC,
        "width": width,
        "height": height,
    }


def _build_video_asset_response(file_id, ext, path, filename):
    clip = VideoFileClip(path)
    try:
        duration = clip.duration
        width, height = clip.size
    finally:
        clip.close()

    return {
        "id": file_id,
        "ext": ext,
        "kind": "video",
        "filename": filename,
        "url": f"/uploads/{file_id}.{ext}",
        "duration": duration,
        "maxDuration": duration,
        "width": width,
        "height": height,
    }


def _build_audio_asset_response(file_id, ext, path, filename):
    audio = AudioSegment.from_file(path)
    duration = len(audio) / 1000.0  # 秒

    return {
        "id": file_id,
        "ext": ext,
        "kind": "audio",
        "filename": filename,
        "url": f"/uploads/{file_id}.{ext}",
        "duration": duration,
        "maxDuration": duration,
    }


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "ファイルがありません"}), 400

    f = request.files["file"]
    if f.filename == "" or not allowed_file(f.filename):
        return jsonify({"error": "対応していないファイル形式です"}), 400

    ext = f.filename.rsplit(".", 1)[1].lower()
    kind = ext_kind(ext)
    file_id = uuid.uuid4().hex
    saved_name = f"{file_id}.{ext}"
    path = os.path.join(UPLOAD_DIR, saved_name)
    f.save(path)

    try:
        if kind == "image":
            payload = _build_image_asset_response(file_id, ext, path, f.filename)
        elif kind == "video":
            payload = _build_video_asset_response(file_id, ext, path, f.filename)
        else:
            payload = _build_audio_asset_response(file_id, ext, path, f.filename)
    except Exception as e:  # noqa: BLE001
        os.remove(path)
        label = {"image": "画像", "video": "動画", "audio": "音声"}[kind]
        return jsonify({"error": f"{label}を読み込めませんでした: {e}"}), 400

    return jsonify(payload)


# ---------- Magic Hour AI生成 ----------

@app.route("/api/settings/magic-hour-key", methods=["GET"])
def get_magic_hour_key_status():
    """現在APIキーが設定されているかどうかだけを返す(キーの値自体は返さない)"""
    configured = bool(os.environ.get("MAGIC_HOUR_API_KEY", "").strip())
    return jsonify({"configured": configured})


@app.route("/api/settings/magic-hour-key", methods=["POST"])
def set_magic_hour_key():
    """
    Magic HourのAPIキーを設定/更新/削除する。実行中のプロセスにも即座に反映し(再起動不要)、
    .env ファイルにも保存して次回起動時にも引き継がれるようにする。
    リクエストJSON: { apiKey: string }  空文字列を渡すと削除
    """
    data = request.get_json(force=True, silent=True) or {}
    key = (data.get("apiKey") or "").strip()

    if key:
        os.environ["MAGIC_HOUR_API_KEY"] = key
        set_key(ENV_PATH, "MAGIC_HOUR_API_KEY", key)
    else:
        os.environ.pop("MAGIC_HOUR_API_KEY", None)
        if os.path.exists(ENV_PATH):
            unset_key(ENV_PATH, "MAGIC_HOUR_API_KEY")

    return jsonify({"ok": True, "configured": bool(key)})


@app.route("/api/ai/generate-new-image", methods=["POST"])
def ai_generate_new_image():
    """
    新規画像生成 (AI Image Generator)。AI Image Editorと違い、元になる画像は不要で
    プロンプトだけから新しい画像を生成する。何もない位置にタイムライン上のクリップとして
    追加する用途を想定しているため、通常アップロードと同じ形式のJSON(kind: "image")を返す。

    リクエストJSON: { prompt, aspectRatio? }
    """
    data = request.get_json(force=True, silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "プロンプトを入力してください"}), 400

    file_id = uuid.uuid4().hex
    out_ext = "png"
    out_path = os.path.join(UPLOAD_DIR, f"{file_id}.{out_ext}")

    try:
        magic_hour_client.generate_image(
            prompt,
            out_path,
            aspect_ratio=data.get("aspectRatio") or None,
        )
    except magic_hour_client.MagicHourError as e:
        return jsonify({"error": str(e)}), 502

    payload = _build_image_asset_response(file_id, out_ext, out_path, f"ai_image_{file_id[:8]}.{out_ext}")
    return jsonify(payload)


@app.route("/api/ai/generate-image", methods=["POST"])
def ai_generate_image():
    """
    参考画像生成 (AI Image Editor)。既存のアップロード済み画像をプロンプトで編集し、
    結果を新しい画像アセットとして保存する。通常アップロードと同じ形式のJSONを返す。

    リクエストJSON: { baseFileId, baseExt, prompt, model?, aspectRatio?, resolution? }
    """
    data = request.get_json(force=True, silent=True) or {}
    base_file_id = data.get("baseFileId")
    base_ext = data.get("baseExt")
    prompt = (data.get("prompt") or "").strip()

    if not base_file_id or not base_ext:
        return jsonify({"error": "元にする画像が指定されていません"}), 400
    if not prompt:
        return jsonify({"error": "プロンプトを入力してください"}), 400

    src_path = os.path.join(UPLOAD_DIR, f"{base_file_id}.{base_ext}")
    if not os.path.exists(src_path):
        return jsonify({"error": "元にする画像が見つかりません"}), 404

    file_id = uuid.uuid4().hex
    out_ext = "png"
    out_path = os.path.join(UPLOAD_DIR, f"{file_id}.{out_ext}")

    try:
        magic_hour_client.edit_image(
            src_path,
            prompt,
            out_path,
            model=data.get("model") or None,
            aspect_ratio=data.get("aspectRatio") or None,
            resolution=data.get("resolution") or None,
        )
    except magic_hour_client.MagicHourError as e:
        return jsonify({"error": str(e)}), 502

    payload = _build_image_asset_response(file_id, out_ext, out_path, f"ai_image_{file_id[:8]}.{out_ext}")
    return jsonify(payload)


@app.route("/api/ai/image-to-video", methods=["POST"])
def ai_image_to_video():
    """
    画像 -> 動画生成 (Image-to-Video)。既存のアップロード済み画像を元に、
    指定秒数の動画を生成し、結果を新しい動画アセットとして保存する。
    通常アップロードと同じ形式のJSONを返す(kind: "video")。

    リクエストJSON: { baseFileId, baseExt, endSeconds, prompt? }
    endSecondsは呼び出し側(フロントエンド)で、元にする画像クリップの
    タイムライン上の長さに合わせて渡す想定。
    """
    data = request.get_json(force=True, silent=True) or {}
    base_file_id = data.get("baseFileId")
    base_ext = data.get("baseExt")

    if not base_file_id or not base_ext:
        return jsonify({"error": "元になる画像が指定されていません"}), 400

    try:
        end_seconds = float(data.get("endSeconds"))
    except (TypeError, ValueError):
        return jsonify({"error": "動画の長さ(秒)が不正です"}), 400
    if not (1 <= end_seconds <= 60):
        return jsonify({"error": "動画の長さは1〜60秒の範囲で指定してください(クリップの長さを調整してください)"}), 400

    src_path = os.path.join(UPLOAD_DIR, f"{base_file_id}.{base_ext}")
    if not os.path.exists(src_path):
        return jsonify({"error": "元になる画像が見つかりません"}), 404

    file_id = uuid.uuid4().hex
    out_ext = "mp4"
    out_path = os.path.join(UPLOAD_DIR, f"{file_id}.{out_ext}")

    try:
        magic_hour_client.image_to_video(
            src_path,
            end_seconds,
            out_path,
            prompt=data.get("prompt") or None,
        )
    except magic_hour_client.MagicHourError as e:
        return jsonify({"error": str(e)}), 502

    payload = _build_video_asset_response(file_id, out_ext, out_path, f"ai_video_{file_id[:8]}.{out_ext}")
    return jsonify(payload)


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.route("/exports/<path:filename>")
def serve_export(filename):
    return send_from_directory(EXPORT_DIR, filename, as_attachment=True)


@app.route("/api/exports/<filename>", methods=["DELETE"])
def delete_export(filename):
    for name in os.listdir(EXPORT_DIR):
        if name == filename:
            os.remove(os.path.join(EXPORT_DIR, name))
            return jsonify({"ok": True})
    return jsonify({"error": "ファイルが見つかりません"}), 404


@app.route("/api/uploads/<file_id>", methods=["DELETE"])
def delete_upload(file_id):
    deleted = False
    for name in os.listdir(UPLOAD_DIR):
        if name.rsplit(".", 1)[0] == file_id:
            os.remove(os.path.join(UPLOAD_DIR, name))
            deleted = True
            break
    if not deleted:
        return jsonify({"error": "ファイルが見つかりません"}), 404
    return jsonify({"ok": True})


@app.route("/api/uploads", methods=["DELETE"])
def delete_all_uploads():
    count = 0
    for name in os.listdir(UPLOAD_DIR):
        path = os.path.join(UPLOAD_DIR, name)
        if os.path.isfile(path):
            os.remove(path)
            count += 1
    return jsonify({"ok": True, "deleted": count})


# ---------- 書き出し共通処理 ----------

def _resolve_clip_path(c):
    file_id = c.get("fileId")
    ext = c.get("ext")
    if not file_id or not ext:
        return None
    path = os.path.join(UPLOAD_DIR, f"{file_id}.{ext}")
    return path if os.path.exists(path) else None


def _extract_video_audio_segment(path, trim_start, trim_end):
    """
    動画ファイルに埋め込まれた音声を、指定区間だけpydubのAudioSegmentとして取り出す。
    音声トラックが無い動画、または取り出しに失敗した場合はNoneを返す。
    """
    dur = trim_end - trim_start
    if dur <= 0:
        return None

    tmp_path = os.path.join(EXPORT_DIR, f"tmp_vaudio_{uuid.uuid4().hex}.wav")
    clip = None
    try:
        clip = VideoFileClip(path)
        if clip.audio is None:
            return None
        end = min(trim_end, clip.duration)
        if end <= trim_start:
            return None
        clip.audio.subclipped(trim_start, end).write_audiofile(tmp_path, logger=None)
        return AudioSegment.from_file(tmp_path)
    except Exception:  # noqa: BLE001
        return None
    finally:
        if clip is not None:
            clip.close()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def build_audio_segments(clips):
    """
    clipsの中から実際に音になる要素を洗い出し、(タイムライン開始ms, AudioSegment)のリストを作る。
      - kind="audio"  : そのまま音声としてトリムして追加
      - kind="video"  : 埋め込み音声があれば、それを抽出してトリムして追加
      - kind="image"  : 音は無いので無視
      - kind="text"   : 音は無いので無視(fileId/extが無く_resolve_clip_pathがNoneを返すため自然にスキップされる)
    """
    loaded = []
    for c in clips:
        ext = c.get("ext")
        kind = c.get("kind") or ext_kind(ext)
        path = _resolve_clip_path(c)
        if not path:
            continue

        trim_start = float(c.get("trimStart", 0))
        trim_end = float(c.get("trimEnd", trim_start))
        timeline_start_ms = max(0, int(max(0.0, float(c.get("timelineStart", 0))) * 1000))

        if kind == "audio":
            audio = AudioSegment.from_file(path)
            src_len_ms = len(audio)
            trim_start_ms = max(0, int(trim_start * 1000))
            trim_end_ms = min(int(trim_end * 1000), src_len_ms)
            if trim_end_ms <= trim_start_ms:
                continue  # 空クリップはスキップ
            loaded.append((timeline_start_ms, audio[trim_start_ms:trim_end_ms]))

        elif kind == "video":
            seg = _extract_video_audio_segment(path, trim_start, trim_end)
            if seg is not None and len(seg) > 0:
                loaded.append((timeline_start_ms, seg))

    return loaded


def mix_audio_segments(loaded, min_duration_ms=0):
    """
    (タイムライン開始ms, AudioSegment)のリストを1つのAudioSegmentにミックスする。
    min_duration_ms を指定すると、音声側の内容がそれより短くても無音でその長さまで
    埋める(動画書き出し時に映像側の長さと音声トラックの長さを一致させるために使う)。
    """
    if not loaded:
        return None

    # ---- サンプリングレートの統一 ----
    # 各クリップの元ファイルはサンプリングレートがバラバラな場合がある。統一しないまま
    # overlay()を繰り返すと、pydubが重ね合わせのたびに暗黙的・段階的にリサンプリングし、
    # クリップの並び順次第で音質が変わってしまう。ここで明示的に単一のターゲットレート
    # （今回のクリップ群のうち最大の値）へ揃えてからミックスすることで、不要なダウン
    # サンプリングを避けつつ一貫した音質にする。
    target_frame_rate = max(clip_audio.frame_rate for _, clip_audio in loaded)
    segments = [
        (start_ms, clip_audio.set_frame_rate(target_frame_rate))
        for start_ms, clip_audio in loaded
    ]
    total_end_ms = max(start_ms + len(clip_audio) for start_ms, clip_audio in segments)
    total_end_ms = max(total_end_ms, min_duration_ms)

    mix = AudioSegment.silent(duration=total_end_ms, frame_rate=target_frame_rate)
    for start_ms, clip_audio in segments:
        mix = mix.overlay(clip_audio, position=start_ms)
    return mix


def export_audio(clips, fmt):
    loaded = build_audio_segments(clips)
    if not loaded:
        return jsonify({"error": "有効な音声クリップがありません"}), 400

    mix = mix_audio_segments(loaded)

    out_name = f"mix_{uuid.uuid4().hex}.{fmt}"
    out_path = os.path.join(EXPORT_DIR, out_name)
    mix.export(out_path, format=fmt)

    return jsonify({"url": f"/exports/{out_name}", "filename": out_name})


def _wrap_text_to_width(text, font_path, font_size, max_width_px):
    """
    「caption」モードはテキストの長さに関わらず指定した幅いっぱいの箱になってしまい、
    (今回のような)9方位への正確な配置ができなくなる。そこで自前で文字単位の折り返しを
    行い、実際の内容にぴったり収まる「label」モードで使う。単語区切り(スペース)が無い
    日本語でも問題なく折り返せるよう、単語単位ではなく1文字ずつ幅を測って折り返す。
    """
    font = ImageFont.truetype(font_path, font_size)
    out_lines = []
    for raw_line in text.split("\n"):
        if not raw_line:
            out_lines.append("")
            continue
        current = ""
        for ch in raw_line:
            trial = current + ch
            if font.getlength(trial) > max_width_px and current:
                out_lines.append(current)
                current = ch
            else:
                current = trial
        out_lines.append(current)
    return "\n".join(out_lines)


def _fit_and_place(clip, timeline_start, canvas_w, canvas_h):
    """クリップをアスペクト比を保ったままキャンバスに収まるよう縮小し、中央配置する(レターボックス)"""
    iw, ih = clip.size
    scale = min(canvas_w / iw, canvas_h / ih)
    new_size = (max(1, round(iw * scale)), max(1, round(ih * scale)))
    return clip.resized(new_size).with_position("center").with_start(timeline_start)


def export_video(clips):
    image_specs = []  # [(timelineStart, duration, path), ...]
    video_specs = []  # [(timelineStart, trimStart, trimEnd, path), ...]
    text_specs = []  # [(timelineStart, duration, text, fontKey, posX, posY), ...]
    # ↑いずれも後にある要素ほど、映像合成時に上に重なる(フロントエンドのトラック順)。
    # テキストは常に画像・動画より後に(=一番上に)重ねる。
    total_end_sec = 0.0

    for c in clips:
        kind = c.get("kind") or ext_kind(c.get("ext"))

        trim_start = float(c.get("trimStart", 0))
        trim_end = float(c.get("trimEnd", trim_start))
        timeline_start = max(0.0, float(c.get("timelineStart", 0)))
        dur = trim_end - trim_start
        if dur <= 0:
            continue

        if kind == "text":
            text = (c.get("text") or "").strip()
            if not text:
                continue
            total_end_sec = max(total_end_sec, timeline_start + dur)
            text_specs.append(
                (timeline_start, dur, text, c.get("fontKey"), c.get("positionX"), c.get("positionY"))
            )
            continue

        path = _resolve_clip_path(c)
        if not path:
            continue

        total_end_sec = max(total_end_sec, timeline_start + dur)

        if kind == "image":
            image_specs.append((timeline_start, dur, path))
        elif kind == "video":
            video_specs.append((timeline_start, trim_start, trim_end, path))

    audio_loaded = build_audio_segments(clips)  # audio kind + 動画埋め込み音声の両方を含む

    if total_end_sec <= 0:
        return jsonify({"error": "有効なクリップがありません"}), 400

    canvas_w, canvas_h = VIDEO_CANVAS_SIZE

    # 一番下に黒背景を敷き、画像・動画クリップをタイムライン上の位置に配置して重ねる。
    layers = [ColorClip(size=VIDEO_CANVAS_SIZE, color=(0, 0, 0), duration=total_end_sec)]
    open_video_clips = []  # 書き出し後にcloseするために保持しておく

    for timeline_start, dur, path in image_specs:
        img_clip = ImageClip(path, duration=dur)
        layers.append(_fit_and_place(img_clip, timeline_start, canvas_w, canvas_h))

    for timeline_start, trim_start, trim_end, path in video_specs:
        raw = VideoFileClip(path)
        open_video_clips.append(raw)
        end = min(trim_end, raw.duration)
        sub = raw.subclipped(trim_start, end).without_audio()  # 音声は別途build_audio_segmentsで合流済み
        layers.append(_fit_and_place(sub, timeline_start, canvas_w, canvas_h))

    # テキストは画像・動画より後に追加することで、常に一番上に重なるようにする
    for timeline_start, dur, text, font_key, pos_x, pos_y in text_specs:
        font_path = _font_path(font_key)
        max_width_px = canvas_w * TEXT_MAX_WIDTH_RATIO
        wrapped = _wrap_text_to_width(text, font_path, TEXT_FONT_SIZE, max_width_px)
        txt_clip = TextClip(
            font=font_path,
            text=wrapped,
            font_size=TEXT_FONT_SIZE,
            color="white",
            stroke_color="black",
            stroke_width=max(1, TEXT_FONT_SIZE // 16),
            method="label",  # 自前で折り返し済みなので、実際の内容にぴったり収まるlabelを使う
            text_align="center",
            duration=dur,
        )
        xy = _text_center_xy(pos_x, pos_y, txt_clip.w, txt_clip.h, canvas_w, canvas_h)
        layers.append(txt_clip.with_position(xy).with_start(timeline_start))

    video = CompositeVideoClip(layers, size=VIDEO_CANVAS_SIZE).with_duration(total_end_sec)

    tmp_audio_path = None
    if audio_loaded:
        mix = mix_audio_segments(audio_loaded, min_duration_ms=int(total_end_sec * 1000))
        tmp_audio_path = os.path.join(EXPORT_DIR, f"tmp_audio_{uuid.uuid4().hex}.wav")
        mix.export(tmp_audio_path, format="wav")
        video = video.with_audio(AudioFileClip(tmp_audio_path))

    out_name = f"mix_{uuid.uuid4().hex}.mp4"
    out_path = os.path.join(EXPORT_DIR, out_name)
    try:
        video.write_videofile(
            out_path,
            fps=VIDEO_FPS,
            codec="libx264",
            audio_codec="aac",
            # -movflags +faststart: メタデータ(moov atom)をファイル先頭に置く。
            # これを付けないとffmpegはデフォルトでファイル末尾に置くため、書き出し自体は
            # 壊れていなくても、ブラウザでの再生やダウンロード直後のプレビュー、一部の
            # プレイヤーで「読み込めない/再生できない」ように見える原因になっていた。
            # -pix_fmt yuv420p: 大半のプレイヤー・OS標準プレイヤーが前提とする色形式を明示指定。
            ffmpeg_params=["-movflags", "+faststart", "-pix_fmt", "yuv420p"],
        )
    finally:
        video.close()
        for c in open_video_clips:
            c.close()
        if tmp_audio_path and os.path.exists(tmp_audio_path):
            os.remove(tmp_audio_path)

    return jsonify({"url": f"/exports/{out_name}", "filename": out_name})


@app.route("/api/export", methods=["POST"])
def export():
    """
    リクエストJSON形式:
    {
      "format": "wav" | "mp3" | "mp4",
      "clips": [
        {
          "fileId": "...",
          "ext": "mp3",
          "kind": "audio" | "image" | "video",
          "trimStart": 0.0,      # 元ファイル内での開始秒
          "trimEnd": 5.2,        # 元ファイル内での終了秒(画像の場合は表示秒数の基準)
          "timelineStart": 3.0   # タイムライン上での開始秒
        },
        {
          # テキストクリップはfileId/extを持たない代わりに以下を持つ
          "kind": "text",
          "text": "表示するテキスト",
          "fontKey": "noto-sans-jp",   # FONT_REGISTRYのキー
          "positionX": 0.5,             # テキスト中心のx座標(キャンバス幅に対する相対値0〜1)
          "positionY": 0.82,            # テキスト中心のy座標(キャンバス高さに対する相対値0〜1)
          "trimStart": 0.0,
          "trimEnd": 5.0,               # 画像同様、表示秒数の基準
          "timelineStart": 3.0
        },
        ...
      ]
    }
    """
    data = request.get_json(force=True, silent=True) or {}
    clips = data.get("clips", [])
    fmt = data.get("format", "wav")
    if fmt not in {"wav", "mp3", "mp4"}:
        fmt = "wav"

    if not clips:
        return jsonify({"error": "クリップがありません"}), 400

    if fmt == "mp4":
        return export_video(clips)
    return export_audio(clips, fmt)


if __name__ == "__main__":
    # threaded=True: AI生成リクエストはMagic Hour側の処理完了まで数十秒〜数分ブロックするため、
    # その間も他のリクエスト(ページ表示や他の操作)を受け付けられるようにする。
    app.run(debug=True, port=5000, threaded=True)