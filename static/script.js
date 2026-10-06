// ===== マルチトラック動画・音声エディタ フロントエンド =====

const PX_PER_SEC = 60; // style.css の --px-per-sec と揃える
const LABEL_WIDTH = 150;
const GRID_SNAP_SEC = 1; // グリッドスナップの間隔(秒)。track-laneの背景の縦線(1秒間隔)と揃えている
const SNAP_PX_THRESHOLD = 8; // スナップが効く距離(px)。PX_PER_SECで秒に換算して使う
// クリップを上下に動かして別の行へ移す時の感度。横移動中の多少の手ブレで行が変わらないようにする。
const ROW_CHANGE_START_PX = 24; // 縦にこれ以上動かすまでは、行の移動を始めない(横移動に専念する)
const ROW_CHANGE_INSET_PX = 16; // 別の行へ切り替えるには、その行の上下端からこれ以上内側まで入る必要がある

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
// テキストのfontSizeは、短辺がこの長さ(px)の画面での大きさとして扱い、実際の画面サイズに合わせて
// 拡大縮小する。サーバー側(app.pyのTEXT_REFERENCE_SHORT_SIDE)と揃えること
const TEXT_REFERENCE_SHORT_SIDE = 720;
// 画像・動画クリップのscale(1 = 画面いっぱいに収まる大きさ)の範囲。サーバー側(app.pyのMIN/MAX_MEDIA_SCALE)と揃えること
const MIN_MEDIA_SCALE = 0.1;
const MAX_MEDIA_SCALE = 4;

// 出力画面サイズ(プレビューcanvasの解像度 = 書き出す動画の解像度)の候補。
// サーバー側(app.pyのALLOWED_CANVAS_SIZES)と揃えること
const CANVAS_PRESETS = {
  "1280x720": { w: 1280, h: 720, label: "横長 16:9 (1280×720)" },
  "1920x1080": { w: 1920, h: 1080, label: "横長 16:9 (1920×1080)" },
  "1080x1920": { w: 1080, h: 1920, label: "縦長 9:16 (1080×1920)" },
  "1080x1080": { w: 1080, h: 1080, label: "正方形 1:1 (1080×1080)" },
};
const DEFAULT_CANVAS_PRESET = "1280x720";
const PREVIEW_MAX_HEIGHT_PX = 360; // プレビュー枠の表示上の最大の高さ(16:9の時に幅640pxになる)

const state = {
  tracks: [],       // [{trackId, label, clips: [clip, ...]}]
  selectedClipId: null,
  playheadSec: 0,
  isPlaying: false,
  bufferCache: {},     // fileId -> Promise<AudioBuffer> (デコード済み音声データ、クリップ間で共有)
  imageCache: {},      // fileId -> Promise<HTMLImageElement> (デコード済み画像、クリップ間で共有)
  loadedImages: {},    // fileId -> HTMLImageElement (読み込み完了済みのもの。プレビューの同期描画に使う)
  videoCache: {},      // fileId -> HTMLVideoElement (プレビュー描画用。動画クリップ間で共有)
  activeSources: [],   // 再生中のAudioBufferSourceNode一覧
  rafId: null,
  playStartCtxTime: 0, // 再生開始時のAudioContext.currentTime
  _playStartSec: 0,    // 再生開始時点のタイムライン上の秒数
  playingVideos: {},   // clipId -> HTMLVideoElement 再生中に実際にplay()させているプレビュー用<video>要素
  previewBoxes: {},    // clipId -> {x,y,width,height,pad} 直近の描画結果(プレビューのドラッグ判定に使う)
  previewHandles: null, // {clipId, corners: {corner名 -> {x,y}}} 選択中クリップの四隅ハンドル座標(リサイズ判定に使う)
};

let clipCounter = 0;
let trackCounter = 0;
let overlayCounter = 0; // 「オーバーレイ N」の通し番号(欠番は詰めない)

const el = {
  fileInput: document.getElementById("fileInput"),
  tracksContainer: document.getElementById("tracksContainer"),
  ruler: document.getElementById("ruler"),
  status: document.getElementById("status"),
  playBtn: document.getElementById("playBtn"),
  stopBtn: document.getElementById("stopBtn"),
  cutBtn: document.getElementById("cutBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  clearUploadsBtn: document.getElementById("clearUploadsBtn"),
  exportBtn: document.getElementById("exportBtn"),
  formatSelect: document.getElementById("formatSelect"),
  canvasSizeSelect: document.getElementById("canvasSizeSelect"),
  previewWrap: document.getElementById("previewWrap"),
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
      img.onload = () => {
        // プレビューは同期的に描くため、読み込み済みの<img>をここに置いておく。
        // 読み込み前の描画ではこの画像が抜けているので、停止中なら描き直す。
        state.loadedImages[fileId] = img;
        if (!state.isPlaying) updatePreview(state.playheadSec);
        resolve(img);
      };
      img.onerror = () => reject(new Error(`画像の読み込みに失敗しました: ${url}`));
      img.src = url;
    });
  }
  return state.imageCache[fileId];
}

