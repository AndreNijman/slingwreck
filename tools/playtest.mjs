#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AMMO, AMMO_BY_ID, MATERIALS, TUNE } from '../data.js?v=20260903-1';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = resolve(root, 'shots');
const viewport = { width: 1280, height: 720 };
const materialIds = Object.keys(MATERIALS);
const args = process.argv.slice(2);
const noShots = args.includes('--no-shots');
const all = args.includes('--all');
const sweep = args.includes('--sweep');
const ammoFlag = args.indexOf('--ammo');
const requestedId = ammoFlag >= 0 ? args[ammoFlag + 1] : null;
const allowedArgs = new Set(['--all', '--sweep', '--no-shots', '--ammo', requestedId]);
const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));

if (unknownArgs.length || all && ammoFlag >= 0 || !all && !sweep && ammoFlag < 0 ||
    ammoFlag >= 0 && (!requestedId || requestedId.startsWith('--'))) {
  console.error('usage: node tools/playtest.mjs (--all | --sweep | --ammo <id>) ' +
    '[--sweep] [--no-shots]');
  process.exit(2);
}
if (requestedId && !AMMO_BY_ID[requestedId]) {
  console.error(`unknown ammo '${requestedId}'; choose ${AMMO.map((ammo) => ammo.id).join(', ')}`);
  process.exit(2);
}

