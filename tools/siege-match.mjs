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
//
// The match seed is pinned (see SIEGE_SEED below) rather than left on `Date.now()`. A
// second review of this file found that a random seed made every guarantee this test
// wants to make — that the draft is reached, that a card actually changes what the editor
// will let you place, that round 2's budget composes correctly — a matter of luck: the bot
// mostly loses (see BUILD_STATE.json), so a random match commonly sweeps 3-0 and never
// drafts a card at all. With the seed pinned, rounds 1 and 2 are deliberately played with
// no player shots fired (see `skipFiring` below) so the bot wins both outright, the player
// drafts twice, and which two cards are on offer is known in advance.
//
// A third review found the same defect one level up: `offerSiegeDraft`'s `loser !== 0`
// branch — the bot drafting for itself when it loses a round — was only ever exercised by
// a scratch script, never by this suite, because the scripted match never let the player
// win a round. Once the bot's fortress stopped ignoring most of its own budget (see
// game.js `buildBotFortress`), the player's naive fixed-angle test shot could no longer
// crack it in time, and the bot's own attack was always fast enough to pop the player's
// tiny fixed test fortress first — so every round went the bot's way and the "bot loses,
// bot drafts" path stayed permanently unreached. `PLAYER_WIN_ROUND` below is the fix:
// for that one round, the player defends with a fortress it builds for itself (the same
// declarative pipeline as the bot's own, sized to that round's real budget) and attacks
// with a real ballistic shot aimed at the bot's King with a high arc, clearing the bot's
// wall of ground-level pillars instead of driving straight into it. Every other round is
// untouched — same tiny fixed blueprint, same naive drag — so the bot keeps winning them,
// and the player's own held-card assertions (rounds 1-2) are unaffected.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIEGE_DIFFICULTIES, SIEGE_DIFFICULTY_DEFAULT, TUNE } from '../data.js?v=20260902-2';
import {
  decode, encode, fromBlueprint, place, settleTest, spent, toBlueprint, undo, validate, budgetFor
} from '../build.js?v=20260902-2';
import { aim, fortressForBudget } from '../bots.js?v=20260902-2';
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
const decodedBlueprint = decode(BLUEPRINT);
const blueprintPieceCount = decodedBlueprint.blocks.length + decodedBlueprint.pigs.length;

// Chosen by brute-forcing relay-audit.js's own `rollDraft` (a pure function of seed, round,
// deficit and player) offline until round 1's deficit-1 draft for the player contained Deep
// Pockets — the only `kind: 'budget'` card, and so the only one that can expose a budget
// composed twice — and round 2's deficit-2 draft contained Heavy Industry, an
// unlock-and-discount card, to prove a held card actually changes what the palette will let
// the player place. Both draws depend only on the seed, not on how the round is played.
const SIEGE_SEED = 1;
const ROUND1_TARGET_CARD = 'Deep Pockets';
const ROUND2_TARGET_CARD = 'Heavy Industry';
// The one round the player is scripted to win outright, to exercise `offerSiegeDraft`'s
// bot-drafts-for-itself branch (see the header comment). Chosen as round 3 because it is
// the first round the player could plausibly win at all (rounds 1-2 are the scripted
// losses that put Deep Pockets and Heavy Industry in the player's hand) and because the
// round's own existing checks (the Heavy Industry material-unlock probe below) only need
// one clear grid cell, which the reserved corner of the player's own fortress preserves.
const PLAYER_WIN_ROUND = 3;