// 動画クリップ用の非表示<video>要素を(無ければ作って)返す。停止中はcurrentTimeをシークして
// フレームを取り出し、再生中はplay()させて今映っているフレームをそのまま描く。
function getOrCreateVideoEl(fileId, url) {
  if (!state.videoCache[fileId]) {
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    // 最初のフレームの読み込み完了時・シーク完了時に、停止中ならプレビュー全体を描き直す
    // (重なり順を保つため、この動画だけを後から上書き描画することはしない)
    const redraw = () => {
      if (!state.isPlaying) updatePreview(state.playheadSec);
    };
    v.addEventListener("loadeddata", redraw);
    v.addEventListener("seeked", redraw);
    state.videoCache[fileId] = v;
  }
  return state.videoCache[fileId];
}

// プレビューcanvasの内部座標1pxが、画面上で何pxに当たるかの逆数を、従来の表示
// (1280pxのcanvasを640px幅で表示)を1とした倍率で返す。選択枠やハンドルの大きさを
// 画面サイズの設定によらず、画面上でほぼ同じ見た目にするために使う。
function previewUiScale() {
  const canvas = el.previewCanvas;
  const shownWidth = canvas.clientWidth || canvas.width / 2;
  return canvas.width / shownWidth / 2;
}

// テキストのfontSizeは「短辺720pxの画面での大きさ」として持っているので、実際の画面サイズに
// 合わせた倍率を掛けて使う。サーバー側(app.pyの_text_scale)と同じ計算。
function textScaleFor(canvasW, canvasH) {
  return Math.min(canvasW, canvasH) / TEXT_REFERENCE_SHORT_SIDE;
}

