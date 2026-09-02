#!/usr/bin/env node

// P8 accessibility gate. Modelled on tools/smoke.mjs and tools/online-smoke.mjs: a static
// server, a real Chromium page, report()/poll() helpers, and a hard failure on any console
// error, page error or failed request. What is different here is the *kind* of assertion —
// every one of these is about the shell around the canvas (DOM, ARIA, CSS), not the sim —
// and BUILD_PLAN.md's rule 6 applies twice as hard: every assertion below prints the
// measured number (a ratio, a count, a pixel width), never a bare verdict.
//
// Two things this harness does deliberately to stay deterministic across runs (BUILD_PLAN.md
// rule 4 — same numbers, three times):
//   - `/lobbies` is served locally as an empty list. Pointing the page at the real relay
//     fallback would make the online lobby's background poll a real network call, which is
//     either a `requestfailed` (killing the "clean runtime" gate) or a timing-dependent
//     response neither run would agree on.
//   - The Siege draft and result panels are reached by unhiding them directly and, for the
//     draft, injecting one representative card. That is not a match — tools/siege-match.mjs
//     and tools/online-smoke.mjs already drive a real one — it is the only way to reach this
//     markup on a fixed, repeatable timeline instead of racing a bot or a relay.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = performance.now();
const failures = [];
const runtimeIssues = [];
let assertion = 0;

const mime = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.mjs': 'text/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml'
};

// Mutable on purpose: an empty list is the common case (and what the portrait run's "empty
// room list" overflow check needs), but .online-lobby-row is only ever rendered when a room
// actually exists, so a fixed, two-room state is needed at least once to measure it — see
// where this is set and reset back to [] in desktopA11yRun.
let stubLobbies = [];

function report(expectation, passed, measurement) {
  assertion++;
  const line = `${passed ? 'PASS' : 'FAIL'}  ${String(assertion).padStart(2, '0')}. ` +
    `${expectation}: ${measurement}`;
  console.log(line);
  if (!passed) failures.push(line);
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function poll(read, accepts, timeout = 8000) {
  const deadline = performance.now() + timeout;
  let value; let error;
  while (performance.now() < deadline) {
    try { value = await read(); error = undefined; if (accepts(value)) return { ok: true, value }; }
    catch (caught) { error = caught; }
    await delay(40);
  }
  return { ok: false, value, detail: error ? `last read failed: ${error.message}` : `timed out after ${timeout} ms` };
}

function createStaticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/lobbies') {
        response.setHeader('cache-control', 'no-store');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ lobbies: stubLobbies }));
        return;
      }
      if (url.pathname === '/_guard/profile') {
        response.setHeader('cache-control', 'no-store');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ profile: null }));
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
      response.end(body);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    }
  });
}

function attachFailureCollectors(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeIssues.push(`${label} console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeIssues.push(`${label} page: ${error.message}`));
  page.on('requestfailed', (request) => {
    runtimeIssues.push(`${label} request: ${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) runtimeIssues.push(`${label} request: ${response.url()} (HTTP ${response.status()})`);
  });
}

// ?relay= (see net.js's relayBase()) is what keeps the online lobby's background poll
// deterministic: pointed at this same static server's stubbed /lobbies instead of the real
// relay fallback, so it always answers instantly with an empty list rather than racing a
// real network call this gate does not control.
function smokeUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('smoke-test', '1');
  url.searchParams.set('relay', baseUrl);
  return url.href;
}

async function waitForReady(page) {
  return poll(
    () => page.evaluate(() => ({
      ready: document.documentElement.dataset.gameReady,
      hook: typeof window.__SLINGWRECK_SMOKE__
    })),
    (state) => state?.ready === 'true' && state.hook === 'function',
    5000
  );
}

async function loadReady(page, baseUrl) {
  await page.addInitScript((ids) => {
    localStorage.setItem('slingwreck.critters.seen.v1', JSON.stringify(ids));
  }, ['nib', 'chip', 'wedge', 'lob', 'pebble', 'boomer', 'hulk', 'spike', 'zip']);
  await page.goto(smokeUrl(baseUrl), { waitUntil: 'domcontentloaded', timeout: 15000 });
  return waitForReady(page);
}

// ------------------------------------------------------------------- keyboard reachability

// Independently derived, not hand-counted: "reachable" means a real focusable element that is
// actually visible on screen right now, computed straight from the DOM/CSSOM rather than a
// number typed in ahead of time (BUILD_PLAN.md rule 1 — a count chosen by eyeballing the page
// once is exactly the kind of threshold that rots). The Tab walk below is then checked
// against this same computation, which is what turns "N controls" into "the right N controls,
// in the right order" instead of a coincidence.
//
// Bare `canvas` is deliberately excluded: an HTML canvas with no `tabindex` attribute is not
// in the default tab order (unlike a button or input), so the decorative star/lock icon
// canvases in campaign-ui.js were never really reachable — only `[tabindex]` matters, which
// still catches #game while game.js has it at tabIndex 0 during the editor.
const FOCUSABLE_SELECTOR = 'a[href], button, input, textarea, select, [tabindex]';

