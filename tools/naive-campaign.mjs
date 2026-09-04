#!/usr/bin/env node
// Plays the entire campaign with a naive vision model and films every level.
//
// `tools/naive-playtest.mjs` proves the idea on one or two levels. This runs all 52, which
// buys two things a single session cannot:
//
//   - a real difficulty curve. Which levels a player with no context can actually beat is
//     not the same question as which levels a bot with a ballistic solver can beat, and
//     `tools/balance.mjs` only answers the second.
//   - footage. One webm per level plus a single concatenated film, so the whole campaign
//     can be watched rather than read about.
//
// Every level is unlocked up front by seeding progress, because the point is to see all of
// them, not to gate the tester behind its own competence.
//
//   node tools/naive-campaign.mjs [--turns 10] [--episode 2] [--no-video] [--model id]

import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { LEVELS } from '../levels.js?v=20260904-2';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TURNS = Number(opt('turns', 10));
const MODEL = opt('model', 'stealth/ox-alpha');
const ONLY_EPISODE = args.includes('--episode') ? Number(opt('episode', 0)) : null;
const VIDEO = !args.includes('--no-video');
const KEY = readFileSync('/var/home/andre/special2.special2', 'utf8').trim();

const targets = LEVELS.filter((l) => ONLY_EPISODE === null || l.episode === ONLY_EPISODE);

// No game knowledge whatsoever. The moment this explains a mechanic it stops measuring
// legibility and starts measuring instruction-following.
const BRIEF = `You are playing a video game you have never seen. Nobody has told you the
rules, the goal or the controls. Work it out from the picture.

Reply in exactly this format, nothing else:

SEE: <one short sentence>
THINK: <one short sentence on what you are trying to do>
CONFUSED: <anything you cannot work out, or "nothing">
ACTION: <CLICK x y | DRAG x1 y1 x2 y2 | KEY name | WAIT | DONE>

Coordinates are pixels in the image you were given. Be specific and blunt in CONFUSED —
what you cannot tell is the most useful thing you can report.`;

