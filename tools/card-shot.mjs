#!/usr/bin/env node
// Produces the hub card and the social image.
//
// Both are screenshots of a real round in progress, not a mock-up, so the marketing image
// cannot drift away from what the game actually looks like. Same reasoning as `bop`'s
// version of this tool.
//
//   card.png      1000x525  the tile on games.andrenijman.com
//   og-image.png  1200x630  link previews
//
// The frame is taken a beat after impact, while the structure is coming apart and the
// debris is still in the air, because a settled pile of rubble is a photograph of the past
// tense and a collapse in progress is the game.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { AMMO } from '../data.js?v=20260903-1';
import { LEVELS } from '../levels.js?v=20260903-1';

const server = spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch();
const issues = [];

async function capture(width, height, path) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => issues.push(e.message));
  await page.addInitScript(({ ids, progress }) => {
    // Skip the introduction cards; the card should show the game, not a tutorial. Progress
    // is seeded too, or every episode past the first is locked and unreachable.
    localStorage.setItem('slingwreck.critters.seen.v1', JSON.stringify(ids));
    localStorage.setItem('slingwreck.campaign.progress.v1', JSON.stringify(progress));
  }, {
    ids: AMMO.map((a) => a.id),
    progress: {
      version: 1,
      levels: Object.fromEntries(LEVELS.map((l) => [l.id,
        { bestScore: l.stars?.[0] ?? 0, stars: 1, completed: true }]))
    }
  });
  await page.goto('http://127.0.0.1:4173/?smoke-test', { waitUntil: 'networkidle' });
  await page.locator('#play-button').click();
  await page.locator('.episode-choice[data-episode="1"]').click();
  // sty-13, the Episode 1 finale: 30 pieces and several pigs, so one shot takes a visible
  // bite out of it without ending the round. qry-07 was tried first and its tapped Lob
  // won outright, which put the results panel over the whole frame — a screenshot of a
  // dialog, not of the game.
  await page.locator('.level-choice[data-level-id="sty-13"]').click();
  await page.waitForFunction(() => window.__SLINGWRECK_SMOKE__?.()?.phase === 'aiming',
    null, { timeout: 15000 });
  await page.waitForTimeout(900);

  const pouch = await page.evaluate(() => {
    const { camera, sling } = window.__SLINGWRECK_SMOKE__();
    return {
      x: camera.viewportX + camera.viewportW / 2 + (sling.x - camera.x) * camera.scale,
      y: camera.viewportY + camera.viewportH / 2 - (sling.y - camera.y) * camera.scale,
      scale: camera.scale
    };
  });

  // Pull back and down: forward and up.
  await page.mouse.move(pouch.x, pouch.y);
  await page.mouse.down();
  // Full draw at this angle, tapped mid-flight, reliably takes 7 of qry-07's 13 blocks.
  await page.mouse.move(pouch.x - pouch.scale * 1.6, pouch.y + pouch.scale * 0.6, { steps: 16 });
  await page.waitForTimeout(150);
  await page.mouse.up();


  // Wait for the shot to actually connect, then a beat for the debris to spread. Polling
  // for damage rather than sleeping a fixed time keeps the frame consistent between runs.
  // Hold until several blocks are actually gone, not just the first contact. A frame taken
  // on impact shows a critter touching an intact wall; a frame a moment later shows the
  // wall coming apart, which is the game.
  await page.waitForFunction(() => {
    const s = window.__SLINGWRECK_SMOKE__?.();
    return s && (s.blocks?.filter((b) => b.dead).length ?? 0) >= 5;
  }, null, { timeout: 14000 }).catch(() => issues.push(`${path}: not enough destruction`));
  // Short: the frame wants debris still in the air, not a settled pile.
  await page.waitForTimeout(150);

  await page.screenshot({ path });
  await page.close();
  console.log(`wrote ${path} (${width}x${height} at 2x)`);
}

try {
  await capture(1000, 525, 'card.png');
  await capture(1200, 630, 'og-image.png');
} finally {
  await browser.close();
  try { process.kill(-server.pid); } catch {}
}

if (issues.length) {
  console.log(`\n${issues.length} issue(s):`);
  for (const i of issues) console.log(`  ${i}`);
  process.exitCode = 1;
}
