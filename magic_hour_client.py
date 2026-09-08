"""
Magic Hour API (https://docs.magichour.ai) の薄いラッパー。

このアプリで使うのは以下の2機能のみ:
  - AI Image Editor  : 参考画像生成 (既存の画像をプロンプトで編集する)
      https://docs.magichour.ai/api-reference/image-projects/ai-image-editor
  - Image-to-Video    : 画像 -> 動画生成
      https://docs.magichour.ai/api-reference/video-projects/image-to-video

どちらも実体は非同期ジョブで、以下の3ステップで完結する:
  1. POST /v1/files/upload-urls で署名付きアップロードURLを取得し、画像をPUTでアップロードする
  2. POST /v1/ai-image-editor もしくは /v1/image-to-video でジョブを作成する(idが返る)
  3. GET /v1/image-projects/{id} もしくは /v1/video-projects/{id} をポーリングし、
     status が complete になったら downloads[0].url から結果をダウンロードする

公式のPython SDK(`magic_hour`)も存在するが、実装時点でPyPI配布バージョンのモデル一覧が
公式ドキュメント記載の最新一覧と食い違っていたため、ここではdocsに忠実な生のHTTPリクエスト
(`requests`)で実装している。
"""

import os
import time

import requests

API_BASE = "https://api.magichour.ai"

POLL_INTERVAL_SEC = 3
IMAGE_POLL_TIMEOUT_SEC = 180  # 参考画像生成の最大待機時間(秒)
VIDEO_POLL_TIMEOUT_SEC = 480  # 動画生成の最大待機時間(秒)。モデルによっては数分かかる


class MagicHourError(Exception):
    """Magic Hour APIとのやり取り中に発生したエラー。メッセージはそのままUIに表示してよい。"""


def _api_key():
    key = os.environ.get("MAGIC_HOUR_API_KEY", "").strip()
    if not key:
        raise MagicHourError(
            "MAGIC_HOUR_API_KEYが設定されていません。画面右上の「⚙ 設定」からAPIキーを入力するか、"
            ".envファイルにMAGIC_HOUR_API_KEY=あなたのAPIキー を記入してください。"
        )
    return key


def _headers():
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _raise_for_api_error(resp):
    if resp.ok:
        return
    try:
        payload = resp.json()
        message = payload.get("message") or str(payload)
    except ValueError:
        message = resp.text or f"HTTP {resp.status_code}"
    raise MagicHourError(f"Magic Hour APIエラー (HTTP {resp.status_code}): {message}")


def _upload_asset(local_path, asset_type):
    """
    ローカルファイルをMagic Hourのストレージへアップロードし、各種生成APIで参照する
    file_path(例: "api-assets/id/1234.png")を返す。
    asset_type: "image" | "video" | "audio"
    """
    ext = local_path.rsplit(".", 1)[-1].lower()
    resp = requests.post(
        f"{API_BASE}/v1/files/upload-urls",
        headers=_headers(),
        json={"items": [{"type": asset_type, "extension": ext}]},
        timeout=30,
    )
    _raise_for_api_error(resp)
    item = resp.json()["items"][0]

    with open(local_path, "rb") as f:
        put_resp = requests.put(item["upload_url"], data=f, timeout=120)
    if not put_resp.ok:
        raise MagicHourError(f"Magic Hourへのファイルアップロードに失敗しました (HTTP {put_resp.status_code})")

    return item["file_path"]


def _poll_project(resource, project_id, timeout_sec):
    """
    resource: "image-projects" | "video-projects"
    completeになったらレスポンスJSON全体(downloadsを含む)を返す。
    error/canceled、もしくはタイムアウトの場合はMagicHourErrorを送出する。
    """
    deadline = time.time() + timeout_sec
    while True:
        resp = requests.get(f"{API_BASE}/v1/{resource}/{project_id}", headers=_headers(), timeout=30)
        _raise_for_api_error(resp)
        data = resp.json()
        status = data.get("status")

        if status == "complete":
            downloads = data.get("downloads") or []
            if not downloads:
                raise MagicHourError("生成は完了しましたが、ダウンロード可能な結果がありませんでした")
            return data
        if status == "error":
            err = data.get("error") or {}
            raise MagicHourError(f"生成に失敗しました: {err.get('message', '不明なエラー')}")
        if status == "canceled":
            raise MagicHourError("生成がキャンセルされました")

        if time.time() > deadline:
            raise MagicHourError(f"生成がタイムアウトしました(現在のステータス: {status})")
        time.sleep(POLL_INTERVAL_SEC)


def _download_to(url, dest_path):
    resp = requests.get(url, timeout=120, stream=True)
    if not resp.ok:
        raise MagicHourError(f"生成結果のダウンロードに失敗しました (HTTP {resp.status_code})")
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 256):
            if chunk:
                f.write(chunk)


def edit_image(local_image_path, prompt, dest_path, model=None, aspect_ratio=None, resolution=None):
    """
    AI Image Editor: ローカル画像をアップロードしてプロンプトで編集し、
    結果を1枚 dest_path に保存する。完了したレスポンスJSON(dict)を返す。
    """
    file_path = _upload_asset(local_image_path, "image")

    body = {
        "image_count": 1,
        "style": {"prompt": prompt},
        "assets": {"image_file_paths": [file_path]},
    }
    if model:
        body["model"] = model
    if aspect_ratio:
        body["aspect_ratio"] = aspect_ratio
    if resolution:
        body["resolution"] = resolution

    resp = requests.post(f"{API_BASE}/v1/ai-image-editor", headers=_headers(), json=body, timeout=30)
    _raise_for_api_error(resp)
    project_id = resp.json()["id"]

    data = _poll_project("image-projects", project_id, IMAGE_POLL_TIMEOUT_SEC)
    _download_to(data["downloads"][0]["url"], dest_path)
    return data


def image_to_video(local_image_path, end_seconds, dest_path, model=None, resolution=None, prompt=None, audio=None):
    """
    Image-to-Video: ローカル画像をアップロードして指定秒数(end_seconds)の動画を生成し、
    結果を dest_path に保存する。完了したレスポンスJSON(dict)を返す。
    """
    file_path = _upload_asset(local_image_path, "image")

    body = {
        "end_seconds": float(end_seconds),
        "assets": {"image_file_path": file_path},
    }
    if model:
        body["model"] = model
    if resolution:
        body["resolution"] = resolution
    if prompt:
        body["style"] = {"prompt": prompt}
    if audio is not None:
        body["audio"] = bool(audio)

    resp = requests.post(f"{API_BASE}/v1/image-to-video", headers=_headers(), json=body, timeout=30)
    _raise_for_api_error(resp)
    project_id = resp.json()["id"]

    data = _poll_project("video-projects", project_id, VIDEO_POLL_TIMEOUT_SEC)
    _download_to(data["downloads"][0]["url"], dest_path)
    return data