// Evaluated in-page by both the "expected" computation and the live walk, so the two can
// never disagree about what counts as focusable or how an element is identified.
const IDENTIFY_AND_LIST = `
  (function (selector) {
    function identify(el, index) {
      if (el.id) return '#' + el.id;
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().replace(/\\s+/g, '.') : '';
      return el.tagName.toLowerCase() + cls + '[' + index + ']';
    }
    const list = [...document.querySelectorAll(selector)].filter((el) => {
      if (el.hidden || el.closest('[hidden]')) return false;
      if (el.disabled) return false;
      const tabindex = el.getAttribute('tabindex');
      if (tabindex !== null && Number(tabindex) < 0) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    });
    return { list, identify };
  })
`;

async function focusableSnapshot(page) {
  return page.evaluate(`(function () {
    const built = (${IDENTIFY_AND_LIST})(${JSON.stringify(FOCUSABLE_SELECTOR)});
    return built.list.map((el, i) => built.identify(el, i));
  })()`);
}

// Where Tab currently would land, identified the same way as focusableSnapshot() — by finding
// document.activeElement's own position in the identical filtered list, not by re-describing
// it in isolation. Two "button.episode-choice" siblings are indistinguishable by class alone;
// their position in the shared list is what makes the comparison in assertTabOrder exact.
async function activeElementIndex(page) {
  return page.evaluate(`(function () {
    const built = (${IDENTIFY_AND_LIST})(${JSON.stringify(FOCUSABLE_SELECTOR)});
    const index = built.list.indexOf(document.activeElement);
    return index === -1 ? null : built.identify(document.activeElement, index);
  })()`);
}

// Several screens deliberately move focus somewhere sensible on open — the episode/level back
// button, the editor back button, the online lobby's name field (campaign-ui.js, game.js,
// siege-online.js) — which is a real accessibility feature worth its own assertion, separate
// from whether the *rest* of the tab order is complete and correct.
async function assertInitialFocus(page, label, expectedId) {
  const activeId = await page.evaluate(() => {
    const el = document.activeElement;
    return el && el.id ? `#${el.id}` : null;
  });
  report(`${label}: opening the screen moves focus to a sensible control`,
    activeId === expectedId, `active element ${activeId ?? '(none)'} (expected ${expectedId})`);
}

// Deliberately re-focuses the first reachable control before walking, rather than trusting
// whatever real UX focus (or a prior test) left active. That sidesteps a genuine Chromium
// quirk that has nothing to do with this app: pressing Tab past the *last* focusable element
// on an untrapped page does not cycle back to the first one — it leaves the reachable set for
// one press (observed directly: walking off the end of the episode/level grids), and the
// *next* press after that re-enters at the document's absolute first focusable element, not
// wherever the walk started. A screen with no reason to trap Tab (episode/level select is a
// full page, not a dialog over one) shouldn't be graded on that browser boundary behaviour.
// Screens that *are* dialog-like overlays (siege-draft/result, the online lobby) get their
// wrap checked directly by assertTrapWraps, against the real trap in siege-online.js.
//
// `skip` drops leading entries from the walk (used once, for the editor: see the dedicated
// canvas-Tab assertion below for why #game cannot be walked through generically).
async function assertTabOrder(page, label, skip = 0) {
  const full = await focusableSnapshot(page);
  const expected = full.slice(skip);
  if (!expected.length) {
    report(`${label}: Tab visits every reachable control once, in DOM order`, false, 'no reachable controls found');
    return 0;
  }
  await page.evaluate(`(function () {
    (${IDENTIFY_AND_LIST})(${JSON.stringify(FOCUSABLE_SELECTOR)}).list[${skip}]?.focus();
  })()`);
  const walked = [expected[0]];
  for (let i = 1; i < expected.length; i++) {
    await page.keyboard.press('Tab');
    walked.push((await activeElementIndex(page)) ?? '(outside the reachable set)');
  }
  const matches = walked.length === expected.length && walked.every((id, index) => id === expected[index]);
  report(`${label}: Tab visits every reachable control once, in DOM order`, matches,
    `${expected.length} controls [${expected.join(', ')}] — walked [${walked.join(', ')}]`);
  return full.length;
}

// Confirms the shared Tab-trap in siege-online.js (one listener keyed off whichever of
// #online-lobby/#siege-draft/#siege-result is visible — see that file's "keyboard (a11y)"
// section) actually catches the boundary it exists for: Tab from the panel's last control
// lands back on its first, rather than escaping to whatever the browser would do by default.
// `reverse` checks the other half of the trap — Shift+Tab from the first control landing on
// the last — which is the branch of siege-online.js's handler (`if (event.shiftKey && ...)`)
// the forward-only calls below never exercise.
async function assertTrapWraps(page, label, panelSelector, reverse = false) {
  const focusableExpr = `[...document.querySelectorAll(${JSON.stringify(`${panelSelector} button, ${panelSelector} input, ${panelSelector} textarea`)})]` +
    '.filter((el) => !el.disabled && el.getClientRects().length > 0)';
  const startIndex = reverse ? '0' : 'focusable.length - 1';
  const endIndex = reverse ? 'focusable.length - 1' : '0';
  const count = await page.evaluate(`(function () {
    const focusable = ${focusableExpr};
    focusable[${startIndex}]?.focus();
    return focusable.length;
  })()`);
  await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
  const wrapped = await page.evaluate(`(function () {
    const focusable = ${focusableExpr};
    return document.activeElement === focusable[${endIndex}];
  })()`);
  report(label, count > 1 && wrapped,
    `${count} focusable control(s) in the panel; wrapped to ${reverse ? 'last' : 'first'}: ${wrapped}`);
}

