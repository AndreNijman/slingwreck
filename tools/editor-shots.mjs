#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { encode } from '../build.js?v=20260904-1';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, 'shots');
const issues = [];
const mime = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.mjs': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const building = {
  v: 1,
  blocks: [
    ['slab', 'stone', 6, 0.5, 0], ['post', 'wood', 5.5, 2, 0],
    ['post', 'wood', 6.5, 2, 0], ['slab', 'wood', 6, 3.5, 0],
    ['slab', 'stone', 10, 0.5, 0], ['post', 'wood', 9.5, 2, 0],
    ['post', 'wood', 10.5, 2, 0], ['slab', 'wood', 10, 3.5, 0],
    ['cube', 'glass', 7.5, 0.5, 0], ['cube', 'glass', 8.5, 0.5, 0]
  ],
  pigs: [
    ['king', 14, 1, 0], ['runt', 3, 0.5, 0], ['runt', 12, 0.5, 0]
  ]
};
const invalid = {
  v: 1,
  blocks: [
    ['cube', 'wood', 7, 0.5, 0], ['cube', 'wood', 7.5, 0.5, 0]
  ],
  pigs: [['king', 10, 1, 0]]
};
const falling = {
  ...building,
  blocks: [...building.blocks, ['cube', 'wood', 18, 8, 0]]
};

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const relative = url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`;
      const path = resolve(root, relative);
      if (path !== resolve(root, 'index.html') && !path.startsWith(`${root}/`)) {
        throw new Error('path outside project');
      }
      const body = await readFile(path);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': `${mime[extname(path)] ?? 'application/octet-stream'}; charset=utf-8`
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    }
  });
}

function collectRuntime(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(`${label} console: ${message.text()}`);
  });
  page.on('pageerror', (error) => issues.push(`${label} page: ${error.message}`));
  page.on('requestfailed', (request) => {
    issues.push(`${label} request: ${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push(`${label} HTTP ${response.status()}: ${response.url()}`);
  });
}

async function loadBlueprint(page, blueprint) {
  await page.locator('#blueprint-input').fill(encode(blueprint));
  await page.locator('#load-blueprint-button').click();
  await page.waitForFunction((count) =>
    window.__SLINGWRECK_SMOKE__?.().editor?.pieceCount === count,
  blueprint.blocks.length + blueprint.pigs.length);
}

async function hoverWorld(page, x, y) {
  const point = await page.evaluate(({ x, y }) => {
    const camera = window.__SLINGWRECK_SMOKE__().editor.camera;
    const rect = document.querySelector('#game').getBoundingClientRect();
    const scaleX = rect.width / camera.viewportW;
    const scaleY = rect.height / camera.viewportH;
    return {
      x: rect.left + (camera.viewportX + camera.viewportW / 2 +
        (x - camera.x) * camera.scale) * scaleX,
      y: rect.top + (camera.viewportY + camera.viewportH / 2 -
        (y - camera.y) * camera.scale) * scaleY
    };
  }, { x, y });
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(() => Boolean(window.__SLINGWRECK_SMOKE__?.().editor?.ghost));
}

async function frameDock(page, section) {
  await page.waitForTimeout(40);
  await page.evaluate((section) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const dock = document.querySelector('.editor-dock');
    const palette = document.querySelector('.palette-panel');
    if (dock) dock.scrollTop = section === 'palette' ? 0 : palette?.offsetHeight ?? 0;
  }, section);
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  if (section === 'palette') {
    await page.waitForFunction(() => document.querySelector('.editor-dock')?.scrollTop < 1);
    await page.waitForTimeout(80);
    await page.evaluate(() => { document.querySelector('.editor-dock').scrollTop = 0; });
  }
}

async function captureSet(page, suffix, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}?smoke-test=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('html[data-game-ready="true"]');
  await page.locator('#editor-button').click();
  await page.waitForFunction(() => Boolean(window.__SLINGWRECK_SMOKE__?.().editor));
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#game');
    const camera = window.__SLINGWRECK_SMOKE__?.().editor?.camera;
    return canvas && camera && Math.abs(canvas.clientWidth - camera.viewportW) < 1;
  });
  await page.waitForFunction(() => window.__SLINGWRECK_SMOKE__?.().editor?.pieceCount === 0);
  await page.evaluate(() => new Promise((resolveFrame) =>
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  await page.screenshot({ path: resolve(shots, `p4-editor-empty${suffix}.png`) });

  await loadBlueprint(page, building);
  await hoverWorld(page, 16, 0.5);
  await frameDock(page, 'palette');
  await page.screenshot({ path: resolve(shots, `p4-editor-building${suffix}.png`) });

  await loadBlueprint(page, invalid);
  await page.locator('[data-validation-code="overlap"]').click();
  await frameDock(page, 'inspector');
  await page.screenshot({ path: resolve(shots, `p4-editor-invalid${suffix}.png`) });

  await loadBlueprint(page, falling);
  await page.locator('#settle-button').click();
  await page.waitForFunction(() => {
    const editor = window.__SLINGWRECK_SMOKE__?.().editor;
    return editor && !editor.settling && /needs bracing/i.test(editor.settleResult ?? '');
  }, null, { timeout: 7000 });
  await frameDock(page, 'inspector');
  await page.screenshot({ path: resolve(shots, `p4-editor-settle${suffix}.png`) });
}

await mkdir(shots, { recursive: true });
const server = staticServer();
await new Promise((ready, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', ready);
});
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/`;
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  collectRuntime(page, 'editor shots');
  await captureSet(page, '', { width: 1280, height: 720 });
  await captureSet(page, '-portrait', { width: 390, height: 844 });
  if (issues.length) throw new Error(issues.join('\n'));
  console.log('wrote four desktop and four portrait editor frames to shots/');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
