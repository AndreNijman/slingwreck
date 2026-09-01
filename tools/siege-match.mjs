#!/usr/bin/env node

// Drives solo Siege through a complete best-of-five in a real browser.
//
// Everything downstream of a round resolving — result panel, draft, standings, the match
// end — was written and unit-tested in tools/siege-test.mjs long before it was ever
// reached through the UI, and when it finally was, four separate defects were waiting
// there: the campaign result dialog opening over the siege panel, the result and draft
// sections having no CSS at all and laying out underneath the canvas, the build banner
// updating on an unreachable line, and the draft rendering card *ids* as if they were
// card records. A unit test cannot see any of those. This can.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNE } from '../data.js';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = performance.now();
const failures = [];
const runtimeIssues = [];
let assertion = 0;

// A small, legal, cheap fortress. Authored in the editor and exported; loading it by code
// keeps the test about the match flow rather than about placing blocks with a mouse.
const BLUEPRINT =
  'AwwDFQCEABUAhQAlgIUAJYCGABUAhwAVAIgAFABEARQARQEkgEUBJIBGARQARwEUAEgBQJoAAAdjAQDAmwAA';

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

function serve() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      // campaign-ui.js asks the shared games guard who is signed in. There is no guard in
      // front of a local file server, so answer the way a signed-out visitor is answered.
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
    } catch {
      response.writeHead(404).end();
    }
  });
}

function siegeState(page) {
  return page.evaluate(() => window.__SLINGWRECK_SMOKE__?.()?.siege ?? null);
}

// The pouch in page coordinates, derived from the live camera rather than measured off a
// screenshot: the camera zooms per shot, so a hard-coded pixel would aim somewhere else
// on every round.
function pouchPoint(page) {
  return page.evaluate(() => {
    const { camera, sling } = window.__SLINGWRECK_SMOKE__();
    return {
      x: camera.viewportX + camera.viewportW / 2 + (sling.x - camera.x) * camera.scale,
      y: camera.viewportY + camera.viewportH / 2 - (sling.y - camera.y) * camera.scale,
      scale: camera.scale
    };
  });
}

