#!/usr/bin/env node

// Drives a full online Siege match through the real UI in two real browser contexts
// against a locally-run relay (`wrangler dev`), the way tools/mp-smoke.mjs drives the raw
// protocol and tools/siege-match.mjs drives solo Siege through the UI. This is the first
// gate to exercise both at once: the actual lobby/build/assault/draft/result screens,
// driven by two independent players, resolved by the relay rather than a bot.
//
// The scoreline is not pinned. Both players load the identical fixture blueprint and fire
// the identical proven shot (see BLUEPRINT/SHOT below, lifted from tools/mp-smoke.mjs's own
// already-verified king-popping trajectory) at nearly the same instant, so who wins any
// given round is a genuine race decided by the relay's audit — exactly the kind of result
// docs/BUILD_PLAN.md calls "legitimately variable". Every per-round fact is therefore
// accumulated into an array during the match loop and judged by a *fixed* set of summary
// assertions afterward, the same shape tools/siege-match.mjs uses for its own 3-to-5-round
// variability. That is what keeps the assertion count identical across runs.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { encode } from '../build.js?v=20260902-2';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = performance.now();
const failures = [];
const runtimeIssues = [];
let assertion = 0;

const RELAY_PORT = 8799;
const relay = `http://127.0.0.1:${RELAY_PORT}`;
const room = `online-${Math.random().toString(36).slice(2, 10)}`;

// Same three-pig, King-popping layout as tools/mp-smoke.mjs's own BLUEPRINT_A/B, plus one
// harmless glass cube resting well clear of the shot's own arc (measured: the -1.3/-0.4
// trajectory stays above y=3.2 out past x=5, so a cube on the ground at x=5 is never
// touched by it, for any of the seven round-1 base ammo types — verified directly against
// sim.js, since an ammo-dependent collision here risked robbing the shot of enough energy
// to miss the King on some draws, which a first attempt at this fixture (an obstacle placed
// *in* the arc, since discarded) actually did for five of the seven types).
//
// The cube exists solely to prove assertion 15 (bidirectional preview) without depending on
// who wins any given round. The King only ever dies on the *winning* side's attack, so a
// fixture with no blocks at all only ever emits a preview delta (a pig death) for whichever
// side's round reaches that point — the losing side's attack is frozen mid-flight by the
// relay's round-over broadcast before its own King ever dies, so it would never emit
// anything. siege-online.js's `sendPreviewIfDue` reports a block's pose only when it differs
// from the last-sent one (`posesDiffer`), and starts each round with that memory cleared
// (`ctx.lastSentPose.clear()` in `onSiege`) — so the very first preview tick of every round
// reports this cube's resting pose as "changed" purely because nothing was sent before it,
// with no collision required. That first tick fires within one ~125 ms preview window after
// the round begins (or immediately via the terminal-boundary force-flush on the rare round
// that resolves faster than that), for both attacking rounds, before either can be frozen —
// so both directions of the preview channel carry data on every round, every run.
const BLUEPRINT = encode({
  v: 1,
  blocks: [
    ['cube', 'glass', 5, 0.5, 0]
  ],
  pigs: [
    ['runt', 2, 0.296875, 0],
    ['king', 12, 0.6875, 0],
    ['runt', 22, 0.296875, 0]
  ]
});
const SHOT = { dx: -1.3, dy: -0.4 };

const MIME = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.mjs': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml'
};

function report(expectation, passed, measurement) {
  assertion++;
  const line = `${passed ? 'PASS' : 'FAIL'}  ${String(assertion).padStart(2, '0')}. ` +
    `${expectation}: ${measurement}`;
  console.log(line);
  if (!passed) failures.push(line);
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function poll(read, accepts, timeout = 20000) {
  const deadline = performance.now() + timeout;
  let value; let error;
  while (performance.now() < deadline) {
    try { value = await read(); error = undefined; if (accepts(value)) return { ok: true, value }; }
    catch (caught) { error = caught; }
    await delay(50);
  }
  return { ok: false, value, detail: error ? `last read failed: ${error.message}` : `timed out after ${timeout} ms` };
}

function serve() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/_guard/profile') {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify({ profile: null }));
        return;
      }
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
      response.setHeader('cache-control', 'no-store');
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
}

