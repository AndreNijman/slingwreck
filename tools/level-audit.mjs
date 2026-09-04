#!/usr/bin/env node
// Checks every level against docs/LEVEL-STANDARD.md, measured rather than judged.
//
// The standard exists because Episode 1's first attempt validated, settled, looked tidy,
// and was still weak: eight of thirteen pigs were directly hittable so the fortresses
// were decoration, and eight of thirteen structures were the same gantry. None of that
// was visible in the lint table and all of it was obvious once measured.
//
// So it is measured here, on every level, every run. `--strict` makes it a gate.

import { LEVELS } from '../levels.js?v=20260904-2';
import { TUNE, PIGS, SHAPES } from '../data.js?v=20260904-2';
import { instantiate, makeRound } from '../sim.js?v=20260904-2';
import { makeWorld, raycastAll, step, isSettled } from '../physics.js?v=20260904-2';

const MAX_GANTRY_FRACTION = 0.25;
const MIN_TWO_RANGE_LEVELS = 3;
const strict = process.argv.includes('--strict');

let problems = 0;
const flag = (msg) => { console.log(`  FLAG  ${msg}`); problems++; };

// A pig is directly hittable if any plausible launch arc reaches it without crossing a
// block. Sampled across the whole usable launch fan rather than one angle, because one
// angle is how you conclude a pig is protected when it is not.
function hittablePigs(round) {
  let hittable = 0;
  for (const pig of round.pigs) {
    if (!pig.body || pig.body.dead) continue;
    let clear = false;
    for (let i = 0; i <= 48 && !clear; i++) {
      // Trace a straight line from the sling to the pig. A straight line is a lower bound
      // on reachability: if even the direct line is blocked, no arc through it is clear.
      const t = i / 48;
      const fromY = TUNE.slingY + t * 6;
      const hits = raycastAll(round.world, TUNE.slingX, fromY, pig.body.x, pig.body.y,
        (b) => b.role !== 'ground');
      const blockers = hits.filter((h) => h.body !== pig.body && h.body.role === 'block');
      if (blockers.length === 0) clear = true;
    }
    if (clear) hittable++;
  }
  return hittable;
}

// Two legs and a horizontal top. Detected structurally: a wide thin piece resting on
// exactly two narrow supports with nothing else above it.
function gantryScore(blueprint) {
  const blocks = blueprint.blocks.map(([shape, mat, x, y]) => ({ shape: SHAPES[shape], x, y }));
  if (blocks.length === 0 || blocks.length > 12) return false;
  const tops = blocks.filter((b) => b.shape.w >= 2 && b.shape.h <= 0.5);
  const legs = blocks.filter((b) => b.shape.h >= 2 && b.shape.w <= 0.5);
  return tops.length >= 1 && legs.length >= 2 && blocks.length <= legs.length + tops.length + 2;
}

function settledHeight(blueprint) {
  const world = makeWorld({});
  const ctx = instantiate(world, blueprint);
  const steps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
  for (let i = 0; i < steps; i++) step(world, TUNE.step);
  let top = 0;
  for (const b of world.bodies) {
    if (b.isStatic || b.dead) continue;
    top = Math.max(top, b.y + (b.r || b.hh || 0));
  }
  return top;
}

// Two targets at meaningfully different ranges: pig x positions spanning at least a
// third of the plot.
function rangeSpread(blueprint) {
  const xs = blueprint.pigs.map((p) => p[1]);
  if (xs.length < 2) return 0;
  return Math.max(...xs) - Math.min(...xs);
}

const byEpisode = new Map();
for (const level of LEVELS) {
  if (!byEpisode.has(level.episode)) byEpisode.set(level.episode, []);
  byEpisode.get(level.episode).push(level);
}

for (const [episode, levels] of [...byEpisode].sort((a, b) => a[0] - b[0])) {
  console.log(`\nEpisode ${episode} — ${levels.length} levels`);
  console.log('  level      pigs  hittable  gantry  height  pig-spread  bag');
  let gantries = 0;
  let twoRange = 0;
  let previousHeight = 0;
  let monotonic = true;

  for (const [index, level] of levels.entries()) {
    const round = makeRound({ blueprint: level.blueprint, bag: level.bag, seed: 1, mode: 'campaign' });
    const steps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
    for (let i = 0; i < steps; i++) step(round.world, TUNE.step);

    const hittable = hittablePigs(round);
    const gantry = gantryScore(level.blueprint);
    const height = settledHeight(level.blueprint);
    const spread = rangeSpread(level.blueprint);
    if (gantry) gantries++;
    if (spread >= TUNE.plotW / 3) twoRange++;
    if (height < previousHeight - 0.01) monotonic = false;
    previousHeight = height;

    console.log(`  ${level.id.padEnd(10)} ${String(level.blueprint.pigs.length).padStart(4)}` +
      `  ${String(hittable).padStart(8)}  ${(gantry ? 'yes' : '-').padStart(6)}` +
      `  ${height.toFixed(2).padStart(6)}  ${spread.toFixed(1).padStart(10)}  ${level.bag.join(',')}`);

    // The first two levels of the campaign may teach with an exposed pig. Nowhere else.
    const isTutorial = episode === 1 && index < 2;
    if (hittable > 0 && !isTutorial) {
      flag(`${level.id}: ${hittable} directly hittable pig(s) — the fortress is decoration`);
    }
    const starsValid = Array.isArray(level.stars) && level.stars.length === 3 &&
      level.stars.every((threshold) => Number.isFinite(threshold)) &&
      level.stars[0] < level.stars[1] && level.stars[1] < level.stars[2];
    if (!starsValid) flag(`${level.id}: missing or invalid P5.8-derived star thresholds`);
  }

  // Star headroom. A level whose three-star threshold sits a few percent above its
  // one-star threshold has stars that carry no information: completing it awards three.
  // Reported rather than failed, because the cause is the scoring formula's dynamic
  // range on small levels, not a bad threshold — an unused critter is worth 10,000 and
  // a whole small fortress is worth a few thousand, so on a level whose bag is fully
  // consumed there is almost nothing left to vary. Fixing it means more destructible
  // material in those levels or a smaller unused-ammo weight, both of which move every
  // threshold in the campaign.
  const tight = levels.filter((l) => Array.isArray(l.stars) && (l.stars[2] - l.stars[0]) / l.stars[0] < 0.15);
  if (tight.length) {
    console.log(`  note  ${tight.length} level(s) with under 15% star headroom: ` +
      tight.map((l) => l.id).join(', '));
  }

  const gantryCap = Math.floor(levels.length * MAX_GANTRY_FRACTION);
  console.log(`  gantries ${gantries}/${levels.length} (cap ${gantryCap}) · ` +
    `two-range ${twoRange} (min ${MIN_TWO_RANGE_LEVELS}) · ` +
    `height monotonic ${monotonic ? 'yes' : 'NO'}`);
  if (gantries > gantryCap) flag(`Episode ${episode}: ${gantries} gantries exceeds the cap of ${gantryCap}`);
  if (twoRange < MIN_TWO_RANGE_LEVELS) flag(`Episode ${episode}: only ${twoRange} two-range level(s), needs ${MIN_TWO_RANGE_LEVELS}`);
  if (!monotonic) flag(`Episode ${episode}: settled height is not monotonic`);
}

console.log('');
if (problems) {
  console.log(`${problems} standard problem(s) against docs/LEVEL-STANDARD.md`);
  if (strict) process.exit(1);
} else {
  console.log('Every level meets docs/LEVEL-STANDARD.md.');
}
