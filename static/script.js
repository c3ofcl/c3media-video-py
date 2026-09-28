// ===== マルチトラック動画・音声エディタ フロントエンド =====

const PX_PER_SEC = 60; // style.css の --px-per-sec と揃える
const LABEL_WIDTH = 150;
const GRID_SNAP_SEC = 1; // グリッドスナップの間隔(秒)。track-laneの背景の縦線(1秒間隔)と揃えている
const SNAP_PX_THRESHOLD = 8; // スナップが効く距離(px)。PX_PER_SECで秒に換算して使う

// テキストクリップ用フォント。キーはapp.py側のFONT_REGISTRYと対応させること。
// cssFamilyはstyle.css内の@font-faceで定義したfont-family名。
const FONT_REGISTRY = {
  "noto-sans-jp": { label: "Noto Sans JP(標準)", cssFamily: "AppFont-NotoSansJP" },
  "noto-serif-jp": { label: "Noto Serif JP(明朝体)", cssFamily: "AppFont-NotoSerifJP" },
  "dela-gothic-one": { label: "Dela Gothic One(極太)", cssFamily: "AppFont-DelaGothicOne" },
  "zen-maru-gothic": { label: "Zen Maru Gothic(丸ゴシック)", cssFamily: "AppFont-ZenMaruGothic" },
};
const DEFAULT_FONT_KEY = "noto-sans-jp";
const DEFAULT_TEXT_DURATION_SEC = 5.0; // 画像クリップと同じ既定の表示秒数
const MAX_TEXT_DURATION_SEC = 600.0; // 画像クリップと同じ、右ハンドルで伸ばせる上限
const DEFAULT_TEXT_FONT_SIZE = 48; // サーバー側(app.pyのDEFAULT_TEXT_FONT_SIZE)と揃えること
const MIN_TEXT_FONT_SIZE = 12; // サーバー側(app.pyのMIN_TEXT_FONT_SIZE)と揃えること
const MAX_TEXT_FONT_SIZE = 240; // サーバー側(app.pyのMAX_TEXT_FONT_SIZE)と揃えること
const TEXT_MARGIN_PX = 40; // サーバー側(app.pyのTEXT_MARGIN_PX)と揃えること
const TEXT_MAX_WIDTH_RATIO = 0.86; // サーバー側(app.pyのTEXT_MAX_WIDTH_RATIO)と揃えること

const state = {
  tracks: [],       // [{trackId, label, clips: [clip, ...]}]
  selectedClipId: null,
  playheadSec: 0,
  isPlaying: false,
  bufferCache: {},     // fileId -> Promise<AudioBuffer> (デコード済み音声データ、クリップ間で共有)
  imageCache: {},      // fileId -> Promise<HTMLImageElement> (デコード済み画像、クリップ間で共有)
  videoCache: {},      // fileId -> HTMLVideoElement (プレビュー描画用。動画クリップ間で共有)
  activeSources: [],   // 再生中のAudioBufferSourceNode一覧
  rafId: null,
  playStartCtxTime: 0, // 再生開始時のAudioContext.currentTime
  _playStartSec: 0,    // 再生開始時点のタイムライン上の秒数
  previewVideoEl: null,     // 現在「再生中」として実際にplay()させているプレビュー用<video>要素
  previewVideoClipId: null, // ↑がどのクリップのものかを覚えておくためのclipId
  textBoundingBoxes: {},    // clipId -> {x,y,width,height} 直近の描画結果(プレビューのドラッグ判定に使う)
  textResizeHandles: {},    // clipId -> {corner名 -> {x,y}} 選択中クリップの四隅ハンドル座標(リサイズ判定に使う)
  draggingTextClipId: null, // プレビュー上でドラッグ中のテキストクリップid
  dragOffset: { x: 0, y: 0 }, // ドラッグ開始時の「クリック位置 - テキスト中心」のオフセット(px)
};

let clipCounter = 0;
let trackCounter = 0;

const el = {
  fileInput: document.getElementById("fileInput"),
  tracksContainer: document.getElementById("tracksContainer"),
  ruler: document.getElementById("ruler"),
  emptyHint: document.getElementById("emptyHint"),
  status: document.getElementById("status"),
  playBtn: document.getElementById("playBtn"),
  stopBtn: document.getElementById("stopBtn"),
  cutBtn: document.getElementById("cutBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  clearUploadsBtn: document.getElementById("clearUploadsBtn"),
  exportBtn: document.getElementById("exportBtn"),
  formatSelect: document.getElementById("formatSelect"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  totalTimeLabel: document.getElementById("totalTimeLabel"),
  previewCanvas: document.getElementById("previewCanvas"),
  clipContextMenu: document.getElementById("clipContextMenu"),
  ctxGenVideoBtn: document.getElementById("ctxGenVideoBtn"),
  ctxGenImageBtn: document.getElementById("ctxGenImageBtn"),
  ctxGenNewImageBtn: document.getElementById("ctxGenNewImageBtn"),
  ctxAddTextBtn: document.getElementById("ctxAddTextBtn"),
  ctxEditTextBtn: document.getElementById("ctxEditTextBtn"),
  aiActionPanel: document.getElementById("aiActionPanel"),
  aiPanelTitle: document.getElementById("aiPanelTitle"),
  aiPanelHint: document.getElementById("aiPanelHint"),
  aiPanelAspectRow: document.getElementById("aiPanelAspectRow"),
  aiPanelAspectRatio: document.getElementById("aiPanelAspectRatio"),
  aiPanelPrompt: document.getElementById("aiPanelPrompt"),
  aiPanelCloseBtn: document.getElementById("aiPanelCloseBtn"),
  aiPanelSubmitBtn: document.getElementById("aiPanelSubmitBtn"),
  aiPanelStatus: document.getElementById("aiPanelStatus"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsBackdrop: document.getElementById("settingsBackdrop"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsKeyStatus: document.getElementById("settingsKeyStatus"),
  settingsApiKeyInput: document.getElementById("settingsApiKeyInput"),
  settingsCloseBtn: document.getElementById("settingsCloseBtn"),
  settingsSaveBtn: document.getElementById("settingsSaveBtn"),
  settingsClearBtn: document.getElementById("settingsClearBtn"),
  settingsStatus: document.getElementById("settingsStatus"),
  textEditPanel: document.getElementById("textEditPanel"),
  textPanelTitle: document.getElementById("textPanelTitle"),
  textPanelContent: document.getElementById("textPanelContent"),
  textPanelFont: document.getElementById("textPanelFont"),
  textPanelPreview: document.getElementById("textPanelPreview"),
  textPanelCloseBtn: document.getElementById("textPanelCloseBtn"),
  textPanelSubmitBtn: document.getElementById("textPanelSubmitBtn"),
  textPanelStatus: document.getElementById("textPanelStatus"),
};

function setStatus(msg, isError = false) {
  el.status.textContent = msg || "";
  el.status.style.color = isError ? "#ff6b6b" : "";
}

function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- 音声再生エンジン(Web Audio API) ----------
// <audio>要素 + setTimeoutでの再生は、シーク・再生開始のタイミングに数十ms単位の
// 誤差やゆらぎが出やすく、カットした境目で音が途切れたり重なったりする原因になる。
// Web Audio APIでバッファを直接スケジューリングし、カット前後のクリップをサンプル
// 単位の精度でつなぐことで、境目のノイズを解消する。

let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

// 同じ音声ファイルはクリップ(カット後の断片含む)間でデコード結果を共有し、
// 再生のたびに毎回フェッチ・デコードし直さないようにする
function loadBuffer(fileId, url) {
  if (!state.bufferCache[fileId]) {
    state.bufferCache[fileId] = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((arrayBuffer) => getAudioContext().decodeAudioData(arrayBuffer));
  }
  return state.bufferCache[fileId];
}

// ---------- 画像・動画プレビュー(Canvas) ----------
// 画像クリップは「静止画を一定時間再生する映像クリップ」として、動画クリップは
// (AI生成された、またはアップロードされた)実際の映像として扱う。
// 音声のbufferCacheと同様、同じファイルはクリップ間でロード結果を共有する。

function loadImage(fileId, url) {
  if (!state.imageCache[fileId]) {
    state.imageCache[fileId] = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`画像の読み込みに失敗しました: ${url}`));
      img.src = url;
    });
  }
  return state.imageCache[fileId];
}

// 動画クリップ用の非表示<video>要素を(無ければ作って)返す。再生はせず、
// プレビュー描画のためにcurrentTimeをシークしてフレームを取り出す用途のみに使う。
function getOrCreateVideoEl(fileId, url) {
  if (!state.videoCache[fileId]) {
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    state.videoCache[fileId] = v;
  }
  return state.videoCache[fileId];
}

