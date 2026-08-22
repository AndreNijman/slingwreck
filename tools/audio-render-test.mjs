#!/usr/bin/env node
// Renders every sim event kind through `audio.js` offline and measures it.
//
// `tools/check.mjs` already asserts that every kind in `EVENT_KINDS` has an entry in
// `EVENT_SOUNDS`. That proves a handler *exists*. It does not prove the handler makes
// any sound, and a handler that quietly renders silence passes it — which is the same
// failure the coverage check was written to prevent, one level further down.
//
// So this renders each kind in isolation through a real WebAudio graph and asserts the
// output is audible, is not clipping, and actually stops. `settled` is the declared
// silence and is asserted to be silent, because an intentional silence should be
// verified too rather than merely tolerated.

import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };

let failures = 0;
const report = (name, passed, measurement) => {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${measurement}`);
  if (!passed) failures++;
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/blank') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><meta charset="utf-8"><title>audio</title>');
  }
  let body;
  try { body = fs.readFileSync(path.join(ROOT, url)); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(url)] ?? 'text/plain' });
  res.end(body);
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
let browser;

try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/blank`);

  const results = await page.evaluate(async (port) => {
    const audio = await import(`http://127.0.0.1:${port}/audio.js`);
    const sim = await import(`http://127.0.0.1:${port}/sim.js`);

    // A representative payload per kind, not one generic blob. Loudness legitimately
    // varies with material and impulse — `hit` scales with the impulse and `shatter`
    // only gets its bright glass bursts when the material is glass — so feeding every
    // handler the same event measures the payload rather than the handler.
    const base = { x: 4, y: 3, r: 3.2, impulse: 40, mat: 'wood', shape: 'cube',
      pig: 'swine', ammo: 'lob', ability: 'boom' };
    const PAYLOAD = {
      shatter: { mat: 'glass' },
      crumble: { mat: 'sand' },
      'stone-split': { mat: 'stone' },
      // `amount` is the damage the gel swallowed and it drives the level. Omitting it
      // renders the floor — the sound of gel absorbing almost nothing — which is
      // correctly near-silent and tells us nothing about the handler.
      'gel-absorb': { mat: 'gel', amount: 20 },
      hit: { impulse: 40, mat: 'stone' }
    };
    const sample = (kind) => ({ ...base, ...(PAYLOAD[kind] ?? {}), kind });

    const SECONDS = 2.5;
    const RATE = 44100;
    const out = [];

    for (const kind of sim.EVENT_KINDS) {
      // audio.js builds its context from the global, so hand it an offline one.
      const Real = globalThis.AudioContext;
      globalThis.AudioContext = class extends OfflineAudioContext {
        constructor() {
          super(1, Math.ceil(RATE * SECONDS), RATE);
          // `pushEvents` refuses to schedule into a context that is not `running`,
          // which is correct in production — scheduling into a suspended context is how
          // sounds pile up and then all fire at once when the user finally interacts.
          // An OfflineAudioContext reports `suspended` until `startRendering`, so the
          // guard would reject every event here. Report `running` to the code under
          // test; the graph and the scheduling are otherwise completely real.
          Object.defineProperty(this, 'state', { get: () => 'running', configurable: true });
        }
      };
      let peak = 0, rms = 0, tail = 0, error = null;
      try {
        const a = audio.makeAudio();
        await audio.unlock(a);
        audio.pushEvents(a, [sample(kind)]);
        const buffer = await a.context.startRendering();
        const data = buffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
          sum += data[i] * data[i];
        }
        rms = Math.sqrt(sum / data.length);
        // Energy in the final quarter second: a sound that never stops is a stuck voice.
        let tailSum = 0;
        const from = data.length - Math.floor(RATE * 0.25);
        for (let i = from; i < data.length; i++) tailSum += data[i] * data[i];
        tail = Math.sqrt(tailSum / Math.floor(RATE * 0.25));
      } catch (e) {
        error = String(e && e.message ? e.message : e);
      } finally {
        globalThis.AudioContext = Real;
      }
      out.push({ kind, peak, rms, tail, error });
    }
    return out;
  }, port);

  const SILENT_BY_DESIGN = new Set(['settled']);

  for (const r of results) {
    if (r.error) { report(`${r.kind}`, false, `threw: ${r.error}`); continue; }
    const silent = SILENT_BY_DESIGN.has(r.kind);
    const measurement = `peak ${r.peak.toFixed(4)}, rms ${r.rms.toFixed(5)}, tail ${r.tail.toFixed(5)}`;
    if (silent) {
      report(`${r.kind} (declared silent)`, r.peak === 0, `${measurement}; expected exactly 0`);
      continue;
    }
    // Peak, not RMS. Every sound here is short by design, so RMS over a fixed 2.5 s
    // window mostly measures how much silence follows it and would flag a crisp glass
    // tick as quieter than a dull thud twice its length. The bar is deliberately low:
    // this test exists to catch a handler that makes *no* sound, which is the failure
    // that hides. Judging the mix is a job for ears, and the levels are printed so a
    // human can do that.
    const audible = r.peak > 0.002;
    const clipping = r.peak > 0.999;
    const stuck = r.tail > 0.002;
    report(r.kind, audible && !clipping && !stuck,
      `${measurement}${audible ? '' : '; SILENT'}${clipping ? '; CLIPPING' : ''}${stuck ? '; STILL RINGING at 2.5 s' : ''}`);
  }

  if (pageErrors.length) report('page errors', false, pageErrors.join(' | '));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

console.log('');
if (failures) {
  console.error(`${failures} audio render assertion(s) failed.`);
  process.exit(1);
}
console.log('Every event kind renders audibly, without clipping, and stops.');
