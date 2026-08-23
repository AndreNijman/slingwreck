#!/usr/bin/env node
// A naive player. Screenshots the running game, hands the image to a vision model that
// has been told nothing about it, and does whatever the model says to do.
//
// This exists because nobody who has built a game can evaluate its legibility. I know
// the slingshot is a slingshot, that the pale blue blocks are glass, and that pulling
// back and down launches forward and up. A first-time player knows none of that, and the
// gap between those two states is invisible from the inside.
//
// The output that matters is not whether it wins. It is every line it writes under
// CONFUSED — each one is a thing the game failed to communicate.
//
//   node tools/naive-playtest.mjs [--turns 20] [--model stealth/ox-alpha]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const TURNS = Number(opt('turns', 20));
const MODEL = opt('model', 'stealth/ox-alpha');
const KEY = readFileSync('/var/home/andre/special2.special2', 'utf8').trim();

// Deliberately no game knowledge. No mention of slingshots, pigs, physics or aiming.
// The moment this prompt explains anything, the test stops measuring legibility.
const BRIEF = `You are looking at a screenshot of a video game you have never seen before.
Nobody has told you the rules, the goal, or the controls. Work it out from the picture.

Reply in exactly this format and nothing else:

SEE: <what is on screen, in ONE short sentence. Do not list coordinates or describe every block>
THINK: <what you believe the goal is and what you are trying to achieve right now>
CONFUSED: <anything you cannot work out, or "nothing">
ACTION: <one of the actions below>

Available actions, using pixel coordinates from the image you were given:
  CLICK <x> <y>
  DRAG <x1> <y1> <x2> <y2>
  KEY <name>          (a single key such as Space, r, m, Escape)
  WAIT
  DONE                (only if you believe you have finished or are completely stuck)

Keep SEE and THINK to one sentence each so you never run out of room before ACTION.
Be specific in CONFUSED. If you cannot tell what something does, what a number means,
whether an action worked, or what you are supposed to aim at, say so plainly. That is the
most useful thing you can report.`;

async function ask(imageBase64, history) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: BRIEF },
      ...history,
      { role: 'user', content: [
        { type: 'text', text: 'Here is the current screen. What do you do?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
      ] }
    ],
    max_tokens: 1400
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

const field = (text, name) => {
  const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
};

mkdirSync('shots/naive', { recursive: true });
const server = spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3500));

const log = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

try {
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
  const history = [];

  for (let turn = 1; turn <= TURNS; turn++) {
    const shotPath = `shots/naive/turn-${String(turn).padStart(2, '0')}.png`;
    await page.screenshot({ path: shotPath });
    const b64 = readFileSync(shotPath).toString('base64');

    let reply;
    try { reply = await ask(b64, history.slice(-4)); }
    catch (e) { console.error(`turn ${turn}: ${e.message}`); break; }

    const see = field(reply, 'SEE');
    const think = field(reply, 'THINK');
    const confused = field(reply, 'CONFUSED');
    const action = field(reply, 'ACTION');

    console.log(`\n── turn ${turn} ─────────────────────────────`);
    console.log(`SEE      ${see}`);
    console.log(`THINK    ${think}`);
    if (confused && !/^nothing\.?$/i.test(confused)) console.log(`CONFUSED ${confused}`);
    console.log(`ACTION   ${action}`);
    log.push({ turn, see, think, confused, action });

    history.push({ role: 'assistant', content: reply });

    const [verb, ...rest] = action.split(/\s+/);
    const n = rest.map(Number);
    try {
      if (verb === 'CLICK') await page.mouse.click(n[0], n[1]);
      else if (verb === 'DRAG') {
        await page.mouse.move(n[0], n[1]);
        await page.mouse.down();
        await page.mouse.move(n[2], n[3], { steps: 20 });
        await page.waitForTimeout(120);
        await page.mouse.up();
      } else if (verb === 'KEY') await page.keyboard.press(rest[0] ?? 'Space');
      else if (verb === 'DONE') { console.log('\nmodel stopped'); break; }
    } catch (e) {
      console.log(`         (action failed: ${e.message})`);
    }
    await page.waitForTimeout(2600);
  }
} finally {
  await browser.close();
  try { process.kill(-server.pid); } catch {}
}

const confusions = log.filter((l) => l.confused && !/^nothing\.?$/i.test(l.confused));
const report = [
  `# Naive playtest — ${MODEL}`,
  '',
  `${log.length} turns. ${confusions.length} turns reported confusion.`,
  '',
  '## Everything it could not work out',
  '',
  ...confusions.map((l) => `- **turn ${l.turn}** — ${l.confused}`),
  '',
  '## What it thought the game was',
  '',
  ...log.map((l) => `- **turn ${l.turn}** — ${l.think}`),
  '',
  '## Page errors during the session',
  '',
  pageErrors.length ? pageErrors.map((e) => `- ${e}`).join('\n') : '- none',
].join('\n');
writeFileSync('shots/naive/report.md', report);

console.log(`\n${'='.repeat(60)}`);
console.log(`${log.length} turns, ${confusions.length} with confusion. Report: shots/naive/report.md`);
if (pageErrors.length) console.log(`page errors: ${pageErrors.length}`);