// 画像・動画クリップをcanvas上のどこにどの大きさで描くかを求める。scale=1は従来通り
// 「アスペクト比を保ったまま画面いっぱいに収まる大きさ」(レターボックス)で、
// positionはその中心点の相対座標。サーバー側の書き出し(_fit_and_place)と同じ計算。
function mediaRect(clip, iw, ih, canvasW, canvasH) {
  const fit = Math.min(canvasW / iw, canvasH / ih);
  const s = fit * (clip.scale ?? 1);
  const width = iw * s;
  const height = ih * s;
  const pos = clip.position || DEFAULT_MEDIA_POSITION;
  const centerX = (pos.x ?? DEFAULT_MEDIA_POSITION.x) * canvasW;
  const centerY = (pos.y ?? DEFAULT_MEDIA_POSITION.y) * canvasH;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

// mediaEl は HTMLImageElement または HTMLVideoElement
function drawMediaPlaced(ctx, mediaEl, clip, canvasW, canvasH) {
  const iw = mediaEl.naturalWidth || mediaEl.videoWidth || 0;
  const ih = mediaEl.naturalHeight || mediaEl.videoHeight || 0;
  if (!iw || !ih) return;
  const r = mediaRect(clip, iw, ih, canvasW, canvasH);
  ctx.drawImage(mediaEl, r.x, r.y, r.width, r.height);
  // ヒットテスト(プレビュー画面でのドラッグ判定)用に、描画のたびに最新の矩形を覚えておく
  state.previewBoxes[clip.clipId] = { ...r, pad: 0 };
}

// 動画クリップを描く。再生中は「クリップが表示範囲に入った瞬間」にだけ開始位置へシークして
// play()し、あとは動画自身の再生に任せて毎フレーム今映っているフレームを描くだけにする
// (requestAnimationFrameのたびにシークし直すと、シークが重くて映像がとぎれとぎれになるため)。
// 停止中・スクラブ中は、位置がずれていればシークだけ行い、描画はシーク完了(seeked)後の
// 描き直しに任せる。
function drawVideoClip(ctx, clip, sec, canvasW, canvasH) {
  const videoEl = getOrCreateVideoEl(clip.fileId, clip.url);
  let target = Math.max(0, clip.trimStart + (sec - clip.timelineStart));
  if (videoEl.duration) target = Math.min(target, Math.max(0, videoEl.duration - 0.05));

  if (state.isPlaying) {
    if (!state.playingVideos[clip.clipId]) {
      state.playingVideos[clip.clipId] = videoEl;
      try {
        videoEl.currentTime = target;
      } catch (e) {
        // メタデータ未読込などで失敗することがある。その場合は先頭から再生される
      }
      videoEl.play().catch(() => {}); // 自動再生ポリシー等で失敗しても致命的ではないため無視する
    }
  } else if (Math.abs(videoEl.currentTime - target) >= 0.08) {
    // 同じ位置へのシークを繰り返し要求しない(終端付近などでぴったり合わない場合の無限ループ防止)
    if (videoEl.dataset.seekTarget !== String(target)) {
      videoEl.dataset.seekTarget = String(target);
      try {
        videoEl.currentTime = target;
        return;
      } catch (e) {
        // 読み込み後(loadeddata)に描き直されるので無視する
      }
    }
  }

  try {
    if (videoEl.readyState >= 2) drawMediaPlaced(ctx, videoEl, clip, canvasW, canvasH);
  } catch (e) {
    // デコードが追いついていない等でまだ描画できない場合は、そのフレームは諦めて次を待つ
  }
}

function pausePreviewVideos() {
  for (const v of Object.values(state.playingVideos)) v.pause();
  state.playingVideos = {};
}

// ---------- テキストクリップの描画 ----------
// サーバー側(app.pyの_wrap_text_to_width / _center_to_topleft)と同じ考え方で折り返し・
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
const DEFAULT_MEDIA_POSITION = { x: 0.5, y: 0.5 }; // 画像・動画の初期位置(画面中央)
const SELECTION_HANDLE_SIZE = 14; // 四隅のリサイズハンドルの大きさ(previewUiScale()=1の時のcanvas内部座標のpx)
const TEXT_FRAME_PAD = 8; // テキストの選択枠を、文字の外側にどれだけ広げるか(同上)

// テキストブロックの折り返し結果と寸法を測る(ctx.fontもこのクリップ用に設定される)
function measureTextBlock(ctx, clip, canvasW, canvasH) {
  const fontSize = (clip.fontSize || DEFAULT_TEXT_FONT_SIZE) * textScaleFor(canvasW, canvasH);
  ctx.font = textClipFontCss(clip.fontKey, fontSize);
  const lineHeight = fontSize * 1.3;
  const lines = wrapTextToWidth(ctx, clip.text || "", canvasW * TEXT_MAX_WIDTH_RATIO);
  const width = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  return { fontSize, lineHeight, lines, width, height: lines.length * lineHeight };
}

function drawSingleTextClip(ctx, clip, canvasW, canvasH) {
  const { fontSize, lineHeight, lines, width, height } = measureTextBlock(ctx, clip, canvasW, canvasH);

  const pos = clip.position || DEFAULT_TEXT_POSITION;
  const centerX = (pos.x ?? DEFAULT_TEXT_POSITION.x) * canvasW;
  const centerY = (pos.y ?? DEFAULT_TEXT_POSITION.y) * canvasH;
  const blockX = centerX - width / 2;
  const blockY = centerY - height / 2;

  // ヒットテスト(プレビュー画面でのドラッグ判定)用に、描画のたびに最新の矩形を覚えておく
  state.previewBoxes[clip.clipId] = {
    x: blockX,
    y: blockY,
    width,
    height,
    pad: TEXT_FRAME_PAD * previewUiScale(),
  };

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, Math.round(fontSize / 8));
  ctx.strokeStyle = "black";
  ctx.fillStyle = "white";

  lines.forEach((line, i) => {
    const cx = blockX + width / 2;
    const cy = blockY + i * lineHeight + fontSize * 0.85;
    ctx.strokeText(line, cx, cy);
    ctx.fillText(line, cx, cy);
  });
}

// 選択中のクリップ(テキスト・画像・動画)に、ドラッグで動かせる/四隅でリサイズできることが
// 分かるよう枠と四隅のハンドルを描く。他のクリップに隠れないよう、すべて描いた後に呼ぶ。
// ハンドルの位置はここで記録し、リサイズのヒットテストに使う。
function drawSelectionFrame(ctx) {
  state.previewHandles = null;
  const box = state.selectedClipId && state.previewBoxes[state.selectedClipId];
  if (!box) return;

  const ui = previewUiScale();
  const left = box.x - box.pad;
  const top = box.y - box.pad;
  const right = box.x + box.width + box.pad;
  const bottom = box.y + box.height + box.pad;

  ctx.save();
  ctx.setLineDash([6 * ui, 4 * ui]);
  ctx.lineWidth = 2 * ui;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.restore();

  const corners = {
    "top-left": { x: left, y: top },
    "top-right": { x: right, y: top },
    "bottom-left": { x: left, y: bottom },
    "bottom-right": { x: right, y: bottom },
  };
  const size = SELECTION_HANDLE_SIZE * ui;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#5b8cff";
  ctx.lineWidth = 2 * ui;
  for (const c of Object.values(corners)) {
    ctx.fillRect(c.x - size / 2, c.y - size / 2, size, size);
    ctx.strokeRect(c.x - size / 2, c.y - size / 2, size, size);
  }
  ctx.restore();
  state.previewHandles = { clipId: state.selectedClipId, corners };
}