// キャンバスいっぱいに、アスペクト比を保ったまま中央寄せで描画する(レターボックス)。
// サーバー側の書き出し(moviepyでの合成)と同じフィット方式に揃えている。
// mediaEl は HTMLImageElement または HTMLVideoElement。
function drawMediaFit(ctx, mediaEl, canvasW, canvasH) {
  const iw = mediaEl.naturalWidth || mediaEl.videoWidth || 0;
  const ih = mediaEl.naturalHeight || mediaEl.videoHeight || 0;
  if (!iw || !ih) return;
  const scale = Math.min(canvasW / iw, canvasH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (canvasW - dw) / 2;
  const dy = (canvasH - dh) / 2;
  ctx.drawImage(mediaEl, dx, dy, dw, dh);
}

// 動画クリップの該当オフセット位置へシークしてから描画する。シークは非同期(seekedイベント)
// なので、既にほぼ同じ位置にいる場合は待たずに即描画し、大きくズレている場合だけ待つ。
function seekAndDrawVideo(clip, offsetSec, ctx, canvasW, canvasH) {
  const videoEl = getOrCreateVideoEl(clip.fileId, clip.url);
  const target = Math.max(0, offsetSec);
  const draw = () => drawMediaFit(ctx, videoEl, canvasW, canvasH);

  if (videoEl.readyState >= 1 && Math.abs(videoEl.currentTime - target) < 0.08) {
    draw();
    return;
  }
  const onSeeked = () => {
    videoEl.removeEventListener("seeked", onSeeked);
    draw();
  };
  videoEl.addEventListener("seeked", onSeeked);
  try {
    videoEl.currentTime = target;
  } catch (e) {
    videoEl.removeEventListener("seeked", onSeeked);
    // メタデータ未読込などで失敗することがある。読み込み後に呼び直されるので無視する。
  }
}

// 指定秒における「その時点で表示されているべきクリップ(画像 or 動画)」をプレビュー
// canvasへ描画する。複数トラックが同じ時刻に重なっている場合は、後のトラックほど
// 上に重なる(サーバー側の書き出しロジックと同じ規則)。該当が無ければ黒で塗りつぶす。
//
// 動画クリップの扱いに注意: 再生中(state.isPlaying)は、requestAnimationFrameのたびに
// currentTimeへシークし直す実装にすると、シークは重い処理でありブラウザが追いつかず
// 映像がとぎれとぎれになる。そのため再生中は「クリップが切り替わった瞬間」にだけ
// 開始位置へシークしてvideoEl.play()を呼び、あとは動画自身の再生に任せて
// 毎フレーム「今映っているフレーム」をそのまま描画するだけにする。
// スクラブ中や停止中(state.isPlaying===false)は、そのつど正確な位置へシークして
// 1枚だけ描画するこれまで通りの方式のままにしている。

function pausePreviewVideo() {
  if (state.previewVideoEl) {
    state.previewVideoEl.pause();
  }
  state.previewVideoEl = null;
  state.previewVideoClipId = null;
}

// ---------- テキストクリップの描画 ----------
// サーバー側(app.pyの_wrap_text_to_width / _text_anchor_xy)と同じ考え方で折り返し・
// 配置を行う。スペースの無い日本語でも折り返せるよう、単語単位ではなく1文字ずつ幅を
// 測って折り返す。canvasのテキスト描画とPillow/moviepyのテキスト描画は仕組みが違うため
// ピクセル単位では一致しないが、プレビューとしては十分な近似になる(正確な見た目は
// 書き出し結果が基準)。
function wrapTextToWidth(ctx, text, maxWidthPx) {
  const outLines = [];
  for (const rawLine of text.split("\n")) {
    if (!rawLine) {
      outLines.push("");
      continue;
    }
    let current = "";
    for (const ch of rawLine) {
      const trial = current + ch;
      if (ctx.measureText(trial).width > maxWidthPx && current) {
        outLines.push(current);
        current = ch;
      } else {
        current = trial;
      }
    }
    outLines.push(current);
  }
  return outLines;
}

function textClipFontCss(fontKey, fontSize) {
  const info = FONT_REGISTRY[fontKey] || FONT_REGISTRY[DEFAULT_FONT_KEY];
  return `${fontSize}px "${info.cssFamily}"`;
}

const DEFAULT_TEXT_POSITION = { x: 0.5, y: 0.82 }; // プレビューでドラッグする前の初期位置(中心点の相対座標)
const TEXT_RESIZE_HANDLE_SIZE = 14; // 四隅のリサイズハンドルの大きさ(canvas内部座標のpx)

function drawSingleTextClip(ctx, clip, canvasW, canvasH) {
  const fontSize = clip.fontSize || DEFAULT_TEXT_FONT_SIZE;
  ctx.font = textClipFontCss(clip.fontKey, fontSize);
  const lineHeight = fontSize * 1.3;
  const maxWidthPx = canvasW * TEXT_MAX_WIDTH_RATIO;
  const lines = wrapTextToWidth(ctx, clip.text || "", maxWidthPx);
  const blockWidth = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  const blockHeight = lines.length * lineHeight;

  const pos = clip.position || DEFAULT_TEXT_POSITION;
  const centerX = (pos.x ?? DEFAULT_TEXT_POSITION.x) * canvasW;
  const centerY = (pos.y ?? DEFAULT_TEXT_POSITION.y) * canvasH;
  const blockX = centerX - blockWidth / 2;
  const blockY = centerY - blockHeight / 2;

  // ヒットテスト(プレビュー画面でのドラッグ判定)用に、描画のたびに最新の矩形を覚えておく
  state.textBoundingBoxes[clip.clipId] = { x: blockX, y: blockY, width: blockWidth, height: blockHeight };

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, Math.round(fontSize / 8));
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";

  lines.forEach((line, i) => {
    const cx = blockX + blockWidth / 2;
    const cy = blockY + i * lineHeight + fontSize * 0.85;
    ctx.strokeText(line, cx, cy);
    ctx.fillText(line, cx, cy);
  });

  // 選択中のテキストクリップは、ドラッグで動かせる/四隅でリサイズできることが分かるよう
  // 枠と四隅のハンドルを表示する。ハンドルの位置はここで記録し、リサイズのヒットテストに使う。
  if (clip.clipId === state.selectedClipId) {
    const pad = 8;
    const left = blockX - pad;
    const top = blockY - pad;
    const right = blockX + blockWidth + pad;
    const bottom = blockY + blockHeight + pad;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.restore();

    const corners = {
      "top-left": { x: left, y: top },
      "top-right": { x: right, y: top },
      "bottom-left": { x: left, y: bottom },
      "bottom-right": { x: right, y: bottom },
    };
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#5b8cff";
    ctx.lineWidth = 2;
    const half = TEXT_RESIZE_HANDLE_SIZE / 2;
    for (const key of Object.keys(corners)) {
      const c = corners[key];
      ctx.fillRect(c.x - half, c.y - half, TEXT_RESIZE_HANDLE_SIZE, TEXT_RESIZE_HANDLE_SIZE);
      ctx.strokeRect(c.x - half, c.y - half, TEXT_RESIZE_HANDLE_SIZE, TEXT_RESIZE_HANDLE_SIZE);
    }
    ctx.restore();
    state.textResizeHandles[clip.clipId] = corners;
  } else {
    delete state.textResizeHandles[clip.clipId];
  }
}

function drawTextOverlays(ctx, textClips, canvasW, canvasH) {
  for (const clip of textClips) {
    try {
      drawSingleTextClip(ctx, clip, canvasW, canvasH);
    } catch (e) {
      // フォント未読込などで失敗しても他のクリップの描画は止めない
    }
  }
}

function updatePreview(sec) {
  const canvas = el.previewCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let activeVisual = null;
  const activeTexts = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const start = clip.timelineStart;
      const end = start + (clip.trimEnd - clip.trimStart);
      if (sec < start || sec >= end) continue;
      if (clip.kind === "image" || clip.kind === "video") {
        activeVisual = clip; // 後のトラックほど上に重なる
      } else if (clip.kind === "text") {
        activeTexts.push(clip); // 複数重なっていてもすべて描く(後のトラックほど上)
      }
    }
  }

  const stillPlayingSameVideo =
    state.isPlaying &&
    activeVisual &&
    activeVisual.kind === "video" &&
    state.previewVideoClipId === activeVisual.clipId;

  if (!stillPlayingSameVideo) pausePreviewVideo();

  if (activeVisual && activeVisual.kind === "image") {
    loadImage(activeVisual.fileId, activeVisual.url)
      .then((img) => {
        drawMediaFit(ctx, img, canvas.width, canvas.height);
        drawTextOverlays(ctx, activeTexts, canvas.width, canvas.height);
      })
      .catch(() => {});
    return;
  }

  if (activeVisual && activeVisual.kind === "video") {
    const offsetIntoClip = activeVisual.trimStart + (sec - activeVisual.timelineStart);
    const videoEl = getOrCreateVideoEl(activeVisual.fileId, activeVisual.url);

    if (!state.isPlaying) {
      // スクラブ/停止中: 対象フレームへシークしてから1回だけ描画する
      seekAndDrawVideo(activeVisual, offsetIntoClip, ctx, canvas.width, canvas.height);
      drawTextOverlays(ctx, activeTexts, canvas.width, canvas.height);
      return;
    }

    if (!stillPlayingSameVideo) {
      // このクリップの再生に入った最初のフレーム: 開始位置へシークして再生を始める
      state.previewVideoEl = videoEl;
      state.previewVideoClipId = activeVisual.clipId;
      videoEl.currentTime = Math.max(0, offsetIntoClip);
      videoEl.play().catch(() => {}); // 自動再生ポリシー等で失敗しても致命的ではないため無視する
    }

    // 2フレーム目以降は改めてシークせず、動画が自然に進めている現在のフレームをそのまま描く
    try {
      if (videoEl.readyState >= 2) drawMediaFit(ctx, videoEl, canvas.width, canvas.height);
    } catch (e) {
      // デコードが追いついていない等でまだ描画できない場合は、そのフレームは諦めて次を待つ
    }
  }

  // 画像・動画の同期描画パス、および何も表示すべきものが無い(黒背景の)場合はここでテキストを重ねる
  drawTextOverlays(ctx, activeTexts, canvas.width, canvas.height);
}

// ---------- プレビュー画面でのテキストドラッグ配置 ----------
// 一般的な動画編集ソフトと同様、テキストクリップをプレビュー画面上で直接ドラッグして
// 位置(画面上の相対座標)を変更できるようにする。

function canvasCoordsFromEvent(e) {
  const canvas = el.previewCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

// 指定した座標(canvas内部座標)に重なる、現在再生ヘッド位置で表示されているテキストクリップを探す。
// 複数重なっている場合は後のトラックのもの(=見た目で一番上にあるもの)を優先する。
function findTextClipAtPoint(x, y) {
  let found = null;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "text") continue;
      const start = clip.timelineStart;
      const end = start + (clip.trimEnd - clip.trimStart);
      if (state.playheadSec < start || state.playheadSec >= end) continue; // 今表示されていないものは対象外
      const box = state.textBoundingBoxes[clip.clipId];
      if (!box) continue;
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        found = clip; // 後で見つかったものほど上書き = 見た目で一番上のものが残る
      }
    }
  }
  return found;
}