// --------------------------------------------------------------------------- contrast (WCAG)

function relLuminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function parseColor(css) {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((x) => parseFloat(x));
  if (parts.length === 4 && parts[3] === 0) return null; // fully transparent
  return parts.slice(0, 3);
}

function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Resolves the *rendered* colour pair for a selector: its own text colour, and the first
// non-transparent background walking up from either a given background selector or the
// element itself. Measuring getComputedStyle's resolved rgb() is the point — a hex value read
// out of style.css by hand cannot account for opacity, inheritance, or a stale assumption
// about which fallback actually won a `var(--x, fallback)`.
async function textContrast(page, selector, { bgSelector } = {}) {
  return page.evaluate(({ selector, bgSelector }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const style = getComputedStyle(el);
    let node = bgSelector ? document.querySelector(bgSelector) : el;
    let bg = getComputedStyle(node).backgroundColor;
    while ((!bg || bg === 'rgba(0, 0, 0, 0)') && node.parentElement) {
      node = node.parentElement;
      bg = getComputedStyle(node).backgroundColor;
    }
    return { fg: style.color, bg, fontSizePx: parseFloat(style.fontSize), fontWeight: Number(style.fontWeight) };
  }, { selector, bgSelector });
}

async function borderContrast(page, selector, { against } = {}) {
  return page.evaluate(({ selector, against }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const style = getComputedStyle(el);
    const results = {};
    for (const bgSelector of against) {
      let node = document.querySelector(bgSelector);
      let bg = node ? getComputedStyle(node).backgroundColor : null;
      while (node && (!bg || bg === 'rgba(0, 0, 0, 0)') && node.parentElement) {
        node = node.parentElement;
        bg = getComputedStyle(node).backgroundColor;
      }
      results[bgSelector] = bg;
    }
    return { border: style.borderTopColor, backgrounds: results };
  }, { selector, against });
}

function isLargeText(fontSizePx, fontWeight) {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

async function assertTextContrast(page, label, selector, opts = {}) {
  const measured = await textContrast(page, selector, opts);
  if (!measured) { report(label, false, `selector ${selector} not found`); return; }
  const fg = parseColor(measured.fg);
  const bg = parseColor(measured.bg);
  const ratio = fg && bg ? contrastRatio(fg, bg) : 0;
  const large = isLargeText(measured.fontSizePx, measured.fontWeight);
  const threshold = large ? 3.0 : 4.5;
  report(label, ratio >= threshold,
    `${ratio.toFixed(2)}:1 >= ${threshold}:1 (${measured.fontSizePx.toFixed(1)}px/${measured.fontWeight}, ` +
    `${large ? 'large' : 'normal'} text) — fg ${measured.fg} on bg ${measured.bg}`);
}

async function assertBorderContrast(page, label, selector, against) {
  const measured = await borderContrast(page, selector, { against });
  if (!measured) { report(label, false, `selector ${selector} not found`); return; }
  const border = parseColor(measured.border);
  const ratios = against.map((sel) => {
    const bg = parseColor(measured.backgrounds[sel]);
    return border && bg ? contrastRatio(border, bg) : 0;
  });
  const worst = Math.min(...ratios);
  report(label, worst >= 3.0,
    `${worst.toFixed(2)}:1 >= 3.0:1 (UI component, WCAG 1.4.11) — border ${measured.border} against ` +
    against.map((sel, i) => `${sel} ${measured.backgrounds[sel]} (${ratios[i].toFixed(2)}:1)`).join(', '));
}

// ------------------------------------------------------------------------------- overflow

async function horizontalOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: innerWidth,
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth)
  }));
}

async function assertNoOverflow(page, label) {
  const measured = await horizontalOverflow(page);
  report(`${label}: no horizontal overflow at 390x844`, measured.overflow === 0,
    `scrollWidth ${measured.scrollWidth} vs innerWidth ${measured.innerWidth} (${measured.overflow}px over)`);
}

// ---------------------------------------------------------------------------- aria-live

async function assertLiveRegion(page, label, selector, expectedLive) {
  const attrs = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? { live: el.getAttribute('aria-live'), role: el.getAttribute('role') } : null;
  }, selector);
  report(label, attrs?.live === expectedLive,
    attrs ? `aria-live="${attrs.live}" role="${attrs.role}"` : `selector ${selector} not found`);
}

async function assertDialogRole(page, label, selector) {
  const attrs = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal') } : null;
  }, selector);
  report(label, attrs?.role === 'dialog' && attrs?.modal === 'true',
    attrs ? `role="${attrs.role}" aria-modal="${attrs.modal}"` : `selector ${selector} not found`);
}

// --------------------------------------------------------------------------------- runs

async function desktopA11yRun(baseUrl, browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  attachFailureCollectors(page, 'desktop a11y');

  try {
    const loaded = await loadReady(page, baseUrl);
    report('page loads with the smoke hook available', loaded.ok,
      loaded.ok ? 'ready' : loaded.detail);

    // siege-online.js sets this once, at createOnlineSiege() init time, specifically so
    // #siege-result-title can take programmatic focus the way #round-title (game.js) already
    // does. Only half of that is checkable here — the actual .focus() call inside
    // onRoundOver/onMatchOver fires on a real relay round-over message, which this gate does
    // not drive (tools/online-smoke.mjs does, but asserts nothing about focus there either).
    // Recorded plainly as unverified in scope, not silently assumed covered.
    const resultTitleTabIndex = await page.evaluate(() => document.querySelector('#siege-result-title').tabIndex);
    report('siege result title is wired for programmatic focus (tabIndex -1, siege-online.js init)',
      resultTitleTabIndex === -1, `tabIndex ${resultTitleTabIndex}`);

    // ---- title screen -----------------------------------------------------------------
    await assertTabOrder(page, 'title screen');

    // ---- campaign: episodes and levels -------------------------------------------------
    await page.locator('#play-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#episode-screen').hidden), (v) => v);
    await assertInitialFocus(page, 'episode screen', '#episode-back-button');
    await assertTabOrder(page, 'episode screen');

    await page.locator('.episode-choice[data-episode="1"]').click();
    await poll(() => page.evaluate(() => !document.querySelector('#level-screen').hidden), (v) => v);
    await assertInitialFocus(page, 'level screen', '#level-back-button');
    await assertTabOrder(page, 'level screen');

    // ---- HUD while a level is live -----------------------------------------------------
    await page.locator('.level-choice[data-level-id="sty-01"]').click();
    await poll(() => page.evaluate(() => window.__SLINGWRECK_SMOKE__?.()?.phase === 'aiming'), (v) => v);
    await assertTabOrder(page, 'round HUD (aiming)');

    // ---- HUD screen-reader text: score, critters remaining, objective -----------------
    const hudText = await page.evaluate(() => ({
      ammoLabel: document.querySelector('#ammo-list')?.getAttribute('aria-label') ?? '',
      objectiveLabel: document.querySelector('#objective-pigs')?.getAttribute('aria-label') ?? '',
      scoreLabel: document.querySelector('.score-block .hud-label')?.textContent ?? ''
    }));
    report('HUD exposes critters-remaining and pig-objective counts as text, not just icons',
      /\d/.test(hudText.ammoLabel) && /\d/.test(hudText.objectiveLabel) && hudText.scoreLabel.length > 0,
      `ammo "${hudText.ammoLabel}"; objective "${hudText.objectiveLabel}"; score label "${hudText.scoreLabel}"`);

    // ---- editor ------------------------------------------------------------------------
    // A fresh load rather than navigating out of the live round: round-hud/round-over have
    // no "back to title" control mid-round by design (R restarts, Escape opens the level
    // grid — see game.js), and this gate cares about the editor's own tab order, not how a
    // player gets there.
    await page.goto(smokeUrl(baseUrl), { waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    await page.locator('#editor-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#editor-screen').hidden), (v) => v);
    await assertInitialFocus(page, 'fortress editor', '#editor-back-button');
    // Walk starts after #game (skip 1): game.js repurposes Tab as the documented "change
    // palette group" shortcut whenever the canvas itself has focus (game.js:1835 — out of
    // scope here), so pressing Tab there does not advance to the next control the way it does
    // everywhere else. That is real, intentional, and printed in #editor-controls-hint ("Tab
    // changes group"); it just makes #game a control this generic forward-order walk cannot
    // include without special-casing it, which the dedicated assertion right below does.
    const editorCount = await assertTabOrder(page, 'fortress editor (materials group, after #game)', 1);
    report('editor palette reachable-control count includes the canvas (tabIndex 0 while editing)',
      editorCount > 20,
      `${editorCount} reachable controls (canvas, back, tools, tabs, materials, shapes, blueprint I/O)`);

    // The canvas's own Tab behaviour, measured rather than assumed: focused directly, Tab does
    // not do the browser's default focus-advance (game.js calls preventDefault first) — it
    // runs setEditorGroup(otherGroup, true), which flips the palette tablist's aria-selected
    // state AND moves focus onto the newly-revealed group's selected piece button. Worth
    // measuring directly rather than trusting the source read: it means landing on the canvas
    // is not a keyboard trap — Tab from there goes somewhere real and useful (into the palette
    // that just became visible), just not to "the next control in DOM order" the way every
    // other tab stop behaves, which is why #game needed skip-1 above instead of walking through
    // it generically. The one real edge, unfixable here since game.js is out of scope: neither
    // branch checks event.shiftKey, so Shift+Tab from the canvas does the identical forward
    // group-switch rather than a backward move — asymmetric, but not a trap.
    await page.evaluate(() => document.querySelector('#game').focus());
    const beforeGroup = await page.evaluate(() => document.querySelector('#materials-tab').getAttribute('aria-selected'));
    await page.keyboard.press('Tab');
    const afterTab = await page.evaluate(() => ({
      activeId: document.activeElement?.id ?? '(none)',
      materialsSelected: document.querySelector('#materials-tab').getAttribute('aria-selected')
    }));
    report('canvas Tab switches the palette group and moves focus into it (not a keyboard trap)',
      afterTab.activeId === 'palette-pig-runt' && afterTab.materialsSelected !== beforeGroup,
      `focus landed on #${afterTab.activeId}; materials-tab aria-selected ${beforeGroup} -> ${afterTab.materialsSelected}`);
    // :not([aria-pressed="true"]) specifically, since the currently-chosen material gets a
    // separate --terracotta-dark border override (style.css) that was never the question here.
    await assertBorderContrast(page, 'editor palette piece border against its own fill',
      '.material-choice:not([aria-pressed="true"])', ['#materials-palette']);

    // ---- online lobby --------------------------------------------------------------------
    await page.locator('#editor-back-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#title-screen').hidden), (v) => v);
    await page.locator('#siege-online-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#online-lobby').hidden), (v) => v);
    // The background lobby-list poll (every 3s, see siege-online.js's LOBBY_POLL_MS) is not
    // in flight yet this soon after open, and the stubbed /lobbies always answers instantly
    // with the same empty list, so the DOM here is stable across runs.
    await delay(150);
    await assertInitialFocus(page, 'online lobby', '#online-name');
    await assertTabOrder(page, 'online lobby');

    // ---- dialog semantics and the shared Tab-trap for the overlay panels ----------------
    await assertDialogRole(page, 'online lobby has dialog/aria-modal semantics', '#online-lobby');
    await assertTrapWraps(page, 'Tab from the lobby\'s last control wraps to its first (siege-online.js trap)', '#online-lobby');

    // ---- Escape's typing guard ----------------------------------------------------------
    // The lobby opens with focus already in #online-name (assertInitialFocus above), so this
    // is the very first keypress state a real player is in. Without the typing guard added
    // alongside the trap, Escape here would close the socket and dump them to the title
    // screen mid-keystroke — matching the guard game.js's own editor handler already applies
    // before acting on a shortcut key.
    await page.evaluate(() => document.querySelector('#online-name').focus());
    await page.keyboard.press('Escape');
    const lobbyOpenAfterTypingEscape = await page.evaluate(() => !document.querySelector('#online-lobby').hidden);
    report('Escape while typing in the lobby name field does not quit (typing guard)',
      lobbyOpenAfterTypingEscape, `lobby still open: ${lobbyOpenAfterTypingEscape}`);

    // ---- .online-lobby-row, only ever rendered once a room actually exists --------------
    // Fixed, not random, so this prints the same two rooms on every run. One joinable (real
    // focusable button) and one full (real `disabled`, matching net.js/siege-online.js's
    // existing correct pattern of a genuinely disabled control rather than aria-disabled —
    // unlike the campaign's locked levels, there is no "why" to explain here beyond the
    // players/max count already shown as text).
    stubLobbies = [
      { name: 'acorn-siege', players: 1, max: 2, locked: true, joinable: true },
      { name: 'full-fortress', players: 2, max: 2, locked: false, joinable: false }
    ];
    await page.locator('#online-refresh').click();
    const roomsListed = await poll(
      () => page.evaluate(() => document.querySelectorAll('#online-lobby-list li').length), (n) => n === 2);
    const rowBox = await page.locator('.online-lobby-row').first().boundingBox();
    report('online lobby room-list row clears the 44px touch-target floor',
      Boolean(rowBox) && rowBox.height >= 44,
      rowBox ? `${rowBox.width.toFixed(0)}x${rowBox.height.toFixed(0)} px` : 'no row rendered');
    const fullRoomDisabled = await page.evaluate(() =>
      document.querySelectorAll('.online-lobby-row')[1]?.disabled);
    report('the full room\'s row is a genuinely disabled control, not just styled that way',
      roomsListed.ok && fullRoomDisabled === true, `2 rooms listed: ${roomsListed.ok}; second row disabled: ${fullRoomDisabled}`);
    await assertTabOrder(page, 'online lobby with one joinable room listed');
    stubLobbies = [];

    // ---- Escape actually quits when not typing -------------------------------------------
    await page.evaluate(() => document.querySelector('#online-back').focus());
    await page.keyboard.press('Escape');
    const lobbyOpenAfterRealEscape = await page.evaluate(() => !document.querySelector('#online-lobby').hidden);
    report('Escape while not typing quits the lobby back to the title screen',
      !lobbyOpenAfterRealEscape, `lobby still open: ${lobbyOpenAfterRealEscape}`);
    await page.locator('#siege-online-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#online-lobby').hidden), (v) => v);

    // Draft and result panels: reached directly (see file header) rather than through a real
    // match, since a live relay match belongs to tools/online-smoke.mjs and a bot match to
    // tools/siege-match.mjs — this gate only needs the markup, not another route to it. The
    // lobby is hidden first because the real flow always does that before either panel shows
    // (see siege-online.js's onBuild); leaving it visible underneath would let two "screens"
    // be reachable at once, which never happens in the live app.
    await page.evaluate(() => {
      document.querySelector('#online-lobby').hidden = true;
      // Always exactly three candidates in the real draft (DESIGN.md §6.4, relay's
      // rollDraft) — one button would make the wrap-to-first check below trivially true
      // even with a broken trap, since there would be nowhere else for focus to go.
      document.querySelector('#siege-draft-cards').innerHTML = ['Reinforce', 'Dirty', 'Desperado'].map((tier) =>
        `<button type="button" class="siege-card"><div class="tier">${tier}</div>` +
        '<div class="card-name">A Card</div><div class="card-text">What it does.</div></button>'
      ).join('');
      document.querySelector('#siege-draft').hidden = false;
    });
    await assertDialogRole(page, 'siege draft panel has dialog/aria-modal semantics', '#siege-draft');
    await assertTabOrder(page, 'siege draft panel (direct)');
    await assertTrapWraps(page, 'Tab from the draft panel\'s last card wraps to its first (siege-online.js trap)', '#siege-draft');
    // The Shift+Tab half of the same trap — checked once, here, rather than at every panel:
    // it is the same shared listener in siege-online.js for all three, so one proof that
    // both branches of its `if (event.shiftKey && ...) / else if (...)` fire is sufficient.
    await assertTrapWraps(page, 'Shift+Tab from the draft panel\'s first card wraps to its last (siege-online.js trap)', '#siege-draft', true);
    await assertTextContrast(page, 'siege draft card tier label: accent on cream', '.siege-card .tier', { bgSelector: '.siege-card' });
    await page.evaluate(() => { document.querySelector('#siege-draft').hidden = true; });

    await page.evaluate(() => { document.querySelector('#siege-result').hidden = false; });
    await assertDialogRole(page, 'siege result panel has dialog/aria-modal semantics', '#siege-result');
    await assertTabOrder(page, 'siege result panel (direct)');
    await assertTrapWraps(page, 'Tab from the result panel\'s last control wraps to its first (siege-online.js trap)', '#siege-result');
    await page.evaluate(() => { document.querySelector('#siege-result').hidden = true; });

    // ---- live regions --------------------------------------------------------------------
    await assertLiveRegion(page, 'connection status announces without user action', '#online-status', 'polite');
    await assertLiveRegion(page, 'connection-lost banner is an assertive live region', '#online-connection-banner', 'assertive');
    await assertLiveRegion(page, 'opponent-joined line in the lobby is a live region', '#online-players', 'polite');
    await assertLiveRegion(page, 'editor validation summary is a live region', '#validation-summary', 'polite');
    await assertLiveRegion(page, 'settle-test result is a live region', '#settle-result', 'polite');
    await assertLiveRegion(page, 'round announcement is a live region', '#round-announcement', 'assertive');
    await assertLiveRegion(page, 'siege round-over detail is a live region', '#siege-result-detail', 'polite');
    await assertLiveRegion(page, 'siege standings line is a live region', '#siege-standings', 'polite');
    await assertLiveRegion(page, 'global status message is a live region', '#status-message', 'polite');

    // ---- contrast --------------------------------------------------------------------
    await assertTextContrast(page, 'body copy: ink on paper (title lede)', '.lede');
    await assertTextContrast(page, 'muted copy: ink-soft on paper (online label)', '.online-form label',
      { bgSelector: '.online-lobby .panel-card' });
    await assertTextContrast(page, 'primary button: cream on terracotta (Campaign)', '#play-button');
    await assertTextContrast(page, 'form field text: ink on cream (online name input)', '#online-name');
    await assertBorderContrast(page, 'form field border: online name input against its own fill and the panel',
      '#online-name', ['.online-lobby .panel-card']);
    await assertBorderContrast(page, 'difficulty toggle border against its own fill',
      '.difficulty-choice', ['.title-panel']);

    await page.evaluate(() => { document.querySelector('#siege-banner').hidden = false; });
    await assertTextContrast(page, 'siege banner: wins line, accent on panel', '#siege-wins', { bgSelector: '#siege-banner' });
    await page.evaluate(() => { document.querySelector('#siege-banner').hidden = true; });

    // Connection banner, shown deliberately (see file header): the hidden default would give
    // a contrast reading of "transparent", not the colour a player actually sees.
    await page.evaluate(() => {
      document.querySelector('#online-connection-text').textContent =
        'The opponent left during the build phase. Back to the lobby.';
      document.querySelector('#online-connection-reconnect').hidden = false;
      document.querySelector('#online-connection-banner').hidden = false;
    });
    await assertTextContrast(page, 'connection banner: cream on terracotta', '#online-connection-text',
      { bgSelector: '#online-connection-banner' });
    const bannerOverflow = await horizontalOverflow(page);
    report('connection banner with a full-length server message does not overflow at 1280px',
      bannerOverflow.overflow === 0, `${bannerOverflow.overflow}px over`);

    // ---- #critter-intro: game.js's screen, siege-online.js's trap ------------------------
    // This panel's own show/hide and focus-on-open (critterIntroButton.focus()) live in
    // game.js, out of scope — but it shares the same .screen-panel overlay treatment, now
    // also marked role="dialog" aria-modal="true", and the shared trap in siege-online.js
    // applies to it exactly the same way. It has exactly one control, so assertTrapWraps'
    // ">1 focusable" bar does not fit: the correct behaviour here is that Tab does *nothing*
    // (first === last), not that it "wraps" between two different elements.
    await page.evaluate(() => { document.querySelector('#critter-intro').hidden = false; });
    await assertDialogRole(page, 'critter-intro card has dialog/aria-modal semantics', '#critter-intro');
    await page.evaluate(() => document.querySelector('#critter-intro-button').focus());
    await page.keyboard.press('Tab');
    const staysOnSoleControl = await page.evaluate(() =>
      document.activeElement === document.querySelector('#critter-intro-button'));
    report('Tab on critter-intro\'s sole control is a correct no-op (siege-online.js trap covers it too)',
      staysOnSoleControl, `focus stayed on the only control: ${staysOnSoleControl}`);
    await page.evaluate(() => { document.querySelector('#critter-intro').hidden = true; });
  } catch (error) {
    runtimeIssues.push(`desktop a11y run aborted: ${error.stack ?? error}`);
  } finally {
    await context.close();
  }
}

// Measured with vs without, the same rule BUILD_PLAN.md applies to every gameplay ability:
// a value that "looks like zero" is not evidence the media query fired, only that a button's
// transition was already short. Comparing against the same probe with the setting off is what
// makes this a real assertion instead of a guess about what "0.01ms" serializes to.
async function transitionDurationSeconds(baseUrl, browser, reducedMotion) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion });
  const page = await context.newPage();
  attachFailureCollectors(page, `reduced motion (${reducedMotion})`);
  try {
    await loadReady(page, baseUrl);
    const raw = await page.evaluate(() => getComputedStyle(document.querySelector('#play-button')).transitionDuration);
    return { raw, seconds: parseFloat(raw) * (raw.trim().endsWith('ms') ? 0.001 : 1) };
  } finally {
    await context.close();
  }
}

async function reducedMotionRun(baseUrl, browser) {
  try {
    const [normal, reduced] = await Promise.all([
      transitionDurationSeconds(baseUrl, browser, 'no-preference'),
      transitionDurationSeconds(baseUrl, browser, 'reduce')
    ]);
    report('prefers-reduced-motion collapses .button\'s CSS transition (style.css @media block)',
      reduced.seconds <= 0.0001 && reduced.seconds < normal.seconds,
      `normal "${normal.raw}" (${normal.seconds}s) vs reduced "${reduced.raw}" (${reduced.seconds}s)`);
  } catch (error) {
    runtimeIssues.push(`reduced motion run aborted: ${error.stack ?? error}`);
  }
}

async function portraitOverflowRun(baseUrl, browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true
  });
  const page = await context.newPage();
  attachFailureCollectors(page, 'portrait overflow');

  try {
    await loadReady(page, baseUrl);
    await assertNoOverflow(page, 'title screen');

    await page.locator('#play-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#episode-screen').hidden), (v) => v);
    await assertNoOverflow(page, 'episode screen');

    await page.locator('.episode-choice[data-episode="1"]').click();
    await poll(() => page.evaluate(() => !document.querySelector('#level-screen').hidden), (v) => v);
    await assertNoOverflow(page, 'level screen');

    await page.locator('.level-choice[data-level-id="sty-01"]').click();
    await poll(() => page.evaluate(() => window.__SLINGWRECK_SMOKE__?.()?.phase === 'aiming'), (v) => v);
    await assertNoOverflow(page, 'round HUD (aiming)');

    await page.evaluate(() => { document.querySelector('#siege-banner').hidden = false; });
    await assertNoOverflow(page, 'siege banner overlaid on the HUD');
    await page.evaluate(() => { document.querySelector('#siege-banner').hidden = true; });

    await page.evaluate(() => { document.querySelector('#siege-preview').hidden = false; });
    await assertNoOverflow(page, 'siege corner preview overlaid on the HUD');
    await page.evaluate(() => { document.querySelector('#siege-preview').hidden = true; });

    // ---- editor at 390x844 --------------------------------------------------------------
    await page.evaluate(() => { document.querySelector('#round-hud').hidden = true; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    await page.locator('#editor-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#editor-screen').hidden), (v) => v);
    await assertNoOverflow(page, 'fortress editor');

    // ---- online lobby, the surface this task actually adds portrait layout for ----------
    await page.locator('#editor-back-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#title-screen').hidden), (v) => v);
    await page.locator('#siege-online-button').click();
    await poll(() => page.evaluate(() => !document.querySelector('#online-lobby').hidden), (v) => v);
    await delay(150);
    await assertNoOverflow(page, 'online lobby, empty room list');

    // .online-lobby-row is only ever rendered once a room exists — the empty-list check just
    // above never touches it. It is `width: 100%` with vertical-only padding and no horizontal
    // padding of its own, so a long name plus " — 2/2 🔒" sitting flush against the panel's
    // edge at 390px is exactly the kind of overflow this gate exists to catch, not assume away.
    stubLobbies = [{ name: 'a-fairly-long-room-code-example', players: 1, max: 2, locked: true, joinable: true }];
    await page.locator('#online-refresh').click();
    await poll(() => page.evaluate(() => document.querySelectorAll('#online-lobby-list li').length === 1), (v) => v);
    await assertNoOverflow(page, 'online lobby, one long room name listed');
    const lobbyRowBox = await page.locator('.online-lobby-row').first().boundingBox();
    report('online lobby room-list row clears the 44px touch-target floor at 390x844',
      Boolean(lobbyRowBox) && lobbyRowBox.height >= 44,
      lobbyRowBox ? `${lobbyRowBox.width.toFixed(0)}x${lobbyRowBox.height.toFixed(0)} px` : 'no row rendered');
    stubLobbies = [];

    // A name typed in, a room code typed in, and the room-state block visible with a real
    // opponent name — the fullest the lobby's own controls ever get without a live relay.
    await page.locator('#online-name').fill('A Rather Long Wrecker Name');
    await page.locator('#online-room').fill('a-fairly-long-room-code-example');
    await page.evaluate(() => {
      const state = document.querySelector('#online-room-state');
      const players = document.querySelector('#online-players');
      const start = document.querySelector('#online-start');
      state.hidden = false;
      players.textContent = 'A Rather Long Wrecker Name vs Their Rather Long Name — ready.';
      start.hidden = false;
    });
    await assertNoOverflow(page, 'online lobby, room state with two long names and Start visible');

    const rowBox = await page.evaluate(() => {
      const btn = document.querySelector('#online-back');
      const rect = btn.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    report('online lobby "Back to title" control clears the 44px touch-target floor',
      rowBox.height >= 44, `${rowBox.width.toFixed(0)}x${rowBox.height.toFixed(0)} px`);

    const inputBox = await page.evaluate(() => document.querySelector('#online-room').getBoundingClientRect());
    report('online lobby room-code field is at least 44px tall to tap accurately',
      inputBox.height >= 44, `${inputBox.width.toFixed(0)}x${inputBox.height.toFixed(0)} px`);

    // ---- connection banner, the one element the task names explicitly as a mobile risk --
    await page.evaluate(() => {
      document.querySelector('#online-connection-text').textContent =
        'The opponent left during the build phase. Back to the lobby.';
      document.querySelector('#online-connection-reconnect').hidden = false;
      document.querySelector('#online-connection-banner').hidden = false;
    });
    await assertNoOverflow(page, 'online lobby with the full-length connection-lost banner shown');
    const bannerBox = await page.locator('#online-connection-banner').boundingBox();
    report('connection banner stays within the 390px viewport',
      Boolean(bannerBox) && bannerBox.x >= 0 && bannerBox.x + bannerBox.width <= 390,
      bannerBox ? `x ${bannerBox.x.toFixed(1)}, width ${bannerBox.width.toFixed(1)}, right edge ${(bannerBox.x + bannerBox.width).toFixed(1)}` : 'not found');
    await page.evaluate(() => { document.querySelector('#online-connection-banner').hidden = true; });

    // ---- draft and result panels, direct (see file header) ------------------------------
    // Lobby hidden first, matching the real flow (siege-online.js's onBuild hides it before
    // the match ever reaches a draft or a result) — see the desktop run for the full note.
    await page.evaluate(() => { document.querySelector('#online-lobby').hidden = true; });
    await page.evaluate(() => {
      document.querySelector('#siege-draft-cards').innerHTML = ['Reinforce', 'Dirty', 'Desperado'].map((tier) =>
        `<button type="button" class="siege-card"><div class="tier">${tier}</div>` +
        '<div class="card-name">A Reasonably Long Card Name</div>' +
        '<div class="card-text">A card description long enough to wrap onto more than one line on a phone.</div></button>'
      ).join('');
      document.querySelector('#siege-draft').hidden = false;
    });
    await assertNoOverflow(page, 'siege draft panel, three full-length cards');
    await page.evaluate(() => { document.querySelector('#siege-draft').hidden = true; });

    await page.evaluate(() => {
      document.querySelector('#siege-result-detail').textContent =
        'Decided on points. Your score: 15,300. That is a fairly long sentence to fit on a phone.';
      document.querySelector('#siege-standings').textContent = 'You 2 — 2 A Rather Long Opponent Name  ·  first to 3';
      document.querySelector('#siege-result').hidden = false;
    });
    await assertNoOverflow(page, 'siege result panel, long detail and standings text');
  } catch (error) {
    runtimeIssues.push(`portrait overflow run aborted: ${error.stack ?? error}`);
  } finally {
    await context.close();
  }
}

