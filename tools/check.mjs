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
const suites = ['physics-test.mjs', 'sim-test.mjs', 'editor-test.mjs']
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
