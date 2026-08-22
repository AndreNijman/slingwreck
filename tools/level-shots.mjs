#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { LEVELS } from '../levels.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = resolve(root, 'shots/levels');
const width = 960;
const height = 540;
const minForegroundRatio = 0.0005;
const issues = [];
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function usage(message = null, code = 2) {
  if (message) console.error(message);
  console.error('usage: node tools/level-shots.mjs [--episode <n> | --level <id>] [--no-sheet]');
  process.exit(code);
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) usage(`${flag} requires a value`);
  return value;
}

function parseArgs(args) {
  let episode = null;
  let levelId = null;
  let sheet = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--episode') {
      if (episode !== null) usage('--episode may be supplied only once');
      const value = takeValue(args, index, arg);
      if (!/^[1-9]\d*$/.test(value)) usage('--episode must be a positive integer');
      episode = Number(value);
      index++;
    } else if (arg === '--level') {
      if (levelId !== null) usage('--level may be supplied only once');
      levelId = takeValue(args, index, arg);
      index++;
    } else if (arg === '--no-sheet') {
      sheet = false;
    } else if (arg === '--help') {
      usage(null, 0);
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  if (episode !== null && levelId !== null) {
    usage('--episode and --level are mutually exclusive');
  }
  let levels = LEVELS;
  if (episode !== null) levels = LEVELS.filter((level) => level.episode === episode);
  if (levelId !== null) levels = LEVELS.filter((level) => level.id === levelId);
  if (!levels.length) {
    usage(levelId === null ? `no levels in episode ${episode}` : `unknown level id: ${levelId}`);
  }
  for (const level of levels) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(level.id)) {
      throw new Error(`level id is not safe for a filename: ${level.id}`);
    }
  }
  return { levels, makeSheet: sheet && levelId === null };
}

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; min-width: ${width}px; background: #211a16; }
  canvas { display: block; }
  #frame { width: ${width}px; height: ${height}px; }
  #background { position: absolute; left: -10000px; top: 0; width: ${width}px; height: ${height}px; }
  #sheet[hidden] { display: none; }
</style>
<canvas id="frame" width="${width}" height="${height}"></canvas>
<canvas id="background" width="${width}" height="${height}"></canvas>
<canvas id="sheet" hidden></canvas>
<script type="module">
import { TUNE } from '/data.js';
import { LEVELS } from '/levels.js';
import { makeRound, stepRound } from '/sim.js';
import { draw, frameRect, makeCamera, makeRenderer } from '/render.js';

const WIDTH = ${width};
const HEIGHT = ${height};
const SHOT_SEED = 0x51a9e11;
const SAMPLE_STRIDE = 4;
const frame = document.querySelector('#frame');
const background = document.querySelector('#background');
const sheet = document.querySelector('#sheet');
const renderer = makeRenderer(frame);
const backgroundRenderer = makeRenderer(background);
const levels = new Map(LEVELS.map((level) => [level.id, level]));
const captures = new Map();
renderer.now = () => 0;
backgroundRenderer.now = () => 0;

function cameraForPlot() {
  const camera = makeCamera();
  camera.canvasW = WIDTH;
  camera.canvasH = HEIGHT;
  camera.viewportW = WIDTH;
  camera.viewportH = HEIGHT;
  frameRect(camera, TUNE.slingX - 0.8, 0, TUNE.plotW, TUNE.plotH, 0.6);
  return camera;
}

function movement(body, start) {
  const dx = body.x - start.x;
  const dy = body.y - start.y;
  let distance = Math.sqrt(dx * dx + dy * dy);
  if (body.role === 'block') {
    const dc = body.c - start.c;
    const ds = body.s - start.s;
    const radius = body.kind === 'circle' ? body.r :
      Math.sqrt(body.hw * body.hw + body.hh * body.hh);
    distance = Math.max(distance, radius * Math.sqrt(dc * dc + ds * ds));
  }
  return distance;
}

function settle(level) {
  const round = makeRound({
    mode: 'campaign',
    seed: SHOT_SEED,
    bag: level.bag,
    blueprint: level.blueprint
  });
  const bodies = [...round.blocks, ...round.pigs, ...round.balloons];
  const starts = bodies.map((body) => ({
    body,
    pose: { x: body.x, y: body.y, c: body.c, s: body.s }
  }));
  const steps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
  for (let step = 0; step < steps; step++) stepRound(round, TUNE.step);
  let maxMovement = 0;
  let moved = false;
  for (const record of starts) {
    const distance = movement(record.body, record.pose);
    maxMovement = Math.max(maxMovement, distance);
    if (record.body.dead || distance > 1e-7) moved = true;
  }
  return { round, moved, maxMovement };
}

function backgroundOnly(round) {
  return {
    ...round,
    world: {
      ...round.world,
      bodies: round.world.bodies.filter((body) => body.role === 'ground')
    }
  };
}

function foregroundRatio() {
  const actual = frame.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
  const empty = background.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
  let foreground = 0;
  let samples = 0;
  for (let y = SAMPLE_STRIDE / 2; y < HEIGHT; y += SAMPLE_STRIDE) {
    for (let x = SAMPLE_STRIDE / 2; x < WIDTH; x += SAMPLE_STRIDE) {
      const offset = (y * WIDTH + x) * 4;
      const difference = Math.abs(actual[offset] - empty[offset]) +
        Math.abs(actual[offset + 1] - empty[offset + 1]) +
        Math.abs(actual[offset + 2] - empty[offset + 2]);
      if (difference > 24) foreground++;
      samples++;
    }
  }
  return { ratio: foreground / samples, foreground, samples };
}

