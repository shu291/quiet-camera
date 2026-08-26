/*!
 * silent-camera.js — 完全無音カメラ Web コンポーネント
 *
 * 使い方（他の自作アプリに組み込む場合）:
 *   <script src="silent-camera.js"></script>
 *   <silent-camera autostart></silent-camera>
 *
 * なぜ無音か:
 *   ネイティブの写真撮影API（AVCapturePhotoOutput 等）を一切使わず、
 *   プレビュー映像の1フレームを Canvas に写し取って画像化しているため、
 *   システムのシャッター音が鳴る経路を通りません。
 *   音声トラックも取得せず、Audio / AudioContext も一切使いません。
 *
 * 音楽・動画が止まらない理由:
 *   iOS が再生中の音を止めるのは「マイクを使うとき」と「音の出る要素を再生したとき」です。
 *   このコンポーネントは
 *     - getUserMedia を audio:false（＝マイクを一切要求しない）
 *     - プレビューの <video> は muted / volume=0 / playsinline
 *     - disableRemotePlayback で「再生中」の主導権を奪わない
 *   のすべてを満たすので、Apple Music や YouTube を流したまま撮影できます。
 *   （標準の「写真を撮る」＝ file input 経由のカメラは音楽が止まりますが、これは止まりません）
 */
(function () {
  'use strict';

  if (window.customElements && customElements.get('silent-camera')) return;

  /* ============================ 定数 ============================ */

  const RATIOS = {
    full: { label: 'フル', value: null },
    '4:3': { label: '4:3', value: 4 / 3 },
    '3:4': { label: '3:4', value: 3 / 4 },
    '16:9': { label: '16:9', value: 16 / 9 },
    '9:16': { label: '9:16', value: 9 / 16 },
    '1:1': { label: '1:1', value: 1 },
  };

  const RES_PRESETS = {
    max: { label: '最大', w: 3840, h: 2160 },
    fhd: { label: '1080p', w: 1920, h: 1080 },
    hd: { label: '720p', w: 1280, h: 720 },
  };

  const DEFAULTS = {
    facing: 'environment',
    ratio: 'full',
    res: 'max',
    format: 'jpeg',
    quality: 0.92,
    timer: 0,
    burst: 1,
    burstInterval: 350,
    grid: false,
    mirrorSave: false,
    store: true,
    autoShare: false,
    zoom: 1,
  };

  const SETTINGS_KEY = 'silentcam.settings.v1';

  /* ============================ 小道具 ============================ */

  const pad = (n) => String(n).padStart(2, '0');

  function stamp(d) {
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '_' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  function fmtBytes(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  /* 「カメラが許可されていません」のときの直し方。ブラウザで手順が違う。
     iPad/iPhone は許可をアプリ終了で忘れるが、Safari だけはサイトごとに覚えられる。
     Chrome/Edge の iOS 版は中身が Safari（WebKit）なので、その記憶を持てない。 */
  function permHint() {
    const ua = navigator.userAgent;
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!iOS)
      return 'アドレスバーの 🔒（またはカメラのマーク）→「カメラ」を「許可する」にして、ページを再読み込みしてください。';
    if (/CriOS|EdgiOS|FxiOS|OPiOS/.test(ua))
      return 'iPad の Chrome や Edge は、サイトごとのカメラの許可を覚えられません。Safari で開くと一度で済みます。';
    return 'アドレスバー左の「ぁあ」→ Webサイトの設定 →「カメラ」を「許可」にしてから、もう一度お試しください。';
  }

  /* ====================== 音を止めないための宣言 ======================

     iOS は「このページが音をどう使うか」で端末の音の設定を切り替える。
     何も宣言しないと自動判定になり、カメラを起こしたときに
     録音向け（play-and-record）や再生向け（playback）に切り替わることがある。
     どちらも「他の音を止める」設定なので、聴いている音楽が止まる。

     WebKit の中では、この自動判定より
     ページからの指定（categoryOverride）のほうが優先される。
     このカメラは音を1バイトも出さないので ambient＝「他の音と混ざってよい」
     を宣言しておく。カメラを使っているあいだだけ宣言し、
     終わったら元に戻す（組み込み先のページの音を邪魔しないため）。

     Audio Session API が無い環境では何も起きない（害もない）。 */
  function audioSession() {
    try { return navigator.audioSession || null; } catch (e) { return null; }
  }
  function claimAmbient(prevBox) {
    const s = audioSession();
    if (!s) return false;
    try {
      prevBox.value = s.type;
      if (s.type !== 'ambient') s.type = 'ambient';
      return s.type === 'ambient';
    } catch (e) {
      return false;
    }
  }
  function releaseAmbient(prevBox) {
    const s = audioSession();
    if (!s || prevBox.value == null) return;
    try { if (s.type === 'ambient') s.type = prevBox.value; } catch (e) { /* 戻せなくても実害はない */ }
    prevBox.value = null;
  }

  function loadSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {
      /* プライベートブラウズ等では黙って諦める */
    }
  }

  /* ====================== 保存庫（IndexedDB） ====================== */

  const DB_NAME = 'silent-camera';
  const STORE = 'photos';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB 非対応'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(STORE, mode);
          const out = fn(t.objectStore(STORE));
          t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  const Store = {
    put: (rec) => tx('readwrite', (os) => os.put(rec)),
    del: (id) => tx('readwrite', (os) => os.delete(id)),
    clear: () => tx('readwrite', (os) => os.clear()),
    all: () =>
      openDB().then(
        (db) =>
          new Promise((resolve, reject) => {
            const t = db.transaction(STORE, 'readonly');
            const req = t.objectStore(STORE).index('createdAt').openCursor(null, 'prev');
            const out = [];
            req.onsuccess = () => {
              const c = req.result;
              if (c) {
                out.push(c.value);
                c.continue();
              } else resolve(out);
            };
            req.onerror = () => reject(req.error);
          })
      ),
  };

  /* ============================ CSS ============================ */

  const CSS = `
:host{
  --bg:#000; --fg:#fff; --panel:rgba(22,22,24,.94); --line:rgba(255,255,255,.14);
  --accent:#ffd60a; --danger:#ff453a; --r:14px;
  display:block; position:relative; width:100%; height:100%; min-height:320px;
  background:var(--bg); color:var(--fg); overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
  -webkit-tap-highlight-color:transparent; -webkit-user-select:none; user-select:none;
  touch-action:manipulation;
}
*{box-sizing:border-box; margin:0;}
button{font:inherit; color:inherit; background:none; border:0; cursor:pointer;}
.root{position:absolute; inset:0; display:flex; flex-direction:column;}

/* ---- ステージ（プレビュー） ---- */
.stage{position:relative; flex:1 1 auto; min-height:0; background:#000; overflow:hidden;}
.frame{position:absolute; overflow:hidden; background:#000;}
.frame video{position:absolute; display:block; object-fit:fill; background:#000;}
.frame video.mir{transform:scaleX(-1);}

.grid{position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity .15s;}
.grid.on{opacity:1;}
.gl{position:absolute; background:rgba(255,255,255,.38); box-shadow:0 0 2px rgba(0,0,0,.4);}

.flash{position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none;}
.flash.go{animation:fl .32s ease-out;}
@keyframes fl{0%{opacity:.85}100%{opacity:0}}

.count{position:absolute; inset:0; display:none; place-items:center; pointer-events:none;
  font-size:clamp(64px,18vmin,160px); font-weight:200; text-shadow:0 2px 24px rgba(0,0,0,.6);}
.count.on{display:grid;}

.badge{position:absolute; top:10px; left:50%; transform:translateX(-50%);
  display:flex; gap:8px; align-items:center; padding:5px 12px; border-radius:999px;
  background:rgba(0,0,0,.5); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  font-size:12px; letter-spacing:.02em; white-space:nowrap; z-index:3;}
.badge b{font-weight:600; color:var(--accent);}
.mute{display:inline-flex; align-items:center; gap:4px; color:#8ce99a; font-weight:600;}

.tl{position:absolute; top:10px; right:10px; display:flex; gap:8px; z-index:3;}
.ic{width:40px; height:40px; border-radius:50%; background:rgba(0,0,0,.45);
  backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  display:grid; place-items:center; font-size:17px; transition:transform .1s,background .15s;}
.ic:active{transform:scale(.9);}
.ic.on{background:var(--accent); color:#000;}

/* ---- ズーム ---- */
.zoom{position:absolute; left:50%; transform:translateX(-50%); bottom:12px; z-index:3;
  display:flex; align-items:center; gap:10px; padding:7px 14px; border-radius:999px;
  background:rgba(0,0,0,.5); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);}
.zoom input{width:min(46vw,240px); accent-color:var(--accent);}
.zoom span{font-size:12px; font-variant-numeric:tabular-nums; min-width:34px; text-align:right;}

/* ---- コントロール ---- */
.ctl{flex:0 0 auto; display:flex; align-items:center; justify-content:space-around;
  gap:12px; padding:14px 18px; background:#000;}
.shot{width:74px; height:74px; border-radius:50%; background:#fff; position:relative;
  box-shadow:0 0 0 4px #000, 0 0 0 6px #fff; transition:transform .08s;}
.shot:active{transform:scale(.92);}
.shot[disabled]{opacity:.4;}
.shot .n{position:absolute; inset:0; display:grid; place-items:center; color:#000;
  font-size:13px; font-weight:700;}
.side{width:52px; height:52px; border-radius:14px; background:#1c1c1e;
  display:grid; place-items:center; font-size:20px; overflow:hidden; border:1px solid var(--line);}
.side img{width:100%; height:100%; object-fit:cover;}
.side:active{transform:scale(.94);}

/* ---- パネル（設定・ギャラリー） ---- */
.panel{position:absolute; inset:0; z-index:10; background:var(--panel);
  backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
  display:flex; flex-direction:column; transform:translateY(100%); transition:transform .25s ease;}
.panel.open{transform:translateY(0);}
.ph{display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:14px 16px; border-bottom:1px solid var(--line); flex:0 0 auto;}
.ph h2{font-size:16px; font-weight:600;}
.pb{flex:1 1 auto; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:8px 16px 24px;}
.close{padding:7px 14px; border-radius:999px; background:rgba(255,255,255,.14); font-size:14px;}

.row{display:flex; align-items:center; justify-content:space-between; gap:14px;
  padding:13px 0; border-bottom:1px solid var(--line);}
.row:last-child{border-bottom:0;}
.row .lb{font-size:15px;}
.row .sub{font-size:11.5px; opacity:.55; margin-top:3px; line-height:1.45;}
.seg{display:flex; background:rgba(255,255,255,.1); border-radius:10px; padding:2px; flex:0 0 auto;}
.seg button{padding:7px 11px; border-radius:8px; font-size:13px; opacity:.75; white-space:nowrap;}
.seg button.on{background:rgba(255,255,255,.9); color:#000; opacity:1; font-weight:600;}
.sw{width:50px; height:30px; border-radius:999px; background:rgba(255,255,255,.2); position:relative;
  flex:0 0 auto; transition:background .2s;}
.sw::after{content:''; position:absolute; top:3px; left:3px; width:24px; height:24px;
  border-radius:50%; background:#fff; transition:transform .2s;}
.sw.on{background:#30d158;}
.sw.on::after{transform:translateX(20px);}
input[type=range]{accent-color:var(--accent);}
.note{font-size:12px; line-height:1.7; opacity:.6; padding:14px 0 0;}

/* ---- ギャラリー ---- */
.gg{display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:6px; padding-top:10px;}
.gi{position:relative; aspect-ratio:1; border-radius:8px; overflow:hidden; background:#111;}
.gi img{width:100%; height:100%; object-fit:cover; display:block;}
.gi.sel::after{content:'✓'; position:absolute; inset:0; display:grid; place-items:center;
  background:rgba(255,214,10,.35); color:#000; font-size:26px; font-weight:800;}
.empty{text-align:center; opacity:.5; padding:56px 20px; font-size:14px; line-height:1.8;}
.bar{display:flex; gap:8px; padding:10px 16px; border-top:1px solid var(--line); flex:0 0 auto;}
.bar button{flex:1; padding:12px; border-radius:12px; background:rgba(255,255,255,.14); font-size:14px;}
.bar button.pri{background:var(--accent); color:#000; font-weight:700;}
.bar button.dan{color:var(--danger);}
.bar button[disabled]{opacity:.35;}

/* ---- ビューア ---- */
.viewer{position:absolute; inset:0; z-index:20; background:#000; display:none; flex-direction:column;}
.viewer.open{display:flex;}
.viewer .vi{flex:1 1 auto; min-height:0; display:grid; place-items:center; padding:10px;}
.viewer img{max-width:100%; max-height:100%; object-fit:contain;}

/* ---- 権限・トースト ---- */
.perm{position:absolute; inset:0; z-index:30; display:none; place-items:center; padding:28px;
  background:#000; text-align:center;}
.perm.open{display:grid;}
.perm .in{max-width:420px; display:grid; gap:14px; justify-items:center;}
.perm h3{font-size:19px;}
.perm p{font-size:14px; line-height:1.85; opacity:.72;}
.perm button{padding:13px 26px; border-radius:999px; background:var(--accent); color:#000; font-weight:700;}
.toast{position:absolute; left:50%; bottom:96px; transform:translate(-50%,10px); z-index:40;
  background:rgba(0,0,0,.85); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  padding:11px 20px; border-radius:999px; font-size:13.5px; opacity:0; pointer-events:none;
  transition:opacity .2s,transform .2s; max-width:86%; text-align:center;}
.toast.on{opacity:1; transform:translate(-50%,0);}

:host([compact]) .badge{font-size:11px; padding:4px 9px;}
:host([compact]) .shot{width:60px; height:60px;}
:host([compact]) .side{width:44px; height:44px;}

/* 全画面（ホーム画面アプリ）のときだけ、ノッチ／ホームバーを避ける。
   他アプリに埋め込んだときに余白がずれないよう属性で切り分ける。 */
:host([fullscreen]) .badge,
:host([fullscreen]) .tl{top:calc(10px + env(safe-area-inset-top));}
:host([fullscreen]) .ctl{padding-bottom:calc(14px + env(safe-area-inset-bottom));}
:host([fullscreen]) .panel,
:host([fullscreen]) .viewer{padding-bottom:env(safe-area-inset-bottom);}
:host([fullscreen]) .ph{padding-top:calc(14px + env(safe-area-inset-top));}

.hide{display:none !important;}
.inv{visibility:hidden !important; pointer-events:none;}
`;

  /* ============================ HTML ============================ */

  const TPL = `
<div class="root">
  <div class="stage" part="stage">
    <div class="frame">
      <video playsinline muted autoplay disablepictureinpicture disableremoteplayback></video>
      <div class="grid"><i class="gl h1"></i><i class="gl h2"></i><i class="gl v1"></i><i class="gl v2"></i></div>
      <div class="flash"></div>
    </div>
    <div class="badge"><span class="mute">🔇 無音</span><span class="info">—</span></div>
    <div class="tl">
      <button class="ic bGrid" title="グリッド">▦</button>
      <button class="ic bSet"  title="設定">⚙</button>
    </div>
    <div class="count"></div>
    <div class="zoom">
      <span class="zl">1.0×</span>
      <input class="zi" type="range" min="1" max="6" step="0.1" value="1" aria-label="ズーム">
    </div>
  </div>

  <div class="ctl">
    <button class="side bGal" title="ギャラリー">🖼</button>
    <button class="shot" title="撮影"><span class="n"></span></button>
    <button class="side bFlip" title="カメラ切替">🔄</button>
  </div>

  <!-- 設定 -->
  <div class="panel pSet">
    <div class="ph"><h2>設定</h2><button class="close cSet">閉じる</button></div>
    <div class="pb">
      <div class="row"><div><div class="lb">縦横比</div></div><div class="seg sRatio"></div></div>
      <div class="row"><div><div class="lb">画質（解像度）</div><div class="sub rInfo"></div></div><div class="seg sRes"></div></div>
      <div class="row"><div><div class="lb">保存形式</div><div class="sub">PNG は無圧縮で高画質・大容量</div></div><div class="seg sFmt"></div></div>
      <div class="row fQ"><div><div class="lb">JPEG 画質 <b class="qv"></b></div></div>
        <input class="qi" type="range" min="0.5" max="1" step="0.02" style="width:140px">
      </div>
      <div class="row"><div><div class="lb">セルフタイマー</div></div><div class="seg sTimer"></div></div>
      <div class="row"><div><div class="lb">連写</div><div class="sub">1回押すと連続で撮影します</div></div><div class="seg sBurst"></div></div>
      <div class="row"><div><div class="lb">グリッド線</div></div><div class="sw wGrid"></div></div>
      <div class="row"><div><div class="lb">内カメラを鏡像で保存</div><div class="sub">OFF なら見た目どおり左右反転せずに保存</div></div><div class="sw wMir"></div></div>
      <div class="row"><div><div class="lb">アプリ内に保存</div><div class="sub">端末内（ブラウザ保存領域）に残してギャラリーで見返せます</div></div><div class="sw wStore"></div></div>
      <div class="row"><div><div class="lb">撮影後すぐ「写真」に保存</div><div class="sub">毎回 iPad の共有シートを開きます</div></div><div class="sw wShare"></div></div>
      <div class="note">
        <b>なぜ無音なのか</b><br>
        端末の写真撮影機能ではなく、プレビュー映像の1コマを画像として書き出しています。
        シャッター音を鳴らす仕組みを通らないため、音量に関係なく無音です。<br><br>
        <b>使用容量</b>：<span class="quota">—</span>
        <br><br>
        撮影が禁止されている場所や、人が写る撮影では相手の同意が必要です。ルールを守って使ってください。
      </div>
    </div>
  </div>

  <!-- ギャラリー -->
  <div class="panel pGal">
    <div class="ph"><h2>ギャラリー <span class="gcount" style="opacity:.5;font-weight:400"></span></h2>
      <div style="display:flex;gap:8px"><button class="close cSel">選択</button><button class="close cGal">閉じる</button></div></div>
    <div class="pb"><div class="gg"></div>
      <div class="empty">まだ写真がありません。<br>丸いボタンで撮影すると、ここに並びます。</div></div>
    <div class="bar gbar hide">
      <button class="pri bSave">写真に保存</button>
      <button class="dan bDel">削除</button>
      <button class="bAll">全選択</button>
    </div>
  </div>

  <!-- ビューア -->
  <div class="viewer">
    <div class="ph"><h2 class="vt"></h2><button class="close cView">閉じる</button></div>
    <div class="vi"><img alt=""></div>
    <div class="bar">
      <button class="bPrev">‹ 前</button>
      <button class="pri bVSave">写真に保存</button>
      <button class="dan bVDel">削除</button>
      <button class="bNext">次 ›</button>
    </div>
  </div>

  <!-- 権限 -->
  <div class="perm">
    <div class="in">
      <div style="font-size:44px">📷</div>
      <h3 class="pt">カメラを使う準備</h3>
      <p class="pm">「許可」を押すとカメラが起動します。音は一切鳴りません。</p>
      <button class="bStart">カメラを起動</button>
    </div>
  </div>

  <div class="toast"></div>
</div>`;

  /* ============================ 本体 ============================ */

  class SilentCamera extends HTMLElement {
    static get observedAttributes() {
      return ['facing', 'compact'];
    }

    constructor() {
      super();
      const sr = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      sr.appendChild(style);
      const wrap = document.createElement('div');
      wrap.innerHTML = TPL;
      sr.appendChild(wrap.firstElementChild);

      this.s = loadSettings();
      this.stream = null;
      this.track = null;
      this._prevAudioType = { value: null };   // カメラ中だけ ambient にして、あとで戻す
      this._ambient = false;
      this.photos = [];
      this.urls = new Map();
      this.selected = new Set();
      this.selMode = false;
      this.viewIndex = -1;
      this.busy = false;
      this._onResize = () => this.layout();
      this._onVis = () => this.handleVisibility();
    }

    /* ---------- ライフサイクル ---------- */

    connectedCallback() {
      if (this._built) return;
      this._built = true;
      // no-gallery: 撮った写真は capture イベントで渡すだけ。
      // 保存庫（IndexedDB）を一度も開かないので、組み込み先のデータを汚しません。
      this.noGallery = this.hasAttribute('no-gallery');
      if (this.noGallery) this.s.store = false;

      this.q();
      this.bind();
      this.renderSettings();
      if (this.noGallery) {
        this.el.bGal.classList.add('inv');
        this.el.pGal.classList.add('hide');
        this.shadowRoot.querySelector('.wStore').closest('.row').classList.add('hide');
        this.shadowRoot.querySelector('.wShare').closest('.row').classList.add('hide');
      } else {
        this.refreshGallery();
        this.updateQuota();
      }
      if (this.hasAttribute('facing')) this.s.facing = this.getAttribute('facing');
      if (this.hasAttribute('ratio')) this.s.ratio = this.getAttribute('ratio');

      window.addEventListener('resize', this._onResize);
      window.addEventListener('orientationchange', this._onResize);
      document.addEventListener('visibilitychange', this._onVis);

      if (this.hasAttribute('autostart')) {
        // iOS では起動にユーザー操作が要る場合があるので、失敗したら案内を出す
        this.start().catch(() => this.showPerm());
      } else {
        this.showPerm();
      }
    }

    disconnectedCallback() {
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('orientationchange', this._onResize);
      document.removeEventListener('visibilitychange', this._onVis);
      this.stop();
      this.urls.forEach((u) => URL.revokeObjectURL(u));
      this.urls.clear();
    }

    attributeChangedCallback(n, o, v) {
      if (n === 'facing' && o !== null && v && v !== this.s.facing) {
        this.s.facing = v;
        if (this.stream) this.start();
      }
    }

    /* ---------- DOM 参照 ---------- */

    q() {
      const $ = (s) => this.shadowRoot.querySelector(s);
      this.el = {
        stage: $('.stage'), frame: $('.frame'), video: $('video'),
        grid: $('.grid'), flash: $('.flash'), count: $('.count'),
        info: $('.info'), toast: $('.toast'),
        zoomWrap: $('.zoom'), zi: $('.zi'), zl: $('.zl'),
        shot: $('.shot'), shotN: $('.shot .n'),
        bGal: $('.bGal'), bFlip: $('.bFlip'), bGrid: $('.bGrid'), bSet: $('.bSet'),
        pSet: $('.pSet'), pGal: $('.pGal'), viewer: $('.viewer'),
        gg: $('.gg'), empty: $('.empty'), gcount: $('.gcount'), gbar: $('.gbar'),
        vimg: $('.viewer img'), vt: $('.vt'),
        perm: $('.perm'), pt: $('.pt'), pm: $('.pm'), bStart: $('.bStart'),
        quota: $('.quota'), rInfo: $('.rInfo'),
      };
    }

    /* ---------- イベント ---------- */

    bind() {
      const e = this.el;
      const $$ = (s) => this.shadowRoot.querySelector(s);

      e.shot.addEventListener('click', () => this.shoot());
      e.bFlip.addEventListener('click', () => this.flip());
      e.bStart.addEventListener('click', () => this.start());

      e.bGrid.addEventListener('click', () => {
        this.s.grid = !this.s.grid;
        this.applySettings();
        saveSettings(this.s);
      });

      e.bSet.addEventListener('click', () => {
        this.updateQuota();
        e.pSet.classList.add('open');
      });
      $$('.cSet').addEventListener('click', () => e.pSet.classList.remove('open'));

      e.bGal.addEventListener('click', () => {
        this.refreshGallery().then(() => e.pGal.classList.add('open'));
      });
      $$('.cGal').addEventListener('click', () => {
        e.pGal.classList.remove('open');
        this.setSelMode(false);
      });
      $$('.cSel').addEventListener('click', () => this.setSelMode(!this.selMode));
      $$('.bAll').addEventListener('click', () => {
        if (this.selected.size === this.photos.length) this.selected.clear();
        else this.photos.forEach((p) => this.selected.add(p.id));
        this.paintGallery();
      });
      $$('.bSave').addEventListener('click', () => this.saveSelected());
      $$('.bDel').addEventListener('click', () => this.deleteSelected());

      $$('.cView').addEventListener('click', () => this.closeViewer());
      $$('.bPrev').addEventListener('click', () => this.openViewer(this.viewIndex + 1));
      $$('.bNext').addEventListener('click', () => this.openViewer(this.viewIndex - 1));
      $$('.bVSave').addEventListener('click', () => {
        const p = this.photos[this.viewIndex];
        if (p) this.exportPhotos([p]);
      });
      $$('.bVDel').addEventListener('click', () => {
        const p = this.photos[this.viewIndex];
        if (!p) return;
        Store.del(p.id).then(() => {
          this.closeViewer();
          this.refreshGallery();
          this.toast('削除しました');
        });
      });

      e.zi.addEventListener('input', () => {
        this.s.zoom = parseFloat(e.zi.value);
        e.zl.textContent = this.s.zoom.toFixed(1) + '×';
        this.layout();
      });

      // ピンチでズーム
      let pinch = null;
      const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      e.stage.addEventListener(
        'touchstart',
        (ev) => {
          if (ev.touches.length === 2) pinch = { d: dist(ev.touches), z: this.s.zoom };
        },
        { passive: true }
      );
      e.stage.addEventListener(
        'touchmove',
        (ev) => {
          if (pinch && ev.touches.length === 2) {
            ev.preventDefault();
            const z = Math.min(6, Math.max(1, (pinch.z * dist(ev.touches)) / pinch.d));
            this.s.zoom = z;
            e.zi.value = z;
            e.zl.textContent = z.toFixed(1) + '×';
            this.layout();
          }
        },
        { passive: false }
      );
      e.stage.addEventListener('touchend', () => {
        if (pinch) {
          pinch = null;
          saveSettings(this.s);
        }
      });

      // 音量ボタン相当（キーボード）: スペース / Enter で撮影
      this.addEventListener('keydown', (ev) => {
        if (ev.key === ' ' || ev.key === 'Enter') {
          ev.preventDefault();
          this.shoot();
        }
      });
      this.tabIndex = 0;

      this.el.video.addEventListener('loadedmetadata', () => {
        this.layout();
        this.updateInfo();
      });
    }

    /* ---------- カメラ制御 ---------- */

    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return this.fail(
          'このブラウザではカメラを使えません',
          'iPad の Safari で開いてください。'
        );
      }
      if (!window.isSecureContext) {
        return this.fail(
          'HTTPS が必要です',
          'カメラは https:// または localhost でしか使えません。'
        );
      }

      this.stop();
      // カメラを起こす前に宣言する。起こしたあとでは、
      // すでに切り替わった設定を追いかけることになる。
      // no-audio-claim を付けると宣言しない（宣言のあり／なしを比べたいとき用）
      this._ambient = this.hasAttribute('no-audio-claim')
        ? false
        : claimAmbient(this._prevAudioType);
      const res = RES_PRESETS[this.s.res] || RES_PRESETS.max;

      const attempt = async (constraints) =>
        navigator.mediaDevices.getUserMedia({ video: constraints, audio: false }); // ← 音声は絶対に取らない

      let stream;
      try {
        stream = await attempt({
          facingMode: { ideal: this.s.facing },
          width: { ideal: res.w },
          height: { ideal: res.h },
        });
      } catch (err) {
        try {
          stream = await attempt({ facingMode: this.s.facing });
        } catch (err2) {
          try {
            stream = await attempt(true);
          } catch (err3) {
            const name = err3 && err3.name;
            // 音の宣言（ambient）がカメラの邪魔をする端末があるかもしれないので、
            // 許可以外の理由でこけたら宣言を取り下げて一度だけやり直す。
            // カメラが写らないより、音楽が止まるほうがまだましなので。
            if (this._ambient && name !== 'NotAllowedError' && name !== 'NotFoundError') {
              releaseAmbient(this._prevAudioType);
              this._ambient = false;
              try {
                stream = await attempt(true);
              } catch (err4) {
                return this.fail('カメラを起動できませんでした', (err4 && err4.message) || '');
              }
            } else if (name === 'NotAllowedError') {
              return this.fail('カメラが許可されていません', permHint());
            } else if (name === 'NotFoundError') {
              return this.fail('カメラが見つかりません', 'この端末にカメラがないようです。');
            } else {
              return this.fail('カメラを起動できませんでした', (err3 && err3.message) || '');
            }
          }
        }
      }

      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      // 万一オーディオトラックが混ざっても即座に破棄（無音の保険）
      stream.getAudioTracks().forEach((t) => {
        t.stop();
        stream.removeTrack(t);
      });

      // 再生中の音楽を絶対に横取りしないための保険
      this.el.video.muted = true;
      this.el.video.volume = 0;
      this.el.video.disableRemotePlayback = true;
      this.el.video.srcObject = stream;
      try {
        await this.el.video.play();
      } catch (e) {
        /* 自動再生が弾かれても loadedmetadata 後に再試行される */
      }

      this.el.perm.classList.remove('open');
      this.applySettings();
      this.layout();
      this.updateInfo();
      this.dispatchEvent(new CustomEvent('ready', { detail: { track: this.track } }));
      return true;
    }

    stop() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.track = null;
      }
      // 映像要素からも必ず切り離す。srcObject を差したままだとブラウザが
      // 「まだ再生中」とみなし、端末の音の権利を返さないことがある
      // （＝他アプリの音楽が止まったまま戻ってこない）
      const v = this.el && this.el.video;
      if (v && v.srcObject) {
        try { v.pause(); } catch (e) { /* 停止済みなら何もしなくてよい */ }
        v.srcObject = null;
      }
      releaseAmbient(this._prevAudioType);
      this._ambient = false;
    }

    /* いま映像が流れているか。組み込み先が「すでに動いていれば取り直さない」を
       判断するために使う（iOS は取り直すたびに許可を聞き直すことがある） */
    get isRunning() {
      return !!(this.track && this.track.readyState === 'live');
    }

    /* 音まわりの状態。うまくいかないときに何が起きているかを外から見るため */
    get audioInfo() {
      const s = audioSession();
      return {
        supported: !!s,
        type: s ? s.type : null,
        state: s ? s.state : null,
        claimed: !!this._ambient,
        audioTracks: this.stream ? this.stream.getAudioTracks().length : 0,
        videoMuted: this.el ? this.el.video.muted : null,
      };
    }

    async flip() {
      this.s.facing = this.s.facing === 'environment' ? 'user' : 'environment';
      saveSettings(this.s);
      await this.start();
    }

    handleVisibility() {
      if (document.hidden) {
        this._wasRunning = !!this.stream;
        this.stop();
      } else if (this._wasRunning) {
        this._wasRunning = false;
        // 画面に出ていないなら起こし直さない。組み込み先で隠されているときに
        // 勝手に復帰すると、再生中の音楽をもう一度止めてしまう
        if (this.offsetParent === null) return;
        this.start().catch(() => this.showPerm());
      }
    }

    showPerm() {
      this.el.perm.classList.add('open');
    }

    fail(title, msg) {
      this.el.pt.textContent = title;
      this.el.pm.textContent = msg;
      this.el.perm.classList.add('open');
      this.dispatchEvent(new CustomEvent('error', { detail: { title, message: msg } }));
      return false;
    }

    /* ---------- レイアウト（見たまま撮れる計算） ---------- */

    outputAspect() {
      const v = this.el.video;
      const r = RATIOS[this.s.ratio] ? RATIOS[this.s.ratio].value : null;
      if (r) return r;
      return v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3;
    }

    // 実際に切り出す領域（動画ピクセル座標）
    cropRect() {
      const v = this.el.video;
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return null;
      const z = Math.max(1, this.s.zoom || 1);
      let cw = vw / z, ch = vh / z;
      const target = RATIOS[this.s.ratio] ? RATIOS[this.s.ratio].value : null;
      if (target) {
        if (cw / ch > target) cw = ch * target;
        else ch = cw / target;
      }
      return { cx: (vw - cw) / 2, cy: (vh - ch) / 2, cw, ch, vw, vh };
    }

    layout() {
      const e = this.el, v = e.video;
      const sw = e.stage.clientWidth, sh = e.stage.clientHeight;
      if (!sw || !sh) return;
      const c = this.cropRect();
      if (!c) return;

      // フレーム = 切り出し領域と同じ縦横比で、ステージに収まる最大サイズ
      const ar = c.cw / c.ch;
      let fw = sw, fh = sw / ar;
      if (fh > sh) { fh = sh; fw = sh * ar; }
      Object.assign(e.frame.style, {
        width: fw + 'px', height: fh + 'px',
        left: (sw - fw) / 2 + 'px', top: (sh - fh) / 2 + 'px',
      });

      // 動画は、切り出し領域がフレームぴったりに重なるよう拡大・移動
      const k = fw / c.cw;
      Object.assign(v.style, {
        width: c.vw * k + 'px', height: c.vh * k + 'px',
        left: -c.cx * k + 'px', top: -c.cy * k + 'px',
      });

      v.classList.toggle('mir', this.s.facing === 'user');

      // グリッド線
      const g = e.grid;
      const set = (sel, css) => Object.assign(g.querySelector(sel).style, css);
      set('.h1', { left: 0, right: 0, top: '33.333%', height: '1px', width: '100%' });
      set('.h2', { left: 0, right: 0, top: '66.666%', height: '1px', width: '100%' });
      set('.v1', { top: 0, bottom: 0, left: '33.333%', width: '1px', height: '100%' });
      set('.v2', { top: 0, bottom: 0, left: '66.666%', width: '1px', height: '100%' });

      this.updateInfo(); // ズームや縦横比を変えたら解像度表示も追従させる
    }

    updateInfo() {
      const c = this.cropRect();
      if (!c) { this.el.info.textContent = '—'; return; }
      const w = Math.round(c.cw), h = Math.round(c.ch);
      const mp = ((w * h) / 1e6).toFixed(1);
      this.el.info.innerHTML = `<b>${w}×${h}</b> ／ ${mp}MP`;
      if (this.el.rInfo) this.el.rInfo.textContent = `いま：${w}×${h}px（${mp}メガピクセル）`;
    }

    /* ---------- 撮影 ---------- */

    async shoot() {
      if (this.busy) return;
      if (!this.stream) return this.start();
      this.busy = true;
      this.el.shot.disabled = true;
      try {
        if (this.s.timer > 0) await this.countdown(this.s.timer);
        const n = Math.max(1, this.s.burst | 0);
        const made = [];
        for (let i = 0; i < n; i++) {
          if (n > 1) this.el.shotN.textContent = i + 1 + '/' + n;
          const rec = await this.captureOne();
          if (rec) made.push(rec);
          if (i < n - 1) await new Promise((r) => setTimeout(r, this.s.burstInterval));
        }
        this.el.shotN.textContent = '';
        if (made.length) {
          await this.refreshGallery();
          this.toast(
            made.length > 1 ? `${made.length}枚 撮影しました` : '撮影しました（無音）'
          );
          if (this.s.autoShare) await this.exportPhotos(made);
        }
      } catch (err) {
        this.toast('撮影に失敗しました');
      } finally {
        this.busy = false;
        this.el.shot.disabled = false;
        this.el.shotN.textContent = '';
      }
    }

    countdown(sec) {
      return new Promise((resolve) => {
        const c = this.el.count;
        c.classList.add('on');
        let n = sec;
        c.textContent = n;
        const t = setInterval(() => {
          n--;
          if (n <= 0) {
            clearInterval(t);
            c.classList.remove('on');
            c.textContent = '';
            resolve();
          } else c.textContent = n;
        }, 1000);
      });
    }

    async captureOne() {
      const v = this.el.video;
      if (!v.videoWidth) return null;
      const c = this.cropRect();
      if (!c) return null;

      const w = Math.max(1, Math.round(c.cw));
      const h = Math.max(1, Math.round(c.ch));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d', { alpha: false });
      ctx.imageSmoothingQuality = 'high';

      const mirror = this.s.facing === 'user' && this.s.mirrorSave;
      if (mirror) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(v, c.cx, c.cy, c.cw, c.ch, 0, 0, w, h);

      const type = this.s.format === 'png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise((res) =>
        cv.toBlob(res, type, type === 'image/jpeg' ? this.s.quality : undefined)
      );
      if (!blob) return null;

      // 視覚だけのフィードバック（音は鳴らさない）
      this.el.flash.classList.remove('go');
      void this.el.flash.offsetWidth;
      this.el.flash.classList.add('go');

      const now = new Date();
      const rec = {
        id: 'p' + now.getTime() + '_' + Math.random().toString(36).slice(2, 7),
        createdAt: now.getTime(),
        name: 'silent_' + stamp(now) + (type === 'image/png' ? '.png' : '.jpg'),
        type,
        w, h,
        size: blob.size,
        blob,
      };

      if (this.s.store) {
        try {
          await Store.put(rec);
        } catch (err) {
          this.toast('端末に保存できませんでした（空き容量）');
        }
      }

      this.dispatchEvent(
        new CustomEvent('capture', {
          detail: { id: rec.id, blob, name: rec.name, width: w, height: h, type },
          bubbles: true,
          composed: true,
        })
      );
      return rec;
    }

    /* ---------- 書き出し（iPad の「写真」へ） ---------- */

    async exportPhotos(list) {
      if (!list || !list.length) return;
      const files = list.map((p) => new File([p.blob], p.name, { type: p.type }));
      if (navigator.canShare && navigator.canShare({ files })) {
        try {
          await navigator.share({ files });
          this.toast('共有シートから「画像を保存」を選んでください');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      // フォールバック：ダウンロード（iPad では「ファイル」に保存されます）
      for (const p of list) {
        const url = URL.createObjectURL(p.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = p.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
        await new Promise((r) => setTimeout(r, 250));
      }
      this.toast('保存しました（「ファイル」アプリを確認）');
    }

    /* ---------- ギャラリー ---------- */

    async refreshGallery() {
      if (this.noGallery) return;
      try {
        this.photos = await Store.all();
      } catch (e) {
        this.photos = [];
      }
      this.paintGallery();
      this.updateQuota();
      // サムネイル（直近1枚）をボタンに
      const last = this.photos[0];
      if (last) {
        this.el.bGal.innerHTML = '';
        const img = document.createElement('img');
        img.src = this.url(last);
        this.el.bGal.appendChild(img);
      } else {
        this.el.bGal.textContent = '🖼';
      }
    }

    url(p) {
      if (!this.urls.has(p.id)) this.urls.set(p.id, URL.createObjectURL(p.blob));
      return this.urls.get(p.id);
    }

    paintGallery() {
      const e = this.el;
      e.gcount.textContent = this.photos.length ? `${this.photos.length}枚` : '';
      e.empty.classList.toggle('hide', this.photos.length > 0);
      e.gg.innerHTML = '';
      this.photos.forEach((p, i) => {
        const d = document.createElement('div');
        d.className = 'gi' + (this.selected.has(p.id) ? ' sel' : '');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = this.url(p);
        d.appendChild(img);
        d.addEventListener('click', () => {
          if (this.selMode) {
            if (this.selected.has(p.id)) this.selected.delete(p.id);
            else this.selected.add(p.id);
            this.paintGallery();
          } else this.openViewer(i);
        });
        e.gg.appendChild(d);
      });
      const n = this.selected.size;
      this.shadowRoot.querySelector('.bSave').disabled = !n;
      this.shadowRoot.querySelector('.bDel').disabled = !n;
      this.shadowRoot.querySelector('.bSave').textContent = n ? `写真に保存 (${n})` : '写真に保存';
    }

    setSelMode(on) {
      this.selMode = on;
      this.selected.clear();
      this.el.gbar.classList.toggle('hide', !on);
      this.shadowRoot.querySelector('.cSel').textContent = on ? 'やめる' : '選択';
      this.paintGallery();
    }

    async saveSelected() {
      const list = this.photos.filter((p) => this.selected.has(p.id));
      await this.exportPhotos(list);
    }

    async deleteSelected() {
      const ids = Array.from(this.selected);
      if (!ids.length) return;
      if (!confirm(`${ids.length}枚を削除します。よろしいですか？`)) return;
      for (const id of ids) {
        await Store.del(id);
        const u = this.urls.get(id);
        if (u) { URL.revokeObjectURL(u); this.urls.delete(id); }
      }
      this.selected.clear();
      await this.refreshGallery();
      this.toast('削除しました');
    }

    openViewer(i) {
      if (i < 0 || i >= this.photos.length) return;
      this.viewIndex = i;
      const p = this.photos[i];
      this.el.vimg.src = this.url(p);
      this.el.vt.textContent = `${p.name}　${p.w}×${p.h}　${fmtBytes(p.size)}`;
      this.el.viewer.classList.add('open');
    }

    closeViewer() {
      this.el.viewer.classList.remove('open');
      this.viewIndex = -1;
    }

    async updateQuota() {
      if (!navigator.storage || !navigator.storage.estimate) return;
      try {
        const { usage, quota } = await navigator.storage.estimate();
        this.el.quota.textContent = `${fmtBytes(usage)} / 目安 ${fmtBytes(quota)}`;
      } catch (e) {
        /* noop */
      }
    }

    /* ---------- 設定 UI ---------- */

    renderSettings() {
      const seg = (sel, items, get, set) => {
        const box = this.shadowRoot.querySelector(sel);
        box.innerHTML = '';
        items.forEach((it) => {
          const b = document.createElement('button');
          b.textContent = it.label;
          b.addEventListener('click', () => {
            set(it.value);
            saveSettings(this.s);
            this.applySettings();
            paintAll();
          });
          b._v = it.value;
          box.appendChild(b);
        });
        box._paint = () => {
          Array.from(box.children).forEach((b) => b.classList.toggle('on', b._v === get()));
        };
        return box;
      };

      const segs = [
        seg('.sRatio', Object.keys(RATIOS).map((k) => ({ label: RATIOS[k].label, value: k })),
          () => this.s.ratio, (v) => { this.s.ratio = v; }),
        seg('.sRes', Object.keys(RES_PRESETS).map((k) => ({ label: RES_PRESETS[k].label, value: k })),
          () => this.s.res, (v) => { this.s.res = v; this.start(); }),
        seg('.sFmt', [{ label: 'JPEG', value: 'jpeg' }, { label: 'PNG', value: 'png' }],
          () => this.s.format, (v) => { this.s.format = v; }),
        seg('.sTimer', [{ label: 'OFF', value: 0 }, { label: '3秒', value: 3 }, { label: '10秒', value: 10 }],
          () => this.s.timer, (v) => { this.s.timer = v; }),
        seg('.sBurst', [{ label: 'OFF', value: 1 }, { label: '3枚', value: 3 }, { label: '5枚', value: 5 }, { label: '10枚', value: 10 }],
          () => this.s.burst, (v) => { this.s.burst = v; }),
      ];

      const sw = (sel, get, set) => {
        const el = this.shadowRoot.querySelector(sel);
        el.addEventListener('click', () => {
          set(!get());
          saveSettings(this.s);
          this.applySettings();
          paintAll();
        });
        el._paint = () => el.classList.toggle('on', !!get());
        return el;
      };

      const sws = [
        sw('.wGrid', () => this.s.grid, (v) => { this.s.grid = v; }),
        sw('.wMir', () => this.s.mirrorSave, (v) => { this.s.mirrorSave = v; }),
        sw('.wStore', () => this.s.store, (v) => { this.s.store = v; }),
        sw('.wShare', () => this.s.autoShare, (v) => { this.s.autoShare = v; }),
      ];

      const qi = this.shadowRoot.querySelector('.qi');
      const qv = this.shadowRoot.querySelector('.qv');
      qi.addEventListener('input', () => {
        this.s.quality = parseFloat(qi.value);
        qv.textContent = Math.round(this.s.quality * 100) + '%';
      });
      qi.addEventListener('change', () => saveSettings(this.s));

      const paintAll = () => {
        segs.forEach((b) => b._paint());
        sws.forEach((b) => b._paint());
        qi.value = this.s.quality;
        qv.textContent = Math.round(this.s.quality * 100) + '%';
        this.shadowRoot.querySelector('.fQ').classList.toggle('hide', this.s.format !== 'jpeg');
      };
      this._paintSettings = paintAll;
      paintAll();
    }

    applySettings() {
      this.el.grid.classList.toggle('on', !!this.s.grid);
      this.el.bGrid.classList.toggle('on', !!this.s.grid);
      this.el.zi.value = this.s.zoom;
      this.el.zl.textContent = (this.s.zoom || 1).toFixed(1) + '×';
      this.layout();
      if (this._paintSettings) this._paintSettings();
    }

    toast(msg) {
      const t = this.el.toast;
      t.textContent = msg;
      t.classList.add('on');
      clearTimeout(this._tt);
      this._tt = setTimeout(() => t.classList.remove('on'), 2200);
    }

    /* ---------- 外部 API ---------- */

    capture() { return this.captureOne(); }
    getPhotos() { return this.noGallery ? Promise.resolve([]) : Store.all(); }
    deletePhoto(id) { return Store.del(id).then(() => this.refreshGallery()); }
    clearPhotos() { return this.noGallery ? Promise.resolve() : Store.clear().then(() => this.refreshGallery()); }
    get settings() { return Object.assign({}, this.s); }
    set settings(v) {
      Object.assign(this.s, v || {});
      saveSettings(this.s);
      this.applySettings();
    }
  }

  customElements.define('silent-camera', SilentCamera);
  window.SilentCamera = SilentCamera;
})();
