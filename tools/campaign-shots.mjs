#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { LEVELS } from '../levels.js?v=20260902-1';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, 'shots');
const issues = [];
let guardProfile = null;

const mime = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml'
};

function seededProfile() {
  const levels = {};
  const desiredStars = [3, 2, 1, 3, 2, 1, 3, 2];
  for (let index = 0; index < desiredStars.length; index++) {
    const level = LEVELS[index];
    const stars = desiredStars[index];
    levels[level.id] = {
      bestScore: level.stars[stars - 1],
      stars,
      completed: true
    };
  }
  for (let index = 13; index < 16; index++) {
    const level = LEVELS[index];
    const stars = index === 14 ? 2 : 1;
    levels[level.id] = {
      bestScore: level.stars[stars - 1],
      stars,
      completed: true
    };
  }
  return { version: 1, levels };
}

function staticServer() {
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

function collect(page, label) {
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

async function waitFor(page, read, timeout = 8000) {
  await page.waitForFunction(read, undefined, { timeout });
}

async function layoutMeasurement(page, screenSelector, contentSelector) {
  return page.evaluate(({ screenSelector, contentSelector }) => {
    const screen = document.querySelector(screenSelector);
    const content = document.querySelector(contentSelector);
    const last = content?.lastElementChild;
    const style = content ? getComputedStyle(content) : null;
    const rect = content?.getBoundingClientRect();
    const lastRect = last?.getBoundingClientRect();
    return {
      viewport: `${innerWidth}x${innerHeight}`,
      columns: style?.gridTemplateColumns.split(' ').filter(Boolean).length ?? 0,
      screenClientHeight: screen?.clientHeight ?? 0,
      screenScrollHeight: screen?.scrollHeight ?? 0,
      contentWidth: Math.round(rect?.width ?? 0),
      lastBottom: Math.round(lastRect?.bottom ?? 0),
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth)
    };
  }, { screenSelector, contentSelector });
}

async function fireTutorialShot(page) {
  await page.waitForTimeout(450);
  const points = await page.evaluate(() => {
    const state = window.__SLINGWRECK_SMOKE__?.();
    const rect = document.querySelector('#game')?.getBoundingClientRect();
    if (!state || !rect) return null;
    const point = (x, y) => ({
      x: rect.left + state.camera.viewportX + state.camera.viewportW / 2 +
        (x - state.camera.x) * state.camera.scale,
      y: rect.top + state.camera.viewportY + state.camera.viewportH / 2 -
        (y - state.camera.y) * state.camera.scale
    });
    return {
      pouch: point(state.sling.x, state.sling.y),
      target: point(
        state.sling.x - 1.5635229303040372,
        state.sling.y - 0.33969993584555885
      )
    };
  });
  if (!points) throw new Error('game camera was not ready for the tutorial shot');
  await page.mouse.move(points.pouch.x, points.pouch.y);
  await page.mouse.down();
  await page.mouse.move(points.target.x, points.target.y, { steps: 8 });
  await page.mouse.up();
  await waitFor(page, () => !document.querySelector('#round-over')?.hidden, 10000);
}

async function runViewport(browser, baseUrl, viewport, suffix) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const label = suffix || 'desktop';
  collect(page, label);
  await page.addInitScript(({ key, profile }) => {
    localStorage.setItem(key, JSON.stringify(profile));
  }, { key: 'slingwreck.campaign.progress.v1', profile: seededProfile() });
  await page.goto(`${baseUrl}?smoke-test=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => document.documentElement.dataset.gameReady === 'true');

  await page.locator('#play-button').click();
  await waitFor(page, () => !document.querySelector('#episode-screen')?.hidden);
  const episodeLayout = await layoutMeasurement(page, '#episode-screen', '#episode-list');
  await page.screenshot({ path: resolve(shots, `p5-episodes${suffix}.png`) });

  await page.locator('.episode-choice[data-episode="1"]').click();
  await waitFor(page, () => !document.querySelector('#level-screen')?.hidden);
  const levelLayout = await layoutMeasurement(page, '#level-screen', '#level-grid');
  await page.screenshot({ path: resolve(shots, `p5-levels${suffix}.png`) });

  await page.locator('.level-choice[data-level-id="sty-01"]').click();
  await waitFor(page, () => window.__SLINGWRECK_SMOKE__?.().phase === 'aiming');
  await fireTutorialShot(page);
  const resultLayout = await layoutMeasurement(page, '#round-over', '.result-panel');
  await page.screenshot({ path: resolve(shots, `p5-result-stars${suffix}.png`) });

  console.log(`${label} episodes ${JSON.stringify(episodeLayout)}`);
  console.log(`${label} levels   ${JSON.stringify(levelLayout)}`);
  console.log(`${label} result   ${JSON.stringify(resultLayout)}`);
  await context.close();
}

let server;
let browser;
try {
  server = staticServer();
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
  guardProfile = null;
  await runViewport(browser, baseUrl, { width: 1280, height: 720 }, '');
  guardProfile = null;
  await runViewport(browser, baseUrl, { width: 390, height: 844 }, '-portrait');
} catch (error) {
  issues.push(error.stack ?? String(error));
} finally {
  await browser?.close().catch((error) => issues.push(`browser close: ${error.message}`));
  if (server) await new Promise((done) => server.close(done));
}

if (issues.length) {
  for (const issue of issues) console.error(issue);
  process.exitCode = 1;
} else {
  console.log('captured six campaign frames with no browser runtime issues');
}