// 指定した座標(canvas内部座標)が、選択中クリップの四隅リサイズハンドルに重なっているか調べる
function findResizeHandleAtPoint(x, y) {
  if (!state.selectedClipId) return null;
  const handles = state.textResizeHandles[state.selectedClipId];
  if (!handles) return null;
  const half = TEXT_RESIZE_HANDLE_SIZE / 2 + 4; // 少し広めに当たり判定を取り、つかみやすくする
  for (const corner of Object.keys(handles)) {
    const h = handles[corner];
    if (x >= h.x - half && x <= h.x + half && y >= h.y - half && y <= h.y + half) {
      return corner;
    }
  }
  return null;
}

function startTextMove(clip, x, y) {
  state.selectedClipId = clip.clipId;
  const pos = clip.position || DEFAULT_TEXT_POSITION;
  const canvas = el.previewCanvas;
  const dragOffset = {
    x: x - pos.x * canvas.width,
    y: y - pos.y * canvas.height,
  };
  el.previewCanvas.style.cursor = "grabbing";
  renderAll(); // タイムライン側の選択状態(枠のハイライト)も同期する

  function onMove(ev) {
    const p = canvasCoordsFromEvent(ev);
    const newX = (p.x - dragOffset.x) / canvas.width;
    const newY = (p.y - dragOffset.y) / canvas.height;
    clip.position = {
      x: Math.max(0, Math.min(1, newX)),
      y: Math.max(0, Math.min(1, newY)),
    };
    updatePreview(state.playheadSec);
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    el.previewCanvas.style.cursor = "default";
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// 四隅のハンドルをドラッグして文字サイズを変える。ドラッグした角の対角(固定角)からの距離の
// 比率をそのまま拡大率とし、固定角が画面上で動かないように中心位置(position)を再計算する。
function startTextResize(clip, corner) {
  const canvas = el.previewCanvas;
  const handles = state.textResizeHandles[clip.clipId];
  if (!handles) return;

  const pad = 8;
  const oppositeOf = {
    "top-left": "bottom-right",
    "top-right": "bottom-left",
    "bottom-left": "top-right",
    "bottom-right": "top-left",
  };
  const dragged = handles[corner];
  const fixed = handles[oppositeOf[corner]];
  const startDist = Math.hypot(dragged.x - fixed.x, dragged.y - fixed.y) || 1;
  const startFontSize = clip.fontSize || DEFAULT_TEXT_FONT_SIZE;
  const isLeft = corner.endsWith("left");
  const isTop = corner.startsWith("top");

  el.previewCanvas.style.cursor = isLeft === isTop ? "nwse-resize" : "nesw-resize";

  function onMove(ev) {
    const p = canvasCoordsFromEvent(ev);
    const currentDist = Math.hypot(p.x - fixed.x, p.y - fixed.y);
    const scale = Math.max(0.1, currentDist / startDist);
    clip.fontSize = Math.max(MIN_TEXT_FONT_SIZE, Math.min(MAX_TEXT_FONT_SIZE, startFontSize * scale));

    // 新しいフォントサイズでの寸法を測り直し、固定角の画面上の位置が変わらないよう中心を再計算する
    const ctx = canvas.getContext("2d");
    ctx.font = textClipFontCss(clip.fontKey, clip.fontSize);
    const lineHeight = clip.fontSize * 1.3;
    const maxWidthPx = canvas.width * TEXT_MAX_WIDTH_RATIO;
    const lines = wrapTextToWidth(ctx, clip.text || "", maxWidthPx);
    const newWidth = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
    const newHeight = lines.length * lineHeight;

    const newCenterX = isLeft ? fixed.x - pad - newWidth / 2 : fixed.x + pad + newWidth / 2;
    const newCenterY = isTop ? fixed.y - pad - newHeight / 2 : fixed.y + pad + newHeight / 2;
    clip.position = {
      x: Math.max(0, Math.min(1, newCenterX / canvas.width)),
      y: Math.max(0, Math.min(1, newCenterY / canvas.height)),
    };
    updatePreview(state.playheadSec);
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    el.previewCanvas.style.cursor = "default";
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

el.previewCanvas.addEventListener("mousedown", (e) => {
  const { x, y } = canvasCoordsFromEvent(e);

  const handleCorner = findResizeHandleAtPoint(x, y);
  if (handleCorner) {
    e.preventDefault();
    const found = findClip(state.selectedClipId);
    if (found) startTextResize(found.clip, handleCorner);
    return;
  }

  const clip = findTextClipAtPoint(x, y);
  if (!clip) return;
  e.preventDefault();
  startTextMove(clip, x, y);
});

// ダブルクリックで、選択中のテキストクリップの内容を直接編集するパネルを開く
el.previewCanvas.addEventListener("dblclick", (e) => {
  const { x, y } = canvasCoordsFromEvent(e);
  const clip = findTextClipAtPoint(x, y);
  if (!clip) return;
  e.preventDefault();
  openTextPanel("edit", { clip }, e.clientX, e.clientY);
});

// ドラッグ中でない時は、ハンドル/テキストの上にカーソルが来たら操作できることを示す
el.previewCanvas.addEventListener("mousemove", (e) => {
  const { x, y } = canvasCoordsFromEvent(e);
  const handleCorner = findResizeHandleAtPoint(x, y);
  if (handleCorner) {
    const isLeft = handleCorner.endsWith("left");
    const isTop = handleCorner.startsWith("top");
    el.previewCanvas.style.cursor = isLeft === isTop ? "nwse-resize" : "nesw-resize";
    return;
  }
  el.previewCanvas.style.cursor = findTextClipAtPoint(x, y) ? "grab" : "default";
});

// ---------- アップロード ----------

el.fileInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    await uploadFile(file);
  }
  e.target.value = "";
  renderAll();
});

// アップロード/AI生成のレスポンス(通常アップロードと同じ形式のJSON)から新しいトラック+
// クリップを1つ作ってstateに追加する。戻り値は作成したclip。
function addTrackFromAssetResponse(data, labelOverride) {
  trackCounter += 1;
  const trackId = `t${trackCounter}`;
  const clip = {
    clipId: `c${++clipCounter}`,
    fileId: data.id,
    ext: data.ext,
    kind: data.kind || "audio", // "audio" | "image" | "video"
    filename: data.filename,
    url: data.url,
    // srcDurationはトリミング右ハンドルで伸ばせる上限。音声・動画は元ファイルの長さそのもの、
    // 画像は「静止画として表示できる上限秒数」(maxDuration)を使う。
    srcDuration: data.maxDuration ?? data.duration,
    trimStart: 0,
    trimEnd: data.duration,
    timelineStart: 0,
    trackId,
  };
  state.tracks.push({ trackId, trackType: "media", label: labelOverride || data.filename, clips: [clip] });
  preloadClipMedia(clip);
  return clip;
}

// クリップの種類に応じて、プレビュー/再生に備えたプリロードをしておく
function preloadClipMedia(clip) {
  if (clip.kind === "image") {
    loadImage(clip.fileId, clip.url).catch(() => {});
  } else if (clip.kind === "video") {
    getOrCreateVideoEl(clip.fileId, clip.url); // <video>のsrcをセットするだけでロードが始まる
  } else {
    loadBuffer(clip.fileId, clip.url).catch(() => {});
  }
}

async function uploadFile(file) {
  setStatus(`アップロード中: ${file.name} ...`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "アップロードに失敗しました"}`, true);
      return;
    }
    addTrackFromAssetResponse(data);
    setStatus(`追加しました: ${file.name}`);
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
}

// ---------- 描画 ----------

function timelineTotalDuration() {
  let maxT = 30;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + (clip.trimEnd - clip.trimStart);
      if (end > maxT) maxT = end;
    }
  }
  return maxT + 15;
}

// 実際の音声コンテンツの長さ(最後のクリップの終端)。ルーラー表示用の余白は含まない。
function contentDurationSec() {
  let maxT = 0;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + (clip.trimEnd - clip.trimStart);
      if (end > maxT) maxT = end;
    }
  }
  return maxT;
}

// 画面上部の「現在位置 / 合計時間」表示を更新する
function updateTimeDisplay(currentSec) {
  const cur = currentSec !== undefined ? currentSec : state.playheadSec;
  el.currentTimeLabel.textContent = fmtTime(cur);
  el.totalTimeLabel.textContent = fmtTime(contentDurationSec());
}

function renderRuler() {
  const total = timelineTotalDuration();
  el.ruler.innerHTML = "";
  el.ruler.style.width = `${total * PX_PER_SEC}px`;
  for (let s = 0; s <= total; s += 5) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${s * PX_PER_SEC}px`;
    tick.textContent = fmtTime(s);
    el.ruler.appendChild(tick);
  }
}

