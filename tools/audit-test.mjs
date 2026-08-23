#!/usr/bin/env node

// Protocol-level adversarial gate. Three rooms contain an explicit cheat and a
// fourth spends both honest bags while reporting every exact replay boundary.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { encode } from '../build.js';
import { TUNE } from '../data.js';
import { launch, makeRound, stepRound } from '../sim.js';

const liveRelay = process.env.LIVE_RELAY;
const relay = liveRelay || 'http://127.0.0.1:8787';
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173';
const processes = [];
const runtimeIssues = [];

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

async function pageFor(context, label) {
  const page = await context.newPage();
  watch(page, label);
  const url = new URL('robots.txt', `${baseUrl.replace(/\/+$/, '')}/`);
  await page.goto(url.href);
  return page;
}

async function connect(page, action, room, name, password = '') {
  await page.evaluate(({ relayBase, action, room, name, password }) =>
    new Promise((resolve, reject) => {
      const url = new URL(`${relayBase.replace(/^http/, 'ws')}/ws`);
      url.searchParams.set('room', room);
      const socket = new WebSocket(url);
      window.__auditClient = { socket, messages: [] };
      socket.onopen = () => socket.send(JSON.stringify({
        t: action, room, name, password
      }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        window.__auditClient.messages.push(message);
        if (message.t === 'welcome') resolve();
        if (message.t === 'err') reject(new Error(`${message.code}: ${message.m}`));
      };
      socket.onerror = () => reject(new Error('websocket connection failed'));
    }), { relayBase: relay, action, room, name, password });
  return page.evaluate(() => window.__auditClient.messages[0]);
}

async function send(page, message) {
  const ok = await page.evaluate((payload) => {
    const socket = window.__auditClient?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, message);
  assert.equal(ok, true, `socket was not open for ${message.t}`);
}

async function count(page) {
  return page.evaluate(() => window.__auditClient.messages.length);
}

async function waitMessage(page, type, after = 0) {
  await page.waitForFunction(({ type, after }) =>
    window.__auditClient.messages.slice(after).some((message) => message.t === type),
  { type, after }, { timeout: 20_000 });
  return page.evaluate(({ type, after }) =>
    window.__auditClient.messages.slice(after).find((message) => message.t === type),
  { type, after });
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

async function setup(context, label) {
  const room = `audit-${label}-${crypto.randomUUID().slice(0, 6)}`;
  const honest = await pageFor(context, `${label}-honest`);
  const suspect = await pageFor(context, `${label}-suspect`);
  const honestWelcome = await connect(honest, 'create', room, 'Honest', 'crown');
  const suspectWelcome = await connect(suspect, 'join', room, 'Suspect', 'crown');
  await send(honest, { t: 'start' });
  await Promise.all([waitMessage(honest, 'build'), waitMessage(suspect, 'build')]);
  await Promise.all([
    send(honest, { t: 'lock', blueprint: BLUEPRINT_A }),
    send(suspect, { t: 'lock', blueprint: BLUEPRINT_B })
  ]);
  const [honestSiege, suspectSiege] = await Promise.all([
    waitMessage(honest, 'siege'),
    waitMessage(suspect, 'siege')
  ]);
  return {
    honest,
    suspect,
    honestWelcome,
    suspectWelcome,
    honestSiege,
    suspectSiege,
    startedAt: Date.now()
  };
}

async function expectForfeit(match, expectedCode) {
  const [honestOver, suspectOver] = await Promise.all([
    waitMessage(match.honest, 'round-over'),
    waitMessage(match.suspect, 'round-over')
  ]);
  for (const result of [honestOver, suspectOver]) {
    assert.equal(result.winner, match.honestWelcome.you);
    assert.equal(result.loser, match.suspectWelcome.you);
    assert.equal(result.reason, 'forfeit');
    assert.equal(result.code, expectedCode);
    assert.match(result.m, /forfeit/i);
  }
}

async function closeMatch(match) {
  await Promise.all([
    match.honest.close().catch(() => {}),
    match.suspect.close().catch(() => {})
  ]);
}

async function initLocal(page, siege) {
  await page.evaluate(async (payload) => {
    const sim = await import('./sim.js');
    const { decode } = await import('./build.js');
    const { TUNE } = await import('./data.js');
    const round = sim.makeRound({
      mode: 'siege',
      blueprint: decode(payload.blueprint),
      seed: payload.seed,
      bag: payload.bag
    });
    const settleSteps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
    for (let index = 0; index < settleSteps; index++) sim.stepRound(round, TUNE.step);
    window.__auditRound = round;
  }, siege);
}

async function localMiss(page, tapAbility = false) {
  return page.evaluate(async (tapAbility) => {
    const sim = await import('./sim.js');
    const { AMMO_BY_ID, TUNE } = await import('./data.js');
    const round = window.__auditRound;
    const step = round.stepCount;
    const ammoIndex = round.shotIndex;
    const ammo = round.bag[ammoIndex];
    if (!sim.launch(round, 0, 0)) throw new Error('honest local shot was rejected');
    let tapStep = null;
    if (tapAbility && AMMO_BY_ID[ammo].ability) {
      sim.stepRound(round, TUNE.step);
      if (!sim.tap(round)) throw new Error('honest local tap was rejected');
      tapStep = round.stepCount;
    }
    for (let index = 0; index < 900 &&
        round.phase !== 'aiming' && round.phase !== 'lost' && round.phase !== 'won'; index++) {
      sim.stepRound(round, TUNE.step);
    }
    if (round.phase !== 'aiming' && round.phase !== 'lost') {
      throw new Error(`honest shot did not settle: ${round.phase}`);
    }
    return {
      step,
      tapStep,
      ammoIndex,
      boundaryStep: round.stepCount,
      score: round.score,
      digest: sim.digestRound(round),
      spent: round.phase === 'lost'
    };
  }, tapAbility);
}

async function sendHonestShot(page, shot) {
  await send(page, {
    t: 'shot', step: shot.step, ammoIndex: shot.ammoIndex, dx: 0, dy: 0
  });
  if (shot.tapStep !== null) await send(page, { t: 'tap', step: shot.tapStep });
}

function benchmarkReplay() {
  const blocks = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 24; x++) blocks.push(['cube', 'wood', x + 0.5, y + 0.5, 0]);
  }
  const blueprint = {
    v: 1,
    blocks,
    pigs: [
      ['runt', 2, 5.3, 0],
      ['king', 12, 5.7, 0],
      ['runt', 22, 5.3, 0]
    ]
  };
  const round = makeRound({
    mode: 'siege', blueprint, seed: 1, bag: Array(20).fill('nib')
  });
  for (let index = 0; index < 180; index++) stepRound(round, TUNE.step);
  launch(round, -1.3, -0.4);
  const steps = 2000;
  const started = performance.now();
  for (let index = 0; index < steps; index++) stepRound(round, TUNE.step);
  const elapsed = performance.now() - started;
  const stepsPerSecond = steps * 1000 / elapsed;
  const fullRoundCpu = TUNE.roundSeconds * 120 / stepsPerSecond;
  return {
    bodies: round.world.bodies.length,
    stepsPerSecond,
    fullRoundCpu,
    margin: 30 / fullRoundCpu
  };
}

await ready(`${relay}/health`, 'relay');
await ready(baseUrl, 'game host', Boolean(process.env.BASE_URL));
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });

  const inflated = await setup(context, 'inflated');
  await send(inflated.suspect, {
    t: 'shot', step: 180, ammoIndex: 0, dx: 0, dy: 0
  });
  await send(inflated.suspect, {
    t: 'score', step: 180, ammoIndex: 0, score: 1_000_000,
    digest: '00000000', settled: true
  });
  await expectForfeit(inflated, 'score-bounds');
  await closeMatch(inflated);
  console.log('PASS inflated score forfeited; honest client won');

  const falseKing = await setup(context, 'false-king');
  await initLocal(falseKing.suspect, falseKing.suspectSiege);
  const miss = await localMiss(falseKing.suspect);
  await sendHonestShot(falseKing.suspect, miss);
  const falseKingWait = Math.max(0,
    (miss.boundaryStep - 180) * TUNE.step * 1000 -
    (Date.now() - falseKing.startedAt) + 100);
  await falseKing.suspect.waitForTimeout(falseKingWait);
  await send(falseKing.suspect, {
    t: 'score',
    step: miss.boundaryStep,
    ammoIndex: miss.ammoIndex,
    score: miss.score,
    digest: miss.digest,
    kingPop: true,
    settled: true
  });
  await expectForfeit(falseKing, 'false-king-pop');
  await closeMatch(falseKing);
  console.log('PASS false King pop replayed and forfeited; honest client won');

  const rapid = await setup(context, 'rapid');
  await send(rapid.suspect, {
    t: 'shot', step: 180, ammoIndex: 0, dx: 0, dy: 0
  });
  await send(rapid.suspect, {
    t: 'shot', step: 181, ammoIndex: 1, dx: 0, dy: 0
  });
  await expectForfeit(rapid, 'shot-timing');
  await closeMatch(rapid);
  console.log('PASS impossible shot cadence forfeited; honest client won');

  const honest = await setup(context, 'honest-full');
  await Promise.all([
    initLocal(honest.honest, honest.honestSiege),
    initLocal(honest.suspect, honest.suspectSiege)
  ]);
  const shots = honest.honestSiege.bag.length;
  for (let index = 0; index < shots; index++) {
    const [first, second] = await Promise.all([
      localMiss(honest.honest, true),
      localMiss(honest.suspect, true)
    ]);
    await Promise.all([
      sendHonestShot(honest.honest, first),
      sendHonestShot(honest.suspect, second)
    ]);
    const wait = Math.max(0,
      (Math.max(first.boundaryStep, second.boundaryStep) - 180) * TUNE.step * 1000 -
      (Date.now() - honest.startedAt) + 100);
    await honest.honest.waitForTimeout(wait);
    const firstAt = await count(honest.honest);
    const secondAt = await count(honest.suspect);
    await Promise.all([
      send(honest.honest, {
        t: 'score', step: first.boundaryStep, ammoIndex: first.ammoIndex,
        score: first.score, digest: first.digest, settled: true
      }),
      send(honest.suspect, {
        t: 'score', step: second.boundaryStep, ammoIndex: second.ammoIndex,
        score: second.score, digest: second.digest, settled: true
      })
    ]);
    await Promise.all([
      waitMessage(honest.honest, 'audit-ok', firstAt),
      waitMessage(honest.suspect, 'audit-ok', secondAt)
    ]);
  }
  const [honestOver, otherOver] = await Promise.all([
    waitMessage(honest.honest, 'round-over'),
    waitMessage(honest.suspect, 'round-over')
  ]);
  assert.equal(honestOver.reason, 'tie');
  assert.equal(otherOver.reason, 'tie');
  assert.equal(honestOver.winner, null);
  assert.equal(otherOver.winner, null);
  for (const page of [honest.honest, honest.suspect]) {
    const messages = await page.evaluate(() => window.__auditClient.messages);
    assert.equal(messages.some((message) =>
      message.t === 'round-over' && message.reason === 'forfeit'), false);
  }
  await closeMatch(honest);
  console.log(`PASS honest full round: ${shots}/${shots} shots per client audited, no accusation`);

  assert.deepEqual(runtimeIssues, [], runtimeIssues.join('\n'));
  const cost = benchmarkReplay();
  console.log(`Replay cost: ${cost.stepsPerSecond.toFixed(0)} steps/s with ` +
    `${cost.bodies} bodies; dual 180 s round ${cost.fullRoundCpu.toFixed(2)} CPU-s; ` +
    `${cost.margin.toFixed(1)}x margin to the 30 s Durable Object CPU limit.`);
} finally {
  await browser.close();
  stop();
}
