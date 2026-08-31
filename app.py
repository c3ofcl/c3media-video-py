"""
マルチトラック動画・音声エディタ - Flaskバックエンド

機能:
  - 複数の音声ファイル・画像ファイルのアップロード（トラック化）
    画像は「静止画を一定時間再生する動画クリップ」として扱う
  - タイムライン情報(開始位置・トリム範囲)に基づく書き出し
      - 音声のみ(WAV/MP3): 音声クリップをミックスダウン
      - 動画(MP4): 画像クリップを合成した映像トラックと、
        音声クリップをミックスした音声トラックを1つの動画に書き出す
    (トリミング / カット / 結合はフロントエンド側で非破壊的に管理し、
     書き出し時にpydub(音声)・moviepy(映像)で実際の処理を行う)

事前準備:
  pip install -r requirements.txt
  ffmpeg がシステムにインストールされている必要があります
    - macOS: brew install ffmpeg
    - Ubuntu/Debian: sudo apt install ffmpeg
    - Windows: https://ffmpeg.org/download.html からダウンロードしPATHに追加

起動:
  python app.py
  ブラウザで http://127.0.0.1:5000 を開く
"""

import os
import uuid

from flask import Flask, request, jsonify, send_from_directory, render_template
from pydub import AudioSegment
from PIL import Image, ImageOps

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
EXPORT_DIR = os.path.join(BASE_DIR, "exports")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)

AUDIO_EXT = {"mp3", "wav", "ogg", "m4a", "flac", "aac", "wma"}
IMAGE_EXT = {"jpg", "jpeg", "png", "gif", "webp", "bmp"}
ALLOWED_EXT = AUDIO_EXT | IMAGE_EXT
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

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


def ext_kind(ext: str) -> str:
    """拡張子から "audio" か "image" を判定する"""
    return "image" if (ext or "").lower() in IMAGE_EXT else "audio"


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

    if kind == "image":
        # PIL.Image.verify()は壊れた画像の検出用。呼び出し後はオブジェクトを
        # 使い回せない仕様のため、都度開き直す。
        try:
            with Image.open(path) as img:
                img.verify()
            _normalize_image_orientation(path)
            with Image.open(path) as img:
                width, height = img.size
        except Exception as e:  # noqa: BLE001
            os.remove(path)
            return jsonify({"error": f"画像を読み込めませんでした: {e}"}), 400

        return jsonify(
            {
                "id": file_id,
                "ext": ext,
                "kind": "image",
                "filename": f.filename,
                "url": f"/uploads/{saved_name}",
                "duration": DEFAULT_IMAGE_DURATION_SEC,
                "maxDuration": MAX_IMAGE_DURATION_SEC,
                "width": width,
                "height": height,
            }
        )

    try:
        audio = AudioSegment.from_file(path)
    except Exception as e:  # noqa: BLE001
        os.remove(path)
        return jsonify({"error": f"音声を読み込めませんでした: {e}"}), 400

    duration = len(audio) / 1000.0  # 秒

    return jsonify(
        {
            "id": file_id,
            "ext": ext,
            "kind": "audio",
            "filename": f.filename,
            "url": f"/uploads/{saved_name}",
            "duration": duration,
            "maxDuration": duration,
        }
    )


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


def build_audio_segments(clips):
    """clipsのうち音声クリップだけを対象に、(タイムライン開始ms, AudioSegment)のリストを作る"""
    loaded = []
    for c in clips:
        ext = c.get("ext")
        kind = c.get("kind") or ext_kind(ext)
        if kind != "audio":
            continue
        path = _resolve_clip_path(c)
        if not path:
            continue

        audio = AudioSegment.from_file(path)
        src_len_ms = len(audio)

        trim_start_ms = max(0, int(float(c.get("trimStart", 0)) * 1000))
        trim_end_ms = int(float(c.get("trimEnd", src_len_ms / 1000)) * 1000)
        trim_end_ms = min(trim_end_ms, src_len_ms)
        if trim_end_ms <= trim_start_ms:
            continue  # 空クリップはスキップ

        clip_audio = audio[trim_start_ms:trim_end_ms]
        timeline_start_ms = max(0, int(float(c.get("timelineStart", 0)) * 1000))
        loaded.append((timeline_start_ms, clip_audio))
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


def export_video(clips):
    # 動画合成にのみ必要な重い依存(numpy等)なので、実際にmp4を書き出す時だけ読み込む
    try:
        from moviepy import ImageClip, ColorClip, CompositeVideoClip, AudioFileClip
    except ImportError:
        return jsonify(
            {"error": "moviepyがインストールされていません。pip install -r requirements.txt を実行してください"}
        ), 500

    image_specs = []  # [(timelineStart, duration, path), ...] 後にあるものほど上に重なる
    total_end_sec = 0.0

    for c in clips:
        ext = c.get("ext")
        kind = c.get("kind") or ext_kind(ext)
        path = _resolve_clip_path(c)
        if not path:
            continue

        trim_start = float(c.get("trimStart", 0))
        trim_end = float(c.get("trimEnd", trim_start))
        timeline_start = max(0.0, float(c.get("timelineStart", 0)))
        dur = trim_end - trim_start
        if dur <= 0:
            continue

        total_end_sec = max(total_end_sec, timeline_start + dur)

        if kind == "image":
            image_specs.append((timeline_start, dur, path))

    audio_loaded = build_audio_segments(clips)

    if total_end_sec <= 0:
        return jsonify({"error": "有効なクリップがありません"}), 400

    canvas_w, canvas_h = VIDEO_CANVAS_SIZE

    # 一番下に黒背景を敷き、画像クリップをタイムライン上の位置に配置して重ねる。
    # image_specsはフロントエンドから送られてきたトラック順(=後のトラックほど上に重なる)
    layers = [ColorClip(size=VIDEO_CANVAS_SIZE, color=(0, 0, 0), duration=total_end_sec)]
    for timeline_start, dur, path in image_specs:
        img_clip = ImageClip(path, duration=dur)
        iw, ih = img_clip.size
        scale = min(canvas_w / iw, canvas_h / ih)
        new_size = (max(1, round(iw * scale)), max(1, round(ih * scale)))
        img_clip = (
            img_clip.resized(new_size)
            .with_position("center")
            .with_start(timeline_start)
        )
        layers.append(img_clip)

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
          "kind": "audio" | "image",
          "trimStart": 0.0,      # 元ファイル内での開始秒
          "trimEnd": 5.2,        # 元ファイル内での終了秒(画像の場合は表示秒数の基準)
          "timelineStart": 3.0   # タイムライン上での開始秒
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
    app.run(debug=True, port=5000, threaded=True)