// トラック1行分の(ラベル+レーン)DOMを組み立てる。メディア/オーバーレイ共通で使う。
function buildTrackRow(track, total) {
  const row = document.createElement("div");
  row.className = "track-row";

  const label = document.createElement("div");
  label.className = "track-label";

  // オーバーレイトラックは、内容の編集やクリップの移動で古くならないよう、
  // 表示のたびに先頭クリップのテキスト(1行目)からラベルを作る
  const labelStr =
    track.trackType === "overlay" && track.clips[0]
      ? `📝 ${(track.clips[0].text || "").split("\n")[0]}`
      : track.label;
  const labelText = document.createElement("span");
  labelText.className = "track-label-text";
  labelText.textContent = labelStr;
  labelText.title = labelStr;
  label.appendChild(labelText);

  const trackDeleteBtn = document.createElement("button");
  trackDeleteBtn.className = "track-delete-btn";
  const isTextTrack = track.trackType === "overlay";
  trackDeleteBtn.title = isTextTrack ? "このトラックを削除" : "このファイルをサーバーから削除";
  trackDeleteBtn.textContent = "🗑";
  trackDeleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTrackFile(track);
  });
  label.appendChild(trackDeleteBtn);

  row.appendChild(label);

  const lane = document.createElement("div");
  lane.className = "track-lane";
  lane.style.width = `${total * PX_PER_SEC}px`;
  lane.dataset.trackId = track.trackId;
  lane.dataset.trackType = track.trackType || "media";
  lane.addEventListener("click", (e) => {
    if (e.target === lane) seekFromClientX(e.clientX, lane);
  });

  for (const clip of track.clips) {
    lane.appendChild(buildClipEl(clip));
  }

  row.appendChild(lane);
  return row;
}

// オーバーレイ区画の見出し行。常に表示し、ここの「+」から新しいオーバーレイ(テキスト)
// トラックを追加できるようにする(オーバーレイが1つも無くても位置が変わらない)。
function buildOverlayHeaderRow(total) {
  const row = document.createElement("div");
  row.className = "track-row overlay-header-row";

  const label = document.createElement("div");
  label.className = "track-label overlay-header-label";
  const addBtn = document.createElement("button");
  addBtn.className = "btn overlay-add-btn";
  addBtn.textContent = "+ オーバーレイ";
  addBtn.title = "新しいオーバーレイ(テキスト)トラックを追加";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = addBtn.getBoundingClientRect();
    openTextPanel("add", { trackId: null, timelineStart: state.playheadSec }, rect.right + 4, rect.top);
  });
  label.appendChild(addBtn);
  row.appendChild(label);

  const lane = document.createElement("div");
  lane.className = "track-lane overlay-header-lane";
  lane.style.width = `${total * PX_PER_SEC}px`;
  const laneLabel = document.createElement("span");
  laneLabel.className = "overlay-header-lane-text";
  laneLabel.textContent = "オーバーレイ(テキスト) — クリップを上下にドラッグして別のオーバーレイへ移動できます";
  lane.appendChild(laneLabel);
  row.appendChild(lane);

  return row;
}

function renderAll() {
  el.emptyHint.style.display = state.tracks.length === 0 ? "block" : "none";
  renderRuler();
  updateTimeDisplay();

  // 既存の track-row / playhead を削除して再構築
  el.tracksContainer.querySelectorAll(".track-row, .playhead").forEach((n) => n.remove());

  const total = timelineTotalDuration();
  const mediaTracks = state.tracks.filter((t) => t.trackType !== "overlay");
  const overlayTracks = state.tracks.filter((t) => t.trackType === "overlay");

  for (const track of mediaTracks) {
    el.tracksContainer.appendChild(buildTrackRow(track, total));
  }

  el.tracksContainer.appendChild(buildOverlayHeaderRow(total));
  for (const track of overlayTracks) {
    el.tracksContainer.appendChild(buildTrackRow(track, total));
  }

  const playhead = document.createElement("div");
  playhead.className = "playhead";
  playhead.id = "playheadEl";
  playhead.style.left = `${LABEL_WIDTH + state.playheadSec * PX_PER_SEC}px`;

  const handle = document.createElement("div");
  handle.className = "playhead-handle";
  playhead.appendChild(handle);
  attachScrub(handle, el.ruler); // つまみ(丸)からもスクラブできるようにする。座標計算はルーラー基準。

  el.tracksContainer.appendChild(playhead);

  updatePreview(state.playheadSec);
}

const CLIP_KIND_ICON = { image: "🖼 ", video: "🎬 ", text: "📝 " };

function buildClipEl(clip) {
  const dur = clip.trimEnd - clip.trimStart;
  const div = document.createElement("div");
  const kindClass =
    clip.kind === "image" ? " clip-image" :
    clip.kind === "video" ? " clip-video" :
    clip.kind === "text" ? " clip-text" : "";
  div.className = "clip" + kindClass + (state.selectedClipId === clip.clipId ? " selected" : "");
  div.style.left = `${clip.timelineStart * PX_PER_SEC}px`;
  div.style.width = `${Math.max(dur * PX_PER_SEC, 10)}px`;
  div.dataset.clipId = clip.clipId;

  const labelDiv = document.createElement("div");
  labelDiv.className = "clip-label";
  const labelText = clip.kind === "text" ? (clip.text || "").split("\n")[0] : clip.filename;
  labelDiv.textContent = (CLIP_KIND_ICON[clip.kind] || "") + labelText;
  div.appendChild(labelDiv);

  const leftHandle = document.createElement("div");
  leftHandle.className = "handle left";
  div.appendChild(leftHandle);

  const rightHandle = document.createElement("div");
  rightHandle.className = "handle right";
  div.appendChild(rightHandle);

  div.addEventListener("click", (e) => {
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    renderAll();
  });

  // テキストクリップはタイムライン上でダブルクリックしても直接編集パネルを開ける
  // (プレビュー画面でダブルクリックする場合と同じ動作)
  if (clip.kind === "text") {
    div.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const rect = div.getBoundingClientRect();
      openTextPanel("edit", { clip }, rect.left, rect.bottom + 4);
    });
  }

  attachDrag(div, clip);
  attachResize(leftHandle, clip, "left");
  attachResize(rightHandle, clip, "right");

  return div;
}

function findClip(clipId) {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.clipId === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

// ---------- スナップ(自動吸着) ----------
// クリップの移動・トリミング時に、きりのいい秒数(1秒刻みのグリッド)や、
// 他のクリップの端(特にカットでできた前後のパート)に近づいたら自動でぴったり合わせる。

// 指定クリップ以外の、全トラック上のクリップの開始・終了位置をスナップ候補として集める
function collectSnapCandidates(excludeClipId) {
  const candidates = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.clipId === excludeClipId) continue;
      candidates.push(clip.timelineStart);
      candidates.push(clip.timelineStart + (clip.trimEnd - clip.trimStart));
    }
  }
  return candidates;
}

// targetに最も近いスナップ候補(グリッド or 他クリップの端)への補正量(秒)を返す。
// しきい値内に候補が無ければnullを返す。
function bestSnapDelta(target, edgeCandidates) {
  const thresholdSec = SNAP_PX_THRESHOLD / PX_PER_SEC;
  const candidates = edgeCandidates.concat([Math.round(target / GRID_SNAP_SEC) * GRID_SNAP_SEC]);

  let best = null;
  let bestDist = thresholdSec;
  for (const c of candidates) {
    if (c < 0) continue; // タイムラインは0秒以降のみ
    const dist = Math.abs(c - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = c - target;
    }
  }
  return best;
}

// ---------- ドラッグ移動 ----------

// オーバーレイ(テキスト)トラックのレーンの画面上の位置を集める。クリップを上下にドラッグして
// 別のオーバーレイへ移す時の、ドロップ先判定に使う(ドラッグ開始時に1回だけ取得する)。
function collectOverlayLaneRects() {
  const rects = [];
  document.querySelectorAll('.track-lane[data-track-type="overlay"]').forEach((laneEl) => {
    const r = laneEl.getBoundingClientRect();
    rects.push({ trackId: laneEl.dataset.trackId, top: r.top, bottom: r.bottom, el: laneEl });
  });
  return rects;
}

// クリップを別のオーバーレイトラックへ移す(タイムライン上の開始位置はそのまま)。
// 移動元のトラックが空になった場合は、他のクリップ削除時と同様にトラックごと取り除く。
function moveClipToTrack(clip, newTrackId) {
  const oldTrack = state.tracks.find((t) => t.trackId === clip.trackId);
  const newTrack = state.tracks.find((t) => t.trackId === newTrackId);
  if (!oldTrack || !newTrack || oldTrack === newTrack) return;
  if (oldTrack.trackType !== "overlay" || newTrack.trackType !== "overlay") return;

  oldTrack.clips = oldTrack.clips.filter((c) => c.clipId !== clip.clipId);
  clip.trackId = newTrack.trackId;
  newTrack.clips.push(clip);
  if (oldTrack.clips.length === 0) {
    state.tracks = state.tracks.filter((t) => t.trackId !== oldTrack.trackId);
  }
}

function attachDrag(clipEl, clip) {
  clipEl.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("handle")) return;
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    const startX = e.clientX;
    const startTimelineStart = clip.timelineStart;
    const dur = clip.trimEnd - clip.trimStart;
    const snapCandidates = collectSnapCandidates(clip.clipId);

    // オーバーレイのクリップだけ、上下にドラッグして別のオーバーレイトラックへ移動できる。
    // ドラッグ中はドロップ先の行を強調表示するだけにして、実際の付け替えは指を離した時に行う。
    const owner = findClip(clip.clipId);
    const isOverlayClip = !!owner && owner.track.trackType === "overlay";
    const overlayLanes = isOverlayClip ? collectOverlayLaneRects() : [];
    let targetTrackId = clip.trackId;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;
      let newStart = Math.max(0, startTimelineStart + deltaSec);

      // クリップの開始端・終了端のどちらか近い方をスナップさせる
      const startDelta = bestSnapDelta(newStart, snapCandidates);
      const endDelta = bestSnapDelta(newStart + dur, snapCandidates);
      if (startDelta !== null && (endDelta === null || Math.abs(startDelta) <= Math.abs(endDelta))) {
        newStart += startDelta;
      } else if (endDelta !== null) {
        newStart += endDelta;
      }

      clip.timelineStart = Math.max(0, newStart);
      clipEl.style.left = `${clip.timelineStart * PX_PER_SEC}px`;

      if (isOverlayClip) {
        const hit = overlayLanes.find((l) => ev.clientY >= l.top && ev.clientY <= l.bottom);
        targetTrackId = hit ? hit.trackId : clip.trackId;
        for (const l of overlayLanes) {
          l.el.classList.toggle("drop-target", l.trackId === targetTrackId && l.trackId !== clip.trackId);
        }
      }
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      for (const l of overlayLanes) l.el.classList.remove("drop-target");
      if (isOverlayClip && targetTrackId !== clip.trackId) {
        moveClipToTrack(clip, targetTrackId);
      }
      renderAll();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- トリミング(端のドラッグ) ----------

