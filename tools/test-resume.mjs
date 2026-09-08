/*
 * ホームに戻って開き直したとき、カメラが戻ってくるかを確かめる。
 *
 *   npm i -g playwright && npx playwright install chromium   （最初の一回だけ）
 *   node tools/test-resume.mjs
 *
 * 実機の代わりに、偽のカメラを積んだ Chromium で
 *   起動 → 撮影 → ホームに戻る → 開き直す
 * を繰り返す。iPad で「一度撮ってホームに戻り、もっかい開くと反応しない」
 * という不具合が出たので、二度と戻らないように残してある。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8117;
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  try {
    // グローバルに入れた playwright（NODE_PATH 経由）でも動くように
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch (e2) {
    console.error('playwright が要ります： npm i -g playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  try {
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',   // 偽のカメラ（実機がなくても映像が流れる）
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['camera'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [ページのエラー]', e.message));
await page.goto(`http://localhost:${PORT}/index.html`);

const state = () =>
  page.evaluate(() => {
    const cam = document.querySelector('silent-camera');
    const v = cam.shadowRoot.querySelector('video');
    return {
      running: cam.isRunning,
      paused: v.paused,
      hasSrc: !!v.srcObject,
      t: v.currentTime,
      perm: cam.shadowRoot.querySelector('.perm').classList.contains('open'),
    };
  });

/* ホームに戻る／開き直す、を再現する（画面を隠して visibilitychange を出す） */
const setHidden = (hidden) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

const shoot = () => page.evaluate(() => document.querySelector('silent-camera').shoot());
const shots = () => page.evaluate(() => document.querySelector('silent-camera').getPhotos().then((p) => p.length));

let bad = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? '  ok  ' : ' NG   '} ${name}${ok || !extra ? '' : '  ' + JSON.stringify(extra)}`);
  if (!ok) bad++;
};

await page.waitForFunction(() => document.querySelector('silent-camera').isRunning, null, { timeout: 8000 }).catch(() => {});
check('起動したらカメラが入る', (await state()).running, await state());

/* --- 1周目：撮る → ホームに戻る → 開き直す --- */
await shoot();
check('1枚撮れる', (await shots()) === 1);

await setHidden(true);
await page.waitForTimeout(150);
check('ホームに戻ったらカメラを離す', !(await state()).running, await state());

await setHidden(true);      // iOS は hidden が続けて2回来ることがある（ホーム → 画面ロック）
await page.waitForTimeout(100);

await setHidden(false);
await page.waitForTimeout(2500);
let s = await state();
check('開き直したらカメラが戻る', s.running && !s.paused && s.hasSrc, s);
check('映像が進んでいる', s.t > 0, s);
check('エラー画面が出ていない', !s.perm, s);

/* --- 2周目：もう一度同じことをする --- */
await shoot();
check('戻ったあとにもう1枚撮れる', (await shots()) === 2);
await setHidden(true);
await page.waitForTimeout(150);
await setHidden(false);
await page.waitForTimeout(2500);
s = await state();
check('2周目も戻る', s.running && !s.paused, s);

/* --- 合図が来なくても、映像が死んだら見張りが気づく --- */
await page.evaluate(() => document.querySelector('silent-camera').stream.getTracks().forEach((t) => t.stop()));
await page.waitForTimeout(4000);
s = await state();
check('合図なしで映像が死んでも自力で戻る', s.running && !s.paused, s);

/* --- 止まった状態から、シャッターで起き上がる --- */
await page.evaluate(() => {
  const cam = document.querySelector('silent-camera');
  cam._wantRunning = false;
  cam._teardown();
});
await page.waitForTimeout(300);
check('止めた状態になる', !(await state()).running);
await shoot();
await page.waitForTimeout(2500);
s = await state();
check('シャッターを押すと起き上がる', s.running && !s.paused, s);

await browser.close();
server.close();
console.log(bad ? `\n${bad} 件 だめでした` : '\nぜんぶ通りました');
process.exit(bad ? 1 : 0);
