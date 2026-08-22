#!/usr/bin/env node
// The gate. Grows with the project instead of being rewritten each phase.
//
// It deliberately does not fail on modules that do not exist yet: a scaffold has to
// be able to pass its own check, or nobody runs it until phase 6 and by then it is
// checking the wrong things. Missing modules are reported by phase and counted.
//
// What it does fail on is drift between the plan and the code, which is the failure
// mode that actually happens: a file nobody wrote down, a cache stamp updated in
// three files out of four, a `Math.atan2` that crept into the simulation and quietly
// broke cross-engine determinism months before anyone would have noticed.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(readFileSync(join(ROOT, 'docs/FILE-PLAN.json'), 'utf8'));

let failures = 0;
let notes = 0;
const fail = (msg) => { console.error(`  FAIL  ${msg}`); failures++; };
const warn = (msg) => { console.warn(`  warn  ${msg}`); notes++; };
const ok = (msg) => console.log(`  ok    ${msg}`);
const head = (msg) => console.log(`\n${msg}`);

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const here = (rel) => existsSync(join(ROOT, rel));

// ---------------------------------------------------------------- syntax
head('syntax');
const present = plan.modules.filter((m) => here(m.path));
const missing = plan.modules.filter((m) => !here(m.path));
for (const m of present) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, m.path)], { stdio: 'pipe' });
  } catch (e) {
    fail(`${m.path} does not parse\n${e.stderr?.toString() ?? e.message}`);
  }
}
if (present.length) ok(`${present.length} module(s) parse`);
if (missing.length) {
  const byPhase = {};
  for (const m of missing) (byPhase[m.phase] ??= []).push(m.path);
  console.log(`  todo  not written yet: ` +
    Object.entries(byPhase).map(([p, f]) => `${p} (${f.join(', ')})`).join('; '));
}

// ------------------------------------------------------- unplanned files
head('plan coverage');
const planned = new Set(plan.modules.map((m) => m.path));
const stray = readdirSync(ROOT)
  .filter((f) => f.endsWith('.js') && !planned.has(f));
if (stray.length) fail(`unplanned module(s): ${stray.join(', ')}. Add them to docs/FILE-PLAN.json with a budget, or delete them.`);
else ok('no unplanned modules at the root');

// ---------------------------------------------------------- line budgets
head('line budgets');
let overBudget = 0;
for (const m of present) {
  const lines = read(m.path).split('\n').length;
  if (lines > m.budget * 1.3) {
    fail(`${m.path} is ${lines} lines against a budget of ${m.budget}. Split it or move the budget deliberately.`);
    overBudget++;
  } else if (lines > m.budget) {
    warn(`${m.path} is ${lines} lines, over its ${m.budget} budget but inside tolerance`);
  }
}
if (present.length && !overBudget) ok('every written module is inside tolerance');

// --------------------------------------------------- simulation purity
// ARCHITECTURE.md section 3. These are the identifiers that silently break
// cross-engine determinism or drag a browser API into a file the relay runs.
head('simulation purity');
const PURE = ['physics.js', 'sim.js', 'data.js'];
const BANNED = [
  /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|pow|exp|log|log2|log10|hypot|cbrt|random)\b/,
  /\b(document|window|localStorage|WebSocket|fetch|AudioContext|requestAnimationFrame)\b/,
  /\b(Date|performance)\s*\./,
  /\bnew\s+Date\b/,
];
let impure = 0;
for (const f of PURE.filter(here)) {
  const lines = read(f).split('\n');
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('//')) return;
    for (const re of BANNED) {
      const hit = line.match(re);
      if (hit) { fail(`${f}:${i + 1} uses \`${hit[0]}\` — banned in the simulation (ARCHITECTURE.md §3)`); impure++; }
    }
  });
}
if (!impure) ok(`${PURE.filter(here).length || 0} simulation file(s) clean`);