// 指定秒において表示されているクリップを、表示されるべき順に返す。
// visuals: 画像・動画(後のトラックほど上に重なる)、texts: テキスト(常に画像・動画より上)
function activePreviewClips(sec) {
  const visuals = [];
  const texts = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const start = clip.timelineStart;
      const end = start + (clip.trimEnd - clip.trimStart);
      if (sec < start || sec >= end) continue;
      if (clip.kind === "image" || clip.kind === "video") visuals.push(clip);
      else if (clip.kind === "text") texts.push(clip);
    }
  }
  return { visuals, texts };
}

// 指定秒における画面をプレビューcanvasへ描画する。表示中の画像・動画をすべて行の順に
// (後のトラックほど上に)重ね、その上にテキストを重ねる(サーバー側の書き出しと同じ規則)。
// 該当が無い部分は黒になる。重なり順を崩さないよう、描画はすべて同期的に1回で行い、
// まだ読み込めていない画像・動画は読み込み完了時に描き直す。
function updatePreview(sec) {
  const canvas = el.previewCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const canvasW = canvas.width;
  const canvasH = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);
  state.previewBoxes = {};

  const { visuals, texts } = activePreviewClips(sec);

  // 再生中の動画のうち、表示範囲から外れたもの(停止中は全部)を止める
  const activeIds = new Set(visuals.map((c) => c.clipId));
  for (const [clipId, v] of Object.entries(state.playingVideos)) {
    if (!state.isPlaying || !activeIds.has(clipId)) {
      v.pause();
      delete state.playingVideos[clipId];
    }
  }

  for (const clip of visuals) {
    if (clip.kind === "image") {
      const img = state.loadedImages[clip.fileId];
      if (img) drawMediaPlaced(ctx, img, clip, canvasW, canvasH);
      else loadImage(clip.fileId, clip.url).catch(() => {});
    } else {
      drawVideoClip(ctx, clip, sec, canvasW, canvasH);
    }
  }

  for (const clip of texts) {
    try {
      drawSingleTextClip(ctx, clip, canvasW, canvasH);
    } catch (e) {
      // フォント未読込などで失敗しても他のクリップの描画は止めない
    }
  }

  drawSelectionFrame(ctx);
}

// ---------- 出力画面サイズ ----------
// プレビューcanvasの内部解像度 = 書き出す動画の解像度。位置(position)・大きさ(scale)は
// 画面に対する相対値で持っているので、サイズを切り替えても配置の比率は崩れない。

function applyCanvasSize(key) {
  const preset = CANVAS_PRESETS[key] || CANVAS_PRESETS[DEFAULT_CANVAS_PRESET];
  el.previewCanvas.width = preset.w;
  el.previewCanvas.height = preset.h;
  // プレビュー枠は縦横比を合わせ、高さがPREVIEW_MAX_HEIGHT_PXを超えないようにする
  // (縦長にした時に画面が縦に伸びすぎないようにするため)
  el.previewWrap.style.aspectRatio = `${preset.w} / ${preset.h}`;
  el.previewWrap.style.width = `min(100%, ${Math.round((PREVIEW_MAX_HEIGHT_PX * preset.w) / preset.h)}px)`;
  updatePreview(state.playheadSec);
}

for (const [key, preset] of Object.entries(CANVAS_PRESETS)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = preset.label;
  el.canvasSizeSelect.appendChild(opt);
}
el.canvasSizeSelect.value = DEFAULT_CANVAS_PRESET;
el.canvasSizeSelect.addEventListener("change", () => applyCanvasSize(el.canvasSizeSelect.value));

// ---------- プレビュー画面でのドラッグ配置・拡大縮小 ----------
// 一般的な動画編集ソフトと同様、テキスト・画像・動画クリップをプレビュー画面上で直接
// ドラッグして位置(画面上の相対座標)を変え、四隅のハンドルで大きさを変えられるようにする。

