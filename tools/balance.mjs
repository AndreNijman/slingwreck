#!/usr/bin/env node

import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { planShot, shouldTap } from '../bots.js';
import { MATERIALS, SCORE, SHAPES, TUNE } from '../data.js';
import { LEVELS } from '../levels.js';
import { isRoundOver, launch, makeRound, stepRound, tap } from '../sim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS_FILE = join(ROOT, 'levels.js');
const SEEDS = Object.freeze([0x51a9, 0x9e37, 0xc0de, 0xb07, 0x5eed, 0xa11ce, 0xf00d]);
const BOT_DIFFICULTY = 0.98;
const SINGLE_SOLUTION_FRACTION = 0.01;
const SINGLE_SOLUTION_POINTS = 500;
const STAR_COMMENT_START = '// balance-stars:start';
const STAR_COMMENT_END = '// balance-stars:end';

function usage(message = null) {
  if (message) console.error(message);
  console.error('usage: node tools/balance.mjs --campaign [--import]');
  process.exitCode = 2;
}

function preflight(round) {
  const steps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
  for (let index = 0; index < steps && !isRoundOver(round); index++) {
    stepRound(round, TUNE.step);
  }
}

export function playLevel(level, seed, difficulty = BOT_DIFFICULTY) {
  const round = makeRound({
    mode: 'campaign',
    seed,
    bag: level.bag,
    blueprint: level.blueprint
  });
  preflight(round);
  let stalled = null;

  while (!isRoundOver(round)) {
    if (round.phase !== 'aiming') {
      stalled = `unexpected phase ${round.phase} before shot`;
      break;
    }
    const plan = planShot(round, difficulty, round.rng);
    if (!plan) {
      stalled = 'no target candidate';
      break;
    }
    if (!launch(round, plan.aim.dx, plan.aim.dy)) {
      stalled = 'launch rejected';
      break;
    }
    let tapped = false;
    const shotStart = round.stepCount;
    const maxSteps = Math.ceil((TUNE.settleTimeout + TUNE.step * 4) / TUNE.step);
    while (!isRoundOver(round) && round.phase !== 'aiming') {
      if (!tapped && shouldTap(round, plan)) tapped = tap(round);
      stepRound(round, TUNE.step);
      if (round.stepCount - shotStart > maxSteps) {
        stalled = `shot exceeded ${maxSteps} fixed steps`;
        break;
      }
    }
    if (stalled) break;
  }

  const survivors = round.pigs.filter((pig) => !pig.dead).map((pig) =>
    `${pig.pigId}#${pig.blueprintIndex}`);
  return {
    seed,
    completed: round.phase === 'won',
    crittersLeft: round.bag.length - round.shotIndex,
    score: round.score,
    shots: round.shots.length,
    survivors,
    stalled
  };
}