async function ready(url, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await delay(250);
  }
  throw new Error(`${label} (${url}) never became ready`);
}

function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') runtimeIssues.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', (e) => runtimeIssues.push(`${label} page: ${e.message}`));
  page.on('requestfailed', (r) => runtimeIssues.push(`${label} request: ${r.url()} (${r.failure()?.errorText ?? 'failed'})`));
  page.on('response', (r) => { if (r.status() >= 400) runtimeIssues.push(`${label} request: ${r.url()} (HTTP ${r.status()})`); });
}

async function state(page) {
  return page.evaluate(() => window.__SLINGWRECK_SMOKE__?.() ?? null);
}
async function online(page) {
  return (await state(page))?.online ?? null;
}

// The camera pans/zooms toward its target over real time (see game.js's updateCamera), so a
// pouch point read the instant the siege phase opens can be stale — tools/siege-match.mjs
// hits the same thing and solves it the same way: wait for camera to actually reach where it
// is going before computing screen coordinates from it.
async function waitForCameraSettled(page, timeout = 8000) {
  return poll(() => state(page), (s) => {
    const camera = s?.camera;
    const target = s?.cameraTarget;
    if (!camera || !target) return true;
    return Math.abs(camera.x - target.x) < 0.03 &&
      Math.abs(camera.y - target.y) < 0.03 &&
      Math.abs(camera.zoom - target.zoom) < 0.03;
  }, timeout);
}

async function pouchPoint(page) {
  return page.evaluate(() => {
    const { camera, sling } = window.__SLINGWRECK_SMOKE__();
    return {
      x: camera.viewportX + camera.viewportW / 2 + (sling.x - camera.x) * camera.scale,
      y: camera.viewportY + camera.viewportH / 2 - (sling.y - camera.y) * camera.scale,
      scale: camera.scale
    };
  });
}

// Inverts game.js's updateAim (dx = (point.x - startX) / scale; dy = (startY - point.y) /
// scale) to turn the proven world-space SHOT vector into a screen-space mouse drag, the same
// derivation tools/siege-match.mjs's own pouchPoint-based helpers use.
async function fireShot(page) {
  await waitForCameraSettled(page);
  const pouch = await pouchPoint(page);
  const x = pouch.x + SHOT.dx * pouch.scale;
  const y = pouch.y - SHOT.dy * pouch.scale;
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  const aimed = await poll(() => state(page), (s) => s?.aim?.active === true, 2000);
  if (!aimed.ok) throw new Error(`shot never registered as an aim: ${aimed.detail}`);
  await page.mouse.up();
}

async function lockIn(page, blueprint) {
  await page.locator('#blueprint-input').fill(blueprint);
  await page.locator('#load-blueprint-button').click();
  await poll(() => state(page), (s) => (s?.editor?.pieceCount ?? 0) > 0);
  await page.locator('#siege-lock').click();
}

const server = serve();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const relayProcess = spawn('npx', ['wrangler', 'dev', '--port', String(RELAY_PORT)],
  { cwd: root, stdio: 'ignore' });

let browser;
const rounds = [];
const threadingChecks = [];
let matchOver = null;
let draftsSeen = 0;
let draftsWentToLoser = 0;
let maxHostPreviewMoved = 0;
let maxGuestPreviewMoved = 0;
let seedSeenNotEqualToPin = 0;
let seedsAgree = 0;
let seedReadings = 0;
let pendingThreadCheck = null;

