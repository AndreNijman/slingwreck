import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { TUNE } from '../data.js';

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
    const path = resolve(root, relative);
    if (path !== resolve(root, 'index.html') && !path.startsWith(`${root}/`)) {
      throw new Error('path outside project');
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': `${mime[extname(path)] ?? 'application/octet-stream'}; charset=utf-8`
    });
    response.end(await readFile(path));
  } catch (error) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(String(error));
  }
});

function aimingPouch() {
  const x0 = TUNE.slingX - 3;
  const x1 = TUNE.plotW + 2;
  const scale = viewport.width / (x1 - x0);
  const centreX = (x0 + x1) / 2;
  const centreY = 6;
  return {
    scale,
    x: viewport.width / 2 + (TUNE.slingX - centreX) * scale,
    y: viewport.height / 2 - (TUNE.slingY - centreY) * scale
  };
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

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('html[data-game-ready="true"]');
  await page.locator('#play-button').click();
  await page.waitForSelector('#game[data-phase="aiming"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(shots, 'p2-aiming.png') });

  const pouch = aimingPouch();
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
