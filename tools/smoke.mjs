#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AMMO, AMMO_BY_ID } from '../data.js?v=20260904-2';
import { LEVELS } from '../levels.js?v=20260904-2';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = performance.now();
const failures = [];
const runtimeIssues = [];
const CAMERA_STABLE_EPSILON = 1e-7;
const CAMERA_STABLE_FRAMES = 3;
let assertion = 0;
let server;
let browser;
let guardProfile = null;

const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.xml': 'application/xml'
};

function report(expectation, passed, measurement) {
  assertion++;
  const line = `${passed ? 'PASS' : 'FAIL'}  ${String(assertion).padStart(2, '0')}. ` +
    `${expectation}: ${measurement}`;
  console.log(line);
  if (!passed) failures.push(line);
}

function compact(value) {
  if (value === undefined) return 'no measurement';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 360 ? `${text.slice(0, 357)}...` : text;
}

function pollMeasurement(result, measurement) {
  return result.ok ? measurement : `${measurement}; ${result.detail}`;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function poll(read, accepts, timeout = 10000) {
  const deadline = performance.now() + timeout;
  let value;
  let error;
  while (performance.now() < deadline) {
    try {
      value = await read();
      error = undefined;
      if (accepts(value)) return { ok: true, value };
    } catch (caught) {
      error = caught;
    }
    await delay(50);
  }
  return {
    ok: false,
    value,
    detail: error ? `last read failed: ${error.message}` : `timed out after ${timeout} ms`
  };
}

function createStaticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/_guard/profile') {
        response.setHeader('cache-control', 'no-store');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        if (request.method === 'GET') {
          response.end(JSON.stringify({ profile: guardProfile }));
          return;
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          let text = '';
          for await (const chunk of request) text += chunk;
          guardProfile = JSON.parse(text);
          response.end(JSON.stringify({ saved: true }));
          return;
        }
        response.writeHead(405);
        response.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
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
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    }
  });
}

async function pageSnapshot(page) {
  return page.evaluate(() => window.__SLINGWRECK_SMOKE__?.());
}

async function domState(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element || element.hidden) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0;
    };
    const scoreText = document.querySelector('#score-value')?.textContent ?? '';
    return {
      titleVisible: visible(document.querySelector('#title-screen')),
      playVisible: visible(document.querySelector('#play-button')),
      episodesVisible: visible(document.querySelector('#episode-screen')),
      levelsVisible: visible(document.querySelector('#level-screen')),
      hudVisible: visible(document.querySelector('#round-hud')),
      resultVisible: visible(document.querySelector('#round-over')),
      canvasVisible: visible(document.querySelector('#game')),
      ammoCount: document.querySelectorAll('#ammo-list [role="listitem"]').length,
      ammoLabel: document.querySelector('#ammo-list')?.getAttribute('aria-label') ?? '',
      score: Number(scoreText.replace(/[^\d-]/g, '')) || 0,
      scoreText,
      heading: document.querySelector('#round-title')?.textContent?.trim() ?? '',
      announcement: document.querySelector('#round-announcement')?.textContent?.trim() ?? '',
      starLabel: document.querySelector('#stars')?.getAttribute('aria-label') ?? '',
      starCopy: document.querySelector('#result-star-copy')?.textContent?.trim() ?? '',
      activeId: document.activeElement?.id ?? ''
    };
  });
}

async function trajectoryPixels(page) {
  return page.evaluate(() => {
    const state = window.__SLINGWRECK_SMOKE__?.();
    const canvas = document.querySelector('#game');
    const context = canvas?.getContext('2d');
    const rect = canvas?.getBoundingClientRect();
    if (!state || !context || !rect?.width || !rect.height) {
      return { active: false, expected: 0, inkDots: 0, contrasts: [] };
    }

    const { aim, camera, sling } = state;
    const length = Math.hypot(aim.dx, aim.dy);
    if (!aim.active || length < 0.08) {
      return { active: aim.active, length, expected: 0, inkDots: 0, contrasts: [] };
    }

    const pixelScaleX = canvas.width / rect.width;
    const pixelScaleY = canvas.height / rect.height;
    const launchScale = sling.launchSpeedMax / sling.radius;
    const vx = -aim.dx * launchScale;
    const vy = -aim.dy * launchScale;
    const radius = Math.max(2, camera.scale * 0.055);
    const offset = Math.max(5, radius * 2.5);
    const contrasts = [];

    const lumaAt = (cssX, cssY) => {
      const x = Math.max(0, Math.min(canvas.width - 1, Math.round(cssX * pixelScaleX)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.round(cssY * pixelScaleY)));
      const pixel = context.getImageData(x, y, 1, 1).data;
      return pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722;
    };

    for (let index = 1; index <= 10; index++) {
      const time = index * sling.trajectoryStep;
      const x = sling.x + vx * time;
      const y = sling.y + vy * time - sling.gravity * time * time / 2;
      if (y < 0 || x < sling.viewMinX || x > sling.viewMaxX) continue;
      const screenX = camera.viewportX + camera.viewportW / 2 + (x - camera.x) * camera.scale;
      const screenY = camera.viewportY + camera.viewportH / 2 - (y - camera.y) * camera.scale;
      if (screenX < 0 || screenX >= rect.width || screenY < 0 || screenY >= rect.height) continue;
      const centre = lumaAt(screenX, screenY);
      const surround = [
        lumaAt(screenX - offset, screenY),
        lumaAt(screenX + offset, screenY),
        lumaAt(screenX, screenY - offset),
        lumaAt(screenX, screenY + offset)
      ];
      contrasts.push(surround.reduce((sum, value) => sum + value, 0) / surround.length - centre);
    }

    return {
      active: aim.active,
      length,
      expected: contrasts.length,
      // Absolute contrast, not signed. The dots are an ink core inside a cream halo
      // precisely so they read against both the sage hills and the parchment sky, which
      // means a sample can legitimately land lighter *or* darker than its surroundings.
      // The old signed test only accepted darker and would fail the very fix that made
      // the preview visible. Threshold raised from 12 as the dots are now bolder.
      inkDots: contrasts.filter((contrast) => Math.abs(contrast) > 18).length,
      contrasts: contrasts.map((contrast) => Number(contrast.toFixed(1)))
    };
  });
}