function copyFrame() {
  const copy = document.createElement('canvas');
  copy.width = WIDTH;
  copy.height = HEIGHT;
  copy.getContext('2d', { alpha: false }).drawImage(frame, 0, 0);
  return copy;
}

function renderLevel(id) {
  const level = levels.get(id);
  if (!level) throw new RangeError('unknown level id: ' + id);
  const result = settle(level);
  const camera = cameraForPlot();
  renderer.effects = [];
  renderer.trail = [];
  draw(renderer, result.round, camera, 1, null);
  draw(backgroundRenderer, backgroundOnly(result.round), { ...camera }, 1, null);
  const sample = foregroundRatio();
  const pieceCount = level.blueprint.blocks.length + level.blueprint.pigs.length;
  captures.set(id, {
    canvas: copyFrame(),
    id,
    pieceCount,
    bag: [...level.bag]
  });
  return {
    id,
    pieceCount,
    moved: result.moved,
    maxMovement: result.maxMovement,
    foregroundRatio: sample.ratio,
    foregroundSamples: sample.foreground,
    totalSamples: sample.samples
  };
}

function buildSheet(ids) {
  if (!ids.length) throw new Error('contact sheet needs at least one level');
  const tiles = ids.map((id) => {
    const tile = captures.get(id);
    if (!tile) throw new Error('level has no captured tile: ' + id);
    return tile;
  });
  const tileW = 320;
  const imageH = 180;
  const labelH = 58;
  const gap = 16;
  const pad = 20;
  const columns = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / columns);
  sheet.width = pad * 2 + columns * tileW + (columns - 1) * gap;
  sheet.height = pad * 2 + rows * (imageH + labelH) + (rows - 1) * gap;
  sheet.style.width = sheet.width + 'px';
  sheet.style.height = sheet.height + 'px';
  sheet.hidden = false;
  const ctx = sheet.getContext('2d', { alpha: false });
  ctx.fillStyle = '#211a16';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.textBaseline = 'alphabetic';
  for (let index = 0; index < tiles.length; index++) {
    const tile = tiles[index];
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = pad + column * (tileW + gap);
    const y = pad + row * (imageH + labelH + gap);
    ctx.drawImage(tile.canvas, x, y, tileW, imageH);
    ctx.strokeStyle = '#2b211c';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, tileW - 2, imageH - 2);
    ctx.fillStyle = '#e8d5b0';
    ctx.fillRect(x, y + imageH, tileW, labelH);
    ctx.fillStyle = '#2b211c';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(tile.id + '  |  ' + tile.pieceCount + ' pieces',
      x + 10, y + imageH + 22, tileW - 20);
    ctx.font = '13px monospace';
    ctx.fillText('bag: ' + tile.bag.join(', '),
      x + 10, y + imageH + 45, tileW - 20);
  }
  return { width: sheet.width, height: sheet.height, tiles: tiles.length };
}

window.__LEVEL_SHOTS__ = Object.freeze({ buildSheet, renderLevel });
document.documentElement.dataset.ready = 'yes';
</script>`;

function staticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8'
        });
        response.end(html);
        return;
      }
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(`${root}/`)) throw new Error('path outside project');
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
}

function collectRuntime(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => issues.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => {
    issues.push(`request: ${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push(`HTTP ${response.status()}: ${response.url()}`);
  });
}

const options = parseArgs(process.argv.slice(2));
await mkdir(shotDir, { recursive: true });
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
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  collectRuntime(page);
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('html[data-ready="yes"]');

  console.log('level       pieces  moved');
  const captured = [];
  for (const level of options.levels) {
    const pieceCount = level.blueprint.blocks.length + level.blueprint.pigs.length;
    try {
      const result = await page.evaluate((id) => window.__LEVEL_SHOTS__.renderLevel(id), level.id);
      await page.locator('#frame').screenshot({ path: resolve(shotDir, `${level.id}.png`) });
      captured.push(level.id);
      console.log(
        `${level.id.padEnd(12)}${String(pieceCount).padStart(6)}  ${result.moved ? 'YES' : 'no'}`
      );
      if (result.pieceCount !== pieceCount) {
        issues.push(`${level.id}: browser counted ${result.pieceCount} pieces; Node counted ${pieceCount}`);
      }
      if (result.foregroundRatio < minForegroundRatio) {
        issues.push(
          `${level.id}: blank frame; foreground ${result.foregroundRatio.toFixed(6)} ` +
          `(${result.foregroundSamples}/${result.totalSamples} samples), minimum ${minForegroundRatio}`
        );
      }
    } catch (error) {
      console.log(`${level.id.padEnd(12)}${String(pieceCount).padStart(6)}  ERROR`);
      issues.push(`${level.id}: ${error.message}`);
    }
  }

  if (options.makeSheet) {
    if (captured.length === options.levels.length) {
      const result = await page.evaluate((ids) => window.__LEVEL_SHOTS__.buildSheet(ids), captured);
      await page.locator('#sheet').screenshot({
        path: resolve(shotDir, '_contact-sheet.png')
      });
      console.log(`contact sheet: ${result.tiles} tiles, ${result.width}x${result.height}`);
    } else {
      issues.push(`contact sheet skipped: captured ${captured.length}/${options.levels.length} levels`);
    }
  }

  if (issues.length) throw new Error(`level shots failed:\n${issues.join('\n')}`);
  console.log(`wrote ${captured.length} level shot(s) to ${shotDir}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
