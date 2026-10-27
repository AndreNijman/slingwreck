#!/usr/bin/env node
// Headless smoke of dev join: a host and a guest start an online Siege through the real
// lobby and reach the attack; then a third page opens the admin page's link,
// /?join=<room>, as a dev. The pages are served at https://slingwreck.andrenijman.com
// (routed to this checkout, since netdev.js only asks for a pass there) and /_guard/dev
// answers the dev page with a pass signed by a throwaway key, which the relay (wrangler
// dev, --var DEV_TEST_PUBLIC_KEY) trusts. Checks: "DEV ANDRE HAS JOINED" shows on all
// three pages; the dev watches both fortresses, and the host's shot moves the guest's
// fortress on the dev's board; ?join= is gone from the address; window.__gamesPlayer
// names everyone and their room; no page errors. Screenshots go to tests/dev/shots/
// (not committed).
//
// Starts its own relay on 8864 (inspector 9364; WRANGLER, default
// node_modules/.bin/wrangler). The pages reach it at ws://127.0.0.1 from an https origin,
// which Chromium's local network access checks would block; the flag below turns those
// off (production's relay is https workers.dev). Uses the repo's playwright and Chromium:
//   node tests/dev/ui-smoke.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { encode } from '../../build.js?v=20261027-1';
import { signDevPass } from '../../netdev.js?v=20261027-1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, 'tests/dev/shots');
const ORIGIN = 'https://slingwreck.andrenijman.com';
const RELAY = 'http://127.0.0.1:8864';
// tools/online-smoke.mjs's fixtures: a five-block fortress and a shot that reaches it.
const FORTRESS = encode({
  v: 1,
  blocks: [
    ['cube', 'wood', 4, 0.5, 0], ['cube', 'wood', 4, 1.5, 0], ['cube', 'wood', 4, 2.5, 0],
    ['cube', 'stone', 10, 0.5, 0], ['cube', 'stone', 10, 1.5, 0]
  ],
  pigs: [['runt', 2, 0.296875, 0], ['king', 12, 0.6875, 0], ['runt', 22, 0.296875, 0]]
});
const SHOT = { dx: -1.3, dy: -0.4 };

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
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

const MIME = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
// The game at its production origin, from this checkout; `guard` answers /_guard/dev.
async function serve(context, guard) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/_guard/dev') return route.fulfill({ json: await guard() });
    if (url.pathname === '/_guard/profile') return route.fulfill({ json: { profile: null } });
    const file = path.resolve(ROOT, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(ROOT)) return route.fulfill({ status: 403 });
    try {
      return route.fulfill({ body: await readFile(file), headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } });
    } catch { return route.fulfill({ status: 404 }); }
  });
}