async function fireOnce(page, pouch) {
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  await page.mouse.move(pouch.x - pouch.scale * 1.55, pouch.y + pouch.scale * 0.45, { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}

const server = serve();
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;

const rounds = [];
let matchEnd = null;
let draftsSeen = 0;
let namedDrafts = 0;

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => runtimeIssues.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeIssues.push(`console: ${message.text()}`);
  });
  await page.goto(`${baseUrl}/?smoke-test`, { waitUntil: 'networkidle' });
  await page.locator('#siege-button').click();

  // Five wins can take at most nine rounds; the loop stops on the match ending.
  for (let round = 1; round <= 9; round++) {
    await page.waitForTimeout(800);
    const opening = await siegeState(page);
    if (!opening || opening.phase === 'matchover') break;

    report(`round ${round} opens in the build phase`, opening.phase === 'build',
      `phase ${opening.phase}`);

    await page.locator('#blueprint-input').fill(BLUEPRINT);
    await page.locator('#load-blueprint-button').click();
    await page.waitForTimeout(700);

    // The banner and the editor's own meter are two readouts of one number. They disagreed
    // for the whole of P7.6 because the banner sat on a line the editor's early return
    // never reached.
    const readouts = await page.evaluate(() => ({
      banner: document.querySelector('#siege-scrap')?.textContent?.trim(),
      meter: document.querySelector('#scrap-left')?.textContent?.trim()
    }));
    report(`round ${round} scrap banner matches the editor meter`,
      readouts.banner === `${readouts.meter} scrap`,
      `banner "${readouts.banner}" vs meter "${readouts.meter}"`);

    await page.locator('#siege-lock').click();
    await page.waitForTimeout(1500);

    const pouch = await pouchPoint(page);
    for (let shot = 0; shot < 14; shot++) {
      const state = await siegeState(page);
      if (state?.phase !== 'assault') break;
      if (state.player?.phase === 'aiming' && state.player.shot < state.player.bag) {
        await fireOnce(page, pouch);
      }
      await page.waitForTimeout(2200);
    }

    const resolved = await siegeState(page);
    report(`round ${round} resolves out of the assault`,
      resolved?.phase === 'roundover' || resolved?.phase === 'matchover',
      `phase ${resolved?.phase}`);
    if (resolved?.phase === 'assault') break;

    // The panel must be the thing on top. The campaign's own round-over dialog used to
    // open over it, and the siege panel itself used to render underneath the canvas.
    const panel = await page.evaluate(() => {
      const result = document.querySelector('#siege-result');
      const box = result.getBoundingClientRect();
      const top = document.elementFromPoint(
        Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
      return {
        shown: !result.hidden,
        covers: box.width >= window.innerWidth - 1 && box.height >= window.innerHeight - 1,
        topIsInsidePanel: Boolean(top && result.contains(top)),
        campaignDialogOpen: !document.querySelector('#round-over').hidden,
        title: document.querySelector('#siege-result-title')?.textContent ?? '',
        standings: document.querySelector('#siege-standings')?.textContent ?? ''
      };
    });
    report(`round ${round} shows the siege result panel and nothing over it`,
      panel.shown && panel.covers && panel.topIsInsidePanel && !panel.campaignDialogOpen,
      `shown ${panel.shown}; full-bleed ${panel.covers}; on top ${panel.topIsInsidePanel}; ` +
      `campaign dialog ${panel.campaignDialogOpen}`);
    rounds.push({ round, title: panel.title.trim(), standings: panel.standings.trim() });

    const finishedNow = await siegeState(page);
    if (finishedNow?.phase === 'matchover') {
      matchEnd = { title: panel.title.trim(), wins: finishedNow.wins };
      break;
    }

    await page.locator('#siege-continue').click();
    await page.waitForTimeout(900);

    const draft = await page.evaluate(() => ({
      shown: !document.querySelector('#siege-draft').hidden,
      names: [...document.querySelectorAll('.siege-card .card-name')].map((e) => e.textContent.trim())
    }));
    if (draft.shown) {
      draftsSeen++;
      if (draft.names.length === 3 && draft.names.every(Boolean)) namedDrafts++;
      report(`round ${round} draft offers three named cards`,
        draft.names.length === 3 && draft.names.every(Boolean), draft.names.join(' / ') || '(blank)');
      await page.locator('.siege-card').first().click();
      await page.waitForTimeout(800);
    }
  }

  // Drafting is not cosmetic: a card the loser picks has to end up on their sheet, or the
  // whole 25-card system is unreachable in solo play however well it unit-tests.
  const finalState = await siegeState(page);
  report('the match reaches a winner inside nine rounds', matchEnd !== null,
    matchEnd ? `${matchEnd.title} at ${matchEnd.wins?.join(' — ')}` : 'no match-over panel');
  report('every draft offered was drawn from real card records',
    draftsSeen === namedDrafts, `${namedDrafts}/${draftsSeen} drafts named`);
  report('picked cards are held for the rest of the match',
    draftsSeen === 0 || (finalState?.cards?.[0]?.length ?? 0) >= 1,
    `player holds ${finalState?.cards?.[0]?.length ?? 0} card(s) after ${draftsSeen} draft(s)`);
  report('a best of five needs at most nine rounds',
    rounds.length <= 9 && rounds.length >= TUNE.winsNeeded,
    `${rounds.length} round(s) played`);

  await page.screenshot({ path: resolve(root, 'shots/siege-match.png') });
} catch (error) {
  runtimeIssues.push(`siege match run aborted: ${error.stack ?? error}`);
} finally {
  await browser?.close().catch((error) => runtimeIssues.push(`browser close: ${error.message}`));
  await new Promise((done) => server.close(done));
}

console.log('');
for (const entry of rounds) console.log(`  round ${entry.round}: ${entry.title} — ${entry.standings}`);

report('browser runtime is clean', runtimeIssues.length === 0,
  `${runtimeIssues.length} console or page error(s)`);
for (const issue of runtimeIssues) console.log(`      ${issue}`);

const seconds = (performance.now() - startedAt) / 1000;
if (failures.length) {
  console.error(`\n${failures.length} siege match assertion(s) failed in ${seconds.toFixed(2)} s.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${assertion} siege match assertions passed in ${seconds.toFixed(2)} s.`);
}
