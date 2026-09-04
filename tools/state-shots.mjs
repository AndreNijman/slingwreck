import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { TUNE } from '../data.js?v=20260904-2';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, 'shots');
const viewport = { width: 1280, height: 720 };
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`;
    // The campaign tries to sync progress to the guard. There is no guard in front of a
    // local static server, so without this stub every run logs a 404 — harmless in itself,
    // but it trips the strict error collector below and, worse, it is exactly the kind of
    // expected noise that hides a real failed request. `tools/smoke.mjs` stubs the same
    // endpoint for the same reason.
    if (url.pathname === '/_guard/profile') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ profile: null }));
      return;
    }
    const path = resolve(root, relative);
    if (path !== resolve(root, 'index.html') && !path.startsWith(`${root}/`)) {
      throw new Error('path outside project');
    }
    // Read before writing the header. Reading after `writeHead` means a missing file
    // throws with the 200 already sent, and the catch below then tries to send a second
    // header — which crashes the whole run with ERR_HTTP_HEADERS_SENT rather than serving
    // a 404 for one asset.
    const body = await readFile(path);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': `${mime[extname(path)] ?? 'application/octet-stream'}; charset=utf-8`
    });
    response.end(body);
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end(String(error));
  }
});

// Ask the page where the pouch is rather than recomputing the camera transform here.
// This function used to duplicate that maths and had silently drifted out of agreement
// with the real camera, so every drag missed the pouch and no shot ever fired — while
// `tools/smoke.mjs`, which reads the same values from the page, kept working. Two copies
// of one calculation, one of them stale.
async function aimingPouch(page) {
  return page.evaluate(() => {
    const state = window.__SLINGWRECK_SMOKE__();
    const { camera, sling } = state;
    return {
      scale: camera.scale,
      x: camera.viewportX + camera.viewportW / 2 + (sling.x - camera.x) * camera.scale,
      y: camera.viewportY + camera.viewportH / 2 - (sling.y - camera.y) * camera.scale
    };
  });
}


await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const address = server.address();
const failures = [];
let browser;

try {
  await mkdir(shots, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => {
    failures.push(`request: ${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  });

  // `?smoke-test` installs the read-only state hook, which is gated off in production.
  await page.goto(`http://127.0.0.1:${address.port}/?smoke-test`, { waitUntil: 'networkidle' });
  await page.waitForSelector('html[data-game-ready="true"]');
  // P5.7 put a campaign shell in front of play: the title button opens the episode
  // picker rather than a level. Note the canvas keeps a `data-phase` from the default
  // round, so waiting on `aiming` alone passes vacuously on a menu — which is why the
  // drag below used to land on nothing and no shot ever fired.
  await page.locator('#play-button').click();
  await page.locator('.episode-choice[data-episode="1"]').click();
  await page.locator('.level-choice[data-level-id="sty-01"]').click();
  await page.waitForFunction(() => window.__SLINGWRECK_SMOKE__?.()?.phase === 'aiming');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(shots, 'p2-aiming.png') });

  const pouch = await aimingPouch(page);
  const draw = { x: -1.5, y: -0.55 };
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  await page.mouse.move(
    pouch.x + draw.x * pouch.scale,
    pouch.y - draw.y * pouch.scale,
    { steps: 8 }
  );
  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(shots, 'p2-drawn.png') });

  await page.mouse.up();
  await page.waitForSelector('#game[data-phase="flying"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(shots, 'p2-flying.png') });

  await page.waitForFunction(() => {
    const canvas = document.querySelector('#game');
    return canvas?.dataset.phase === 'aiming' && canvas.dataset.cameraMode === 'settling';
  }, null, { timeout: 10000 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(shots, 'p2-settled.png') });

  if (failures.length) throw new Error(failures.join('\n'));
  console.log('wrote shots/p2-aiming.png, p2-drawn.png, p2-flying.png and p2-settled.png');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