const selected = requestedId ? [AMMO_BY_ID[requestedId]] : AMMO;
const failures = [];
const runtimeIssues = [];
const rows = [];
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// The first bastion catches Boomer on its return. The main keep puts glass, sand and
// TNT on the flight line, with enough material behind them that one shot cannot hide
// at a low ceiling. Pebble's payload falls into the covered right bay.
const fortress = {
  v: 1,
  blocks: [
    ['cube', 'tnt', 0.5, 0.5, 0],
    ['cube', 'gel', 6.5, 0.5, 0],
    ['post', 'stone', 3, 1, 0],
    ['cube', 'tnt', 3, 2.5, 0],
    ['cube', 'spring', 8, 0.5, 0],
    ['slab', 'sand', 9.5, 0.5, 0],
    ['cube', 'wood', 9.5, 1.5, 0],
    ['cube', 'wood', 9.5, 2.5, 0],
    ['cube', 'wood', 9.5, 3.5, 0],
    ['cube', 'glass', 10.5, 0.5, 0],
    ['cube', 'glass', 11.5, 0.5, 0],
    ['cube', 'glass', 12.5, 0.5, 0],
    ['cube', 'glass', 13.5, 0.5, 0],
    ['slab', 'stone', 15.5, 0.5, 0],
    ['post', 'wood', 14.75, 2, 0],
    ['post', 'wood', 16.25, 2, 0],
    ['beam', 'wood', 15.5, 3.25, 0],
    ['post', 'glass', 14.75, 4.5, 0],
    ['post', 'stone', 16.25, 4.5, 0],
    ['plank', 'glass', 15.5, 5.75, 0],
    ['cube', 'stone', 17, 0.5, 0],
    ['cube', 'stone', 18, 0.5, 0],
    ['pillar', 'iron', 17, 3, 0],
    ['slab', 'stone', 19.5, 0.5, 0],
    ['post', 'gel', 18.75, 2, 0],
    ['post', 'wood', 20.25, 2, 0],
    ['beam', 'wood', 19.5, 3.25, 0],
    ['cube', 'stone', 21, 0.5, 0],
    ['cube', 'stone', 22, 0.5, 0],
    ['pillar', 'iron', 21, 3, 0],
    ['cube', 'wood', 23.5, 0.5, 0],
    ['cube', 'wood', 23.5, 1.5, 0],
    ['cube', 'wood', 23.5, 2.5, 0],
    ['cube', 'tnt', 23.5, 3.5, 0]
  ],
  pigs: [
    ['king', 5.1, 0.68],
    ['runt', 4, 0.3],
    ['helm', 1.8, 0.42],
    ['helm', 15.5, 3.92],
    ['swine', 19.5, 1.4]
  ]
};
const drawVector = { dx: -1.5, dy: -0.65 };
const harnessHtml = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
</head><body><canvas id="game" width="1280" height="720"></canvas></body></html>`;

function createStaticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/playtest.html') {
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html' });
        response.end(harnessHtml);
        return;
      }
      const relative = `.${decodeURIComponent(url.pathname)}`;
      const path = resolve(root, relative);
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

async function installHarness(page) {
  await page.evaluate(async ({ blueprint, draw, materials }) => {
    const [{ AMMO_BY_ID, TUNE }, sim, render] = await Promise.all([
      import('/data.js?v=20260903-1'),
      import('/sim.js?v=20260903-1'),
      import('/render.js?v=20260903-1')
    ]);
    const canvas = document.querySelector('#game');
    const renderer = render.makeRenderer(canvas);
    const camera = render.makeCamera();
    render.frameRect(camera, 0, 0, TUNE.plotW, 7, 0.35);
    const impactKinds = new Set(['hit', 'shatter', 'boom', 'pop', 'gel-absorb']);
    let trial = null;

    function findNonFinite(value, path = 'round', seen = new WeakSet()) {
      if (typeof value === 'number') return Number.isFinite(value) ? null : path;
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      if (value instanceof Map) {
        for (const [key, item] of value) {
          const found = findNonFinite(item, `${path}.map(${String(key)})`, seen);
          if (found) return found;
        }
        return null;
      }
      for (const key of Object.keys(value)) {
        const found = findNonFinite(value[key], `${path}.${key}`, seen);
        if (found) return found;
      }
      return null;
    }

    function trackWorld() {
      for (const body of trial.round.world.bodies) {
        if (body.tag?.startsWith('ammo:')) {
          trial.travel = Math.max(trial.travel, body.x - TUNE.slingX);
        }
      }
      for (const block of trial.round.blocks) {
        if (block.x < 0 || block.x > TUNE.plotW) trial.offPlot.add(block.blueprintIndex);
      }
    }

    function projectileContact() {
      return trial.round.world.contacts.some((contact) => {
        const roles = [contact.a.role, contact.b.role];
        return roles.some((role) => role === 'ammo' || role === 'payload') &&
          roles.some((role) => role === 'block' || role === 'pig' || role === 'balloon');
      });
    }

    function stepOnce() {
      const activeAmmo = trial.round.flying && AMMO_BY_ID[trial.round.flying.ammoId];
      const tappableNow = trial.round.flying && !trial.round.flying.dead && activeAmmo?.ability &&
        (trial.round.phase === 'flying' ||
          trial.round.phase === 'settling' && activeAmmo.params.tappableAtRest);
      if (tappableNow) {
        trial.tapWindowEnd = trial.round.stepCount - trial.launchStep;
      }
      if (trial.tapAt !== null && trial.round.stepCount === trial.launchStep + trial.tapAt) {
        trial.tapPhase = trial.round.phase;
        trial.tapAccepted = sim.tap(trial.round);
      }
      render.capturePose(renderer, trial.round);
      const events = sim.stepRound(trial.round, TUNE.step);
      render.pushEvents(renderer, events);
      trackWorld();
      const bad = findNonFinite(trial.round);
      if (bad) throw new Error(`non-finite number at ${bad}`);
      if (!trial.impact && (events.some((event) => impactKinds.has(event.kind)) ||
          projectileContact())) {
        trial.impact = trial.round.stepCount;
        trial.captureAt = trial.impact + 12;
      }
      if (events.some((event) => event.kind === 'settled')) trial.settled = true;
    }

    function drawNow() {
      render.draw(renderer, trial.round, camera, 1, { active: false, dx: 0, dy: 0 });
    }

    function begin(ammoId, tapAt) {
      const round = sim.makeRound({
        mode: 'campaign', seed: 0x51a9, bag: [ammoId], blueprint
      });
      // Siege blueprints are settled before play; launching into creation jitter would
      // make the fixture, rather than the critter, the changing variable.
      const preflightSteps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
      for (let index = 0; index < preflightSteps; index++) sim.stepRound(round, TUNE.step);
      const preflightDamage = [...round.blocks, ...round.pigs].filter((body) =>
        body.dead || body.hp < body.maxHp);
      if (preflightDamage.length) {
        throw new Error(`standard fortress took damage during pre-settle: ` +
          `${preflightDamage.map((body) => body.tag).join(', ')}`);
      }
      trial = {
        round,
        launchStep: round.stepCount,
        tapAt,
        tapAccepted: false,
        tapPhase: null,
        tapWindowEnd: null,
        impact: 0,
        captureAt: Infinity,
        settled: false,
        travel: 0,
        offPlot: new Set()
      };
      const body = sim.launch(round, draw.dx, draw.dy);
      if (!body) throw new Error('launch was rejected');
      trackWorld();
      const bad = findNonFinite(round);
      if (bad) throw new Error(`non-finite number at ${bad}`);
    }

    function runUntilCapture() {
      const limit = trial.launchStep + Math.ceil(TUNE.settleTimeout / TUNE.step) + 10;
      while (trial.round.stepCount < limit && !sim.isRoundOver(trial.round) &&
          trial.round.stepCount < trial.captureAt) stepOnce();
      drawNow();
      return { impact: trial.impact, step: trial.round.stepCount };
    }

    function finish() {
      const limit = trial.launchStep + Math.ceil(TUNE.settleTimeout / TUNE.step) + 10;
      while (trial.round.stepCount < limit && !sim.isRoundOver(trial.round)) stepOnce();
      const damage = Object.fromEntries(materials.map((id) => [id, 0]));
      const capacity = Object.fromEntries(materials.map((id) => [id, 0]));
      for (const block of trial.round.blocks) {
        capacity[block.materialId] += block.maxHp;
        damage[block.materialId] += Math.min(block.maxHp,
          Math.max(0, block.maxHp - block.hp));
      }
      return {
        damage,
        capacity,
        pigsKilled: trial.round.pigs.filter((pig) => pig.dead).length,
        blocksDestroyed: trial.round.blocks.filter((block) => block.dead).length,
        offPlot: trial.offPlot.size,
        score: trial.round.score,
        settle: trial.round.settleTimer,
        travel: trial.travel,
        timedOut: trial.round.settleTimer >= TUNE.settleTimeout,
        settled: trial.settled,
        tapAccepted: trial.tapAccepted,
        tapPhase: trial.tapPhase,
        tapWindowEnd: trial.tapWindowEnd,
        impact: trial.impact ? trial.impact - trial.launchStep : 0,
        phase: trial.round.phase,
        moving: trial.round.world.bodies.filter((body) =>
          !body.isStatic && !body.dead && !body.isAsleep).map((body) =>
          `${body.tag ?? body.role}@${body.x.toFixed(1)},${body.y.toFixed(1)}`)
      };
    }

    window.__SLINGWRECK_PLAYTEST__ = { begin, runUntilCapture, finish };
  }, { blueprint: fortress, draw: drawVector, materials: materialIds });
}

async function runShot(page, ammo, tapStep, screenshot) {
  await page.evaluate(({ ammoId, tapAt }) => {
    window.__SLINGWRECK_PLAYTEST__.begin(ammoId, tapAt);
  }, { ammoId: ammo.id, tapAt: tapStep });
  if (screenshot) {
    const capture = await page.evaluate(() =>
      window.__SLINGWRECK_PLAYTEST__.runUntilCapture());
    if (!capture.impact) failures.push(`${ammo.id}: no fortress impact was visible`);
    await page.locator('#game').screenshot({ path: resolve(shotsDir, `p3-${ammo.id}.png`) });
  }
  const result = await page.evaluate(() => window.__SLINGWRECK_PLAYTEST__.finish());
  return { ammo: ammo.id, tapStep, ...result };
}

function tapStepsFor(ammo, baseline) {
  const first = 6;
  const last = ammo.params.tappableAtRest ? baseline.tapWindowEnd : baseline.impact - 1;
  if (!Number.isInteger(last)) return [];
  if (last < first) return [];
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function damageTotal(row) {
  return materialIds.reduce((total, id) => total + row.damage[id], 0);
}

function bestByScore(candidates) {
  return candidates.reduce((best, row) => row.score > best.score ||
    row.score === best.score && damageTotal(row) > damageTotal(best) ? row : best);
}

function damageCell(damage, capacity) {
  const percent = capacity > 0 ? damage / capacity * 100 : 0;
  return `${damage.toFixed(1)} / ${capacity.toFixed(1)} (${percent.toFixed(0)}%)`;
}

function stepRanges(steps) {
  if (!steps.length) return 'none';
  const ranges = [];
  let first = steps[0];
  let last = first;
  for (const step of steps.slice(1)) {
    if (step === last + 1) {
      last = step;
      continue;
    }
    ranges.push(first === last ? `${first}` : `${first}–${last}`);
    first = step;
    last = step;
  }
  ranges.push(first === last ? `${first}` : `${first}–${last}`);
  return ranges.join(', ');
}

function markedWinningSteps(winners, impactStep) {
  const preImpact = winners.filter((row) => row.tapStep < impactStep)
    .map((row) => row.tapStep);
  const postImpact = winners.filter((row) => row.tapStep >= impactStep)
    .map((row) => row.tapStep);
  const groups = [];
  if (preImpact.length) groups.push(`${stepRanges(preImpact)} pre-impact`);
  if (postImpact.length) groups.push(`${stepRanges(postImpact)} post-impact`);
  return groups.join('; ') || 'none';
}

function winningTimingRow(ammo, baseline, best, candidates, winners) {
  if (!ammo.ability) {
    return {
      Ammo: ammo.id,
      'Tap window': 'none',
      Impact: baseline.impact,
      'Best tap': '—',
      'Pre-impact wins': '—',
      'All wins': '—',
      'Winning timings': '—',
      'Rest-window wins': '—'
    };
  }
  const preImpactCandidates = candidates.filter((row) => row.tapStep < baseline.impact);
  const preImpactWinners = winners.filter((row) => row.tapStep < baseline.impact);
  const restCandidates = candidates.filter((row) => row.tapPhase === 'settling');
  const restWinners = winners.filter((row) => row.tapPhase === 'settling');
  const bestPosition = best.tapStep < baseline.impact ? 'pre-impact' : 'post-impact';
  const windowKind = ammo.params.tappableAtRest ? 'flight + settling' : 'pre-impact only';
  return {
    Ammo: ammo.id,
    'Tap window': `6–${candidates.at(-1).tapStep} ${windowKind}`,
    Impact: baseline.impact,
    'Best tap': `${best.tapStep} ${bestPosition} (${best.tapPhase})`,
    'Pre-impact wins': `${preImpactWinners.length}/${preImpactCandidates.length}`,
    'All wins': `${winners.length}/${candidates.length}`,
    'Winning timings': markedWinningSteps(winners, baseline.impact),
    'Rest-window wins': restWinners.length ?
      `${restWinners.length}/${restCandidates.length}: ` +
        stepRanges(restWinners.map((row) => row.tapStep)) : `0/${restCandidates.length}`
  };
}

function tableRow(row) {
  const result = { Ammo: row.ammo, 'Tap step': row.tapStep ?? 'baseline' };
  for (const id of materialIds) {
    result[id] = damageCell(row.damage[id], row.capacity[id]);
  }
  return {
    ...result,
    Pigs: row.pigsKilled,
    Destroyed: row.blocksDestroyed,
    'Off plot': row.offPlot,
    Score: Math.round(row.score),
    'Δ score': row.tapStep === null ? '—' : Math.round(row.score - row.baselineScore),
    'Winning taps': row.sweepCount ? `${row.winningTaps}/${row.sweepCount}` : '—',
    'Settle s': row.settle.toFixed(2),
    Travel: row.travel.toFixed(2)
  };
}

function checkShot(row, requireSettled = true) {
  const label = row.tapStep === null ? 'untapped' : `tap step ${row.tapStep}`;
  if (requireSettled && (row.timedOut || !row.settled)) {
    failures.push(`${row.ammo} ${label} did not settle within TUNE.settleTimeout ` +
      `(${TUNE.settleTimeout}s); moving: ${row.moving.join(', ') || 'unknown'}`);
  }
  if (row.tapStep !== null && !row.tapAccepted) {
    failures.push(`${row.ammo}: tap at step ${row.tapStep} was not accepted`);
  }
}

const server = createStaticServer();
let browser;
try {
  await mkdir(shotsDir, { recursive: true });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeIssues.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeIssues.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => {
    runtimeIssues.push(`request: ${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  });
  const port = server.address().port;
  await page.goto(`http://127.0.0.1:${port}/playtest.html`, { waitUntil: 'networkidle' });
  await installHarness(page);

  const summaryRows = [];
  const timingRows = [];
  const verdicts = [];
  for (const ammo of selected) {
    try {
      const baseline = await runShot(page, ammo, null, false);
      rows.push(baseline);
      summaryRows.push(baseline);
      checkShot(baseline);
      if (!baseline.impact) failures.push(`${ammo.id}: untapped shot never reached the fixture`);

      let screenshotTap = null;
      if (ammo.ability) {
        const tapSteps = tapStepsFor(ammo, baseline);
        if (!tapSteps.length) throw new Error('tap window ended before a sweep was possible');
        const candidates = [];
        for (const tapStep of tapSteps) {
          const row = await runShot(page, ammo, tapStep, false);
          row.baselineScore = baseline.score;
          rows.push(row);
          candidates.push(row);
          checkShot(row, false);
        }
        // A bad exploratory timing remains in --sweep, but cannot become the reported
        // ceiling unless the shot actually resolves. Baselines and chosen bests retain
        // the original hard settle-timeout failure.
        const valid = candidates.filter((row) => !row.timedOut && row.settled);
        const best = bestByScore(valid.length ? valid : candidates);
        const winners = valid.filter((row) => row.score > baseline.score);
        const winningTaps = winners.length;
        for (const row of candidates) {
          row.winningTaps = winningTaps;
          row.sweepCount = candidates.length;
        }
        checkShot(best);
        summaryRows.push(best);
        timingRows.push(winningTimingRow(ammo, baseline, best, candidates, winners));
        screenshotTap = best.tapStep;
        const restCandidates = candidates.filter((row) => row.tapPhase === 'settling');
        const restWinners = winners.filter((row) => row.tapPhase === 'settling');
        const comparison = `best tap step ${best.tapStep} scored ${Math.round(best.score)} ` +
          `vs ${Math.round(baseline.score)} untapped; ${winningTaps}/${candidates.length} ` +
          `tap steps won (${markedWinningSteps(winners, baseline.impact)}; ` +
          `${restWinners.length}/${restCandidates.length} settling steps won)`;
        verdicts.push(`${winningTaps ? 'WORKING' : 'BROKEN '} ${ammo.id}: ${comparison}`);
        if (!winningTaps) {
          failures.push(`${ammo.id}: no tap step beat untapped score ` +
            `${Math.round(baseline.score)}; ${comparison}; flag for tools/balance.mjs`);
        }
      } else {
        timingRows.push(winningTimingRow(ammo, baseline, null, [], []));
        verdicts.push(`BASELINE ${ammo.id}: untapped score ${Math.round(baseline.score)}`);
      }
      if (!noShots) await runShot(page, ammo, screenshotTap, true);
    } catch (error) {
      failures.push(`${ammo.id} threw: ${error.message}`);
    }
  }

  console.table((sweep ? rows : summaryRows).map(tableRow));
  console.log('\nWinning-timing coverage (post-impact timings are marked explicitly):');
  console.table(timingRows);
  for (const verdict of verdicts) console.log(verdict);
  failures.push(...runtimeIssues);
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL  ${failure}`);
    process.exitCode = 1;
  } else {
    const screenshotNote = noShots ? 'screenshots skipped' : `${selected.length} screenshot(s)`;
    console.log(`PASS  ${rows.length} measured shot(s), ${screenshotNote}; no runtime errors`);
  }
} finally {
  await browser?.close();
  if (server.listening) await new Promise((done) => server.close(done));
}