let relay = null;
let registry = '';
async function startRelay(publicKey) {
  const local = path.join(ROOT, 'node_modules/.bin/wrangler');
  const bin = process.env.WRANGLER || (existsSync(local) ? local : 'npx');
  registry = mkdtempSync(path.join(tmpdir(), 'slingwreck-devui-'));
  relay = spawn(bin, [...(bin === 'npx' ? ['wrangler'] : []), 'dev', '--port', '8864', '--inspector-port', '9364',
    '--ip', '127.0.0.1', '--var', 'DEV_COLO:FRA', '--var', `DEV_TEST_PUBLIC_KEY:${publicKey}`], {
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

const online = (page) => page.evaluate(() => window.__SLINGWRECK_SMOKE__?.()?.online ?? null);
const banner = (page) => page.evaluate(() => {
  const el = document.querySelector('#dev-joined-banner');
  return el ? { text: el.textContent, opacity: Number(getComputedStyle(el).opacity) } : null;
});

async function fireShot(page) {
  await poll(() => page.evaluate(() => window.__SLINGWRECK_SMOKE__()), (s) => {
    const { camera, cameraTarget: target } = s;
    return Math.abs(camera.x - target.x) < 0.03 && Math.abs(camera.y - target.y) < 0.03 &&
      Math.abs(camera.zoom - target.zoom) < 0.03;
  }, 8000);
  const pouch = await page.evaluate(() => {
    const { camera, sling } = window.__SLINGWRECK_SMOKE__();
    return {
      x: camera.viewportX + camera.viewportW / 2 + (sling.x - camera.x) * camera.scale,
      y: camera.viewportY + camera.viewportH / 2 - (sling.y - camera.y) * camera.scale,
      scale: camera.scale
    };
  });
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  await page.mouse.move(pouch.x + SHOT.dx * pouch.scale, pouch.y - SHOT.dy * pouch.scale, { steps: 10 });
  await sleep(100);
  await page.mouse.up();
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = b64url(await crypto.subtle.exportKey('raw', keys.publicKey));
  const privateKey = b64url(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  await startRelay(publicKey);
  const browser = await chromium.launch({
    args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests']
  });
  const errors = [];
  const pages = {};
  const open = async (label, guard, query, name) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await serve(context, guard);
    if (name) await context.addInitScript((n) => { try { localStorage.setItem('slingwreck-online-name', n); } catch {} }, name);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${label} console: ${m.text()}`);
    });
    await page.goto(`${ORIGIN}/?smoke-test&relay=${encodeURIComponent(RELAY)}${query}`);
    pages[label] = page;
    return page;
  };
  const nobody = async () => ({ dev: false });
  const host = await open('host', nobody, '');
  const guest = await open('guest', nobody, '');
  const room = `devjoin ${Math.random().toString(36).slice(2, 7)}`;

  await host.locator('#siege-online-button').click();
  await host.locator('#online-name').fill('Hana');
  await host.locator('#online-room').fill(room);
  await host.locator('#online-create').click();
  await poll(() => online(host), (o) => o?.phase === 'lobby' && o.pid > 0);
  await guest.locator('#siege-online-button').click();
  await guest.locator('#online-name').fill('Gus');
  await guest.locator('#online-room').fill(room);
  await guest.locator('#online-join').click();
  await poll(() => online(host), (o) => Boolean(o?.opponent));
  await host.locator('#online-start').click();
  for (const page of [host, guest]) await poll(() => online(page), (o) => o?.phase === 'build');
  for (const page of [host, guest]) {
    await page.locator('#blueprint-input').fill(FORTRESS);
    await page.locator('#load-blueprint-button').click();
    await sleep(300);
    await page.locator('#siege-lock').click();
  }
  const sieges = await Promise.all([host, guest].map((page) => poll(() => online(page), (o) => o?.phase === 'siege', 30000)));
  ok(sieges.every((o) => o?.phase === 'siege'), 'host and guest are in the attack');

  // The admin page's link, opened by a dev mid-match.
  const dev = await open('dev', async () => {
    const { pass: devPass, exp } = await signDevPass(privateKey, { name: 'Andre', host: 'slingwreck.andrenijman.com' });
    return { dev: true, name: 'ANDRE', pass: devPass, exp };
  }, `&join=${encodeURIComponent(room)}`, 'Andre');
  const watching = await poll(() => online(dev), (o) => o?.watching?.boards?.length === 2, 20000);
  ok(watching?.watching?.phase === 'siege' && watching.watching.boards.length === 2,
    'the dev lands in the match as a watcher with both fortresses', JSON.stringify(watching?.watching));
  const banners = await Promise.all([host, guest, dev].map((page) =>
    poll(() => banner(page), (b) => b?.text === 'DEV ANDRE HAS JOINED' && b.opacity > 0.9, 4000)));
  ok(banners.every((b) => b?.text === 'DEV ANDRE HAS JOINED' && b.opacity > 0.9),
    'DEV ANDRE HAS JOINED is showing on all three pages', JSON.stringify(banners));
  await dev.screenshot({ path: path.join(SHOTS, 'dev-banner.png') });
  await host.screenshot({ path: path.join(SHOTS, 'host-banner.png') });
  const address = await dev.evaluate(() => location.search);
  ok(!/join=/.test(address) && /relay=/.test(address), 'the ?join= link is used up, the rest kept', address);
  const players = await Promise.all([host, guest, dev].map((page) => page.evaluate(() => window.__gamesPlayer)));
  ok(players.map((p) => `${p?.name}@${p?.room}`).join() === [`Hana@${room}`, `Gus@${room}`, `Andre@${room}`].join(),
    'window.__gamesPlayer names each player and the room', JSON.stringify(players));
  const visible = await dev.evaluate(() => ({
    panel: !document.querySelector('#siege-watch').hidden,
    boards: !document.querySelector('#siege-watch-boards').hidden,
    names: [0, 1].map((i) => document.querySelector(`#siege-watch-name-${i}`).textContent),
    lobby: !document.querySelector('#online-lobby').hidden
  }));
  ok(visible.panel && visible.boards && !visible.lobby && visible.names.some((n) => /Gus's fortress · Hana attacking/.test(n)),
    'the watch panel shows both boards, named', JSON.stringify(visible));

  // The host fires: the guest's fortress moves on the dev's board, live.
  const hostPid = sieges[0].pid;
  await sleep(4200); // let the banner fade before the screenshots of the match
  await fireShot(host);
  const moved = await poll(() => online(dev), (o) => o?.watching?.boards?.find((b) => b.by === hostPid)?.played, 15000);
  const board = moved?.watching?.boards?.find((b) => b.by === hostPid);
  ok(board?.played, 'the host\'s shot reaches the dev\'s board of the guest\'s fortress', JSON.stringify(board));
  await sleep(1500);
  await dev.screenshot({ path: path.join(SHOTS, 'dev-watching.png') });
  const guestView = await online(guest);
  ok(guestView?.previewFramesApplied > 0, 'the guest\'s own corner preview still gets the frames', String(guestView?.previewFramesApplied));

  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(1); });
setTimeout(() => { console.log('ERROR: timed out'); stop(); process.exit(1); }, 180_000).unref();
main()
  .catch((error) => { console.log('ERROR:', error.stack || error.message); fail++; })
  .finally(() => { stop(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });
