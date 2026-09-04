#!/usr/bin/env node

// P8's live gate: the deployed site and the deployed relay, not a local copy of either.
// Every other browser gate in this repo serves the working tree over local HTTP and, for
// the online ones, runs the relay under `wrangler dev`. Those prove the code is right.
// This proves the thing on the internet is the code — a distinction that mattered on
// 2026-09-02, when a fully-gated push deployed correctly and changed nothing a visitor
// could see because the cache stamp had not moved, so every module URL was unchanged and
// caches kept serving the previous build. `check.mjs` validates stamps but cannot catch a
// stale one, because a stale set is still internally consistent.
//
// Two things about the live topology that are not obvious and cost an hour to find:
//
//   1. The game runs in an iframe at `?_games_frame=1`. The bare domain returns an
//      SEO/about wrapper that the shared games-guard Worker builds from the hub's
//      JSON-LD, so `curl` and a browser receive different documents. Point this at the
//      frame URL or you are testing the wrapper.
//   2. `/_guard/profile` answers 401 for anyone without a guard session, which is every
//      headless browser. Campaign progress sync is designed to fail silently in exactly
//      that case, so this gate expects that one request to fail and fails on any other.

import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const SITE = process.env.SLINGWRECK_SITE ?? 'https://slingwreck.andrenijman.com';
const FRAME = `${SITE}/?_games_frame=1`;
const EXPECTED_FAILURES = [/\/_guard\/profile$/];
const room = `live${Math.random().toString(36).slice(2, 8)}`;

let passed = 0;
const failures = [];
function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (ok) passed++;
  else failures.push(name);
}

const started = performance.now();
const issues = [];
const sockets = [];
let browser;

try {
  browser = await chromium.launch();
  const open = async (label) => {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (error) => issues.push(`${label} page error: ${error.message}`));
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('response', (response) => {
      if (response.status() < 400) return;
      if (EXPECTED_FAILURES.some((pattern) => pattern.test(new URL(response.url()).pathname))) return;
      issues.push(`${label} ${response.status()} ${response.url()}`);
    });
    await page.goto(FRAME, { waitUntil: 'networkidle' });
    return page;
  };

  const host = await open('host');
  const guest = await open('guest');

  report('the deployed site serves the game, not the SEO wrapper',
    await host.locator('#siege-online-button').count() === 1,
    'Siege Online button present in the frame');

  const tiers = await host.locator('.difficulty-choice').count();
  report('the deployed build carries the P8 difficulty selector', tiers === 3, `${tiers} tiers`);

  // Not "a stamp exists" — "the stamp is the one in this working tree". The weaker check
  // passed green over a stale deploy on 2026-09-04, which is the whole failure this gate
  // was written for: a push can be correct, gated and published and still leave the site
  // serving the previous build under unchanged module URLs.
  const stamp = await host.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map((s) => s.src.match(/\?v=([\d-]+)/)?.[1])
      .filter(Boolean)[0] ?? 'none');
  const expected = (await readFile(new URL('../index.html', import.meta.url), 'utf8'))
    .match(/\?v=([\d-]+)/)?.[1] ?? 'none';
  report('the deployed build is the one in this working tree',
    stamp === expected, `live ${stamp} vs local ${expected}`);

  await host.locator('#siege-online-button').click();
  await guest.locator('#siege-online-button').click();
  await host.waitForTimeout(1000);

  await host.locator('#online-name').fill('Host');
  await host.locator('#online-room').fill(room);
  await host.locator('#online-create').click();
  await host.waitForTimeout(4500);

  await guest.locator('#online-name').fill('Guest');
  await guest.locator('#online-room').fill(room);
  await guest.locator('#online-join').click();
  await guest.waitForTimeout(6000);

  for (const [label, page] of [['host', host], ['guest', guest]]) {
    const seen = await page.evaluate(() => ({
      players: document.querySelector('#online-players')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      start: (() => {
        const button = document.querySelector('#online-start');
        return button ? !button.disabled : false;
      })()
    }));
    report(`${label} sees the opponent across the deployed relay and can start`,
      / vs /.test(seen.players) && seen.start, `"${seen.players}" | start ${seen.start}`);
  }

  const inRoom = sockets.filter((url) => url.includes(`room=${room}`));
  report('both clients opened a socket to the deployed relay in the same room',
    inRoom.length === 2 && inRoom.every((url) => url.startsWith('wss://')),
    inRoom.map((url) => url.replace(/^wss:\/\//, '').split('/ws')[0]).join(' + ') || 'none');

  await host.screenshot({ path: 'shots/live-lobby.png' });
} catch (error) {
  issues.push(`live smoke aborted: ${error.stack ?? error}`);
} finally {
  await browser?.close().catch(() => {});
}

report('live runtime is clean apart from the expected guard 401',
  issues.length === 0, issues.length ? issues.slice(0, 3).join(' | ') : '0 issues');

const seconds = (performance.now() - started) / 1000;
if (failures.length) {
  console.error(`\n${failures.length} live smoke assertion(s) failed in ${seconds.toFixed(2)} s: ` +
    failures.join(', '));
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passed} live smoke assertions passed against ${SITE} in ${seconds.toFixed(2)} s.`);
}