// ------------------------------------------------------- data invariants
// data.js is hand-authored content that three hosts agree on by convention alone.
// These are the ways that convention has already broken once: a shape id that
// collided with an ammo id, and index maps written by hand beside the array they
// index. Both are cheap to assert and expensive to debug in P6.
head('data invariants');
if (here('data.js')) {
  const D = await import(new URL('../data.js', import.meta.url));
  const dupes = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i);

  const ammoIds = D.AMMO.map((a) => a.id);
  const shapeIds = Object.keys(D.SHAPES);
  const pigIds = Object.keys(D.PIGS);
  const matIds = Object.keys(D.MATERIALS);
  const cardIds = D.CARDS.map((c) => c.id);

  for (const [label, ids] of [['ammo', ammoIds], ['card', cardIds]])
    if (dupes(ids).length) fail(`duplicate ${label} id(s): ${dupes(ids).join(', ')}`);

  // Ids from different tables share one wire namespace in blueprints and shot logs.
  const collide = shapeIds.filter((s) => ammoIds.includes(s));
  if (collide.length) fail(`shape id(s) collide with ammo id(s): ${collide.join(', ')} — both are wire format`);

  if (Object.keys(D.AMMO_BY_ID).length !== ammoIds.length) fail('AMMO_BY_ID does not cover AMMO');
  if (Object.keys(D.CARDS_BY_ID).length !== cardIds.length) fail('CARDS_BY_ID does not cover CARDS');
  const tiered = [1, 2, 3].reduce((n, t) => n + D.CARDS_BY_TIER[t].length, 0);
  if (tiered !== cardIds.length) fail(`CARDS_BY_TIER holds ${tiered} of ${cardIds.length} cards`);
  for (const c of D.CARDS) {
    const expect = { 1: 'reinforce', 2: 'dirty', 3: 'desperado' }[c.tier];
    if (c.tierName !== expect) fail(`card ${c.id} is tier ${c.tier} but tierName "${c.tierName}"`);
    if (typeof c.effect !== 'object' || c.effect === null) fail(`card ${c.id} has a non-data effect`);
  }

  // Cross-table references. A card naming a material that does not exist is a P7 bug
  // that would otherwise surface as a silent no-op.
  for (const c of D.CARDS) {
    const e = c.effect;
    if (e.material && !matIds.includes(e.material)) fail(`card ${c.id} references unknown material "${e.material}"`);
    if (e.pig && !pigIds.includes(e.pig)) fail(`card ${c.id} references unknown pig "${e.pig}"`);
    if (e.ammo && !ammoIds.includes(e.ammo)) fail(`card ${c.id} references unknown ammo "${e.ammo}"`);
    for (const a of e.add ?? []) if (!ammoIds.includes(a)) fail(`card ${c.id} adds unknown ammo "${a}"`);
  }

  const kings = pigIds.filter((p) => D.PIGS[p].traits?.king);
  if (kings.length !== 1) fail(`expected exactly one king pig, found ${kings.length}`);
  const scored = Object.keys(D.SCORE.siege.pigs);
  const unscored = pigIds.filter((p) => !D.PIGS[p].traits?.king && !scored.includes(p));
  if (unscored.length) fail(`pig(s) with no siege score: ${unscored.join(', ')}`);
  const phantom = scored.filter((p) => !pigIds.includes(p));
  if (phantom.length) fail(`siege score for unknown pig(s): ${phantom.join(', ')}`);

  for (const [id, s] of Object.entries(D.SHAPES)) {
    const area = s.kind === 'circle' ? 3.141592653589793 * s.r * s.r
      : s.kind === 'tri' ? s.w * s.h / 2 : s.w * s.h;
    if (Math.abs(area - s.area) > 1e-9) fail(`shape ${id} area ${s.area} should be ${area}`);
  }

  const guesses = read('data.js').split('\n').filter((l) => l.includes('// guess')).length;
  ok(`${ammoIds.length} ammo, ${pigIds.length} pigs, ${matIds.length} materials, ${shapeIds.length} shapes, ${cardIds.length} cards`);
  if (guesses) console.log(`  note  ${guesses} value(s) marked \`// guess\` — balance.mjs should revisit these`);
} else {
  console.log('  todo  data.js not written yet');
}

// ----------------------------------------------------------- cache stamp
head('cache stamps');
const stampRe = /\?v=(\d{8}-\d+)/g;
const stamps = new Map();
const stampFiles = ['index.html', ...plan.modules.map((m) => m.path)].filter(here);
for (const f of stampFiles) {
  for (const [, v] of read(f).matchAll(stampRe)) {
    if (!stamps.has(v)) stamps.set(v, []);
    stamps.get(v).push(f);
  }
}
if (stamps.size > 1) {
  fail(`cache stamps disagree: ` +
    [...stamps].map(([v, f]) => `${v} in ${[...new Set(f)].join(', ')}`).join(' | ') +
    `. Run \`npm run stamp\`.`);
} else if (stamps.size === 1) ok(`one stamp everywhere: ${[...stamps.keys()][0]}`);
else console.log('  todo  no stamps yet (no index.html)');

// -------------------------------------------------------- plan and state
head('plan and state');
const state = JSON.parse(read('BUILD_STATE.json'));
const planIds = [...read('docs/BUILD_PLAN.md').matchAll(/^## (P\d) — /gm)].map((m) => m[1]);
const stateIds = state.phases.map((p) => p.id);
if (planIds.join(',') !== stateIds.join(','))
  fail(`BUILD_PLAN.md phases [${planIds}] do not match BUILD_STATE.json [${stateIds}]`);
else ok(`${planIds.length} phases agree between the plan and the state`);
if (!stateIds.includes(state.phase)) fail(`BUILD_STATE.json phase "${state.phase}" is not a known phase`);

// --------------------------------------------------------- headless tests
head('headless tests');
const suites = ['physics-test.mjs', 'sim-test.mjs', 'settle-probe.mjs', 'editor-test.mjs']
  .filter((f) => here(join('tools', f)));
for (const f of suites) {
  try {
    execFileSync(process.execPath, [join(ROOT, 'tools', f)], { stdio: 'inherit' });
    ok(f);
  } catch {
    fail(`${f} failed`);
  }
}
if (!suites.length) console.log('  todo  no headless suites yet (P1 writes the first)');

// ---------------------------------------------------------------- verdict
console.log('');
if (failures) {
  console.error(`check failed: ${failures} problem(s), ${notes} warning(s)`);
  process.exit(1);
}
console.log(`check passed${notes ? `, ${notes} warning(s)` : ''} — phase ${state.phase} (${state.phaseName})`);