function attachResize(handleEl, clip, side) {
  handleEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    const startX = e.clientX;
    const startTrimStart = clip.trimStart;
    const startTrimEnd = clip.trimEnd;
    const startTimelineStart = clip.timelineStart;
    const snapCandidates = collectSnapCandidates(clip.clipId);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;

      if (side === "left") {
        let newTrimStart = startTrimStart + deltaSec;
        newTrimStart = Math.max(0, Math.min(newTrimStart, startTrimEnd - 0.05));
        let actualDelta = newTrimStart - startTrimStart;
        let newTimelineStart = Math.max(0, startTimelineStart + actualDelta);

        // 左端(タイムライン上の開始位置)をスナップさせ、trimStartも整合を取り直す
        const snapDelta = bestSnapDelta(newTimelineStart, snapCandidates);
        if (snapDelta !== null) {
          newTimelineStart += snapDelta;
          actualDelta = newTimelineStart - startTimelineStart;
          newTrimStart = Math.max(0, Math.min(startTrimStart + actualDelta, startTrimEnd - 0.05));
          actualDelta = newTrimStart - startTrimStart;
          newTimelineStart = Math.max(0, startTimelineStart + actualDelta);
        }

        clip.trimStart = newTrimStart;
        clip.timelineStart = newTimelineStart;
      } else {
        let newTrimEnd = startTrimEnd + deltaSec;
        newTrimEnd = Math.min(clip.srcDuration, Math.max(newTrimEnd, startTrimStart + 0.05));

        // 右端(タイムライン上の終了位置)をスナップさせ、trimEndへ逆算する
        const newEndOnTimeline = clip.timelineStart + (newTrimEnd - clip.trimStart);
        const snapDelta = bestSnapDelta(newEndOnTimeline, snapCandidates);
        if (snapDelta !== null) {
          const snappedEndOnTimeline = newEndOnTimeline + snapDelta;
          let snappedTrimEnd = clip.trimStart + (snappedEndOnTimeline - clip.timelineStart);
          snappedTrimEnd = Math.min(clip.srcDuration, Math.max(snappedTrimEnd, startTrimStart + 0.05));
          newTrimEnd = snappedTrimEnd;
        }

        clip.trimEnd = newTrimEnd;
      }
      renderAll();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- カット / 削除 ----------

el.cutBtn.addEventListener("click", () => {
  if (!state.selectedClipId) {
    setStatus("カットするクリップを選択してください", true);
    return;
  }
  const found = findClip(state.selectedClipId);
  if (!found) return;
  const { clip, track } = found;

  const clipStartT = clip.timelineStart;
  const clipEndT = clip.timelineStart + (clip.trimEnd - clip.trimStart);
  const playhead = state.playheadSec;

  if (playhead <= clipStartT + 0.05 || playhead >= clipEndT - 0.05) {
    setStatus("カットしたい位置に再生ヘッドを合わせてから実行してください", true);
    return;
  }

  const cutLocal = clip.trimStart + (playhead - clipStartT); // 元ファイル内でのカット位置

  const clipB = {
    ...clip,
    clipId: `c${++clipCounter}`,
    trimStart: cutLocal,
    timelineStart: clip.timelineStart + (cutLocal - clip.trimStart),
  };
  clip.trimEnd = cutLocal;

  const idx = track.clips.indexOf(clip);
  track.clips.splice(idx + 1, 0, clipB);

  setStatus("カットしました。2つのクリップに分割されました。");
  renderAll();
});

el.deleteBtn.addEventListener("click", () => {
  if (!state.selectedClipId) {
    setStatus("削除するクリップを選択してください", true);
    return;
  }
  const found = findClip(state.selectedClipId);
  if (!found) return;
  const { clip, track } = found;
  track.clips = track.clips.filter((c) => c.clipId !== clip.clipId);
  if (track.clips.length === 0) {
    state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);
  }
  state.selectedClipId = null;
  renderAll();
});

// トラック1つ分のファイル(音声/画像)をサーバーから削除し、タイムラインからも取り除く
async function deleteTrackFile(track) {
  const fileId = track.clips[0]?.fileId;

  if (fileId) {
    if (!confirm(`「${track.label}」をサーバーから完全に削除します。よろしいですか?`)) {
      return;
    }
    setStatus(`削除中: ${track.label} ...`);
    try {
      const res = await fetch(`/api/uploads/${fileId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`エラー: ${data.error || "削除に失敗しました"}`, true);
        return;
      }
    } catch (err) {
      setStatus(`通信エラー: ${err}`, true);
      return;
    }
    delete state.bufferCache[fileId];
    delete state.imageCache[fileId];
    delete state.videoCache[fileId];
  }

  if (track.clips.some((c) => c.clipId === state.selectedClipId)) {
    state.selectedClipId = null;
  }
  state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);

  setStatus(`削除しました: ${track.label}`);
  renderAll();
}

// サーバーに保存されているファイル(音声/画像)を(前回セッション分も含めて)まとめて削除する
el.clearUploadsBtn.addEventListener("click", async () => {
  if (!confirm("サーバーに保存されている音声・画像ファイルを全て削除します。よろしいですか?\n(現在編集中のタイムラインも空になります)")) {
    return;
  }
  setStatus("素材を全削除中...");
  try {
    const res = await fetch("/api/uploads", { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "削除に失敗しました"}`, true);
      return;
    }
    stopPlayback();
    state.tracks = [];
    state.selectedClipId = null;
    state.bufferCache = {};
    state.imageCache = {};
    state.videoCache = {};
    setStatus(`削除しました(${data.deleted ?? 0}件)`);
    renderAll();
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
});

// ---------- 再生ヘッド / シーク ----------

function seekFromClientX(clientX, referenceEl) {
  const rect = referenceEl.getBoundingClientRect();
  const x = clientX - rect.left;
  let sec = Math.max(0, x / PX_PER_SEC);

  // グリッド(1秒刻み)や他クリップの端(カットでできた前後のパートなど)に近ければスナップさせる。
  // 「カット」は再生ヘッドの位置で行われるため、これによりカット位置もぴったり合わせられる。
  const snapDelta = bestSnapDelta(sec, collectSnapCandidates());
  if (snapDelta !== null) {
    sec = Math.max(0, sec + snapDelta);
  }

  state.playheadSec = sec;
  renderPlayheadOnly();
}

// ドラッグ中はクリップを再構築せず、再生ヘッドの位置だけ動かす(軽量・無段階)
function renderPlayheadOnly() {
  const playheadEl = document.getElementById("playheadEl");
  if (playheadEl) {
    playheadEl.style.left = `${LABEL_WIDTH + state.playheadSec * PX_PER_SEC}px`;
  }
  updateTimeDisplay(state.playheadSec);
  updatePreview(state.playheadSec);
}

// ルーラー、または再生ヘッドのつまみを押しながら動かす(スクラブ)ことで
// 無段階に再生ヘッドを移動できるようにする。
// triggerEl: mousedownを検知する要素 / referenceEl: 座標(秒)計算の基準にする要素
function attachScrub(triggerEl, referenceEl = triggerEl) {
  triggerEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.isPlaying) {
      stopPlayback();
    }
    seekFromClientX(e.clientX, referenceEl);

    function onMove(ev) {
      seekFromClientX(ev.clientX, referenceEl);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

attachScrub(el.ruler);
// ---------- 再生 / 停止 ----------

function stopPlayback() {
  state.isPlaying = false;
  pausePreviewVideo(); // プレビュー用に再生していた<video>があれば止める
  state.activeSources.forEach((source) => {
    try {
      source.stop();
    } catch (e) {
      // 既に再生を終えたノードのstop()はエラーになるだけなので無視してよい
    }
  });
  state.activeSources = [];
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

el.playBtn.addEventListener("click", async () => {
  stopPlayback();
  const ctx = getAudioContext();
  state.isPlaying = true;
  const startPlayhead = state.playheadSec;

  // 再生対象のクリップを先に洗い出す。Web Audioでサンプル精度スケジュールできるのは
  // kind="audio"のクリップのみ。画像には音声データが無く、動画クリップに埋め込まれた
  // 音声はこのプレビュー再生エンジンでは扱わない(書き出し時のみ合流する)ため、
  // どちらもスケジューリング対象からは除外し、代わりにtickPlayhead側のupdatePreview()で
  // タイムラインに同期して表示だけを切り替える。
  const targets = [];
  let hasRemainingContent = false;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const dur = clip.trimEnd - clip.trimStart;
      const clipStartT = clip.timelineStart;
      const clipEndT = clip.timelineStart + dur;
      if (clipEndT <= startPlayhead) continue; // 既に終わっている
      hasRemainingContent = true;
      if (clip.kind !== "audio") continue;
      targets.push({ clip, clipStartT, clipEndT });
    }
  }

  if (!hasRemainingContent) {
    setStatus("再生できるクリップがありません", true);
    state.isPlaying = false;
    return;
  }

  // 全クリップの音声データを先に確保してから、まとめて同じ基準時刻でスケジュールする。
  // バラバラにawaitすると、クリップごとの再生開始タイミングがズレてカットした
  // 境目にノイズが生じるため。(画像のみの区間の場合はtargetsが空のままでよい)
  let buffers = [];
  if (targets.length > 0) {
    try {
      buffers = await Promise.all(targets.map((t) => loadBuffer(t.clip.fileId, t.clip.url)));
    } catch (err) {
      setStatus(`音声の読み込みに失敗しました: ${err}`, true);
      state.isPlaying = false;
      return;
    }
  }

  if (!state.isPlaying) return; // 読み込み待ちの間に停止/再クリックされていたら何もしない

  // 少し先の時刻を共通の基準にすることで、全クリップをサンプル単位でぴったり同期させる
  const baseWhen = ctx.currentTime + 0.05;
  state.playStartCtxTime = baseWhen;
  state._playStartSec = startPlayhead;

  targets.forEach(({ clip, clipStartT, clipEndT }, i) => {
    const source = ctx.createBufferSource();
    source.buffer = buffers[i];
    source.connect(ctx.destination);

    const offsetIntoClip = clip.trimStart + Math.max(0, startPlayhead - clipStartT);
    const startDelay = Math.max(0, clipStartT - startPlayhead);
    const playDuration = clipEndT - Math.max(clipStartT, startPlayhead);

    source.start(baseWhen + startDelay, offsetIntoClip, playDuration);
    state.activeSources.push(source);
  });

  setStatus("再生中...");
  tickPlayhead();
});