function screenPoint(state, worldX, worldY) {
  const { camera } = state;
  return {
    x: camera.viewportX + camera.viewportW / 2 + (worldX - camera.x) * camera.scale,
    y: camera.viewportY + camera.viewportH / 2 - (worldY - camera.y) * camera.scale
  };
}

async function liveWorldDraw(page, draw) {
  const state = await pageSnapshot(page);
  if (!state) throw new Error('smoke hook unavailable while preparing world-space draw');
  const pouch = screenPoint(state, state.sling.x, state.sling.y);
  const target = screenPoint(
    state,
    state.sling.x + draw.dx,
    state.sling.y + draw.dy
  );
  return { state, pouch, target };
}

function drawAtLivePig(state) {
  const pig = state.pigs.find((candidate) => !candidate.dead);
  if (!pig) return { dx: -1, dy: -0.5 };
  const distance = Math.max(0.5, pig.x - state.sling.x);
  const height = pig.y - state.sling.y;
  const angle = (pig.x < 8 ? 10 : 20) * Math.PI / 180;
  const denominator = 2 * Math.cos(angle) ** 2 * (distance * Math.tan(angle) - height);
  const speed = Math.sqrt(state.sling.gravity * distance * distance / Math.max(0.01, denominator));
  const length = Math.min(state.sling.radius, speed / state.sling.launchSpeedMax * state.sling.radius);
  return {
    dx: -length * Math.cos(angle),
    dy: -length * Math.sin(angle)
  };
}

async function waitForAimingCamera(page) {
  const timeout = 5000;
  const deadline = performance.now() + timeout;
  let previous;
  let value;
  let stableFrames = 0;
  let movement = { x: Infinity, y: Infinity, zoom: Infinity };

  while (performance.now() < deadline) {
    value = await page.evaluate(() => new Promise((resolveFrame) => {
      requestAnimationFrame(() => resolveFrame(window.__SLINGWRECK_SMOKE__?.()));
    }));
    const aiming = value?.phase === 'aiming' && value.camera.mode === 'aiming';
    if (aiming && previous?.phase === 'aiming' && previous.camera.mode === 'aiming') {
      movement = {
        x: Math.abs(value.camera.x - previous.camera.x),
        y: Math.abs(value.camera.y - previous.camera.y),
        zoom: Math.abs(value.camera.zoom - previous.camera.zoom)
      };
      stableFrames = movement.x <= CAMERA_STABLE_EPSILON &&
        movement.y <= CAMERA_STABLE_EPSILON &&
        movement.zoom <= CAMERA_STABLE_EPSILON
        ? stableFrames + 1
        : 0;
      if (stableFrames >= CAMERA_STABLE_FRAMES) return { ok: true, value };
    } else {
      stableFrames = 0;
    }
    previous = value;
  }

  return {
    ok: false,
    value,
    detail: `timed out after ${timeout} ms waiting for ${CAMERA_STABLE_FRAMES} stable frames; ` +
      `last frame movement x ${movement.x}, y ${movement.y}, zoom ${movement.zoom}`
  };
}

async function beginMouseDraw(page, draw) {
  const ready = await waitForAimingCamera(page);
  if (!ready.ok) {
    throw new Error(`aiming camera did not settle (${ready.detail}): ${compact(ready.value)}`);
  }
  const { state, pouch, target } = await liveWorldDraw(page, draw);
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  return { ready: state, pouch, target };
}