try {
  const server = createStaticServer();
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/`;

  const browser = await chromium.launch({ headless: true });
  try {
    await desktopA11yRun(baseUrl, browser);
  } catch (error) {
    runtimeIssues.push(`desktop a11y run aborted: ${error.stack ?? error}`);
  }
  try {
    await reducedMotionRun(baseUrl, browser);
  } catch (error) {
    runtimeIssues.push(`reduced motion run aborted: ${error.stack ?? error}`);
  }
  try {
    await portraitOverflowRun(baseUrl, browser);
  } catch (error) {
    runtimeIssues.push(`portrait overflow run aborted: ${error.stack ?? error}`);
  }
  await browser.close();
  await new Promise((done) => server.close(done));
} catch (error) {
  runtimeIssues.push(`a11y setup failed: ${error.stack ?? error}`);
}

report('browser runtime is clean', runtimeIssues.length === 0,
  `${runtimeIssues.length} console, page, request, or infrastructure error(s)`);
for (const issue of runtimeIssues) console.log(`      ${issue}`);

const runtimeSeconds = (performance.now() - startedAt) / 1000;
report('a11y run stays within 60 seconds', runtimeSeconds < 60, `${runtimeSeconds.toFixed(2)} s < 60.00 s`);

if (failures.length) {
  console.error(`\n${failures.length} a11y assertion(s) failed in ${runtimeSeconds.toFixed(2)} s.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${assertion} a11y assertions passed in ${runtimeSeconds.toFixed(2)} s.`);
}