function tickPlayhead() {
  if (!state.isPlaying) return;
  const elapsed = Math.max(0, getAudioContext().currentTime - state.playStartCtxTime);
  const nowSec = state._playStartSec + elapsed;
  const playheadEl = document.getElementById("playheadEl");
  if (playheadEl) {
    playheadEl.style.left = `${LABEL_WIDTH + nowSec * PX_PER_SEC}px`;
  }
  updateTimeDisplay(nowSec);
  updatePreview(nowSec);
  state.rafId = requestAnimationFrame(tickPlayhead);
}

el.stopBtn.addEventListener("click", () => {
  if (state.isPlaying) {
    const elapsed = Math.max(0, getAudioContext().currentTime - state.playStartCtxTime);
    state.playheadSec = state._playStartSec + elapsed;
  }
  stopPlayback();
  setStatus("停止しました");
  renderAll();
});

// ---------- 書き出し(結合) ----------

el.exportBtn.addEventListener("click", async () => {
  const clips = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      clips.push({
        fileId: clip.fileId,
        ext: clip.ext,
        kind: clip.kind,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        timelineStart: clip.timelineStart,
        // テキストクリップはfileId/extを持たない代わりに以下を送る
        text: clip.text,
        fontKey: clip.fontKey,
        fontSize: clip.fontSize,
        positionX: clip.position ? clip.position.x : undefined,
        positionY: clip.position ? clip.position.y : undefined,
      });
    }
  }
  if (clips.length === 0) {
    setStatus("書き出すクリップがありません", true);
    return;
  }

  const fmt = el.formatSelect.value;

  // 対応ブラウザ(Chrome/Edgeなど)では、実際にミックスダウン/合成する前に保存先を選んでもらう。
  // ここでキャンセルされた場合はサーバー側での処理自体を行わない。
  // 非対応ブラウザ(Firefox/Safariなど)では従来通りブラウザのダウンロード機能にお任せする。
  let saveHandle = null;
  if (window.showSaveFilePicker) {
    const typeInfo =
      {
        mp4: { description: "MP4動画", mime: "video/mp4" },
        mp3: { description: "MP3音声", mime: "audio/mpeg" },
        wav: { description: "WAV音声", mime: "audio/wav" },
      }[fmt] || { description: "WAV音声", mime: "audio/wav" };
    try {
      saveHandle = await window.showSaveFilePicker({
        suggestedName: `mix.${fmt}`,
        types: [{ description: typeInfo.description, accept: { [typeInfo.mime]: [`.${fmt}`] } }],
      });
    } catch (err) {
      if (err.name === "AbortError") {
        setStatus("書き出しをキャンセルしました");
      } else {
        setStatus(`保存先の選択に失敗しました: ${err}`, true);
      }
      return;
    }
  }

  setStatus("書き出し中...");
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips, format: fmt }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "書き出しに失敗しました"}`, true);
      return;
    }

    // サーバー上の書き出し結果をこちらで完全に取得してから保存する。
    // (保存方法によらず、取得が終わった時点でサーバー側の一時ファイルを削除できるようにするため)
    const blob = await (await fetch(data.url)).blob();

    if (saveHandle) {
      const writable = await saveHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("書き出し完了。指定した保存先に保存しました。");
    } else {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      setStatus("書き出し完了。ダウンロードを開始します。");
    }

    // ダウンロード(取得)が完了したので、サーバー上に溜まっていく書き出しファイルは削除しておく
    fetch(`/api/exports/${encodeURIComponent(data.filename)}`, { method: "DELETE" }).catch((err) => {
      console.warn("書き出しファイルのサーバー側削除に失敗しました", err);
    });
  } catch (err) {
    setStatus(`書き出しに失敗しました: ${err}`, true);
  }
});

// ---------- Magic Hour AI生成 (画像クリップの右クリックメニュー + プロンプトパネル) ----------

let aiPanelMode = null; // "video" | "image" | "new"
let aiPanelTargetClipId = null;       // "video" / "image" モード: 対象クリップ
let aiPanelTargetTrackId = null;      // "new" モード: 追加先トラック(nullなら新規トラックを作る)
let aiPanelTargetTimelineStart = 0;   // "new" モード: タイムライン上の追加位置(秒)

function closeClipContextMenu() {
  el.clipContextMenu.classList.add("hidden");
}

function showContextMenuAt(clientX, clientY) {
  el.clipContextMenu.classList.remove("hidden");
  // 画面外にはみ出さないよう位置を調整
  const menuRect = el.clipContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuRect.height - 8;
  el.clipContextMenu.style.left = `${Math.max(8, Math.min(clientX, maxX))}px`;
  el.clipContextMenu.style.top = `${Math.max(8, Math.min(clientY, maxY))}px`;
}

// 既存のクリップを右クリックした場合のメニュー。
// 画像クリップ: 動画生成/画像編集、テキストクリップ: テキスト編集、を表示する。
function openClipContextMenuForClip(clip, clientX, clientY) {
  closeAiPanel();
  closeTextPanel();
  el.clipContextMenu.dataset.targetClipId = clip.clipId;
  const isImage = clip.kind === "image";
  const isText = clip.kind === "text";
  el.ctxGenVideoBtn.classList.toggle("hidden", !isImage);
  el.ctxGenImageBtn.classList.toggle("hidden", !isImage);
  el.ctxGenNewImageBtn.classList.add("hidden");
  el.ctxAddTextBtn.classList.add("hidden");
  el.ctxEditTextBtn.classList.toggle("hidden", !isText);
  showContextMenuAt(clientX, clientY);
}

// クリップが無い位置(トラックの空いている部分、またはトラックが1つも無い状態)を
// 右クリックした場合のメニュー(新規画像生成/テキスト追加)。trackIdがnullなら新しいトラックを作る。
// areaType: "overlay"(オーバーレイ側) | "media"(メディア側) | null(どちらか未定=両方出す)。
// オーバーレイのトラックにはテキストだけ、メディアのトラックには画像生成だけを出して、
// 2つの区画に別種のクリップが混ざらないようにする。
function openClipContextMenuForNewImage(trackId, timelineStart, clientX, clientY, areaType = null) {
  closeAiPanel();
  closeTextPanel();
  el.clipContextMenu.dataset.targetTrackId = trackId || "";
  el.clipContextMenu.dataset.targetTimelineStart = String(timelineStart);
  el.ctxGenVideoBtn.classList.add("hidden");
  el.ctxGenImageBtn.classList.add("hidden");
  el.ctxGenNewImageBtn.classList.toggle("hidden", areaType === "overlay");
  el.ctxAddTextBtn.classList.toggle("hidden", areaType === "media");
  el.ctxEditTextBtn.classList.add("hidden");
  showContextMenuAt(clientX, clientY);
}

function closeAiPanel() {
  el.aiActionPanel.classList.add("hidden");
  aiPanelMode = null;
  aiPanelTargetClipId = null;
  aiPanelTargetTrackId = null;
  aiPanelTargetTimelineStart = 0;
}

// AI Image Editor(既存画像の編集)とAI Image Generator(新規生成)は、APIとして
// 対応している縦横比の選択肢がそれぞれ異なる(後者はauto非対応・3種類のみ)ため、
// モードに応じて<select>の中身を作り直す。
function populateAspectRatioSelect(mode) {
  const select = el.aiPanelAspectRatio;
  select.innerHTML = "";
  const options =
    mode === "image"
      ? [
          { value: "", label: "おまかせ (auto)" },
          { value: "1:1", label: "1:1(正方形)" },
          { value: "16:9", label: "16:9(横長)" },
          { value: "9:16", label: "9:16(縦長)" },
          { value: "4:3", label: "4:3(横長)" },
          { value: "3:2", label: "3:2(横長)" },
          { value: "4:5", label: "4:5(縦長)" },
          { value: "2:3", label: "2:3(縦長)" },
        ]
      : [
          { value: "1:1", label: "1:1(正方形)" },
          { value: "16:9", label: "16:9(横長)" },
          { value: "9:16", label: "9:16(縦長)" },
        ];
  for (const opt of options) {
    const optionEl = document.createElement("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    select.appendChild(optionEl);
  }
}

function openAiPanel(mode, ctx, anchorX, anchorY) {
  aiPanelMode = mode;
  el.aiPanelPrompt.value = "";
  el.aiPanelStatus.textContent = "";
  el.aiPanelStatus.classList.remove("error");
  el.aiPanelSubmitBtn.disabled = false;

  if (mode === "video") {
    aiPanelTargetClipId = ctx.clip.clipId;
    const dur = Math.max(1, Math.round(ctx.clip.trimEnd - ctx.clip.trimStart));
    el.aiPanelTitle.textContent = "🎬 この画像から動画を生成";
    el.aiPanelHint.textContent =
      `長さ: ${dur}秒(このクリップのタイムライン上の長さに合わせます)。動画の縦横比はMagic Hourの` +
      `Image-to-Video APIでは個別指定できず、元になる画像の縦横比がそのまま使われます。` +
      `特定の縦横比にしたい場合は、先に画像側(✨の2メニュー)で縦横比を指定して作った画像を` +
      `元に生成してください。生成後、この画像は動画クリップに置き換わります。`;
    el.aiPanelPrompt.placeholder = "動きの指示(任意) 例: ゆっくりカメラが左からパンする";
    el.aiPanelAspectRow.classList.add("hidden");
  } else if (mode === "image") {
    aiPanelTargetClipId = ctx.clip.clipId;
    el.aiPanelTitle.textContent = "✨ この画像を編集して新規生成";
    el.aiPanelHint.textContent = "この画像を元にAIで編集し、新しいトラックとして追加します。";
    el.aiPanelPrompt.placeholder = "編集内容を入力(例: 背景を夕焼けの空に変更して)";
    populateAspectRatioSelect("image");
    el.aiPanelAspectRow.classList.remove("hidden");
  } else {
    // "new": 元になる画像は無く、プロンプトだけから新しい画像を生成する
    aiPanelTargetTrackId = ctx.trackId;
    aiPanelTargetTimelineStart = ctx.timelineStart;
    el.aiPanelTitle.textContent = "✨ 新しい画像を生成";
    el.aiPanelHint.textContent = "プロンプトから新しい画像を生成し、この位置にクリップとして追加します。";
    el.aiPanelPrompt.placeholder = "画像の内容を入力(例: 夕焼けの海辺で笑う猫)";
    populateAspectRatioSelect("new");
    el.aiPanelAspectRow.classList.remove("hidden");
  }

  el.aiActionPanel.classList.remove("hidden");
  const panelRect = el.aiActionPanel.getBoundingClientRect();
  const maxX = window.innerWidth - panelRect.width - 8;
  const maxY = window.innerHeight - panelRect.height - 8;
  el.aiActionPanel.style.left = `${Math.max(8, Math.min(anchorX, maxX))}px`;
  el.aiActionPanel.style.top = `${Math.max(8, Math.min(anchorY, maxY))}px`;
  el.aiPanelPrompt.focus();
}

el.ctxGenVideoBtn.addEventListener("click", (e) => {
  e.stopPropagation(); // documentのクリックリスナーでパネルが即閉じないようにする
  const found = findClip(el.clipContextMenu.dataset.targetClipId);
  const rect = el.clipContextMenu.getBoundingClientRect(); // 閉じる前に位置を取得
  closeClipContextMenu();
  if (!found) return;
  openAiPanel("video", { clip: found.clip }, rect.left, rect.top);
});

el.ctxGenImageBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const found = findClip(el.clipContextMenu.dataset.targetClipId);
  const rect = el.clipContextMenu.getBoundingClientRect();
  closeClipContextMenu();
  if (!found) return;
  openAiPanel("image", { clip: found.clip }, rect.left, rect.top);
});

el.ctxGenNewImageBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const trackId = el.clipContextMenu.dataset.targetTrackId || null;
  const timelineStart = parseFloat(el.clipContextMenu.dataset.targetTimelineStart || "0");
  const rect = el.clipContextMenu.getBoundingClientRect();
  closeClipContextMenu();
  openAiPanel("new", { trackId, timelineStart }, rect.left, rect.top);
});

el.ctxAddTextBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const trackId = el.clipContextMenu.dataset.targetTrackId || null;
  const timelineStart = parseFloat(el.clipContextMenu.dataset.targetTimelineStart || "0");
  const rect = el.clipContextMenu.getBoundingClientRect();
  closeClipContextMenu();
  openTextPanel("add", { trackId, timelineStart }, rect.left, rect.top);
});

el.ctxEditTextBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const found = findClip(el.clipContextMenu.dataset.targetClipId);
  const rect = el.clipContextMenu.getBoundingClientRect();
  closeClipContextMenu();
  if (!found) return;
  openTextPanel("edit", { clip: found.clip }, rect.left, rect.top);
});

el.aiPanelCloseBtn.addEventListener("click", closeAiPanel);

el.aiPanelSubmitBtn.addEventListener("click", async () => {
  const mode = aiPanelMode;
  let clip = null;

  if (mode === "video" || mode === "image") {
    const found = findClip(aiPanelTargetClipId);
    if (!found) {
      el.aiPanelStatus.textContent = "対象のクリップが見つかりません(削除された可能性があります)";
      el.aiPanelStatus.classList.add("error");
      return;
    }
    clip = found.clip;
  }

  const prompt = el.aiPanelPrompt.value.trim();

  if ((mode === "image" || mode === "new") && !prompt) {
    el.aiPanelStatus.textContent = "プロンプトを入力してください";
    el.aiPanelStatus.classList.add("error");
    return;
  }

  el.aiPanelSubmitBtn.disabled = true;
  const startedAt = Date.now();
  const tick = () => {
    el.aiPanelStatus.classList.remove("error");
    el.aiPanelStatus.textContent =
      `生成中...(${Math.floor((Date.now() - startedAt) / 1000)}秒経過。モデルによっては数分かかります)`;
  };
  tick();
  const intervalId = setInterval(tick, 1000);
  const targetTrackId = aiPanelTargetTrackId; // fetch待ちの間に閉じられても参照できるよう退避しておく
  const targetTimelineStart = aiPanelTargetTimelineStart;

  try {
    if (mode === "video") {
      const endSeconds = Math.max(1, Math.round(clip.trimEnd - clip.trimStart));
      const res = await fetch("/api/ai/image-to-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseFileId: clip.fileId,
          baseExt: clip.ext,
          endSeconds,
          prompt: prompt || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "動画の生成に失敗しました");
      replaceClipWithAsset(clip, data);
      setStatus("動画を生成し、タイムラインのクリップと置き換えました");
    } else if (mode === "image") {
      const res = await fetch("/api/ai/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseFileId: clip.fileId,
          baseExt: clip.ext,
          prompt,
          aspectRatio: el.aiPanelAspectRatio.value || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "画像の生成に失敗しました");
      addTrackFromAssetResponse(data);
      setStatus("AIで編集した画像を新しいトラックとして追加しました");
    } else {
      const res = await fetch("/api/ai/generate-new-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, aspectRatio: el.aiPanelAspectRatio.value || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "画像の生成に失敗しました");
      addNewImageClipAt(data, targetTrackId, targetTimelineStart);
      setStatus("新しい画像を生成してタイムラインに追加しました");
    }
    clearInterval(intervalId);
    closeAiPanel();
    renderAll();
  } catch (err) {
    clearInterval(intervalId);
    el.aiPanelStatus.textContent = err.message || String(err);
    el.aiPanelStatus.classList.add("error");
    el.aiPanelSubmitBtn.disabled = false;
  }
});

// 生成された動画で、元の画像クリップを置き換える(同じトラック・同じタイムライン開始位置)
function replaceClipWithAsset(oldClip, data) {
  const track = state.tracks.find((t) => t.clips.some((c) => c.clipId === oldClip.clipId));
  if (!track) return;
  const idx = track.clips.findIndex((c) => c.clipId === oldClip.clipId);
  if (idx === -1) return;

  const newClip = {
    clipId: `c${++clipCounter}`,
    fileId: data.id,
    ext: data.ext,
    kind: data.kind || "video",
    filename: data.filename,
    url: data.url,
    srcDuration: data.maxDuration ?? data.duration,
    trimStart: 0,
    trimEnd: data.duration,
    timelineStart: oldClip.timelineStart,
    trackId: oldClip.trackId,
  };
  track.clips[idx] = newClip;
  if (state.selectedClipId === oldClip.clipId) state.selectedClipId = newClip.clipId;
  preloadClipMedia(newClip);
}

// 新規生成した画像を、指定したトラックの指定位置にクリップとして追加する。
// trackIdがnull、または該当トラックが見つからない場合は新しいトラックを作る。
function addNewImageClipAt(data, trackId, timelineStart) {
  let track = trackId ? state.tracks.find((t) => t.trackId === trackId) : null;
  if (track && track.trackType === "overlay") track = null; // オーバーレイには入れず、新しいメディアトラックを作る

  const clip = {
    clipId: `c${++clipCounter}`,
    fileId: data.id,
    ext: data.ext,
    kind: data.kind || "image",
    filename: data.filename,
    url: data.url,
    srcDuration: data.maxDuration ?? data.duration,
    trimStart: 0,
    trimEnd: data.duration,
    timelineStart: Math.max(0, timelineStart || 0),
    trackId: null,
  };

  if (track) {
    clip.trackId = track.trackId;
    track.clips.push(clip);
  } else {
    trackCounter += 1;
    const newTrackId = `t${trackCounter}`;
    clip.trackId = newTrackId;
    state.tracks.push({ trackId: newTrackId, trackType: "media", label: data.filename, clips: [clip] });
  }

  state.selectedClipId = clip.clipId;
  preloadClipMedia(clip);
}

// ---------- テキストクリップの追加/編集パネル ----------

let textPanelMode = null; // "add" | "edit"
let textPanelTargetClipId = null;      // "edit"モード用
let textPanelTargetTrackId = null;     // "add"モード用(nullなら新規トラックを作る)
let textPanelTargetTimelineStart = 0;  // "add"モード用

function updateTextPanelPreview() {
  const info = FONT_REGISTRY[el.textPanelFont.value] || FONT_REGISTRY[DEFAULT_FONT_KEY];
  el.textPanelPreview.style.fontFamily = `"${info.cssFamily}"`;
  el.textPanelPreview.textContent = el.textPanelContent.value || "プレビュー";
}

function closeTextPanel() {
  el.textEditPanel.classList.add("hidden");
  textPanelMode = null;
  textPanelTargetClipId = null;
  textPanelTargetTrackId = null;
  textPanelTargetTimelineStart = 0;
}

function openTextPanel(mode, ctx, anchorX, anchorY) {
  textPanelMode = mode;
  el.textPanelStatus.textContent = "";
  el.textPanelStatus.classList.remove("error");

  if (mode === "edit") {
    const clip = ctx.clip;
    textPanelTargetClipId = clip.clipId;
    el.textPanelTitle.textContent = "✏️ テキストを編集";
    el.textPanelSubmitBtn.textContent = "更新する";
    el.textPanelContent.value = clip.text || "";
    el.textPanelFont.value = clip.fontKey || DEFAULT_FONT_KEY;
  } else {
    textPanelTargetTrackId = ctx.trackId;
    textPanelTargetTimelineStart = ctx.timelineStart;
    el.textPanelTitle.textContent = "📝 テキストを追加";
    el.textPanelSubmitBtn.textContent = "追加する";
    el.textPanelContent.value = "";
    el.textPanelFont.value = DEFAULT_FONT_KEY;
  }
  updateTextPanelPreview();

  el.textEditPanel.classList.remove("hidden");
  const panelRect = el.textEditPanel.getBoundingClientRect();
  const maxX = window.innerWidth - panelRect.width - 8;
  const maxY = window.innerHeight - panelRect.height - 8;
  el.textEditPanel.style.left = `${Math.max(8, Math.min(anchorX, maxX))}px`;
  el.textEditPanel.style.top = `${Math.max(8, Math.min(anchorY, maxY))}px`;
  el.textPanelContent.focus();
}

el.textPanelContent.addEventListener("input", updateTextPanelPreview);
el.textPanelFont.addEventListener("change", updateTextPanelPreview);
el.textPanelCloseBtn.addEventListener("click", closeTextPanel);

// 新しいテキストクリップを、指定したトラックの指定位置(タイムライン上)に追加する。
// 画面上の表示位置は既定値(下寄り中央)からスタートし、プレビュー画面でのドラッグで調整する。
// trackIdがnull、または該当トラックが見つからない場合は新しいトラックを作る。
function addTextClipAt(trackId, timelineStart, text, fontKey) {
  let track = trackId ? state.tracks.find((t) => t.trackId === trackId) : null;
  if (track && track.trackType !== "overlay") track = null; // メディアのトラックには入れず、新しいオーバーレイを作る

  const clip = {
    clipId: `c${++clipCounter}`,
    kind: "text",
    text,
    fontKey,
    fontSize: DEFAULT_TEXT_FONT_SIZE,
    position: { ...DEFAULT_TEXT_POSITION },
    trimStart: 0,
    trimEnd: DEFAULT_TEXT_DURATION_SEC,
    srcDuration: MAX_TEXT_DURATION_SEC,
    timelineStart: Math.max(0, timelineStart || 0),
    trackId: null,
  };

  if (track) {
    clip.trackId = track.trackId;
    track.clips.push(clip);
  } else {
    trackCounter += 1;
    const newTrackId = `t${trackCounter}`;
    clip.trackId = newTrackId;
    state.tracks.push({ trackId: newTrackId, trackType: "overlay", label: text.split("\n")[0], clips: [clip] });
  }

  state.selectedClipId = clip.clipId;
}

el.textPanelSubmitBtn.addEventListener("click", () => {
  const text = el.textPanelContent.value.trim();
  if (!text) {
    el.textPanelStatus.textContent = "テキストを入力してください";
    el.textPanelStatus.classList.add("error");
    return;
  }
  const fontKey = el.textPanelFont.value;

  if (textPanelMode === "edit") {
    const found = findClip(textPanelTargetClipId);
    if (!found) {
      el.textPanelStatus.textContent = "対象のクリップが見つかりません(削除された可能性があります)";
      el.textPanelStatus.classList.add("error");
      return;
    }
    // 表示位置(position)はプレビュー画面でのドラッグで管理するため、ここでは変更しない
    found.clip.text = text;
    found.clip.fontKey = fontKey;
    setStatus("テキストを更新しました");
  } else {
    addTextClipAt(textPanelTargetTrackId, textPanelTargetTimelineStart, text, fontKey);
    setStatus("テキストを追加しました");
  }

  closeTextPanel();
  renderAll();
});

// メニュー/パネルの外側をクリックしたら閉じる
document.addEventListener("click", (e) => {
  if (!el.clipContextMenu.contains(e.target)) closeClipContextMenu();
  if (!el.aiActionPanel.contains(e.target)) closeAiPanel();
  if (!el.textEditPanel.contains(e.target)) closeTextPanel();
});

// 右クリックの一括ハンドリング:
//   - 画像/テキストクリップ上    -> それぞれ専用のメニュー(動画生成/画像編集/テキスト編集)
//   - トラックラベル上          -> 対象外(通常のブラウザメニューに任せる)
//   - トラックレーンの空き部分  -> そのトラック・その位置に新規画像生成/テキスト追加メニュー
//   - タイムライン領域のそれ以外(トラックが1つも無い場合の空欄など)
//                               -> 新しいトラックの先頭に同上のメニュー
//   - それ以外(ツールバー等)   -> 通常のブラウザメニューに任せ、開いていたUIは閉じる
document.addEventListener("contextmenu", (e) => {
  const clipEl = e.target.closest(".clip.clip-image, .clip.clip-text");
  if (clipEl) {
    e.preventDefault();
    const clipId = clipEl.dataset.clipId;
    const found = findClip(clipId);
    if (!found) return;
    state.selectedClipId = clipId;
    renderAll();
    openClipContextMenuForClip(found.clip, e.clientX, e.clientY);
    return;
  }

  if (e.target.closest(".clip")) {
    // 音声/動画クリップは対象外。通常のブラウザメニューに任せ、開いていたUIは閉じる
    closeClipContextMenu();
    closeAiPanel();
    closeTextPanel();
    return;
  }

  if (e.target.closest(".track-label")) {
    closeClipContextMenu();
    closeAiPanel();
    closeTextPanel();
    return;
  }

  const laneEl = e.target.closest(".track-lane");
  if (laneEl) {
    e.preventDefault();
    const trackId = laneEl.dataset.trackId || null;
    const rect = laneEl.getBoundingClientRect();
    let sec = Math.max(0, (e.clientX - rect.left) / PX_PER_SEC);
    const snapDelta = bestSnapDelta(sec, collectSnapCandidates());
    if (snapDelta !== null) sec = Math.max(0, sec + snapDelta);
    const areaType = laneEl.classList.contains("overlay-header-lane")
      ? "overlay"
      : laneEl.dataset.trackType || null;
    openClipContextMenuForNewImage(trackId, sec, e.clientX, e.clientY, areaType);
    return;
  }

  if (e.target.closest("#tracksContainer")) {
    // トラックが1つも無い状態(空のヒント文言など)を右クリックした場合、
    // 新しいトラックの先頭(0秒)に追加する
    e.preventDefault();
    openClipContextMenuForNewImage(null, 0, e.clientX, e.clientY);
    return;
  }

  closeClipContextMenu();
  closeAiPanel();
  closeTextPanel();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeClipContextMenu();
    closeAiPanel();
    closeSettingsPanel();
    closeTextPanel();
  }
});

// ---------- 設定 (Magic Hour APIキー) ----------

function openSettingsPanel() {
  el.settingsBackdrop.classList.remove("hidden");
  el.settingsPanel.classList.remove("hidden");
  el.settingsApiKeyInput.value = "";
  el.settingsStatus.textContent = "";
  el.settingsStatus.classList.remove("error");
  refreshSettingsKeyStatus();
}

function closeSettingsPanel() {
  el.settingsBackdrop.classList.add("hidden");
  el.settingsPanel.classList.add("hidden");
}

async function refreshSettingsKeyStatus() {
  el.settingsKeyStatus.textContent = "確認中...";
  try {
    const res = await fetch("/api/settings/magic-hour-key");
    const data = await res.json();
    el.settingsKeyStatus.textContent = data.configured
      ? "現在の状態: 設定済み(変更する場合は新しいキーを入力して保存してください)"
      : "現在の状態: 未設定";
  } catch (err) {
    el.settingsKeyStatus.textContent = "状態の確認に失敗しました";
  }
}

async function submitSettingsKey(key) {
  el.settingsSaveBtn.disabled = true;
  el.settingsClearBtn.disabled = true;
  el.settingsStatus.classList.remove("error");
  el.settingsStatus.textContent = "保存中...";
  try {
    const res = await fetch("/api/settings/magic-hour-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "保存に失敗しました");
    el.settingsApiKeyInput.value = "";
    el.settingsStatus.textContent = data.configured ? "保存しました" : "キーを削除しました";
    await refreshSettingsKeyStatus();
  } catch (err) {
    el.settingsStatus.textContent = err.message || String(err);
    el.settingsStatus.classList.add("error");
  } finally {
    el.settingsSaveBtn.disabled = false;
    el.settingsClearBtn.disabled = false;
  }
}

el.settingsBtn.addEventListener("click", openSettingsPanel);
el.settingsCloseBtn.addEventListener("click", closeSettingsPanel);
el.settingsBackdrop.addEventListener("click", closeSettingsPanel);

el.settingsSaveBtn.addEventListener("click", () => {
  const key = el.settingsApiKeyInput.value.trim();
  if (!key) {
    el.settingsStatus.textContent = "キーを入力してください(削除する場合は「キーを削除」を押してください)";
    el.settingsStatus.classList.add("error");
    return;
  }
  submitSettingsKey(key);
});

el.settingsClearBtn.addEventListener("click", () => {
  if (!confirm("設定済みのAPIキーを削除します。よろしいですか?")) return;
  submitSettingsKey("");
});

// 初期描画
renderAll();