function formatScrap(value) {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// Same shape as tools/smoke.mjs's `poll`: read the page every 50 ms until the condition
// holds or the timeout expires. Used throughout instead of a fixed sleep — the amount of
// real time a shot or a lock-in takes to resolve is not something this test should have to
// guess at, per docs/BUILD_PLAN.md's "a flaky gate is worse than no gate".
async function poll(read, accepts, timeout = 15000) {
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

async function fullState(page) {
  return page.evaluate(() => window.__SLINGWRECK_SMOKE__?.() ?? null);
}

// The editor camera in page coordinates, matching the conversion tools/smoke.mjs and
// tools/editor-shots.mjs already use — `getBoundingClientRect` picks up any CSS scaling of
// the canvas element rather than assuming device pixels equal CSS pixels.
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

// The pouch in page coordinates, derived from the live game camera rather than measured off
// a screenshot: the camera zooms per shot, so this has to be read fresh before every shot,
// not once per round — a stale point aims shots 2..N at wherever the pouch used to be.
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

async function waitForCameraSettled(page, timeout = 8000) {
  return poll(() => fullState(page), (state) => {
    const camera = state?.camera;
    const target = state?.cameraTarget;
    if (!camera || !target) return true;
    return Math.abs(camera.x - target.x) < 0.03 &&
      Math.abs(camera.y - target.y) < 0.03 &&
      Math.abs(camera.zoom - target.zoom) < 0.03;
  }, timeout);
}

async function fireOnce(page, pouch) {
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  await page.mouse.move(pouch.x - pouch.scale * 1.55, pouch.y + pouch.scale * 0.45, { steps: 10 });
  // Wait for the drag to actually register as an aim rather than a fixed hold time — a
  // release before the game has seen the move does nothing and the shot never fires.
  await poll(() => fullState(page), (state) => state?.aim?.active === true, 2000);
  await page.mouse.up();
}

// A legal, settled, fully-spent defensive fortress for the player to load on
// `PLAYER_WIN_ROUND`, built with the same declarative pipeline `bots.js`/`build.js` give
// the bot itself: seed a template, then fill every remaining scrap with `place`, gated by
// `validate` at every step. No card effects are needed here — the player never drafts for
// this blueprint, it is loaded once as a fixture — so this is deliberately a smaller,
// cards-free cousin of game.js's own `buildBotFortress`, not a copy of it. `reserveMaxX`
// keeps a strip of the plot's left edge empty regardless of budget, so the round 3 Heavy
// Industry check below (which needs one clear grid cell) keeps working without having to
// know where in a fully-spent fortress a gap happened to fall.
function buildToughFortress(baseBudget, templateIndex, reserveMaxX) {
  const initial = fortressForBudget(baseBudget, templateIndex);
  const draft = fromBlueprint(initial.blueprint, { budget: baseBudget });
  const groundSources = (shape) => {
    const sources = [];
    if (shape === 'pillar') {
      for (const y of [2, 6]) {
        for (let index = 0; index < TUNE.plotW * 2; index++) {
          const x = 0.25 + index * 0.5;
          if (x > reserveMaxX) sources.push({ shape, x, y });
        }
      }
    } else {
      for (let index = 0; index < TUNE.plotW; index++) {
        const x = 0.5 + index;
        if (x > reserveMaxX) sources.push({ shape, x, y: 0.5 });
      }
    }
    return sources;
  };
  const placeLegal = (material, shape = 'pillar') => {
    for (const source of groundSources(shape)) {
      if (!place(draft, { ...source, material }).ok) continue;
      if (validate(draft, { mode: 'siege' }).ok) return true;
      undo(draft);
    }
    return false;
  };
  for (let guard = 0; spent(draft) < draft.budget && guard < 500; guard++) {
    const added = ['stone', 'wood', 'glass'].some((material) => placeLegal(material, 'pillar')) ||
      placeLegal('glass', 'cube');
    if (!added) break;
  }
  const legality = validate(draft, { mode: 'siege' });
  if (!legality.ok) {
    throw new Error(`tough fortress rejected: ${legality.errors.map((e) => e.code).join(', ')}`);
  }
  const settled = settleTest(draft);
  if (!settled.ok) {
    throw new Error(`tough fortress failed settle: moved [${settled.movedPieces.join(',') || 'none'}], ` +
      `dead pigs [${settled.deadPigs.join(',') || 'none'}]`);
  }
  return { blueprint: toBlueprint(draft), spent: spent(draft) };
}

// `PLAYER_WIN_ROUND`'s shot: a real ballistic solve (the same `aim()` bots.js's own
// opponent uses) targeting the bot King's live position, with a high arc so the shot
// drops in from above rather than driving into the wall of ground-level pillars a
// fully-spent fortress puts up. Converted to a page-space mouse delta by inverting
// `updateAim` in game.js (`dx = (point.x - startX) / scale`, `dy = (startY - point.y) /
// scale`) the same way `pouch`'s own coordinates are already derived from the live camera
// — difficulty 1 makes the aim noise term exactly zero, so the dummy rng below is inert.
async function fireAtKing(page, pouch) {
  const state = await fullState(page);
  // Round 3's bot fortress holds no cards yet (it has not lost a round), so its blueprint
  // is the stock template's three pigs in their authored order — [runt, king, runt] for
  // both `bots.js` templates — making index 1 reliably the King. This assumption is
  // specific to `PLAYER_WIN_ROUND` being the bot's first loss; it would need revisiting if
  // that constant ever moved to a round where the bot could already hold a decoy-King or
  // Flak Hog card reordering its pig list.
  const king = state.pigs[1];
  const shot = aim({}, { x: king.x, y: king.y }, 1, () => 0, 'high');
  const x = pouch.x + shot.dx * pouch.scale;
  const y = pouch.y - shot.dy * pouch.scale;
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await poll(() => fullState(page), (s) => s?.aim?.active === true, 2000);
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
  await page.goto(`${baseUrl}/?smoke-test&siege-seed=${SIEGE_SEED}`, { waitUntil: 'networkidle' });

  // --- P8's difficulty selector: chosen on the title screen, persisted like campaign
  // progress (see campaign-ui.js's own localStorage pattern), and threaded through to the
  // bot's real aim accuracy and fortress budget fraction (data.js's SIEGE_DIFFICULTIES,
  // game.js's siegeDifficultyProfile/buildBotFortress/stepSiegeOpponent). ---
  const difficultyButton = (id) => page.locator(`.difficulty-choice[data-difficulty="${id}"]`);

  const defaultPressed = await page.evaluate((id) =>
    document.querySelector(`.difficulty-choice[data-difficulty="${id}"]`)?.getAttribute('aria-pressed'),
    SIEGE_DIFFICULTY_DEFAULT);
  report(`the difficulty picker defaults to ${SIEGE_DIFFICULTY_DEFAULT} with nothing stored`,
    defaultPressed === 'true', `aria-pressed="${defaultPressed}"`);

  await difficultyButton('straw').click();
  const strawState = await page.evaluate(() => ({
    pressed: [...document.querySelectorAll('.difficulty-choice')]
      .map((b) => [b.dataset.difficulty, b.getAttribute('aria-pressed')]),
    stored: localStorage.getItem('slingwreck.siege.difficulty.v1')
  }));
  report('picking Straw presses only the Straw button and persists it to localStorage',
    strawState.pressed.every(([id, pressed]) => pressed === String(id === 'straw')) &&
    strawState.stored === 'straw',
    `pressed [${strawState.pressed.map(([id, p]) => `${id}:${p}`).join(', ')}]; stored "${strawState.stored}"`);

  await page.reload({ waitUntil: 'networkidle' });
  const afterReload = await page.evaluate(() =>
    document.querySelector('.difficulty-choice[data-difficulty="straw"]')?.getAttribute('aria-pressed'));
  report('the choice survives a reload, the same way campaign progress does',
    afterReload === 'true', `aria-pressed="${afterReload}" after reload`);

  // Every tier actually reaching the bot: cycle through all three, lock in round 1's build
  // phase immediately (no player shots needed — the bot's own fortress is built the moment
  // the player locks in, before any assault happens), and read the numbers game.js exposes
  // straight from the profile stepSiegeOpponent/buildBotFortress themselves read from, not
  // a restatement of it.
  const spentByTier = {};
  for (const tierId of Object.keys(SIEGE_DIFFICULTIES)) {
    await difficultyButton(tierId).click();
    await page.locator('#siege-button').click();
    await poll(() => fullState(page), (state) => state?.siege?.phase === 'build');
    await page.locator('#blueprint-input').fill(BLUEPRINT);
    await page.locator('#load-blueprint-button').click();
    await poll(() => fullState(page), (state) => state?.editor?.pieceCount === blueprintPieceCount);
    await page.locator('#siege-lock').click();
    const locked = await poll(() => fullState(page), (state) => state?.siege?.phase !== 'build');
    const state = locked.value;
    report(`${tierId} tier is actually in effect once a match starts`,
      state?.siege?.difficulty === tierId &&
      state.siege.difficultyProfile.accuracy === SIEGE_DIFFICULTIES[tierId].accuracy &&
      state.siege.difficultyProfile.budgetFraction === SIEGE_DIFFICULTIES[tierId].budgetFraction,
      `difficulty "${state?.siege?.difficulty}"; profile ${JSON.stringify(state?.siege?.difficultyProfile)}; ` +
      `expected ${JSON.stringify(SIEGE_DIFFICULTIES[tierId])}`);
    spentByTier[tierId] = state?.siege?.botSpent;
    await page.locator('#siege-quit').click();
    await poll(() => fullState(page), (state) => !state?.siege);
  }
  const tierIds = Object.keys(SIEGE_DIFFICULTIES);
  report('a lower budgetFraction tier actually spends less scrap on its round-1 fortress, in tier order',
    tierIds.every((id, index) => index === 0 || spentByTier[tierIds[index - 1]] < spentByTier[id]),
    tierIds.map((id) => `${id}=${spentByTier[id]}`).join(', '));

  // The scripted match below is pinned to the bot's original, unreduced behaviour (accuracy
  // 0.82, full purse) so its scoreline and card draws stay exactly what they always were —
  // `bricks` is that behaviour byte for byte, see data.js's SIEGE_DIFFICULTIES comment.
  await difficultyButton('bricks').click();
  await page.locator('#siege-button').click();

  // Five wins can take at most nine rounds; the loop stops on the match ending.
  for (let round = 1; round <= 9; round++) {
    const opened = await poll(() => fullState(page),
      (state) => state?.siege && (state.siege.phase === 'build' || state.siege.phase === 'matchover'));
    const opening = opened.value?.siege ?? null;
    if (!opening || opening.phase === 'matchover') break;

    report(`round ${round} opens in the build phase`, opening.phase === 'build',
      `phase ${opening.phase}`);

    // `siegeBudget(0)` and the held cards are both live the instant the build phase opens
    // (`beginSiegeBuild` sets them before the editor ever renders), so they can be read
    // before deciding — and, on `PLAYER_WIN_ROUND`, before building — which blueprint to
    // load. `state` is re-read after loading, below, for anything the load itself changes.
    const cardsHeld = opened.value.siege.cards[0];
    const composedBudget = budgetFor({ budget: opened.value.siege.rulesBudget, cards: cardsHeld });
    const isWinRound = round === PLAYER_WIN_ROUND;
    let blueprintToLoad = BLUEPRINT;
    let expectedPieceCount = blueprintPieceCount;
    let blueprintCost = spent(fromBlueprint(decodedBlueprint, { cards: cardsHeld }));
    if (isWinRound) {
      // See the header comment and `buildToughFortress`: this is the one round the player
      // defends with a fortress sized to its own real budget instead of the cheap fixture,
      // so the bot's attack cannot pop it before the player's own aimed shot lands.
      //
      // `IRON_PROBE_RESERVE` scrap is deliberately left unspent: `PLAYER_WIN_ROUND` also
      // happens to be round 3, which already places one discounted iron block below to
      // prove Heavy Industry unlocked it (cost 6 for a cube) — a fortress that spent the
      // entire budget left `over-budget` as the only reason that placement could ever fail.
      const IRON_PROBE_RESERVE = 20;
      const tough = buildToughFortress(composedBudget - IRON_PROBE_RESERVE, 0, 4);
      blueprintToLoad = encode(tough.blueprint);
      expectedPieceCount = tough.blueprint.blocks.length + tough.blueprint.pigs.length;
      blueprintCost = tough.spent;
    }

    await page.locator('#blueprint-input').fill(blueprintToLoad);
    await page.locator('#load-blueprint-button').click();
    const loaded = await poll(() => fullState(page),
      (state) => state?.editor?.pieceCount === expectedPieceCount);
    report(`round ${round} loads the ${isWinRound ? "player's own defensive" : 'fixed'} blueprint`,
      loaded.ok, loaded.ok ? `${loaded.value.editor.pieceCount} pieces` : loaded.detail);

    // The banner and the editor's own meter are two DOM readouts of one number, and until
    // now they were checked against each other — which passes by construction, since both
    // are sourced from `editorDraft.budget` (game.js `updateSiegeBanner` and
    // `updateBudgetMeter`). That let the whole build phase run on a flat default budget
    // through P7.6/7.7/7.8 without either assertion ever failing. The independent value
    // here is `siegeBudget(0)` — game.js's own separately-computed round/deficit/banked
    // purse, exposed as `siege.rulesBudget` — composed with the held cards' bonus exactly
    // once via build.js's own `budgetFor`, then reduced by the loaded blueprint's cost
    // computed the same way. Neither side of this check reads `editorDraft.budget`.
    const state = await fullState(page);
    const expectedLeft = formatScrap(composedBudget - blueprintCost);
    // `updateSiegeBanner` only re-reads the meter on the next requestAnimationFrame tick,
    // so a read straight after `pieceCount` catches up can still see last frame's banner —
    // not the defect this test exists to catch, just the DOM not having painted yet. This
    // is purely a settle barrier: it waits for the two DOM nodes to agree with each other,
    // it does not judge them by each other. The judgment below is against `expectedLeft`,
    // computed above without reading either node.
    await poll(() => page.evaluate(() => ({
      banner: document.querySelector('#siege-scrap')?.textContent?.trim(),
      meter: document.querySelector('#scrap-left')?.textContent?.trim()
    })), (r) => r.banner === `${r.meter} scrap`, 3000);
    const readouts = await page.evaluate(() => ({
      banner: document.querySelector('#siege-scrap')?.textContent?.trim(),
      meter: document.querySelector('#scrap-left')?.textContent?.trim()
    }));
    report(`round ${round} scrap banner and editor meter match the independently-computed budget`,
      readouts.meter === expectedLeft && readouts.banner === `${expectedLeft} scrap`,
      `expected ${expectedLeft} scrap (siegeBudget(0) ${state.siege.rulesBudget} + card bonus = ` +
      `${composedBudget}, blueprint costs ${blueprintCost}); banner "${readouts.banner}"; ` +
      `meter "${readouts.meter}"; cards [${cardsHeld.join(', ') || 'none'}]`);

    // Item 1's specific ask: does `editorDraft.budget` — built once in `openEditor` from
    // `siegeBudget(0)` and the held cards — agree with `siegeBudget(0)` composed the same
    // way independently here? Round 1 has roundsBehind 0 and no cards, so several terms are
    // zero and would hide a mismatch; round 2 (deficit 1, Deep Pockets held) is the first
    // round where every term is live.
    if (round === 2) {
      report('round 2 editorDraft.budget equals siegeBudget(0) composed once with the held cards',
        state.editor.budget === composedBudget,
        `editorDraft.budget ${state.editor.budget}; siegeBudget(0) [rules.budget at ` +
        `lockSiegeFortress] ${state.siege.rulesBudget}; composed once with [${cardsHeld.join(', ')}] ` +
        `= ${composedBudget}`);
    }

    // Item 1's other ask: does a held card that unlocks or discounts a material actually
    // change what the palette will let the player place? Heavy Industry (drafted after
    // round 2) discounts iron from 12 to 6 and removes its per-round limit; iron is
    // draft-only, so without the card it is locked in the palette regardless of budget.
    if (round === 3) {
      const paletteLocked = await page.evaluate(() =>
        document.querySelector('.material-choice[data-material="iron"]')?.classList.contains('locked'));
      report('round 3 the palette shows iron unlocked with Heavy Industry held',
        paletteLocked === false,
        `iron .locked class present: ${paletteLocked}; cards [${cardsHeld.join(', ')}]`);
      await page.locator('.material-choice[data-material="iron"]').click();
      const beforePlace = await fullState(page);
      // Clear of both blueprints this round can load: the fixed fixture occupies x 8..16,
      // and `buildToughFortress`'s `reserveMaxX` keeps x <= 4 empty on `PLAYER_WIN_ROUND`.
      const spot = await editorPoint(page, 2, 2);
      await page.mouse.click(spot.x, spot.y);
      const placed = await poll(() => fullState(page),
        (s) => s?.editor?.pieceCount === beforePlace.editor.pieceCount + 1);
      report('round 3 an iron block is actually placeable with Heavy Industry held',
        placed.ok,
        placed.ok
          ? `pieces ${beforePlace.editor.pieceCount} -> ${placed.value.editor.pieceCount}; ` +
            `spent ${beforePlace.editor.spent} -> ${placed.value.editor.spent}`
          : placed.detail);
    }

    // DESIGN.md 6.2: Space locks in early. Covered on round 1 only — every other round
    // uses the button, which is the more common path and already covered below.
    if (round === 1) {
      // Focus has to leave #blueprint-input first: the editor's own keydown handler treats
      // Space as text input while focus is inside a form field, by design, so it never
      // reaches the lock-in branch until focus is back on the canvas.
      await page.locator('#game').focus();
      await page.keyboard.press('Space');
      const locked = await poll(() => fullState(page), (s) => s?.siege?.phase !== 'build');
      report('round 1 locks in via Space rather than the button', locked.ok,
        locked.ok ? `phase now ${locked.value.siege.phase}` : locked.detail);
    } else {
      await page.locator('#siege-lock').click();
      const locked = await poll(() => fullState(page), (s) => s?.siege?.phase !== 'build');
      report(`round ${round} locks in via the button`, locked.ok,
        locked.ok ? `phase now ${locked.value.siege.phase}` : locked.detail);
    }

    // Rounds 1 and 2 are deliberately not fired: the seed is pinned so the bot wins them
    // outright when the player does not shoot, which is what puts a card in the player's
    // hand — via a real round loss, not a shortcut around the draft screen — before round 2
    // (Deep Pockets, for the budget-composition check above) and before round 3 (Heavy
    // Industry, for the material-unlock check above). See the header comment.
    //
    // With zero player shots, `siegeRoundFinished`'s `done(playerRound)` never becomes true
    // on its own (shotIndex stays 0, below bag.length, forever) — these two rounds can only
    // end via `kingDown`, the bot popping the player's King. That is reliable against the
    // fixed BLUEPRINT at this seed, but it is a real dependency: if the bot ever stopped
    // finishing a King off, rounds 1-2 would spin to the iteration cap below and fail with a
    // timeout that would not obviously point back here.
    const skipFiring = round <= 2;
    let iterations = 0;
    for (;;) {
      iterations++;
      if (iterations > 60) {
        runtimeIssues.push(`round ${round}: assault did not resolve within 60 poll iterations`);
        break;
      }
      const before = await fullState(page);
      if (!before?.siege || before.siege.phase !== 'assault') break;
      const p = before.siege.player;
      if (!skipFiring && p?.phase === 'aiming' && p.shot < p.bag) {
        await waitForCameraSettled(page);
        const pouch = await pouchPoint(page);
        // `PLAYER_WIN_ROUND` fires a real aimed shot at the bot's King; every other round
        // keeps the original naive fixed-angle drag, unchanged.
        if (isWinRound) await fireAtKing(page, pouch); else await fireOnce(page, pouch);
        await poll(() => fullState(page), (s) =>
          s?.siege?.phase !== 'assault' || (s.siege.player && s.siege.player.shot > p.shot));
      } else {
        // Nothing for the player to do this instant — waiting on the bot's own cadence or
        // on physics settling. Wait for any observable change rather than a fixed sleep.
        await poll(() => fullState(page), (s) => {
          if (!s?.siege || s.siege.phase !== 'assault') return true;
          return s.siege.player?.phase !== p?.phase || s.siege.player?.shot !== p?.shot ||
            s.siege.bot?.phase !== before.siege.bot?.phase ||
            s.siege.bot?.shot !== before.siege.bot?.shot;
        }, 3000);
      }
    }

    const resolved = await fullState(page);
    report(`round ${round} resolves out of the assault`,
      resolved?.siege?.phase === 'roundover' || resolved?.siege?.phase === 'matchover',
      `phase ${resolved?.siege?.phase}`);
    if (resolved?.siege?.phase === 'assault') break;

    // The panel must be the thing on top. The campaign's own round-over dialog used to
    // open over it, and the siege panel itself used to render underneath the canvas.
    const shown = await poll(() => page.evaluate(() => !document.querySelector('#siege-result').hidden),
      (isShown) => isShown === true, 5000);
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
      shown.ok && panel.shown && panel.covers && panel.topIsInsidePanel && !panel.campaignDialogOpen,
      `shown ${panel.shown}; full-bleed ${panel.covers}; on top ${panel.topIsInsidePanel}; ` +
      `campaign dialog ${panel.campaignDialogOpen}`);
    rounds.push({ round, title: panel.title.trim(), standings: panel.standings.trim() });

    const finishedNow = await fullState(page);
    // The whole point of `PLAYER_WIN_ROUND`: verify the player actually won it (making the
    // bot the round's loser), not just that a shot was fired. `opening.wins` was read
    // before this round played; a win shows up as the player's own tally advancing.
    if (isWinRound) {
      report(`round ${round} is won by the player, making the bot the loser who drafts next`,
        finishedNow?.siege?.wins?.[0] > opening.wins[0],
        `wins ${opening.wins.join('-')} -> ${finishedNow?.siege?.wins?.join('-')}`);
    }
    if (finishedNow?.siege?.phase === 'matchover') {
      matchEnd = { title: panel.title.trim(), wins: finishedNow.siege.wins };
      break;
    }

    await page.locator('#siege-continue').click();
    const afterContinue = await poll(() => fullState(page),
      (s) => s?.siege?.phase === 'draft' || s?.siege?.phase === 'build');

    const draft = await page.evaluate(() => ({
      shown: !document.querySelector('#siege-draft').hidden,
      names: [...document.querySelectorAll('.siege-card .card-name')].map((e) => e.textContent.trim())
    }));
    if (draft.shown) {
      draftsSeen++;
      if (draft.names.length === 3 && draft.names.every(Boolean)) namedDrafts++;
      report(`round ${round} draft offers three named cards`,
        draft.names.length === 3 && draft.names.every(Boolean), draft.names.join(' / ') || '(blank)');
      const targetName = round === 1 ? ROUND1_TARGET_CARD : round === 2 ? ROUND2_TARGET_CARD : null;
      if (targetName) {
        const targetIndex = draft.names.indexOf(targetName);
        report(`round ${round} draft offers ${targetName}, pinned by the seed for the checks above`,
          targetIndex !== -1, `offered [${draft.names.join(', ')}]`);
      }
      const targetIndex = targetName ? draft.names.indexOf(targetName) : -1;
      await page.locator('.siege-card').nth(targetIndex >= 0 ? targetIndex : 0).click();
      await poll(() => fullState(page), (s) => s?.siege?.phase === 'build');
    } else {
      report(`round ${round} reaches the next build phase`,
        afterContinue.ok, afterContinue.ok ? `phase ${afterContinue.value.siege.phase}` : afterContinue.detail);
      // No draft screen shown means the bot was the round's loser and drafted for itself,
      // through `offerSiegeDraft`'s `loser !== 0` branch — this is the path a card the bot
      // drafts is otherwise never exercised through. Assert the growth of `siege.cards[1]`
      // itself, not merely that this branch ran, per the header comment.
      if (isWinRound) {
        const afterBotDraft = afterContinue.ok ? afterContinue.value : await fullState(page);
        report(`round ${round}'s loss sends the bot through its own invisible draft`,
          (afterBotDraft?.siege?.cards?.[1]?.length ?? 0) > 0,
          `bot cards: [${afterBotDraft?.siege?.cards?.[1]?.join(', ') || 'none'}]`);
      }
    }
  }

  // Drafting is not cosmetic: a card the loser picks has to end up on their sheet, or the
  // whole 25-card system is unreachable in solo play however well it unit-tests. Rounds 1
  // and 2 are scripted to guarantee two player losses (see above), so — unlike a random
  // match, which can sweep 3-0 and never draft at all — this floor is not optimistic.
  const finalState = await fullState(page);
  report('the match reaches a winner inside nine rounds', matchEnd !== null,
    matchEnd ? `${matchEnd.title} at ${matchEnd.wins?.join(' — ')}` : 'no match-over panel');
  report('at least two drafts were exercised during the match',
    draftsSeen >= 2, `${draftsSeen} draft(s) shown`);
  report('every draft offered was drawn from real card records',
    draftsSeen >= 1 && draftsSeen === namedDrafts, `${namedDrafts}/${draftsSeen} drafts named`);
  report('picked cards are held for the rest of the match',
    (finalState?.siege?.cards?.[0]?.length ?? 0) >= 2,
    `player holds ${finalState?.siege?.cards?.[0]?.length ?? 0} card(s) after ${draftsSeen} draft(s)`);
  // Both draft directions, held to the end of the match: the player's from losing rounds
  // 1-2, the bot's from losing `PLAYER_WIN_ROUND` — not just that the bot's own draft
  // branch ran once, but that the card it drew is still on its sheet at the final state.
  report('the bot also drafted for itself after losing a round, and still holds the card',
    (finalState?.siege?.cards?.[1]?.length ?? 0) >= 1,
    `bot holds ${finalState?.siege?.cards?.[1]?.length ?? 0} card(s): ` +
    `[${finalState?.siege?.cards?.[1]?.join(', ') || 'none'}]`);
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
