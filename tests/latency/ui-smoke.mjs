#!/usr/bin/env node
// Headless smoke of the latency UI against wrangler dev: two browsers, one hosts and one
// joins through the real lobby, and the host starts a match. Checks the lobby list's
// region label with this player's ms to the room, the room screen's "Room runs in ...",
// the HUD ping pill during the build (neutral on a local line, warning once the guest's
// pongs are held back 80 ms, bad at 250 ms), and that neither page threw. Screenshots go
// to tests/latency/shots/ (not committed).
//
// Starts its own relay on 8860 (WRANGLER, default node_modules/.bin/wrangler) and serves
// the game on 8862. Needs playwright-core and a Chromium:
//   PLAYWRIGHT_CORE=/path/to/playwright-core CHROMIUM=/path/to/chrome node tests/latency/ui-smoke.mjs

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encode } from '../../build.js?v=20260904-2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tests/latency/shots');
const PLAYWRIGHT = process.env.PLAYWRIGHT_CORE ||
  '/var/home/andre/Projects/site/games.andrenijman.com/river-flume/node_modules/playwright-core';
const CHROMIUM = process.env.CHROMIUM ||
  '/var/home/andre/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const RELAY = 'http://127.0.0.1:8860';
const SITE_PORT = 8862;
const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT);
// A legal three-pig fortress (tools/online-smoke.mjs's fixture).
const FORTRESS = encode({
  v: 1,
  blocks: [['cube', 'wood', 5, 0.5, 0]],
  pigs: [['runt', 2, 0.296875, 0], ['king', 12, 0.6875, 0], ['runt', 22, 0.296875, 0]]
});

let pass = 0;
let fail = 0;
const ok = (condition, message, detail = '') => {
  if (condition) { pass++; console.log('ok  ', message, detail); }
  else { fail++; console.log('FAIL', message, detail); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(read, accept, timeout = 15000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    try { value = await read(); if (accept(value)) return value; } catch {}
    await sleep(100);
  }
  return value;
}

const MIME = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function site() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/_guard/profile') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ profile: null }));
        return;
      }
      const file = path.resolve(ROOT, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
      if (!file.startsWith(ROOT)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
      response.setHeader('cache-control', 'no-store');
      response.end(body);
    } catch { response.writeHead(404).end(); }
  }).listen(SITE_PORT, '127.0.0.1');
}

