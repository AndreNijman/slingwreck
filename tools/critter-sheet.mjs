#!/usr/bin/env node
// Renders the nine critters as reviewable sheets.
//
// They shipped identical — one colour, one silhouette, nine abilities — and a naive
// playtester finished level after level without realising there was more than one bird. So
// the art now needs to be checkable at a glance, side by side, rather than one at a time
// in the corner of a level.
//
// Two sheets, because they answer different questions:
//   critter-sheet.png    the art itself, large, with each ability's own words
//   critter-ingame.png   the same nine in the actual sling, at real gameplay size
//
// The second matters more. Art that separates at 96px and collapses at 20px has not
// solved the problem it was drawn for.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { AMMO } from '../data.js';
import { LEVELS } from '../levels.js';

mkdirSync('shots', { recursive: true });
const server = spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch();
const issues = [];

try {
  // ---- sheet one: the art, with its own copy ------------------------------------
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => issues.push(e.message));
  await page.goto('http://127.0.0.1:4173/?smoke-test', { waitUntil: 'networkidle' });

  await page.evaluate(async (rows) => {
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#2B211C;font-family:ui-monospace,monospace';
    const wrap = document.createElement('div');
    wrap.id = 'sheet';
    wrap.style.cssText = 'padding:26px;background:#EDE3CB;display:grid;' +
      'grid-template-columns:repeat(3,1fr);gap:20px';
    for (const row of rows) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex;gap:14px;align-items:flex-start;' +
        'background:#F4EBD6;border:3px solid #2B211C;border-radius:14px;padding:14px';
      const c = document.createElement('canvas');
      c.style.cssText = 'width:88px;height:88px;flex:0 0 auto';
      window.__drawHead(c, row.ammo);
      const text = document.createElement('div');
      text.innerHTML =
        `<div style="font-weight:700;font-size:17px;color:#2B211C">${row.ammo.name}</div>` +
        `<div style="font-size:11px;color:#8A5A2B;margin:1px 0 6px">` +
        `${row.ammo.ability ?? 'no ability'} · r ${row.ammo.radius} · mass ${row.ammo.mass}</div>` +
        `<div style="font-size:12px;line-height:1.35;color:#4A3E35">${row.ammo.tutorial}</div>`;
      cell.append(c, text);
      wrap.append(cell);
    }
    document.body.append(wrap);
  }, AMMO.map((ammo) => ({ ammo })));

  await page.locator('#sheet').screenshot({ path: 'shots/critter-sheet.png' });
  console.log('wrote shots/critter-sheet.png');
  await page.close();

  // ---- sheet two: the same nine at real gameplay size ---------------------------
  // Each critter loaded into a real level through the `?ammo=` hook, cropped tight on the
  // sling. This is the size a player actually sees them at.
  const tiles = [];
  for (const ammo of AMMO) {
    const p = await browser.newPage({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 2 });
    p.on('pageerror', (e) => issues.push(`${ammo.id}: ${e.message}`));
    await p.addInitScript((ids) => {
      localStorage.setItem('slingwreck.critters.seen.v1', JSON.stringify(ids));
    }, AMMO.map((a) => a.id));
    await p.goto(`http://127.0.0.1:4173/?smoke-test&ammo=${ammo.id}`, { waitUntil: 'networkidle' });
    await p.locator('#play-button').click();
    await p.locator('.episode-choice[data-episode="1"]').click();
    await p.locator(`.level-choice[data-level-id="${LEVELS[0].id}"]`).click();
    await p.waitForFunction(() => window.__SLINGWRECK_SMOKE__?.()?.phase === 'aiming',
      null, { timeout: 15000 });
    await p.waitForTimeout(900);

    // Pull the sling back so the critter sits clear of the fork and is fully visible.
    const pouch = await p.evaluate(() => {
      const s = window.__SLINGWRECK_SMOKE__();
      const { camera, sling } = s;
      return {
        x: camera.viewportX + camera.viewportW / 2 + (sling.x - camera.x) * camera.scale,
        y: camera.viewportY + camera.viewportH / 2 - (sling.y - camera.y) * camera.scale,
        scale: camera.scale
      };
    });
    await p.mouse.move(pouch.x, pouch.y);
    await p.mouse.down();
    await p.mouse.move(pouch.x - pouch.scale * 1.1, pouch.y + pouch.scale * 0.5, { steps: 10 });
    await p.waitForTimeout(400);

    const shot = await p.screenshot({
      clip: { x: Math.max(0, pouch.x - 190), y: Math.max(0, pouch.y - 130), width: 300, height: 240 }
    });
    tiles.push({ id: ammo.id, name: ammo.name, png: shot.toString('base64') });
    await p.mouse.up();
    await p.close();
    console.log(`  captured ${ammo.id}`);
  }

  const compose = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
  await compose.setContent('<body style="margin:0"></body>');
  await compose.evaluate((rows) => {
    const wrap = document.createElement('div');
    wrap.id = 'sheet';
    wrap.style.cssText = 'padding:20px;background:#2B211C;display:grid;' +
      'grid-template-columns:repeat(3,1fr);gap:14px';
    for (const row of rows) {
      const cell = document.createElement('div');
      cell.style.cssText = 'border:3px solid #EDE3CB;border-radius:12px;overflow:hidden';
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${row.png}`;
      img.style.cssText = 'display:block;width:100%';
      const cap = document.createElement('div');
      cap.textContent = row.name;
      cap.style.cssText = 'font:700 13px ui-monospace,monospace;color:#EDE3CB;' +
        'background:#2B211C;padding:5px 8px';
      cell.append(img, cap);
      wrap.append(cell);
    }
    document.body.append(wrap);
  }, tiles);
  await compose.waitForTimeout(400);
  await compose.locator('#sheet').screenshot({ path: 'shots/critter-ingame.png' });
  console.log('wrote shots/critter-ingame.png');
  await compose.close();
} finally {
  await browser.close();
  try { process.kill(-server.pid); } catch {}
}

if (issues.length) {
  console.log(`\n${issues.length} page issue(s):`);
  for (const i of issues.slice(0, 6)) console.log(`  ${i}`);
  process.exitCode = 1;
}
