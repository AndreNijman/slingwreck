#!/usr/bin/env node

// Two independent Chromium processes drive the public relay protocol. The game UI
// does not own Siege until P7, so the pages import the same browser modules the UI
// will use and act as thin protocol clients around the real simulation.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { encode } from '../build.js?v=20260902-2';

const liveRelay = process.env.LIVE_RELAY;
const relay = liveRelay || 'http://127.0.0.1:8787';
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173';
const processes = [];
const runtimeIssues = [];
const browsers = [];

if (!process.env.BASE_URL) {
  processes.push(spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore' }));
}
if (!liveRelay) {
  processes.push(spawn('npx', ['wrangler', 'dev', '--port', '8787'], {
    stdio: 'ignore'
  }));
}

function stop() {
  for (const process of processes) {
    try { process.kill('SIGTERM'); } catch {}
  }
}
process.on('exit', stop);

async function ready(url, label, protectedOrigin = false) {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok || protectedOrigin && response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} (${url}) never became ready`);
}

function watch(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeIssues.push(`${label} console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeIssues.push(`${label} page: ${error.message}`));
  page.on('requestfailed', (request) => runtimeIssues.push(
    `${label} request: ${request.url()} (${request.failure()?.errorText ?? 'failed'})`
  ));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      runtimeIssues.push(`${label} request: ${response.url()} (HTTP ${response.status()})`);
    }
  });
}

async function openPage(browser, label) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  watch(page, label);
  const url = new URL('robots.txt', `${baseUrl.replace(/\/+$/, '')}/`);
  url.searchParams.set('_games_frame', '1');
  await page.goto(url.href);
  const nameInput = page.locator('form[action^="/_guard/name"] input[name="name"]');
  if (await nameInput.count()) {
    const action = await nameInput.evaluate((input) => input.form.action);
    await context.request.post(action, {
      form: { name: 'SLINGWRECK multiplayer smoke' },
      maxRedirects: 0
    });
    await page.goto(url.href);
  }
  return page;
}