async function beginTouchDraw(context, page, draw) {
  const session = await context.newCDPSession(page);
  try {
    const ready = await waitForAimingCamera(page);
    if (!ready.ok) {
      throw new Error(`aiming camera did not settle (${ready.detail}): ${compact(ready.value)}`);
    }
    const { state, pouch, target } = await liveWorldDraw(page, draw);
    const touch = (x, y) => ({ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [touch(pouch.x, pouch.y)]
    });
    for (let step = 1; step <= 8; step++) {
      const fraction = step / 8;
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touch(
          pouch.x + (target.x - pouch.x) * fraction,
          pouch.y + (target.y - pouch.y) * fraction
        )]
      });
    }
    return { ready: state, pouch, target, session };
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

async function endTouchDraw(session) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

function attachFailureCollectors(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location();
      runtimeIssues.push(`${label} console: ${message.text()} ` +
        `(${location.url || 'unknown'}:${location.lineNumber ?? 0})`);
    }
  });
  page.on('pageerror', (error) => runtimeIssues.push(`${label} page: ${error.message}`));
  page.on('requestfailed', (request) => {
    runtimeIssues.push(`${label} request: ${request.url()} ` +
      `(${request.failure()?.errorText ?? 'failed'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      runtimeIssues.push(`${label} request: ${response.url()} (HTTP ${response.status()})`);
    }
  });
}

function smokeUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('smoke-test', '1');
  return url.href;
}

// Most assertions want to reach gameplay directly, and the new-critter card deliberately
// stands in the way the first time a bag contains an unfamiliar bird. Marking every critter
// as already met keeps those assertions about the thing they are named for; the card itself
// gets its own dedicated assertion below, with the seen list cleared.
async function markAllCrittersSeen(page) {
  await page.addInitScript((ids) => {
    localStorage.setItem('slingwreck.critters.seen.v1', JSON.stringify(ids));
  }, AMMO.map((ammo) => ammo.id));
}

async function loadReady(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  return poll(
    () => page.evaluate(() => ({
      ready: document.documentElement.dataset.gameReady,
      hook: typeof window.__SLINGWRECK_SMOKE__
    })),
    (state) => state?.ready === 'true' && state.hook === 'function',
    5000
  );
}

async function editorPoint(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const camera = window.__SLINGWRECK_SMOKE__?.().editor?.camera;
    const rect = document.querySelector('#game')?.getBoundingClientRect();
    if (!camera || !rect) return null;
    const scaleX = rect.width / camera.viewportW;
    const scaleY = rect.height / camera.viewportH;
    return {
      x: rect.left + (camera.viewportX + camera.viewportW / 2 +
        (x - camera.x) * camera.scale) * scaleX,
      y: rect.top + (camera.viewportY + camera.viewportH / 2 -
        (y - camera.y) * camera.scale) * scaleY
    };
  }, { x, y });
}

async function clickEditorPoint(page, x, y) {
  const point = await editorPoint(page, x, y);
  if (!point) throw new Error(`editor camera unavailable for ${x}, ${y}`);
  await page.mouse.click(point.x, point.y);
}

async function editorRun(baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(baseUrl).origin
  });
  const page = await context.newPage();
  attachFailureCollectors(page, 'editor');
  await markAllCrittersSeen(page);

  try {
    const loaded = await loadReady(page, smokeUrl(baseUrl));
    await page.locator('#editor-button').click();
    const opened = await poll(
      () => pageSnapshot(page),
      (state) => state?.editor?.pieceCount === 0 &&
        state.editor.camera.viewportW === 712,
      5000
    );
    report('title opens the fortress editor with the plot framed outside its chrome',
      loaded.ok && opened.ok,
      pollMeasurement(opened,
        `pieces ${opened.value?.editor?.pieceCount ?? '?'}; canvas ` +
        `${opened.value?.editor?.camera.viewportW ?? '?'}×${opened.value?.editor?.camera.viewportH ?? '?'}`));

    const initialText = await page.locator('#validation-summary').textContent();
    report('empty draft gives human King and guard guidance',
      opened.value?.editor?.validation.join(',') === 'king-count,too-few-pigs' &&
        /Place one real King Hog/.test(initialText) && /Add at least two pigs/.test(initialText),
      `codes [${opened.value?.editor?.validation.join(', ') ?? ''}]; guidance "${compact(initialText?.trim())}"`);

    await page.locator('#pigs-tab').click();
    await page.locator('#palette-pig-king').click();
    await clickEditorPoint(page, 8, 1);
    const oneKing = await poll(
      () => pageSnapshot(page),
      (state) => state?.editor?.pieceCount === 1 &&
        state.editor.validation.length === 1 && state.editor.validation[0] === 'too-few-pigs',
      3000
    );
    report('placing the King reaches the intended one-problem invalid state', oneKing.ok,
      pollMeasurement(oneKing,
        `pieces ${oneKing.value?.editor?.pieceCount ?? '?'}; errors ` +
        `[${oneKing.value?.editor?.validation.join(', ') ?? ''}]`));

    await page.locator('#palette-pig-runt').click();
    await clickEditorPoint(page, 6, 1);
    await clickEditorPoint(page, 10, 1);
    const fixed = await poll(
      () => pageSnapshot(page),
      (state) => state?.editor?.pieceCount === 3 && state.editor.validation.length === 0,
      3000
    );
    report('two guard pigs fix the continuous validation state', fixed.ok,
      pollMeasurement(fixed,
        `pieces ${fixed.value?.editor?.pieceCount ?? '?'}; errors ` +
        `[${fixed.value?.editor?.validation.join(', ') ?? ''}]`));

    await page.locator('#materials-tab').click();
    await page.locator('#palette-block-cube').click();
    const sweepStart = await editorPoint(page, 2, 0.5);
    const sweepEnd = await editorPoint(page, 5, 0.5);
    await page.mouse.move(sweepStart.x, sweepStart.y);
    await page.mouse.down();
    await page.mouse.move(sweepEnd.x, sweepEnd.y, { steps: 18 });
    await page.mouse.up();
    const swept = await poll(
      () => pageSnapshot(page),
      (state) => state?.editor?.pieceCount >= 6 && state.editor.spent >= 7,
      3000
    );
    report('drag sweep places a snapped run and spends its scrap', swept.ok,
      pollMeasurement(swept,
        `${(swept.value?.editor?.pieceCount ?? 3) - 3} blocks; ` +
        `${swept.value?.editor?.spent ?? '?'} scrap spent`));

    const beforeUndo = swept.value?.editor?.pieceCount;
    await page.keyboard.press('Control+z');
    const undone = await poll(() => pageSnapshot(page),
      (state) => state?.editor?.pieceCount === beforeUndo - 1, 2000);
    await page.keyboard.press('Control+Shift+z');
    const redone = await poll(() => pageSnapshot(page),
      (state) => state?.editor?.pieceCount === beforeUndo, 2000);
    report('editor undo and redo restore the swept draft', undone.ok && redone.ok,
      `counts ${beforeUndo} → ${undone.value?.editor?.pieceCount ?? '?'} → ` +
      `${redone.value?.editor?.pieceCount ?? '?'}`);

    const beforeSettle = redone.value?.editor?.encoded;
    const settleStartedAt = performance.now();
    await page.locator('#settle-button').click();
    const settled = await poll(
      () => pageSnapshot(page),
      (state) => state?.editor && !state.editor.settling &&
        typeof state.editor.settleResult === 'string',
      7000
    );
    const settleSeconds = (performance.now() - settleStartedAt) / 1000;
    report('settle test plays for three seconds and leaves the draft untouched',
      settled.ok && settleSeconds >= 2.8 && settled.value?.editor?.encoded === beforeSettle,
      pollMeasurement(settled,
        `${settleSeconds.toFixed(2)} s; same encoded draft ` +
        `${settled.value?.editor?.encoded === beforeSettle}; "${settled.value?.editor?.settleResult ?? ''}"`));

    await page.locator('#copy-blueprint-button').click();
    const copied = await poll(
      async () => ({
        clipboard: await page.evaluate(() => navigator.clipboard.readText()),
        state: await pageSnapshot(page)
      }),
      ({ clipboard, state }) => clipboard === beforeSettle && state.editor.encoded === beforeSettle,
      3000
    );
    report('export copies the exact encoded blueprint', copied.ok,
      pollMeasurement(copied,
        `${copied.value?.clipboard?.length ?? 0} clipboard characters; exact ` +
        `${copied.value?.clipboard === beforeSettle}`));

    await clickEditorPoint(page, 14, 0.5);
    const mutated = await poll(() => pageSnapshot(page),
      (state) => state?.editor?.encoded !== beforeSettle, 2000);
    await page.locator('#paste-blueprint-button').click();
    const imported = await poll(() => pageSnapshot(page),
      (state) => state?.editor?.encoded === beforeSettle, 3000);
    report('paste-to-load round-trips the authored draft exactly', mutated.ok && imported.ok,
      pollMeasurement(imported,
        `mutated ${mutated.ok}; restored ${imported.value?.editor?.encoded === beforeSettle}; ` +
        `${imported.value?.editor?.pieceCount ?? '?'} pieces`));
  } finally {
    await context.close();
  }
}

// The new-critter card, tested with the seen list actually empty. Every other run marks
// all critters as met so it stays out of the way, which means without this the feature
// would ship untested — the same trap as an ability with no assertion.
async function critterIntroRun(baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  attachFailureCollectors(page, 'critter intro');
  try {
    await page.addInitScript(() => localStorage.removeItem('slingwreck.critters.seen.v1'));
    await loadReady(page, smokeUrl(baseUrl));
    await page.locator('#play-button').click();
    await page.locator('.episode-choice[data-episode="1"]').click();
    await page.locator('.level-choice[data-level-id="sty-01"]').click();

    const shown = await poll(() => page.evaluate(() => {
      const panel = document.querySelector('#critter-intro');
      return {
        visible: panel && !panel.hidden,
        name: document.querySelector('#critter-intro-name')?.textContent ?? '',
        tip: document.querySelector('#critter-intro-tip')?.textContent ?? '',
        phase: window.__SLINGWRECK_SMOKE__?.()?.phase ?? ''
      };
    }), (state) => state?.visible, 5000);

    const first = AMMO_BY_ID[LEVELS[0].bag[0]];
    report('a new critter is introduced before its first level', shown.ok &&
      shown.value.name === first.name && shown.value.tip === first.tutorial,
    pollMeasurement(shown, `card "${shown.value?.name}" — "${(shown.value?.tip ?? '').slice(0, 44)}…"`));

    await page.locator('#critter-intro-button').click();
    const playing = await poll(() => pageSnapshot(page),
      (state) => state?.phase === 'aiming', 5000);
    report('dismissing the card starts the level', playing.ok,
      pollMeasurement(playing, `phase ${playing.value?.phase ?? 'unknown'}`));

    // Second visit: the card must not reappear for a critter already met.
    await page.locator('#restart-button').click();
    await page.waitForTimeout(600);
    const again = await page.evaluate(() => {
      const panel = document.querySelector('#critter-intro');
      return panel ? !panel.hidden : false;
    });
    report('the card does not repeat for a critter already met', again === false,
      `card visible on replay: ${again}`);
  } finally {
    await page.close();
    await context.close();
  }
}

async function desktopRun(baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  attachFailureCollectors(page, 'desktop');
  await markAllCrittersSeen(page);

  try {
    const loaded = await loadReady(page, smokeUrl(baseUrl));
    const title = await domState(page);
    report('title screen and canvas are visible', loaded.ok && title.titleVisible &&
      title.playVisible && title.canvasVisible,
    pollMeasurement(loaded,
      `ready ${loaded.ok}; title ${title.titleVisible}; Play ${title.playVisible}; canvas ${title.canvasVisible}`));

    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Tab');
    const keyboard = await domState(page);
    report('Campaign is keyboard reachable', keyboard.activeId === 'play-button',
      `active element #${keyboard.activeId || '(none)'} after Tab`);
    if (keyboard.activeId === 'play-button') await page.keyboard.press('Enter');
    else await page.locator('#play-button').click();

    const episodes = await poll(() => domState(page), (state) => state.episodesVisible, 3000);
    const episodeState = await page.evaluate(() => ({
      count: document.querySelectorAll('.episode-choice').length,
      locked: [...document.querySelectorAll('.episode-choice')]
        .filter((button) => button.getAttribute('aria-disabled') === 'true').length,
      locks: document.querySelectorAll('.episode-choice .drawn-lock').length
    }));
    report('Campaign opens four episodes with later chapters ink-locked', episodes.ok &&
      episodeState.count === 4 && episodeState.locked === 3 && episodeState.locks === 3,
    pollMeasurement(episodes,
      `${episodeState.count} episodes; ${episodeState.locked} locked; ${episodeState.locks} drawn locks`));

    await page.locator('.episode-choice[data-episode="1"]').click();
    const levels = await poll(() => domState(page), (state) => state.levelsVisible, 3000);
    const levelState = await page.evaluate(() => ({
      count: document.querySelectorAll('.level-choice').length,
      unlocked: [...document.querySelectorAll('.level-choice')]
        .filter((button) => button.getAttribute('aria-disabled') === 'false').length,
      starCanvases: document.querySelectorAll('.level-choice .drawn-star').length,
      locks: document.querySelectorAll('.level-choice .drawn-lock').length
    }));
    report('Sty opens as thirteen real level buttons with only level one available', levels.ok &&
      levelState.count === 13 && levelState.unlocked === 1 &&
      levelState.starCanvases === 3 && levelState.locks === 12,
    pollMeasurement(levels,
      `${levelState.count} buttons; ${levelState.unlocked} unlocked; ` +
      `${levelState.starCanvases} drawn stars; ${levelState.locks} drawn locks`));

    await page.locator('.level-choice[data-level-id="sty-01"]').click();
    const aiming = await poll(() => pageSnapshot(page), (state) => state?.phase === 'aiming', 5000);
    const hud = await domState(page);
    report('level one opens the HUD', aiming.ok && hud.hudVisible && !hud.levelsVisible,
      pollMeasurement(aiming,
        `level ${aiming.value?.level?.id ?? 'unknown'}; phase ${aiming.value?.phase ?? 'unknown'}; HUD ${hud.hudVisible}`));
    report('HUD shows the full critter bag', hud.ammoCount === aiming.value?.bagSize &&
      aiming.value?.bagSize === 2 && aiming.value?.shotIndex === 0,
    `${hud.ammoCount}/${aiming.value?.bagSize ?? '?'} icons; ${hud.ammoLabel}; shot index ${aiming.value?.shotIndex ?? '?'}`);
    const firstDraw = await beginMouseDraw(page, {
      dx: -1.5635229303040372,
      dy: -0.33969993584555885
    });
    const preview = await poll(
      () => trajectoryPixels(page),
      (measurement) => measurement.active && measurement.expected >= 3 && measurement.inkDots >= 3,
      3000
    );
    const previewValue = preview.value ?? {};
    report('held back-and-down drag draws a trajectory preview', preview.ok,
      pollMeasurement(preview, `draw (${(firstDraw.target.x - firstDraw.pouch.x).toFixed(1)}, ` +
      `${(firstDraw.target.y - firstDraw.pouch.y).toFixed(1)}) px; ` +
      `${previewValue.inkDots ?? 0}/${previewValue.expected ?? 0} sampled dots, ` +
      `contrasts [${previewValue.contrasts?.join(', ') ?? ''}]`));

    await page.mouse.up();
    const flying = await poll(
      () => pageSnapshot(page),
      (state) => state?.phase === 'flying' && state.shotIndex === 1,
      3000
    );
    report('release changes the phase to flying', flying.ok,
      pollMeasurement(flying,
        `phase ${flying.value?.phase ?? 'unknown'} at step ${flying.value?.stepCount ?? '?'}`));
    const afterReleaseHud = await domState(page);
    report('release consumes one critter', flying.value?.bagSize - flying.value?.shotIndex === 1 &&
      afterReleaseHud.ammoCount === 1,
    `hook ${flying.value ? flying.value.bagSize - flying.value.shotIndex : '?'}; HUD ${afterReleaseHud.ammoCount}`);

    const cameraMoved = await poll(
      () => pageSnapshot(page),
      (state) => state && Math.hypot(
        state.camera.x - firstDraw.ready.camera.x,
        state.camera.y - firstDraw.ready.camera.y
      ) > 0.2,
      3000
    );
    const cameraDistance = cameraMoved.value ? Math.hypot(
      cameraMoved.value.camera.x - firstDraw.ready.camera.x,
      cameraMoved.value.camera.y - firstDraw.ready.camera.y
    ) : 0;
    report('camera follows the launched critter', cameraMoved.ok,
      pollMeasurement(cameraMoved,
        `moved ${cameraDistance.toFixed(3)} world units; mode ${cameraMoved.value?.camera.mode ?? 'unknown'}`));

    const settled = await poll(
      () => pageSnapshot(page),
      (state) => state && ['aiming', 'won', 'lost'].includes(state.phase),
      10000
    );
    const settledDom = await domState(page);
    const deadPigs = settled.value?.pigs.filter((pig) => pig.dead).length ?? 0;
    report('world settles after the first shot', settled.ok,
      pollMeasurement(settled,
        `phase ${settled.value?.phase ?? 'unknown'} at step ${settled.value?.stepCount ?? '?'}`));
    report('settled shot increases the visible score', settledDom.score > 0,
      `${settledDom.scoreText || '0'} > 0`);
    report('settled shot kills at least one pig', deadPigs >= 1,
      `${deadPigs}/${settled.value?.pigs.length ?? '?'} pigs dead`);

    let endState = settled.value;
    while (endState?.phase === 'aiming' && endState.shotIndex < endState.bagSize &&
      endState.pigs.some((pig) => !pig.dead)) {
      await beginMouseDraw(page, drawAtLivePig(endState));
      await page.mouse.up();
      const nextState = await poll(
        () => pageSnapshot(page),
        (state) => state && ['aiming', 'won', 'lost'].includes(state.phase) &&
          state.shotIndex > endState.shotIndex,
        10000
      );
      if (!nextState.ok) {
        endState = nextState.value;
        break;
      }
      endState = nextState.value;
    }

    const result = await poll(
      () => domState(page),
      (state) => state.resultVisible,
      3000
    );
    const resultState = await pageSnapshot(page);
    report('round end shows the result panel', result.ok,
      pollMeasurement(result,
        `visible ${result.value?.resultVisible ?? false}; phase ${resultState?.phase ?? 'unknown'}; ` +
        `shots ${resultState?.shotIndex ?? '?'}/${resultState?.bagSize ?? '?'}`));
    report('result announces a win', resultState?.phase === 'won' &&
      result.value?.heading === 'Fortress wrecked' && /brought the fortress down/i.test(result.value?.announcement),
    `heading "${result.value?.heading ?? ''}"; announcement "${result.value?.announcement ?? ''}"`);
    report('result heading receives focus', result.value?.activeId === 'round-title',
      `active element #${result.value?.activeId || '(none)'}`);

    const expectedStars = resultState?.level?.stars
      .filter((threshold) => resultState.score >= threshold).length ?? 0;
    const resultStars = await page.evaluate(() => ({
      filled: document.querySelectorAll('#stars .drawn-star[data-filled="true"]').length,
      total: document.querySelectorAll('#stars .drawn-star').length,
      label: document.querySelector('#stars')?.getAttribute('aria-label'),
      copy: document.querySelector('#result-star-copy')?.textContent?.trim()
    }));
    report('result award matches the authored level thresholds', resultStars.total === 3 &&
      resultStars.filled === expectedStars &&
      resultStars.label === `${expectedStars} of 3 stars earned` &&
      resultStars.copy === result.value.starCopy,
    `score ${resultState?.score ?? '?'} against [${resultState?.level?.stars.join(', ') ?? ''}] -> ` +
      `${expectedStars} stars; ${resultStars.filled}/${resultStars.total} drawn; "${resultStars.copy}"`);

    await page.locator('#menu-button').click();
    const returned = await poll(() => domState(page), (state) => state.levelsVisible, 3000);
    const savedTile = await page.evaluate(() => {
      const tile = document.querySelector('.level-choice[data-level-id="sty-01"]');
      const state = window.__SLINGWRECK_SMOKE__?.();
      return {
        aria: tile?.getAttribute('aria-label') ?? '',
        best: tile?.querySelector('.level-best')?.textContent?.trim() ?? '',
        filled: tile?.querySelectorAll('.drawn-star[data-filled="true"]').length ?? 0,
        unlocked: [...document.querySelectorAll('.level-choice')]
          .filter((button) => button.getAttribute('aria-disabled') === 'false').length,
        record: state?.campaign?.profile?.levels?.['sty-01']
      };
    });
    report('returning to the grid shows the earned stars, best score, and next unlock', returned.ok &&
      savedTile.filled === expectedStars && savedTile.record?.bestScore === resultState.score &&
      savedTile.record?.completed && savedTile.unlocked === 2 &&
      savedTile.best.includes(resultState.score.toLocaleString('en-AU')),
    pollMeasurement(returned,
      `${savedTile.filled} stars; ${savedTile.best}; ${savedTile.unlocked} levels unlocked; ` +
      `stored ${compact(savedTile.record)}`));

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await loadReady(page, smokeUrl(baseUrl));
    await page.locator('#play-button').click();
    await page.locator('.episode-choice[data-episode="1"]').click();
    const reloadedTile = await page.evaluate(() => {
      const tile = document.querySelector('.level-choice[data-level-id="sty-01"]');
      const state = window.__SLINGWRECK_SMOKE__?.();
      return {
        best: tile?.querySelector('.level-best')?.textContent?.trim() ?? '',
        filled: tile?.querySelectorAll('.drawn-star[data-filled="true"]').length ?? 0,
        record: state?.campaign?.profile?.levels?.['sty-01']
      };
    });
    report('reload preserves campaign progress', reloaded.ok &&
      reloadedTile.filled === expectedStars &&
      reloadedTile.record?.bestScore === resultState.score && reloadedTile.record?.completed,
    pollMeasurement(reloaded,
      `${reloadedTile.filled} stars; ${reloadedTile.best}; stored ${compact(reloadedTile.record)}`));
  } finally {
    await context.close();
  }
}

async function mobileRun(baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true
  });
  const page = await context.newPage();
  attachFailureCollectors(page, 'portrait touch');
  await markAllCrittersSeen(page);
  await page.addInitScript(() => {
    localStorage.setItem('slingwreck.campaign.progress.v1', JSON.stringify({
      version: 1,
      levels: {
        'sty-01': { bestScore: 15300, stars: 3, completed: true }
      }
    }));
  });

  try {
    const loaded = await loadReady(page, smokeUrl(baseUrl));
    const merged = await poll(
      () => pageSnapshot(page),
      (state) => state?.campaign?.guardSession &&
        state.campaign.profile.levels['sty-01'].bestScore === 15300,
      3000
    );
    report('guard merge keeps the higher per-level score from local progress', loaded.ok && merged.ok,
      pollMeasurement(merged,
        `local 15,300 vs guard 15,100 -> ` +
        `${merged.value?.campaign?.profile?.levels?.['sty-01']?.bestScore?.toLocaleString('en-AU') ?? '?'}`));
    const playBox = await page.locator('#play-button').boundingBox();
    if (playBox) {
      await page.touchscreen.tap(playBox.x + playBox.width / 2, playBox.y + playBox.height / 2);
    }
    const episodeBox = await page.locator('.episode-choice[data-episode="1"]').boundingBox();
    if (episodeBox) {
      await page.touchscreen.tap(episodeBox.x + episodeBox.width / 2,
        episodeBox.y + episodeBox.height / 2);
    }
    const levelBox = await page.locator('.level-choice[data-level-id="sty-01"]').boundingBox();
    if (levelBox) {
      await page.touchscreen.tap(levelBox.x + levelBox.width / 2,
        levelBox.y + levelBox.height / 2);
    }
    const aiming = await poll(() => pageSnapshot(page), (state) => state?.phase === 'aiming', 5000);
    const hud = await domState(page);
    report('portrait touch campaign navigation opens a full-bag HUD', loaded.ok && aiming.ok &&
      hud.hudVisible && hud.ammoCount === 2 && aiming.value?.bagSize === 2,
    pollMeasurement(loaded.ok ? aiming : loaded,
      `viewport 390x844; HUD ${hud.hudVisible}; bag ${hud.ammoCount}/${aiming.value?.bagSize ?? '?'}`));

    const firstDraw = await beginTouchDraw(context, page, {
      dx: -1.5635229303040372,
      dy: -0.33969993584555885
    });
    const preview = await poll(
      () => trajectoryPixels(page),
      (measurement) => measurement.active && measurement.expected >= 3 && measurement.inkDots >= 3,
      3000
    );
    const previewValue = preview.value ?? {};
    report('portrait touch drag draws a trajectory preview', preview.ok,
      pollMeasurement(preview, `draw (${(firstDraw.target.x - firstDraw.pouch.x).toFixed(1)}, ` +
      `${(firstDraw.target.y - firstDraw.pouch.y).toFixed(1)}) px; ` +
      `${previewValue.inkDots ?? 0}/${previewValue.expected ?? 0} sampled dots, ` +
      `contrasts [${previewValue.contrasts?.join(', ') ?? ''}]`));

    await endTouchDraw(firstDraw.session);
    const flying = await poll(
      () => pageSnapshot(page),
      (state) => state?.phase === 'flying' && state.shotIndex === 1,
      3000
    );
    const portraitHud = await domState(page);
    report('portrait touch release flies and consumes one critter', flying.ok &&
      portraitHud.ammoCount === 1,
    pollMeasurement(flying,
      `phase ${flying.value?.phase ?? 'unknown'}; bag ${portraitHud.ammoCount}/2`));

    const cameraMoved = await poll(
      () => pageSnapshot(page),
      (state) => state && Math.hypot(
        state.camera.x - firstDraw.ready.camera.x,
        state.camera.y - firstDraw.ready.camera.y
      ) > 0.2,
      3000
    );
    const cameraDistance = cameraMoved.value ? Math.hypot(
      cameraMoved.value.camera.x - firstDraw.ready.camera.x,
      cameraMoved.value.camera.y - firstDraw.ready.camera.y
    ) : 0;
    report('portrait camera follows the launched critter', cameraMoved.ok,
      pollMeasurement(cameraMoved,
        `moved ${cameraDistance.toFixed(3)} world units; mode ${cameraMoved.value?.camera.mode ?? 'unknown'}`));

    const settled = await poll(
      () => pageSnapshot(page),
      (state) => state && ['aiming', 'won', 'lost'].includes(state.phase),
      10000
    );
    const settledDom = await domState(page);
    const deadPigs = settled.value?.pigs.filter((pig) => pig.dead).length ?? 0;
    report('portrait touch shot settles with score and pig damage', settled.ok &&
      settledDom.score > 0 && deadPigs >= 1,
    pollMeasurement(settled,
      `phase ${settled.value?.phase ?? 'unknown'}; score ${settledDom.scoreText || '0'}; ` +
      `pigs dead ${deadPigs}/${settled.value?.pigs.length ?? '?'}`));
    const runningAudio = await poll(
      () => pageSnapshot(page),
      (state) => state?.audioState === 'running',
      5000
    );
    report('AudioContext runs after the level-select gesture', runningAudio.ok,
      pollMeasurement(runningAudio, `state ${runningAudio.value?.audioState ?? 'unknown'}`));
  } finally {
    await context.close();
  }
}

