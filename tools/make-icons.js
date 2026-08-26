/*
 * make-icons.js — 依存パッケージなしで PWA 用 PNG アイコンを生成する
 *   実行: node tools/make-icons.js
 * 4倍で描いてから縮小するので、輪郭がなめらかになります。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- 描画用のちいさなキャンバス ---------- */
function Canvas(size) {
  const buf = Buffer.alloc(size * size * 3);
  return {
    size,
    buf,
    fill(hex) {
      const [r, g, b] = rgb(hex);
      for (let i = 0; i < size * size; i++) buf.writeUInt8(r, i * 3), buf.writeUInt8(g, i * 3 + 1), buf.writeUInt8(b, i * 3 + 2);
    },
    px(x, y, hex) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const [r, g, b] = rgb(hex);
      const i = (y * size + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    },
    roundRect(x0, y0, x1, y1, rad, hex) {
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          if (inRound(x + 0.5, y + 0.5, x0, y0, x1, y1, rad)) this.px(x, y, hex);
        }
      }
    },
    circle(cx, cy, r, hex) {
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r * r) this.px(x, y, hex);
        }
      }
    },
    line(x0, y0, x1, y1, w, hex) {
      const minX = Math.floor(Math.min(x0, x1) - w), maxX = Math.ceil(Math.max(x0, x1) + w);
      const minY = Math.floor(Math.min(y0, y1) - w), maxY = Math.ceil(Math.max(y0, y1) + w);
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        if (distSeg(x + 0.5, y + 0.5, x0, y0, x1, y1) <= w / 2) this.px(x, y, hex);
      }
    },
    poly(pts, hex) {
      const ys = pts.map((p) => p[1]);
      for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
        const xs = [];
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if (yi > y + 0.5 !== yj > y + 0.5) xs.push(xi + ((y + 0.5 - yi) / (yj - yi)) * (xj - xi));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2)
          for (let x = Math.ceil(xs[k]); x < xs[k + 1]; x++) this.px(x, y, hex);
      }
    },
  };
}

const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function inRound(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function distSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/* ---------- 絵柄 ---------- */
const BG = '#0d0d10', BODY = '#f2f2f5', DARK = '#0d0d10', ACCENT = '#ffd60a';

function draw(c, inset) {
  const S = c.size;
  const u = (v) => inset + v * (S - inset * 2); // 内側の座標系 0..1
  const k = (S - inset * 2);

  c.fill(BG);
  // 角丸の下地
  c.roundRect(u(0.0), u(0.0), u(1.0), u(1.0), k * 0.22, '#141419');

  // カメラ本体
  c.roundRect(u(0.10), u(0.30), u(0.90), u(0.82), k * 0.10, BODY);
  // 上の出っぱり
  c.roundRect(u(0.30), u(0.20), u(0.56), u(0.34), k * 0.04, BODY);
  // レンズ
  c.circle(u(0.50), u(0.565), k * 0.19, DARK);
  c.circle(u(0.50), u(0.565), k * 0.145, ACCENT);
  c.circle(u(0.50), u(0.565), k * 0.085, DARK);
  // 小窓
  c.circle(u(0.795), u(0.385), k * 0.030, ACCENT);

  // 消音バッジ（スピーカー＋斜線）
  const bx = u(0.755), by = u(0.755), br = k * 0.155;
  c.circle(bx, by, br, DARK);
  c.circle(bx, by, br * 0.86, BODY);
  const sx = bx - br * 0.30, sy = by;
  const h = br * 0.30;
  c.roundRect(sx - br * 0.20, sy - h * 0.55, sx + br * 0.02, sy + h * 0.55, 1, DARK);
  c.poly([[sx + br * 0.02, sy - h], [sx + br * 0.42, sy - h * 1.5], [sx + br * 0.42, sy + h * 1.5], [sx + br * 0.02, sy + h]], DARK);
  c.line(bx - br * 0.45, by + br * 0.45, bx + br * 0.5, by - br * 0.5, br * 0.16, DARK);
}

/* ---------- 縮小 & PNG 書き出し ---------- */
function downsample(src, factor) {
  const S = src.size / factor;
  const out = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const i = ((y * factor + dy) * src.size + (x * factor + dx)) * 3;
      r += src.buf[i]; g += src.buf[i + 1]; b += src.buf[i + 2];
    }
    const n = factor * factor, o = (y * S + x) * 3;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
  }
  return { size: S, buf: out };
}

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png({ size, buf }) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    buf.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 実行 ---------- */
const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
const F = 4;

[[180, 0], [192, 0], [512, 0], [512, 0.13]].forEach(([size, padRatio], i) => {
  const c = Canvas(size * F);
  draw(c, Math.round(size * F * padRatio));
  const small = downsample(c, F);
  const name = padRatio ? `icon-${size}-maskable.png` : `icon-${size}.png`;
  fs.writeFileSync(path.join(dir, name), png(small));
  console.log('  ✓', name);
});
console.log('アイコンを生成しました →', dir);