function median(values) {
  if (!values.length) return NaN;
  const ordered = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function maximumCampaignScore(level) {
  let destroyed = 0;
  for (const tuple of level.blueprint.blocks) {
    destroyed += SHAPES[tuple[0]].area * MATERIALS[tuple[1]].cost;
  }
  return Math.max(0, level.bag.length - 1) * SCORE.campaign.unusedAmmo +
    level.blueprint.pigs.length * SCORE.campaign.pig +
    destroyed * SCORE.campaign.destroyedBlockCostMultiplier;
}

function deriveStars(level, trials) {
  const clears = trials.filter((trial) => trial.completed);
  if (!clears.length) return null;
  const clearScores = clears.map((trial) => trial.score);
  const competent = median(clearScores);
  const best = Math.max(...clearScores);
  const one = level.blueprint.pigs.length * SCORE.campaign.pig;
  const two = Math.max(one + 100, Math.floor(competent / 100) * 100);
  const three = Math.max(two + 100, (Math.floor(best / 100) + 1) * 100);
  return { stars: [one, two, three], median: competent, best,
    maximum: maximumCampaignScore(level) };
}

function analyseLevel(level) {
  const trials = SEEDS.map((seed) => playLevel(level, seed));
  const clears = trials.filter((trial) => trial.completed);
  const spareClears = clears.filter((trial) => trial.crittersLeft >= 1);
  const scores = clears.map((trial) => trial.score);
  const shots = trials.map((trial) => trial.shots);
  const stars = deriveStars(level, trials);
  const firstSpareClear = trials.findIndex((trial) =>
    trial.completed && trial.crittersLeft >= 1);
  const nearIdentical = Boolean(stars) && stars.best - stars.median <=
    Math.max(SINGLE_SOLUTION_POINTS, stars.best * SINGLE_SOLUTION_FRACTION);
  return {
    level,
    trials,
    clears,
    spareClears,
    firstSpareClear,
    bestScore: scores.length ? Math.max(...scores) : NaN,
    medianScore: median(scores),
    bestSpare: spareClears.length ? Math.max(...spareClears.map((trial) => trial.crittersLeft)) : -1,
    medianShots: median(shots),
    minShots: Math.min(...shots),
    maxShots: Math.max(...shots),
    stars,
    nearIdentical
  };
}

function formatScore(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-AU') : '—';
}

function sameStars(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function printCampaign(rows) {
  console.log(`campaign bot: ${SEEDS.length} seeds, difficulty ${BOT_DIFFICULTY}`);
  console.log('level    clear  spare  score median/best     shots min/med/max  failed pig survivors');
  for (const row of rows) {
    const failed = row.trials.filter((trial) => !trial.completed);
    const survivors = [...new Set(failed.flatMap((trial) => trial.survivors))].join(',') || '—';
    console.log(`${row.level.id.padEnd(9)}${`${row.clears.length}/${SEEDS.length}`.padStart(5)}  ` +
      `${(row.bestSpare >= 0 ? row.bestSpare : '—').toString().padStart(5)}  ` +
      `${`${formatScore(row.medianScore)}/${formatScore(row.bestScore)}`.padStart(20)}  ` +
      `${`${row.minShots}/${row.medianShots}/${row.maxShots}`.padStart(17)}  ${survivors}`);
  }

  console.log('\nstar thresholds (1★ completion floor; 2★ bot median; 3★ > bot best)');
  console.log('level       one       two     three  bot median  bot best');
  for (const row of rows) {
    if (!row.stars) {
      console.log(`${row.level.id.padEnd(9)}${'UNWINNABLE'.padStart(28)}`);
      continue;
    }
    const [one, two, three] = row.stars.stars;
    console.log(`${row.level.id.padEnd(9)}${formatScore(one).padStart(9)}` +
      `${formatScore(two).padStart(10)}${formatScore(three).padStart(10)}` +
      `${formatScore(row.stars.median).padStart(12)}${formatScore(row.stars.best).padStart(10)}`);
  }
}

function starComment() {
  return `${STAR_COMMENT_START}\n` +
    `// P5.8 provenance: tools/balance.mjs --campaign, seeds ${SEEDS.join(', ')}.\n` +
    '// Formula: 1★ = pig count × 5,000 (the completion floor); 2★ = the median bot\n' +
    '// clear rounded down to 100; 3★ = the first 100-point step strictly above its best.\n' +
    `${STAR_COMMENT_END}`;
}

export function rewriteStarSource(source, rows) {
  let rewritten = source;
  const comment = starComment();
  const existingStart = rewritten.indexOf(STAR_COMMENT_START);
  const existingEnd = rewritten.indexOf(STAR_COMMENT_END);
  if (existingStart >= 0 && existingEnd > existingStart) {
    rewritten = rewritten.slice(0, existingStart) + comment +
      rewritten.slice(existingEnd + STAR_COMMENT_END.length);
  } else {
    const marker = 'export const LEVELS = [';
    const at = rewritten.indexOf(marker);
    if (at < 0) throw new Error('levels.js has no LEVELS export marker');
    rewritten = rewritten.slice(0, at) + comment + '\n\n' + rewritten.slice(at);
  }

  for (const row of rows) {
    if (!row.stars) throw new Error(`cannot import stars for unwinnable ${row.level.id}`);
    const idMarker = `id: '${row.level.id}'`;
    const start = rewritten.indexOf(idMarker);
    if (start < 0 || rewritten.indexOf(idMarker, start + idMarker.length) >= 0) {
      throw new Error(`levels.js needs exactly one record for ${row.level.id}`);
    }
    const next = rewritten.indexOf('\n  {', start + idMarker.length);
    const end = next < 0 ? rewritten.indexOf('\n];', start) : next;
    const segment = rewritten.slice(start, end);
    const matches = [...segment.matchAll(/\bstars:\s*(?:null|\[[^\]\n]*\])/g)];
    if (matches.length !== 1) {
      throw new Error(`${row.level.id} needs exactly one writable stars field`);
    }
    const match = matches[0];
    const replacement = `stars: [${row.stars.stars.join(', ')}]`;
    const absolute = start + match.index;
    rewritten = rewritten.slice(0, absolute) + replacement +
      rewritten.slice(absolute + match[0].length);
  }
  return rewritten;
}

function atomicWrite(path, contents, mode) {
  const temporary = `${path}.balance-${process.pid}`;
  try {
    writeFileSync(temporary, contents, 'utf8');
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch (unused) { /* nothing to clean up */ }
    throw error;
  }
}

async function importStars(rows) {
  const before = readFileSync(LEVELS_FILE, 'utf8');
  const mode = statSync(LEVELS_FILE).mode;
  const after = rewriteStarSource(before, rows);
  if (after === before) {
    console.log('\nlevels.js stars already match this campaign run.');
    return;
  }
  atomicWrite(LEVELS_FILE, after, mode);
  try {
    const url = pathToFileURL(LEVELS_FILE);
    url.searchParams.set('balance', String(process.pid));
    const updated = await import(url.href);
    for (const row of rows) {
      const level = updated.LEVELS.find((candidate) => candidate.id === row.level.id);
      if (!level || !sameStars(level.stars, row.stars.stars)) {
        throw new Error(`${row.level.id} failed its star import verification`);
      }
    }
  } catch (error) {
    atomicWrite(LEVELS_FILE, before, mode);
    throw error;
  }
  console.log('\nimported 52 derived star rows into levels.js and verified them.');
}

async function campaign(writeStars) {
  const rows = LEVELS.map(analyseLevel);
  printCampaign(rows);
  const failures = [];
  for (const row of rows) {
    if (!row.clears.length) failures.push(`${row.level.id}: bot never completed it`);
    else if (!row.spareClears.length) failures.push(`${row.level.id}: no clear left a critter spare`);
    if (row.stars && row.stars.stars[2] > row.stars.maximum) {
      failures.push(`${row.level.id}: 3★ ${row.stars.stars[2]} exceeds theoretical maximum ` +
        `${row.stars.maximum}`);
    }
    if (!writeStars && row.stars && !sameStars(row.level.stars, row.stars.stars)) {
      failures.push(`${row.level.id}: levels.js stars do not match derived bot data`);
    }
  }

  const singleSolution = rows.filter((row) => row.nearIdentical).map((row) => row.level.id);
  const laterSeed = rows.filter((row) => row.firstSpareClear > 0).map((row) =>
    `${row.level.id} (seed ${row.firstSpareClear + 1}/${SEEDS.length})`);
  console.log(`\nnear-identical best/median: ${singleSolution.join(', ') || 'none'}`);
  console.log(`needed more than one seed: ${laterSeed.join(', ') || 'none'}`);

  if (failures.length) {
    console.error('\ncampaign balance failed:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (writeStars) await importStars(rows);
  console.log(`\ncampaign balance passed: ${rows.length}/${rows.length} levels clear with a spare critter.`);
}

async function main(args) {
  const writeStars = args.includes('--import');
  if (!args.includes('--campaign') || args.some((arg) => arg !== '--campaign' && arg !== '--import')) {
    usage();
    return;
  }
  await campaign(writeStars);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