function canvasCoordsFromEvent(e) {
  const canvas = el.previewCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

// 指定した座標(canvas内部座標)に重なる、現在再生ヘッド位置で表示されているクリップを探す。
// 見た目で一番上にあるもの(テキスト → 後のトラックの画像・動画 の順)を優先する。
function findPreviewClipAtPoint(x, y) {
  const { visuals, texts } = activePreviewClips(state.playheadSec);
  const topFirst = [...texts.reverse(), ...visuals.reverse()];
  return (
    topFirst.find((clip) => {
      const box = state.previewBoxes[clip.clipId];
      return box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    }) || null
  );
}

// 指定した座標(canvas内部座標)が、選択中クリップの四隅リサイズハンドルに重なっているか調べる
function findResizeHandleAtPoint(x, y) {
  const handles = state.previewHandles;
  if (!handles || handles.clipId !== state.selectedClipId) return null;
  const ui = previewUiScale();
  const half = (SELECTION_HANDLE_SIZE / 2 + 4) * ui; // 少し広めに当たり判定を取り、つかみやすくする
  for (const [corner, h] of Object.entries(handles.corners)) {
    if (x >= h.x - half && x <= h.x + half && y >= h.y - half && y <= h.y + half) {
      return corner;
    }
  }
  return null;
}

function startPreviewMove(clip, x, y) {
  state.selectedClipId = clip.clipId;
  const defaultPos = clip.kind === "text" ? DEFAULT_TEXT_POSITION : DEFAULT_MEDIA_POSITION;
  const pos = clip.position || defaultPos;
  const canvas = el.previewCanvas;
  const dragOffset = {
    x: x - (pos.x ?? defaultPos.x) * canvas.width,
    y: y - (pos.y ?? defaultPos.y) * canvas.height,
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

// 四隅のハンドルをドラッグして大きさを変える(テキストは文字サイズ、画像・動画はscale)。
// ドラッグした角の対角(固定角)からの距離の比率をそのまま拡大率とし、固定角が画面上で
// 動かないように中心位置(position)を再計算する。
function startPreviewResize(clip, corner) {
  const canvas = el.previewCanvas;
  const handles = state.previewHandles;
  const box = state.previewBoxes[clip.clipId];
  if (!handles || handles.clipId !== clip.clipId || !box) return;

  const oppositeOf = {
    "top-left": "bottom-right",
    "top-right": "bottom-left",
    "bottom-left": "top-right",
    "bottom-right": "top-left",
  };
  const dragged = handles.corners[corner];
  const fixed = handles.corners[oppositeOf[corner]];
  const startDist = Math.hypot(dragged.x - fixed.x, dragged.y - fixed.y) || 1;
  const pad = box.pad;
  const isText = clip.kind === "text";
  const startFontSize = clip.fontSize || DEFAULT_TEXT_FONT_SIZE;
  const startScale = clip.scale ?? 1;
  // 画像・動画の、scale=1の時の寸法(canvas内部座標)
  const baseWidth = box.width / startScale;
  const baseHeight = box.height / startScale;
  const isLeft = corner.endsWith("left");
  const isTop = corner.startsWith("top");

  el.previewCanvas.style.cursor = isLeft === isTop ? "nwse-resize" : "nesw-resize";

  function onMove(ev) {
    const p = canvasCoordsFromEvent(ev);
    const currentDist = Math.hypot(p.x - fixed.x, p.y - fixed.y);
    const ratio = Math.max(0.1, currentDist / startDist);

    // 新しい大きさでの寸法を求め、固定角の画面上の位置が変わらないよう中心を再計算する
    let newWidth;
    let newHeight;
    if (isText) {
      clip.fontSize = Math.max(MIN_TEXT_FONT_SIZE, Math.min(MAX_TEXT_FONT_SIZE, startFontSize * ratio));
      const m = measureTextBlock(canvas.getContext("2d"), clip, canvas.width, canvas.height);
      newWidth = m.width;
      newHeight = m.height;
    } else {
      clip.scale = Math.max(MIN_MEDIA_SCALE, Math.min(MAX_MEDIA_SCALE, startScale * ratio));
      newWidth = baseWidth * clip.scale;
      newHeight = baseHeight * clip.scale;
    }

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
    if (found) startPreviewResize(found.clip, handleCorner);
    return;
  }

  const clip = findPreviewClipAtPoint(x, y);
  if (!clip) return;
  e.preventDefault();
  startPreviewMove(clip, x, y);
});

// ダブルクリックで、テキストクリップの内容を直接編集するパネルを開く
el.previewCanvas.addEventListener("dblclick", (e) => {
  const { x, y } = canvasCoordsFromEvent(e);
  const clip = findPreviewClipAtPoint(x, y);
  if (!clip || clip.kind !== "text") return;
  e.preventDefault();
  openTextPanel("edit", { clip }, e.clientX, e.clientY);
});

// ドラッグ中でない時は、ハンドル/クリップの上にカーソルが来たら操作できることを示す
el.previewCanvas.addEventListener("mousemove", (e) => {
  const { x, y } = canvasCoordsFromEvent(e);
  const handleCorner = findResizeHandleAtPoint(x, y);
  if (handleCorner) {
    const isLeft = handleCorner.endsWith("left");
    const isTop = handleCorner.startsWith("top");
    el.previewCanvas.style.cursor = isLeft === isTop ? "nwse-resize" : "nesw-resize";
    return;
  }
  el.previewCanvas.style.cursor = findPreviewClipAtPoint(x, y) ? "grab" : "default";
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
// ---------- トラック(行)の管理 ----------
// 行は「メディアの行」(ファイルのアップロード/AI生成でできる)と「オーバーレイ」(「+ オーバーレイ」
// で作る、最初は空の行)の2種類。どちらも中身の種類には縛られず、どの行にも画像・動画・音声・
// テキストのクリップを置ける(行をまたいだドラッグ移動も自由)。違いは、中身が空になった時の扱い
// だけで、メディアの行は自動的に消え、オーバーレイは空のまま残る(行の🗑で明示的に消す)。
// state.tracksの並び順がそのまま画面上の上下の並びで、重なり順(下の行ほど手前)でもある。

// 新しい空のオーバーレイを作る(配列には入れない)。名前は「オーバーレイ N」。
function newOverlayTrack() {
  overlayCounter += 1;
  trackCounter += 1;
  return {
    trackId: `t${trackCounter}`,
    trackType: "overlay",
    label: `オーバーレイ ${overlayCounter}`,
    clips: [],
  };
}

// 新しいメディアの行は最初のオーバーレイの手前に差し込み、「メディアの行が上、オーバーレイが
// 下、いちばん下に作成ボタン」という並びを保つ。
function insertMediaTrack(track) {
  const firstOverlayIdx = state.tracks.findIndex((t) => t.trackType === "overlay");
  if (firstOverlayIdx === -1) state.tracks.push(track);
  else state.tracks.splice(firstOverlayIdx, 0, track);
}

// クリップが無くなった行の片付け。メディアの行は消し、オーバーレイは空のまま残す。
function cleanupEmptyTrack(track) {
  if (track.clips.length === 0 && track.trackType !== "overlay") {
    state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);
  }
}

// 行のラベルは、いまその行に入っている先頭クリップの名前から作る(クリップの移動や編集で
// 古い名前が残らないようにするため)。空のオーバーレイだけは作成時の名前を使う。
function clipDisplayName(clip) {
  return clip.kind === "text" ? `📝 ${(clip.text || "").split("\n")[0]}` : clip.filename;
}
function trackDisplayLabel(track) {
  return track.clips.length > 0 ? clipDisplayName(track.clips[0]) : track.label;
}

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
  insertMediaTrack({ trackId, trackType: "media", label: labelOverride || data.filename, clips: [clip] });
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

// トラック1行分の(ラベル+レーン)DOMを組み立てる。
function buildTrackRow(track, total) {
  const row = document.createElement("div");
  row.className = "track-row";

  const label = document.createElement("div");
  label.className = "track-label";

  const labelStr = trackDisplayLabel(track);
  const labelText = document.createElement("span");
  labelText.className = "track-label-text";
  labelText.textContent = labelStr;
  // 複数のクリップが入っている行は、ツールチップに全クリップの名前を並べる
  labelText.title = track.clips.length > 1 ? track.clips.map(clipDisplayName).join(" / ") : labelStr;
  label.appendChild(labelText);

  const trackDeleteBtn = document.createElement("button");
  trackDeleteBtn.className = "track-delete-btn";
  const hasFiles = track.clips.some((c) => c.fileId);
  trackDeleteBtn.title = hasFiles ? "この行のファイルをサーバーから削除" : "この行を削除";
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

  // 空の行には、何ができるかのヒントを薄く表示しておく
  if (track.clips.length === 0) {
    const hint = document.createElement("span");
    hint.className = "empty-lane-hint";
    hint.textContent = "空のオーバーレイ — 右クリックでテキストや画像を追加、他の行のクリップをここへドラッグして移動できます";
    lane.appendChild(hint);
  }

  row.appendChild(lane);
  return row;
}

// 空のオーバーレイを1つ、いちばん下(作成ボタンの行のすぐ上)に追加する
function addEmptyOverlay() {
  state.tracks.push(newOverlayTrack());
  setStatus("空のオーバーレイを追加しました。右クリックでテキストや画像を追加できます");
  renderAll();
  const addRow = el.tracksContainer.querySelector(".add-overlay-row");
  if (addRow && addRow.scrollIntoView) addRow.scrollIntoView({ block: "nearest" });
}

// タイムラインのいちばん下に置く「+ オーバーレイ」の行。新しいオーバーレイは、常にこの行の
// 上に追加されるので、作成ボタンは必ず一番下に来る。
function buildAddOverlayRow(total) {
  const row = document.createElement("div");
  row.className = "track-row add-overlay-row";

  const label = document.createElement("div");
  label.className = "track-label add-overlay-label";
  const addBtn = document.createElement("button");
  addBtn.className = "btn add-overlay-btn";
  addBtn.textContent = "+ オーバーレイ";
  addBtn.title = "空のオーバーレイを追加";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    addEmptyOverlay();
  });
  label.appendChild(addBtn);
  row.appendChild(label);

  const lane = document.createElement("div");
  lane.className = "track-lane add-overlay-lane";
  lane.style.width = `${total * PX_PER_SEC}px`;
  const laneLabel = document.createElement("span");
  laneLabel.className = "add-overlay-lane-text";
  laneLabel.textContent = "← 空のオーバーレイをこの行の上に追加します。クリップは行をまたいでドラッグ移動できます";
  lane.appendChild(laneLabel);
  row.appendChild(lane);

  return row;
}

function renderAll() {
  renderRuler();
  updateTimeDisplay();

  // 既存の track-row / playhead を削除して再構築
  el.tracksContainer.querySelectorAll(".track-row, .playhead").forEach((n) => n.remove());

  const total = timelineTotalDuration();
  for (const track of state.tracks) {
    el.tracksContainer.appendChild(buildTrackRow(track, total));
  }
  el.tracksContainer.appendChild(buildAddOverlayRow(total));

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

// すべての行のレーンの、画面上での縦の位置を集める。クリップを上下にドラッグして別の行へ
// 移す時の、ドロップ先の判定に使う(ドラッグ開始時に1回だけ取得する)。
// 一番下の「+ オーバーレイ」の行にはdata-track-idが無いので、対象に含まれない。
function collectLaneRects() {
  const rects = [];
  document.querySelectorAll(".track-lane[data-track-id]").forEach((laneEl) => {
    const r = laneEl.getBoundingClientRect();
    rects.push({ trackId: laneEl.dataset.trackId, top: r.top, bottom: r.bottom, el: laneEl });
  });
  return rects;
}

// クリップを別の行へ移す(タイムライン上の開始位置はそのまま)。どの種類のクリップ(画像・動画・
// 音声・テキスト)も、どの行へでも移せる。移動元の行が空になった場合、メディアの行は消え、
// オーバーレイは空のまま残る。
function moveClipToTrack(clip, newTrackId) {
  const oldTrack = state.tracks.find((t) => t.trackId === clip.trackId);
  const newTrack = state.tracks.find((t) => t.trackId === newTrackId);
  if (!oldTrack || !newTrack || oldTrack === newTrack) return;

  oldTrack.clips = oldTrack.clips.filter((c) => c.clipId !== clip.clipId);
  clip.trackId = newTrack.trackId;
  newTrack.clips.push(clip);
  cleanupEmptyTrack(oldTrack);
}

function attachDrag(clipEl, clip) {
  clipEl.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("handle")) return;
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    const startX = e.clientX;
    const startY = e.clientY;
    const startTimelineStart = clip.timelineStart;
    const dur = clip.trimEnd - clip.trimStart;
    const snapCandidates = collectSnapCandidates(clip.clipId);

    // 上下にドラッグすると別の行へ移動できる。ドラッグ中はクリップが指に追従して見え、ドロップ先の
    // 行が強調表示される。実際の付け替えは指を離した時に行う。
    const lanes = collectLaneRects();
    const canChangeRow = lanes.length > 1;
    let targetTrackId = clip.trackId;
    let rowChangeActive = false; // 縦にROW_CHANGE_START_PX以上動かしたら、そのドラッグ中はずっと有効

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

      if (canChangeRow) {
        const dy = ev.clientY - startY;
        if (!rowChangeActive && Math.abs(dy) >= ROW_CHANGE_START_PX) rowChangeActive = true;
        if (!rowChangeActive) return; // まだ横移動のみ(クリップは今の行から動かさない)

        clipEl.style.transform = `translateY(${dy}px)`;
        clipEl.classList.add("dragging");

        // 今の行は端まで、別の行は端からROW_CHANGE_INSET_PX内側まで入った時だけ対象にする。
        // 行の境目付近では直前の対象を保ち、どの行の上にも無い(タイムラインの外)時は元の行に戻す。
        const overAny = lanes.some((l) => ev.clientY >= l.top && ev.clientY <= l.bottom);
        const hit = lanes.find((l) => {
          const inset = l.trackId === targetTrackId ? 0 : ROW_CHANGE_INSET_PX;
          return ev.clientY >= l.top + inset && ev.clientY <= l.bottom - inset;
        });
        if (hit) targetTrackId = hit.trackId;
        else if (!overAny) targetTrackId = clip.trackId;
        for (const l of lanes) {
          l.el.classList.toggle("drop-target", l.trackId === targetTrackId && l.trackId !== clip.trackId);
        }
      }
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      for (const l of lanes) l.el.classList.remove("drop-target");
      clipEl.classList.remove("dragging");
      clipEl.style.transform = "";
      if (canChangeRow && targetTrackId !== clip.trackId) {
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
  cleanupEmptyTrack(track); // メディアの行は消え、オーバーレイは空のまま残る
  state.selectedClipId = null;
  renderAll();
});

// 行を丸ごと削除する。その行のクリップが使っているサーバー上のファイル(音声/画像/動画)のうち、
// 他の行のクリップから使われていないものだけをサーバーからも削除する。クリップは行をまたいで
// 移動でき、カットで分けた片方が別の行にあることもあるため、他の行が使っているファイルまで消して
// そちらのクリップを壊さないようにしている。ファイルを使っていない行(空のオーバーレイや
// テキストだけの行)は、確認なしでタイムラインから外すだけ。
async function deleteTrackFile(track) {
  const usedElsewhere = new Set();
  for (const t of state.tracks) {
    if (t === track) continue;
    for (const c of t.clips) if (c.fileId) usedElsewhere.add(c.fileId);
  }
  const fileIds = [...new Set(track.clips.map((c) => c.fileId).filter(Boolean))].filter(
    (id) => !usedElsewhere.has(id)
  );
  const label = trackDisplayLabel(track);

  if (fileIds.length > 0) {
    const what = fileIds.length === 1 ? `「${label}」` : `この行の${fileIds.length}個のファイル`;
    if (!confirm(`${what}をサーバーから完全に削除します。よろしいですか?`)) {
      return;
    }
    setStatus(`削除中: ${label} ...`);
    for (const fileId of fileIds) {
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
      delete state.loadedImages[fileId];
      delete state.videoCache[fileId];
    }
  }

  if (track.clips.some((c) => c.clipId === state.selectedClipId)) {
    state.selectedClipId = null;
  }
  state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);

  setStatus(`削除しました: ${label}`);
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
    // 初期表示と同じく、空のオーバーレイ1つだけの状態に戻す
    overlayCounter = 0;
    state.tracks = [newOverlayTrack()];
    state.selectedClipId = null;
    state.bufferCache = {};
    state.imageCache = {};
    state.loadedImages = {};
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
  pausePreviewVideos(); // プレビュー用に再生していた<video>があれば止める
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
        // 画像・動画クリップの大きさ(1 = 画面いっぱいに収まる大きさ)
        scale: clip.scale,
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
      body: JSON.stringify({
        clips,
        format: fmt,
        canvasWidth: el.previewCanvas.width,
        canvasHeight: el.previewCanvas.height,
      }),
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
// どの行でも、テキストの追加と新しい画像の生成の両方を選べる(行は中身の種類に縛られない)。
function openClipContextMenuForNewImage(trackId, timelineStart, clientX, clientY) {
  closeAiPanel();
  closeTextPanel();
  el.clipContextMenu.dataset.targetTrackId = trackId || "";
  el.clipContextMenu.dataset.targetTimelineStart = String(timelineStart);
  el.ctxGenVideoBtn.classList.add("hidden");
  el.ctxGenImageBtn.classList.add("hidden");
  el.ctxGenNewImageBtn.classList.remove("hidden");
  el.ctxAddTextBtn.classList.remove("hidden");
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
          { value: "16:9", label: "16:9(横長)" },
          { value: "4:3", label: "4:3(横長)" },
          { value: "3:2", label: "3:2(横長)" },
          { value: "9:16", label: "9:16(縦長)" },
          { value: "4:5", label: "4:5(縦長)" },
          { value: "2:3", label: "2:3(縦長)" },
          { value: "1:1", label: "1:1(正方形)" },
        ]
      : [
          { value: "16:9", label: "16:9(横長)" },
          { value: "9:16", label: "9:16(縦長)" },
          { value: "1:1", label: "1:1(正方形)" },
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
      `長さ: ${dur}秒(このクリップのタイムライン上の長さに合わせます)。`;
    el.aiPanelPrompt.placeholder = "動きの指示(任意) 例: 家で寝転がる黒猫";
    el.aiPanelAspectRow.classList.add("hidden");
  } else if (mode === "image") {
    aiPanelTargetClipId = ctx.clip.clipId;
    el.aiPanelTitle.textContent = "✨ この画像を基に新規生成";
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
    el.aiPanelPrompt.placeholder = "画像の内容を入力(例: 夕焼けの海辺で鳴く猫)";
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
    // プレビュー上で調整した位置・大きさは、置き換え後の動画にも引き継ぐ
    position: oldClip.position,
    scale: oldClip.scale,
  };
  track.clips[idx] = newClip;
  if (state.selectedClipId === oldClip.clipId) state.selectedClipId = newClip.clipId;
  preloadClipMedia(newClip);
}

// 新規生成した画像を、指定したトラックの指定位置にクリップとして追加する。
// trackIdがnull、または該当トラックが見つからない場合は新しいトラックを作る。
function addNewImageClipAt(data, trackId, timelineStart) {
  const track = trackId ? state.tracks.find((t) => t.trackId === trackId) : null;

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
    insertMediaTrack({ trackId: newTrackId, trackType: "media", label: data.filename, clips: [clip] });
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
  const track = trackId ? state.tracks.find((t) => t.trackId === trackId) : null;

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
    // どの行も指定されていない(トラックが無い状態での右クリック等)場合は、新しいオーバーレイを作って入れる
    const newTrack = newOverlayTrack();
    clip.trackId = newTrack.trackId;
    newTrack.clips.push(clip);
    state.tracks.push(newTrack);
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
    openClipContextMenuForNewImage(trackId, sec, e.clientX, e.clientY);
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

// 初期描画: 最初から空のオーバーレイを1つ用意しておく
state.tracks.push(newOverlayTrack());
applyCanvasSize(el.canvasSizeSelect.value);
renderAll();