try {
  await Promise.all([
    ready(`${relay}/health`, 'relay'),
    ready(baseUrl, 'game host')
  ]);

  browser = await chromium.launch();
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  watch(host, 'host'); watch(guest, 'guest');

  // ?siege-seed=1 is present on both — the whole point of the gate for this flag is that
  // online ignores it. `1` is never a real relay seed (randomSeed() draws a full uint32 from
  // crypto.getRandomValues, landing on exactly 1 with probability ~2^-32), so any observed
  // seed equal to 1 downstream would itself be strong evidence of a leak, not a coincidence.
  const url = `${baseUrl}/?smoke-test&siege-seed=1&relay=${encodeURIComponent(relay)}`;
  await Promise.all([
    host.goto(url, { waitUntil: 'networkidle' }),
    guest.goto(url, { waitUntil: 'networkidle' })
  ]);

  await host.locator('#siege-online-button').click();
  await guest.locator('#siege-online-button').click();
  const lobbiesOpen = await Promise.all([
    poll(() => host.evaluate(() => !document.querySelector('#online-lobby').hidden), (v) => v),
    poll(() => guest.evaluate(() => !document.querySelector('#online-lobby').hidden), (v) => v)
  ]);
  report('create room opens the lobby on both clients',
    lobbiesOpen.every((r) => r.ok), lobbiesOpen.map((r) => r.ok).join('/'));

  await host.locator('#online-name').fill('Host');
  await host.locator('#online-room').fill(room);
  await host.locator('#online-create').click();
  const created = await poll(() => online(host), (o) => o?.phase === 'lobby' && o.room === room);
  report('create room succeeds', created.ok, created.ok ? `room "${created.value.room}"` : created.detail);

  await guest.locator('#online-name').fill('Guest');
  await guest.locator('#online-room').fill(room);
  await guest.locator('#online-join').click();
  const bothInLobby = await Promise.all([
    poll(() => online(host), (o) => Boolean(o?.opponent)),
    poll(() => online(guest), (o) => Boolean(o?.opponent))
  ]);
  report('join room puts both players in the same lobby with each other visible',
    bothInLobby.every((r) => r.ok),
    bothInLobby.map((r) => r.value?.opponent?.name ?? 'none').join(' / '));

  await host.locator('#online-start').click();
  const bothBuilding = await Promise.all([
    poll(() => online(host), (o) => o?.phase === 'build'),
    poll(() => online(guest), (o) => o?.phase === 'build')
  ]);
  report('starting the match opens the build phase for both players',
    bothBuilding.every((r) => r.ok), bothBuilding.map((r) => r.value?.phase).join('/'));

  // Best of five needs at most nine rounds in principle; two players who each pop a King on
  // their first shot resolve every round in well under that, so a generous cap here is a
  // safety valve, not the expected path. Per-round facts go into the arrays below rather than
  // individual report() calls: the round count itself varies 3-5 depending on who wins each
  // race, and a report() per round would make the total assertion count vary with it — exactly
  // what the gate is required not to do. Every one of these becomes a single fixed assertion,
  // over every round played, after the loop.
  const buildOpened = [];
  const siegeReached = [];
  const roundResolved = [];
  const buildAfterDraft = [];
  for (let round = 1; round <= 9 && !matchOver; round++) {
    const opening = await Promise.all([
      poll(() => online(host), (o) => o?.phase === 'build' || o?.phase === 'match-over'),
      poll(() => online(guest), (o) => o?.phase === 'build' || o?.phase === 'match-over')
    ]);
    if (opening.some((r) => r.value?.phase === 'match-over')) break;
    buildOpened.push(opening.every((r) => r.ok && r.value?.phase === 'build'));

    await Promise.all([lockIn(host, BLUEPRINT), lockIn(guest, BLUEPRINT)]);
    const bothSieging = await Promise.all([
      poll(() => online(host), (o) => o?.phase === 'siege'),
      poll(() => online(guest), (o) => o?.phase === 'siege')
    ]);
    siegeReached.push(bothSieging.every((r) => r.ok));

    const [hostOnline, guestOnline] = bothSieging.map((r) => r.value);
    seedReadings += 2;
    if (hostOnline?.seed !== 1) seedSeenNotEqualToPin++;
    if (guestOnline?.seed !== 1) seedSeenNotEqualToPin++;
    if (hostOnline?.seed != null && hostOnline.seed === guestOnline?.seed) seedsAgree++;

    // The one measurement that only makes sense once a card exists: whichever player drafted
    // last round now has that card threaded onto the correct sides of both live rounds.
    if (pendingThreadCheck) {
      const { cardId, holder } = pendingThreadCheck;
      const holderOnline = holder === 'host' ? hostOnline : guestOnline;
      const otherOnline = holder === 'host' ? guestOnline : hostOnline;
      threadingChecks.push(holderOnline?.attackerCards?.includes(cardId) === true);
      threadingChecks.push(otherOnline?.defenderCards?.includes(cardId) === true);
      threadingChecks.push(otherOnline?.attackerCards?.includes(cardId) !== true);
      threadingChecks.push(holderOnline?.defenderCards?.includes(cardId) !== true);
      threadingChecks.push(holderOnline?.shadowDefenderCards?.includes(cardId) === true);
      threadingChecks.push(holderOnline?.shadowAttackerCards?.includes(cardId) !== true);
      pendingThreadCheck = null;
    }

    await Promise.all([fireShot(host), fireShot(guest)]);

    // Polling a phase string is racy: 'round-over' is transient (finishRound() calls
    // beginDraft() synchronously right after, or ends the match, so the follow-on
    // draft-offer/draft-wait/match-over messages arrive back to back with it) and a
    // *coincidental* non-'siege' phase read is not proof this round resolved. lastRoundOver
    // is instead keyed to the round it belongs to and is set once, synchronously, by
    // onRoundOver before any of those follow-on messages are processed — polling on it
    // directly is what "this round" actually means, and cannot be satisfied early or by an
    // unrelated phase change.
    const resolved = await Promise.all([
      poll(() => online(host), (o) => o?.lastRoundOver?.round === round, 20000),
      poll(() => online(guest), (o) => o?.lastRoundOver?.round === round, 20000)
    ]);
    roundResolved.push(resolved.every((r) => r.ok));

    // lastRoundOver landing does not mean the room has already advanced into 'draft' or
    // 'match-over' — the relay sends those as separate messages processed on later event-loop
    // turns, so the very snapshot that first satisfied the poll above can still read a stale
    // phase. Confirm one of those two before deciding whether this was the final round.
    const settled = await Promise.all([
      poll(() => online(host), (o) => o?.phase === 'draft' || o?.phase === 'match-over', 5000),
      poll(() => online(guest), (o) => o?.phase === 'draft' || o?.phase === 'match-over', 5000)
    ]);
    const [hostAfter, guestAfter] = settled.map((r) => r.value);
    maxHostPreviewMoved = Math.max(maxHostPreviewMoved, hostAfter?.previewBodiesMovedTotal ?? 0);
    maxGuestPreviewMoved = Math.max(maxGuestPreviewMoved, guestAfter?.previewBodiesMovedTotal ?? 0);

    const roundOver = hostAfter?.lastRoundOver ?? guestAfter?.lastRoundOver;
    rounds.push({ round, reason: roundOver?.reason, winner: roundOver?.winner });

    if (settled.some((r) => r.value?.phase === 'match-over')) {
      matchOver = settled.find((r) => r.value?.phase === 'match-over')?.value;
      break;
    }

    const loserIsHost = roundOver?.winner === guestOnline?.pid;
    const loserPage = loserIsHost ? host : guest;
    const draftShown = await poll(() => online(loserPage), (o) => o?.phase === 'draft' && o.draftOffer);
    if (draftShown.ok) {
      draftsSeen++;
      draftsWentToLoser++;
      const cardId = draftShown.value.draftOffer.candidates[0];
      await loserPage.locator('.siege-card').first().click();
      pendingThreadCheck = { cardId, holder: loserIsHost ? 'host' : 'guest' };
    }
    // Longer than TUNE.draftSeconds (25s): even if the click above missed, the relay's own
    // draft-clock auto-picks for the loser once it expires (worker.js tick()), so the room
    // reaches build either way — this margin is what makes that fallback path harmless
    // instead of a spurious timeout.
    const nextBuild = await Promise.all([
      poll(() => online(host), (o) => o?.phase === 'build', 35000),
      poll(() => online(guest), (o) => o?.phase === 'build', 35000)
    ]);
    buildAfterDraft.push(nextBuild.every((r) => r.ok));
  }

  report('every round played opened the build phase for both players',
    buildOpened.length > 0 && buildOpened.every(Boolean), `${buildOpened.filter(Boolean).length}/${buildOpened.length}`);
  report('every round played had both lock-ins reach the siege phase',
    siegeReached.length > 0 && siegeReached.every(Boolean), `${siegeReached.filter(Boolean).length}/${siegeReached.length}`);
  report('every round played resolved to round-over or match-over on both clients',
    roundResolved.length > 0 && roundResolved.every(Boolean), `${roundResolved.filter(Boolean).length}/${roundResolved.length}`);
  report('the match reaches a winner within nine rounds',
    matchOver !== null && matchOver.matchWinner != null,
    matchOver ? `winner pid ${matchOver.matchWinner}` : 'no match-over reached');
  report('at least three rounds were resolved (best of five needs at least three)',
    rounds.length >= 3 && rounds.length <= 9, `${rounds.length} round(s) played`);
  report('every resolved round ended in a King pop (the only outcome this fixture can produce)',
    rounds.every((r) => r.reason === 'king-pop'), rounds.map((r) => r.reason).join(', ') || 'none');
  report('every draft offered went to that round\'s actual loser',
    draftsSeen > 0 && draftsWentToLoser === draftsSeen, `${draftsWentToLoser}/${draftsSeen}`);
  report('every non-final round reached the next build phase after its draft',
    buildAfterDraft.length > 0 && buildAfterDraft.every(Boolean),
    `${buildAfterDraft.filter(Boolean).length}/${buildAfterDraft.length}`);
  report('the online round seed was never the pinned ?siege-seed=1 value',
    seedReadings > 0 && seedSeenNotEqualToPin === seedReadings,
    `${seedSeenNotEqualToPin}/${seedReadings} seed reading(s) not equal to 1`);
  report('both clients agreed on the relay-issued seed every round',
    seedsAgree === rounds.length, `${seedsAgree}/${rounds.length} rounds agreed`);
  report('bidirectional preview: both clients applied at least one opponent pose update',
    maxHostPreviewMoved > 0 && maxGuestPreviewMoved > 0,
    `host applied ${maxHostPreviewMoved} body update(s); guest applied ${maxGuestPreviewMoved}`);
  report('drafted-card threading: attacker/defender roles were correct on every check made',
    threadingChecks.length > 0 && threadingChecks.every(Boolean),
    `${threadingChecks.filter(Boolean).length}/${threadingChecks.length} threading check(s) passed`);

  await host.screenshot({ path: resolve(root, 'shots/online-smoke.png') }).catch(() => {});
} catch (error) {
  runtimeIssues.push(`online smoke run aborted: ${error.stack ?? error}`);
} finally {
  await browser?.close().catch((e) => runtimeIssues.push(`browser close: ${e.message}`));
  await new Promise((done) => server.close(done));
  try { relayProcess.kill('SIGTERM'); } catch {}
}

console.log('');
for (const entry of rounds) console.log(`  round ${entry.round}: winner pid ${entry.winner} (${entry.reason})`);

report('browser and relay runtime is clean', runtimeIssues.length === 0, `${runtimeIssues.length} issue(s)`);
for (const issue of runtimeIssues) console.log(`      ${issue}`);

const seconds = (performance.now() - startedAt) / 1000;
if (failures.length) {
  console.error(`\n${failures.length} online smoke assertion(s) failed in ${seconds.toFixed(2)} s.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${assertion} online smoke assertions passed in ${seconds.toFixed(2)} s.`);
}