async function ask(b64, history) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: BRIEF },
        ...history,
        { role: 'user', content: [
          { type: 'text', text: 'Current screen. What do you do?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
        ] }
      ],
      max_tokens: 700
    })
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 120);
    const err = new Error(`openrouter ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()).choices?.[0]?.message?.content ?? '';
}

// Retry with backoff. Six workers against a free endpoint gets rate limited, and without
// this a single 429 aborted the whole level after one turn — which read as "the tester
// could not finish", i.e. the harness reporting its own throttling as a game result.
async function askWithRetry(b64, history) {
  let wait = 4000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { return await ask(b64, history); }
    catch (e) {
      const retryable = e.status === 429 || e.status === 502 || e.status === 503 || !e.status;
      if (!retryable || attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 30000);
    }
  }
  throw new Error('unreachable');
}

const field = (t, n) => (t.match(new RegExp(`^${n}:\\s*(.+)$`, 'im'))?.[1] ?? '').trim();

// Every level marked cleared at one star, so the grid unlocks without pretending the
// tester earned it. Scores stay at the one-star threshold so nothing looks mastered.
const seededProgress = () => ({
  version: 1,
  levels: Object.fromEntries(LEVELS.map((l) => [l.id,
    { bestScore: l.stars?.[0] ?? 0, stars: 1, completed: true }]))
});

mkdirSync('shots/naive-campaign', { recursive: true });
if (VIDEO) { rmSync('shots/naive-campaign/video', { recursive: true, force: true }); mkdirSync('shots/naive-campaign/video', { recursive: true }); }

const server = spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3500));

const results = [];
const browser = await chromium.launch();

// A worker pool rather than a loop. Each level costs a dozen sequential model calls, so
// run serially the full campaign takes about nine hours and nobody ever watches the
// result. Levels are completely independent — separate contexts, separate localStorage, no
// shared state — so the only real limit is the model API, and a handful in flight is fine.
const CONCURRENCY = Number(opt('concurrency', 5));
let cursor = 0;
let finished = 0;

async function playLevel(n, level) {
  {
    const context = await browser.newContext({
      viewport: { width: 960, height: 540 },
      // One temp directory per level: with workers in flight, a shared directory means two
      // contexts writing at once and the rename below picking up the wrong file.
      ...(VIDEO ? { recordVideo: { dir: `shots/naive-campaign/video-tmp/${level.id}`, size: { width: 960, height: 540 } } } : {})
    });
    const page = await context.newPage();
    const issues = [];
    page.on('pageerror', (e) => issues.push(e.message));

    let outcome = 'unfinished';
    let stars = 0;
    let turnsUsed = 0;
    let score = 0;
    let attempts = 1;
    let introduced = null;
    const confusions = [];

    try {
      // Each level runs in a fresh context, so without this the seen-critters list is empty
      // every time and the tester meets the same introduction card on all 52 levels —
      // wasting turns and reporting "+Nib" for every level. Seed it with everything the
      // earlier levels would already have taught, so a card appears only for a critter
      // that is genuinely new at this point in the campaign.
      const alreadyMet = [...new Set(LEVELS.slice(0, LEVELS.findIndex((l) => l.id === level.id))
        .flatMap((l) => l.bag))];
      await page.addInitScript(({ profile, met }) => {
        localStorage.setItem('slingwreck.campaign.progress.v1', JSON.stringify(profile));
        localStorage.setItem('slingwreck.critters.seen.v1', JSON.stringify(met));
      }, { profile: seededProgress(), met: alreadyMet });
      await page.goto('http://127.0.0.1:4173/?smoke-test', { waitUntil: 'networkidle' });
      await page.locator('#play-button').click();
      await page.locator(`.episode-choice[data-episode="${level.episode}"]`).click();
      await page.locator(`.level-choice[data-level-id="${level.id}"]`).click();
      // Wait for either the round or the new-critter card. The card deliberately gates
      // the first level a critter appears in, so demanding `aiming` here blocked forever
      // and no level ever started. It is also the thing most worth watching the tester
      // meet, so it is left on screen for the model to read and dismiss itself.
      await page.waitForFunction(() => {
        const panel = document.querySelector('#critter-intro');
        if (panel && !panel.hidden) return true;
        return window.__SLINGWRECK_SMOKE__?.()?.phase === 'aiming';
      }, null, { timeout: 20000 });
      introduced = await page.evaluate(() => {
        const panel = document.querySelector('#critter-intro');
        return panel && !panel.hidden
          ? document.querySelector('#critter-intro-name')?.textContent ?? null : null;
      });

      const history = [];
      for (let turn = 1; turn <= TURNS; turn++) {
        turnsUsed = turn;
        const buf = await page.screenshot();
        let reply;
        try { reply = await askWithRetry(buf.toString('base64'), history.slice(-3)); }
        catch (e) { issues.push(`model: ${e.message}`); break; }

        const confused = field(reply, 'CONFUSED');
        if (confused && !/^nothing/i.test(confused)) confusions.push(`turn ${turn}: ${confused}`);
        history.push({ role: 'assistant', content: reply });

        const action = field(reply, 'ACTION');
        const [verb, ...rest] = action.split(/\s+/);
        const v = rest.map(Number);
        try {
          if (verb === 'CLICK') await page.mouse.click(v[0], v[1]);
          else if (verb === 'DRAG') {
            await page.mouse.move(v[0], v[1]); await page.mouse.down();
            await page.mouse.move(v[2], v[3], { steps: 18 });
            await page.waitForTimeout(120); await page.mouse.up();
          } else if (verb === 'KEY') await page.keyboard.press(rest[0] ?? 'Space');
          else if (verb === 'DONE') break;
        } catch (e) { issues.push(`action: ${e.message}`); }

        await page.waitForTimeout(2400);
        // Stars are derived from the score against the level's thresholds, the same way
        // the result panel and `tools/smoke.mjs` do it. There is no `awardedStars` on the
        // snapshot; asking for one silently returned 0 for every level.
        const state = await page.evaluate(() => {
          const s = window.__SLINGWRECK_SMOKE__?.();
          if (!s) return null;
          const stars = (s.level?.stars ?? []).filter((t) => s.score >= t).length;
          return { phase: s.phase, stars, score: s.score };
        }).catch(() => null);
        if (state?.phase === 'won') { outcome = 'won'; stars = state.stars; score = state.score; break; }
        // Do not stop on a loss. A real player reads the failure screen and presses Retry,
        // and the tester does exactly that when left to it — in an earlier single-level run
        // it lost twice and won on the third attempt. Breaking here recorded that as
        // "cannot beat the level", which measures the harness rather than the game.
        if (state?.phase === 'lost') { outcome = 'lost'; attempts++; }
      }
    } catch (e) {
      issues.push(`level: ${e.message}`);
    }

    await page.close();
    await context.close();

    if (VIDEO) {
      // Playwright names videos by an internal id; rename to the level so the film can be
      // assembled in campaign order rather than whatever order the files landed in.
      const tmp = `shots/naive-campaign/video-tmp/${level.id}`;
      if (existsSync(tmp)) {
        const files = readFileSync ? (await import('node:fs')).readdirSync(tmp) : [];
        for (const f of files) {
          (await import('node:fs')).renameSync(`${tmp}/${f}`,
            `shots/naive-campaign/video/${String(n).padStart(2, '0')}-${level.id}.webm`);
        }
      }
    }

    results.push({ ...level, outcome, stars, score, attempts, introduced, turnsUsed, confusions, issues });
    finished++;
    console.log(`${String(finished).padStart(2)}/${targets.length}  ${level.id.padEnd(8)} ` +
      `${outcome.padEnd(10)} ${stars}★  ${turnsUsed} turns, ${attempts} try` +
      (introduced ? `  +${introduced}` : '') +
      (confusions.length ? `  (${confusions.length} confused)` : '') +
      (issues.length ? `  [${issues.length} issue]` : ''));
  }
}

try {
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      await playLevel(index, targets[index]);
    }
  }));
} finally {
  await browser.close();
  try { process.kill(-server.pid); } catch {}
  rmSync('shots/naive-campaign/video-tmp', { recursive: true, force: true });
}

// Workers finish out of order, so restore campaign order before the report and the film.
const order = new Map(targets.map((l, i) => [l.id, i]));
results.sort((a, b) => order.get(a.id) - order.get(b.id));

const won = results.filter((r) => r.outcome === 'won');
const lost = results.filter((r) => r.outcome === 'lost');
const allConfusions = results.flatMap((r) => r.confusions.map((c) => `${r.id} — ${c}`));

const report = [
  `# Naive campaign run — ${MODEL}`,
  '',
  `${results.length} levels attempted. **${won.length} won**, ${lost.length} lost, ` +
  `${results.length - won.length - lost.length} unfinished within ${TURNS} turns.`,
  '',
  '## Per level',
  '',
  '| level | episode | outcome | stars | score | tries | turns | confusions |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => `| \`${r.id}\` | ${r.episode} | ${r.outcome} | ${r.stars} | ${r.score.toLocaleString()} | ${r.attempts} | ${r.turnsUsed} | ${r.confusions.length} |`),
  '',
  '## Critters introduced',
  '',
  ...results.filter((r) => r.introduced).map((r) => `- \`${r.id}\` met **${r.introduced}**`),
  '',
  '## What it could not work out',
  '',
  ...(allConfusions.length ? allConfusions.map((c) => `- ${c}`) : ['- nothing reported']),
  '',
  '## Runtime issues',
  '',
  ...(results.flatMap((r) => r.issues.map((i) => `- \`${r.id}\` ${i}`)) || ['- none']),
].join('\n');
writeFileSync('shots/naive-campaign/report.md', report);

// One film of the whole campaign, in order. Re-encoded rather than stream-copied because
// the per-level webms do not share a timebase and concat would desync without it.
if (VIDEO) {
  const { readdirSync } = await import('node:fs');
  const clips = readdirSync('shots/naive-campaign/video').filter((f) => f.endsWith('.webm')).sort();
  if (clips.length) {
    writeFileSync('shots/naive-campaign/clips.txt',
      clips.map((f) => `file 'video/${f}'`).join('\n'));
    try {
      execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0',
        '-i', 'shots/naive-campaign/clips.txt',
        '-c:v', 'libvpx-vp9', '-b:v', '1M', '-cpu-used', '4',
        'shots/naive-campaign/campaign.webm'],
        { cwd: 'shots/naive-campaign'.startsWith('/') ? undefined : process.cwd(), stdio: 'pipe' });
      console.log('\nfilm: shots/naive-campaign/campaign.webm');
    } catch (e) {
      console.log(`\nffmpeg concat failed: ${String(e.stderr ?? e).slice(-300)}`);
    }
  }
}

console.log(`\n${won.length}/${results.length} won. ${allConfusions.length} confusions. ` +
  `Report: shots/naive-campaign/report.md`);