async function connect(page, action, room, name, options = {}) {
  await page.evaluate(({ relayBase, action, room, name, options }) =>
    new Promise((resolve, reject) => {
      const url = new URL(`${relayBase.replace(/^http/, 'ws')}/ws`);
      url.searchParams.set('room', room);
      const socket = new WebSocket(url);
      const state = { socket, messages: [] };
      window.__slingMp = state;
      socket.onopen = () => socket.send(JSON.stringify({
        t: action,
        room,
        name,
        password: options.password || '',
        pid: options.pid,
        token: options.token
      }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        state.messages.push(message);
        if (message.t === 'welcome') resolve(message);
        if (message.t === 'err' && !state.messages.some((entry) => entry.t === 'welcome')) {
          reject(new Error(`${message.code}: ${message.m}`));
        }
      };
      socket.onerror = () => reject(new Error('websocket connection failed'));
    }), { relayBase: relay, action, room, name, options });
  return page.evaluate(() => window.__slingMp.messages.find((message) =>
    message.t === 'welcome'));
}

async function send(page, message) {
  const sent = await page.evaluate((payload) => {
    const socket = window.__slingMp?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, message);
  assert.equal(sent, true, `socket was not open for ${message.t}`);
}

async function messageCount(page) {
  return page.evaluate(() => window.__slingMp.messages.length);
}

async function waitMessage(page, type, after = 0, field = null, value = null) {
  await page.waitForFunction(({ type, after, field, value }) =>
    window.__slingMp.messages.slice(after).some((message) =>
      message.t === type && (!field || message[field] === value)),
  { type, after, field, value }, { timeout: 15_000 });
  return page.evaluate(({ type, after, field, value }) =>
    window.__slingMp.messages.slice(after).find((message) =>
      message.t === type && (!field || message[field] === value)),
  { type, after, field, value });
}

async function settleDigest(page, blueprint, seed, bag, keep = false) {
  return page.evaluate(async ({ blueprint, seed, bag, keep }) => {
    const sim = await import('./sim.js?v=20260902-2');
    const { decode } = await import('./build.js?v=20260902-2');
    const { TUNE } = await import('./data.js?v=20260902-2');
    const round = sim.makeRound({ mode: 'siege', blueprint: decode(blueprint), seed, bag });
    const steps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
    for (let index = 0; index < steps; index++) sim.stepRound(round, TUNE.step);
    if (keep) window.__slingRound = round;
    return { digest: sim.digestRound(round), step: round.stepCount };
  }, { blueprint, seed, bag, keep });
}

async function launchLocal(page, dx, dy, stopAtKing) {
  return page.evaluate(async ({ dx, dy, stopAtKing }) => {
    const sim = await import('./sim.js?v=20260902-2');
    const { TUNE } = await import('./data.js?v=20260902-2');
    const round = window.__slingRound;
    const ammoIndex = round.shotIndex;
    const step = round.stepCount;
    if (!sim.launch(round, dx, dy)) throw new Error('local launch was rejected');
    if (stopAtKing) {
      const king = round.pigs.find((pig) => pig.isKing);
      for (let index = 0; index < 600 && !king.dead; index++) {
        sim.stepRound(round, TUNE.step);
      }
      if (!king.dead) throw new Error('test trajectory did not pop the King');
    }
    return {
      step,
      ammoIndex,
      boundaryStep: round.stepCount,
      score: round.score,
      digest: sim.digestRound(round)
    };
  }, { dx, dy, stopAtKing });
}

async function replayResume(page, resume) {
  return page.evaluate(async (payload) => {
    const sim = await import('./sim.js?v=20260902-2');
    const { decode } = await import('./build.js?v=20260902-2');
    const { TUNE } = await import('./data.js?v=20260902-2');
    const round = sim.makeRound({
      mode: 'siege',
      blueprint: decode(payload.blueprint),
      seed: payload.seed,
      bag: payload.bag
    });
    let cursor = 0;
    while (true) {
      while (cursor < payload.shotLog.length &&
          payload.shotLog[cursor].step === round.stepCount) {
        const event = payload.shotLog[cursor++];
        if (event.t === 'shot') sim.launch(round, event.dx, event.dy);
        else sim.tap(round);
      }
      if (round.stepCount >= payload.step) break;
      sim.stepRound(round, TUNE.step);
    }
    return { digest: sim.digestRound(round), step: round.stepCount };
  }, resume);
}

const BLUEPRINT_A = encode({
  v: 1,
  blocks: [],
  pigs: [
    ['runt', 2, 0.296875, 0],
    ['king', 12, 0.6875, 0],
    ['runt', 22, 0.296875, 0]
  ]
});
const BLUEPRINT_B = encode({
  v: 1,
  blocks: [],
  pigs: [
    ['runt', 4, 0.296875, 0],
    ['king', 12, 0.6875, 0],
    ['runt', 20, 0.296875, 0]
  ]
});

await ready(`${relay}/health`, 'relay');
await ready(baseUrl, 'game host', Boolean(process.env.BASE_URL));
const room = `mp-${crypto.randomUUID().slice(0, 8)}`;

try {
  browsers.push(await chromium.launch({ headless: true }));
  browsers.push(await chromium.launch({ headless: true }));
  const host = await openPage(browsers[0], 'host');
  let guest = await openPage(browsers[1], 'guest');
  const hostWelcome = await connect(host, 'create', room, 'Host', { password: 'crown' });
  const guestWelcome = await connect(guest, 'join', room, 'Guest', { password: 'crown' });

  await send(host, { t: 'start' });
  await Promise.all([waitMessage(host, 'build'), waitMessage(guest, 'build')]);
  await Promise.all([
    send(host, { t: 'lock', blueprint: BLUEPRINT_A }),
    send(guest, { t: 'lock', blueprint: BLUEPRINT_B })
  ]);
  const [hostSiege, guestSiege] = await Promise.all([
    waitMessage(host, 'siege'),
    waitMessage(guest, 'siege')
  ]);
  assert.equal(hostSiege.blueprint, BLUEPRINT_B,
    'host did not receive the guest authored blueprint');
  assert.equal(guestSiege.blueprint, BLUEPRINT_A,
    'guest did not receive the host authored blueprint');

  const [aHost, aGuest, bHost, bGuest] = await Promise.all([
    settleDigest(host, BLUEPRINT_A, hostSiege.seed, hostSiege.bag),
    settleDigest(guest, BLUEPRINT_A, hostSiege.seed, hostSiege.bag, true),
    settleDigest(host, BLUEPRINT_B, hostSiege.seed, hostSiege.bag, true),
    settleDigest(guest, BLUEPRINT_B, hostSiege.seed, hostSiege.bag)
  ]);
  assert.deepEqual(aHost, aGuest, 'clients settled the host fortress differently');
  assert.deepEqual(bHost, bGuest, 'clients settled the guest fortress differently');

  const hostPreviewAt = await messageCount(guest);
  const guestPreviewAt = await messageCount(host);
  const hostPreview = { t: 'preview', frame: { owner: 'host', n: 1 } };
  const guestPreview = { t: 'preview', frame: { owner: 'guest', n: 1 } };
  await Promise.all([send(host, hostPreview), send(guest, guestPreview)]);
  assert.deepEqual(await waitMessage(guest, 'preview', hostPreviewAt), hostPreview,
    'host preview was changed or did not arrive');
  assert.deepEqual(await waitMessage(host, 'preview', guestPreviewAt), guestPreview,
    'guest preview was changed or did not arrive');

  const [hostShot, guestShot] = await Promise.all([
    launchLocal(host, -1.3, -0.4, true),
    launchLocal(guest, 0, 0, false)
  ]);
  await Promise.all([
    send(host, {
      t: 'shot', step: hostShot.step, ammoIndex: hostShot.ammoIndex,
      dx: -1.3, dy: -0.4
    }),
    send(guest, {
      t: 'shot', step: guestShot.step, ammoIndex: guestShot.ammoIndex,
      dx: 0, dy: 0
    })
  ]);

  const disconnectedAt = await messageCount(host);
  await guest.close();
  const disconnected = await waitMessage(host, 'opponent-disconnected', disconnectedAt);
  assert.equal(disconnected.grace, 20, 'disconnect grace was not 20 seconds');
  await host.waitForTimeout(300);
  const premature = await host.evaluate((after) =>
    window.__slingMp.messages.slice(after).some((message) => message.t === 'round-over'),
  disconnectedAt);
  assert.equal(premature, false, 'the round ended before reconnect grace elapsed');

  guest = await openPage(browsers[1], 'guest-reconnect');
  const nextWelcome = await connect(guest, 'reconnect', room, 'Guest', {
    pid: guestWelcome.you,
    token: guestWelcome.resumeToken
  });
  assert.equal(nextWelcome.reconnected, true, 'reconnect was treated as a fresh join');
  const resume = await waitMessage(guest, 'resume');
  assert.equal(resume.blueprint, BLUEPRINT_A, 'resume changed the authored target blueprint');
  assert.equal(resume.seed, guestSiege.seed, 'resume changed the round seed');
  assert.deepEqual(resume.shotLog[0], {
    t: 'shot', step: guestShot.step, ammoIndex: 0, dx: 0, dy: 0
  });
  const rebuilt = await replayResume(guest, resume);
  assert.equal(rebuilt.step, resume.step);
  assert.equal(rebuilt.digest, resume.digest, 'reconnect did not reconstruct the same world');

  const hostOverAt = await messageCount(host);
  const guestOverAt = await messageCount(guest);
  const claimedAt = Date.now();
  await send(host, {
    t: 'score',
    step: hostShot.boundaryStep,
    ammoIndex: hostShot.ammoIndex,
    score: hostShot.score,
    digest: hostShot.digest,
    kingPop: true
  });
  const [hostOver, guestOver] = await Promise.all([
    waitMessage(host, 'round-over', hostOverAt),
    waitMessage(guest, 'round-over', guestOverAt)
  ]);
  const endLatency = Date.now() - claimedAt;
  assert.ok(endLatency <= 500, `King pop took ${endLatency} ms to end the round`);
  assert.equal(hostOver.winner, hostWelcome.you, 'host saw the wrong round winner');
  assert.equal(guestOver.winner, hostWelcome.you, 'guest saw the wrong round winner');
  assert.equal(hostOver.reason, 'king-pop');

  assert.deepEqual(runtimeIssues, [], runtimeIssues.join('\n'));
  console.log(`Multiplayer smoke passed: authored twin digests ${aHost.digest}/${bHost.digest}; ` +
    `previews both ways; audited King end ${endLatency} ms; resume ${rebuilt.digest}.`);
} finally {
  await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
  stop();
}