let relay = null;
let registry = '';
async function startRelay() {
  const local = path.join(ROOT, 'node_modules/.bin/wrangler');
  const bin = process.env.WRANGLER || (existsSync(local) ? local : 'npx');
  registry = mkdtempSync(path.join(tmpdir(), 'slingwreck-registry-'));
  relay = spawn(bin, [...(bin === 'npx' ? ['wrangler'] : []), 'dev', '--port', '8860', '--inspector-port', '9360',
    '--ip', '127.0.0.1', '--var', 'DEV_COLO:FRA'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
    env: { ...process.env, WRANGLER_REGISTRY_PATH: registry }
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${RELAY}/health`)).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('wrangler dev did not come up');
}
function stop() {
  if (relay) try { process.kill(-relay.pid, 'SIGTERM'); } catch {}
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch {}
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = site();
  await startRelay();
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];
  const pages = [];
  // Pongs to the guest are held back by `hold` ms, to walk its HUD through the thresholds.
  let hold = 0;
  for (const label of ['host', 'guest']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (label === 'guest') {
      await context.routeWebSocket(/\/ws\?/, (ws) => {
        const server = ws.connectToServer();
        server.onMessage((message) => {
          if (hold && String(message).includes('"t":"pong"')) setTimeout(() => ws.send(message), hold);
          else ws.send(message);
        });
        ws.onMessage((message) => server.send(message));
      });
    }
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${label} console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${SITE_PORT}/?smoke-test&relay=${encodeURIComponent(RELAY)}`);
    await page.locator('#siege-online-button').click();
    pages.push(page);
  }
  const [host, guest] = pages;
  const room = `latency ${Math.random().toString(36).slice(2, 7)}`;
  const online = (page) => page.evaluate(() => window.__SLINGWRECK_SMOKE__?.()?.online ?? null);

  await host.locator('#online-name').fill('Host');
  await host.locator('#online-room').fill(room);
  await host.locator('#online-create').click();
  await poll(() => online(host), (o) => o?.phase === 'lobby');

  // The guest's lobby list: the room, where it runs, and the guest's ms to it.
  const row = await poll(async () => {
    await guest.locator('#online-refresh').click();
    await sleep(400);
    return guest.locator('#online-lobby-list').innerText();
  }, (text) => new RegExp(`${room}.*Western Europe · \\d+ ms`).test(text));
  // innerText collapses the row's double spaces.
  ok(new RegExp(`${room} — 1/2\\s+·\\s+Western Europe · \\d+ ms`).test(row), 'lobby list shows region and ms', JSON.stringify(row));
  await guest.screenshot({ path: path.join(SHOTS, 'lobby-list.png') });

  await guest.locator('#online-name').fill('Guest');
  await guest.locator('#online-room').fill(room);
  await guest.locator('#online-join').click();
  await poll(() => online(host), (o) => Boolean(o?.opponent));
  const where = await poll(() => host.locator('#online-room-where').innerText(), (t) => /\d+ ms$/.test(t));
  ok(/^Room runs in Western Europe · \d+ ms$/.test(where), 'room screen shows where the room runs', JSON.stringify(where));
  await host.screenshot({ path: path.join(SHOTS, 'room.png') });

  await host.locator('#online-start').click();
  await poll(() => online(host), (o) => o?.phase === 'build');
  await poll(() => online(guest), (o) => o?.phase === 'build');
  const pill = async (page) => page.evaluate(() => {
    const el = document.querySelector('#net-ping');
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { hidden: el.hidden, text: el.textContent, cls: el.className, look: `${style.color} on ${style.backgroundColor}`,
      right: innerWidth - box.right, bottom: innerHeight - box.bottom, w: box.width };
  });
  const neutral = await poll(() => pill(host), (p) => !p.hidden && /^\d+ ms$/.test(p.text));
  ok(!neutral.hidden && /^\d+ ms$/.test(neutral.text) && neutral.cls === 'net-ping', 'HUD ping shows NN ms, neutral on a local line',
    JSON.stringify(neutral));
  ok(neutral.right >= 0 && neutral.right < 40 && neutral.bottom >= 0 && neutral.bottom < 40 && neutral.w > 20,
    'HUD ping sits in the bottom-right corner, on screen');
  await host.screenshot({ path: path.join(SHOTS, 'build-hud-neutral.png') });

  hold = 80;
  const warn = await poll(() => pill(guest), (p) => /warn/.test(p.cls), 12000);
  ok(/warn/.test(warn.cls) && !/bad/.test(warn.cls) && warn.look !== neutral.look, 'HUD ping warns from 120 ms', JSON.stringify(warn));
  await guest.screenshot({ path: path.join(SHOTS, 'build-hud-warn.png') });
  hold = 250;
  const bad = await poll(() => pill(guest), (p) => /bad/.test(p.cls), 12000);
  ok(/bad/.test(bad.cls) && !/warn/.test(bad.cls) && bad.look !== warn.look && bad.look !== neutral.look, 'HUD ping is bad from 200 ms', JSON.stringify(bad));
  await guest.screenshot({ path: path.join(SHOTS, 'build-hud-bad.png') });
  // Into the attack: both lock in a legal fortress. There the ability button owns the
  // bottom-right corner, so the pill must sit clear of it.
  hold = 0;
  for (const page of [host, guest]) {
    await page.locator('#blueprint-input').fill(FORTRESS);
    await page.locator('#load-blueprint-button').click();
    await sleep(300);
    await page.locator('#siege-lock').click();
  }
  await poll(() => online(host), (o) => o?.phase === 'siege', 30000);
  const clear = await poll(() => host.evaluate(() => {
    const ping = document.querySelector('#net-ping');
    const ability = document.querySelector('#ability-button');
    const was = ability.hidden;
    ability.hidden = false; // shown only while a critter with an ability flies
    const a = ability.getBoundingClientRect();
    const p = ping.getBoundingClientRect();
    ability.hidden = was;
    return { hidden: ping.hidden, cls: ping.className, overlap: !(p.bottom <= a.top || p.top >= a.bottom ||
      p.right <= a.left || p.left >= a.right), gap: Math.round(a.top - p.bottom), right: Math.round(innerWidth - p.right) };
  }), (c) => !c.hidden && /siege/.test(c.cls));
  ok(!clear.hidden && !clear.overlap && clear.gap >= 0, 'in the attack the HUD ping sits above the ability button', JSON.stringify(clear));
  await host.evaluate(() => { document.querySelector('#ability-button').hidden = false; });
  await host.screenshot({ path: path.join(SHOTS, 'siege-hud.png') });
  await host.evaluate(() => { document.querySelector('#ability-button').hidden = true; });

  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  server.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(1); });
setTimeout(() => { console.log('ERROR: timed out'); stop(); process.exit(1); }, 150_000).unref();
main()
  .catch((error) => { console.log('ERROR:', error.stack || error.message); fail++; })
  .finally(() => { stop(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