try {
  let baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    server = createStaticServer();
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', ready);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}/`;
  }

  browser = await chromium.launch({ headless: true });
  try {
    await desktopRun(baseUrl);
  } catch (error) {
    runtimeIssues.push(`desktop run aborted: ${error.stack ?? error}`);
  }
  try {
    await critterIntroRun(baseUrl);
  } catch (error) {
    runtimeIssues.push(`critter intro run aborted: ${error.stack ?? error}`);
  }
  try {
    await editorRun(baseUrl);
  } catch (error) {
    runtimeIssues.push(`editor run aborted: ${error.stack ?? error}`);
  }
  try {
    await mobileRun(baseUrl);
  } catch (error) {
    runtimeIssues.push(`portrait touch run aborted: ${error.stack ?? error}`);
  }
} catch (error) {
  runtimeIssues.push(`smoke setup failed: ${error.stack ?? error}`);
} finally {
  await browser?.close().catch((error) => runtimeIssues.push(`browser close: ${error.message}`));
  if (server) {
    await new Promise((done) => server.close(done));
  }
}

report('browser runtime is clean', runtimeIssues.length === 0,
  `${runtimeIssues.length} console, page, request, or infrastructure error(s)`);
for (const issue of runtimeIssues) console.log(`      ${issue}`);

const runtimeSeconds = (performance.now() - startedAt) / 1000;
report('smoke run stays within 90 seconds', runtimeSeconds < 90,
  `${runtimeSeconds.toFixed(2)} s < 90.00 s`);

if (failures.length) {
  console.error(`\n${failures.length} smoke assertion(s) failed in ${runtimeSeconds.toFixed(2)} s.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${assertion} smoke assertions passed in ${runtimeSeconds.toFixed(2)} s.`);
}
