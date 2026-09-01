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

import { fortressForBudget, planShot, shouldTap } from '../bots.js';
import {
  BUDGET,
  CARDS,
  MATERIALS,
  SCORE,
  SHAPES,
  TUNE
} from '../data.js';
import {
  budgetFor,
  earlyLockScrap,
  fromBlueprint,
  place,
  settleTest,
  spent,
  toBlueprint,
  undo,
  validate
} from '../build.js';
import { LEVELS } from '../levels.js';
import { removeBody, rng } from '../physics.js';
import {
  beginSuddenDeath,
  finalizeSiegeScore,
  isRoundOver,
  launch,
  makeRound,
  remoteDetonate,
  stepRound,
  tap
} from '../sim.js';
import {
  bagForRound,
  defaultDraftPick,
  matchWinner,
  previewInterval,
  resolveRound,
  rollDraft
} from '../relay-audit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS_FILE = join(ROOT, 'levels.js');
const SEEDS = Object.freeze([0x51a9, 0x9e37, 0xc0de, 0xb07, 0x5eed, 0xa11ce, 0xf00d]);
const BOT_DIFFICULTY = 0.98;
const SINGLE_SOLUTION_FRACTION = 0.03;
const SINGLE_SOLUTION_MARGIN_CAP = 500;
const STAR_COMMENT_START = '// balance-stars:start';
const STAR_COMMENT_END = '// balance-stars:end';
const SIEGE_N_DEFAULT = 400;
const SIEGE_BOT_DIFFICULTY = 0.82;
const PARITY_SEED = 0x51a9c0de;
const NATURAL_SEED = 0x9e375eed;
const CONTROL_LOW = 0.45;
const CONTROL_HIGH = 0.55;
const CARD_LOW = 0.40;
const CARD_HIGH = 0.65;
const POINTS_HIGH = 0.70;
const Z_95 = 1.959963984540054;
const REASONS = [
  'king-pop', 'score', 'sudden-death-damage', 'fortress-cost', 'unresolved'
];
// Everything past a plain score comparison, grouped for the per-card explain
// table: the "sudden-death/fortress-cost tail" the P7.8 spec asks to separate
// from a clean king-pop or score decision.
const TAIL_REASONS = ['sudden-death-damage', 'fortress-cost', 'unresolved'];
const BREAKDOWN_KEYS = ['destroyedBlocks', 'offPlotBlocks', 'pigs', 'unused', 'breach'];
const fortressCache = new Map();

function usage(message = null) {
  if (message) console.error(message);
  console.error('usage: node tools/balance.mjs --campaign [--import]');
  console.error('       node tools/balance.mjs --siege [-n N] [--no-lane-respend]');
  console.error('       --no-lane-respend: airlift still opens its King-balloon flight');
  console.error('       lane, but the harness does not respend the scrap that lane frees.');
  console.error('       Omitting it is byte-identical to today. Diagnostic only — it does');
  console.error('       not change 40/65/70 or which run exits non-zero.');
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
  const standingBlockScores = round.blocks.filter((block) => !block.dead).map((block) =>
    block.shape.area * block.mat.cost * SCORE.campaign.destroyedBlockCostMultiplier);
  return {
    seed,
    completed: round.phase === 'won',
    crittersLeft: round.bag.length - round.shotIndex,
    score: round.score,
    shots: round.shots.length,
    standingBlockScores,
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
  let two = Math.max(one + 100, Math.floor(competent / 100) * 100);
  const singleSolution = best - competent <= competent * SINGLE_SOLUTION_FRACTION;
  let three;
  let structureMargin = null;
  let atBest = false;
  if (singleSolution) {
    const bestTrials = clears.filter((trial) => trial.score === best);
    const cheapestStanding = Math.min(...bestTrials.flatMap((trial) =>
      trial.standingBlockScores));
    if (Number.isFinite(cheapestStanding)) {
      structureMargin = Math.min(SINGLE_SOLUTION_MARGIN_CAP, cheapestStanding);
      three = best + structureMargin;
    } else {
      three = best;
      atBest = true;
      // Preserve three ascending thresholds when the median and best coincide.
      two = Math.min(two, best - 100);
    }
  } else {
    three = Math.max(two + 100, (Math.floor(best / 100) + 1) * 100);
  }
  if (!(one < two && two < three)) {
    throw new Error(`${level.id}: cannot derive ascending stars from ${one}/${two}/${three}`);
  }
  return { stars: [one, two, three], median: competent, best,
    maximum: maximumCampaignScore(level), singleSolution, structureMargin, atBest };
}

function analyseLevel(level) {
  const trials = SEEDS.map((seed) => playLevel(level, seed));
  const clears = trials.filter((trial) => trial.completed);
  const scores = clears.map((trial) => trial.score);
  const shots = trials.map((trial) => trial.shots);
  const stars = deriveStars(level, trials);
  const firstClear = trials.findIndex((trial) => trial.completed);
  return {
    level,
    trials,
    clears,
    firstClear,
    bestScore: scores.length ? Math.max(...scores) : NaN,
    medianScore: median(scores),
    bestRemaining: clears.length ? Math.max(...clears.map((trial) => trial.crittersLeft)) : -1,
    medianShots: median(shots),
    minShots: Math.min(...shots),
    maxShots: Math.max(...shots),
    stars
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
  console.log('level    clear   left  score median/best     shots min/med/max  failed pig survivors');
  for (const row of rows) {
    const failed = row.trials.filter((trial) => !trial.completed);
    const survivors = [...new Set(failed.flatMap((trial) => trial.survivors))].join(',') || '—';
    console.log(`${row.level.id.padEnd(9)}${`${row.clears.length}/${SEEDS.length}`.padStart(5)}  ` +
      `${(row.bestRemaining >= 0 ? row.bestRemaining : '—').toString().padStart(5)}  ` +
      `${`${formatScore(row.medianScore)}/${formatScore(row.bestScore)}`.padStart(20)}  ` +
      `${`${row.minShots}/${row.medianShots}/${row.maxShots}`.padStart(17)}  ${survivors}`);
  }

  console.log('\nstar thresholds (1★ completion floor; 2★ bot median; 3★ mastery target)');
  console.log('level       one       two     three  bot median  bot best  3★ basis');
  for (const row of rows) {
    if (!row.stars) {
      console.log(`${row.level.id.padEnd(9)}${'UNWINNABLE'.padStart(28)}`);
      continue;
    }
    const [one, two, three] = row.stars.stars;
    const basis = row.stars.atBest ? 'at best (no structure)' :
      row.stars.singleSolution ? `+${formatScore(row.stars.structureMargin)} structure` :
        'next 100 above best';
    console.log(`${row.level.id.padEnd(9)}${formatScore(one).padStart(9)}` +
      `${formatScore(two).padStart(10)}${formatScore(three).padStart(10)}` +
      `${formatScore(row.stars.median).padStart(12)}${formatScore(row.stars.best).padStart(10)}  ` +
      basis);
  }
}

function starComment() {
  return `${STAR_COMMENT_START}\n` +
    `// P5.8 provenance: tools/balance.mjs --campaign, seeds ${SEEDS.join(', ')}.\n` +
    '// Formula: 1★ = pig count × 5,000 (the completion floor); 2★ = the median bot\n' +
    '// clear rounded down to 100; normally 3★ = the first 100-point step above its best.\n' +
    '// If best is within 3% of median, 3★ = best + the cheaper of 500 or the least\n' +
    '// valuable block left by a best run. If none remains, 3★ = best (and 2★ steps down).\n' +
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
    if (row.stars && row.stars.stars[2] > row.stars.maximum) {
      failures.push(`${row.level.id}: 3★ ${row.stars.stars[2]} exceeds theoretical maximum ` +
        `${row.stars.maximum}`);
    }
    if (!writeStars && row.stars && !sameStars(row.level.stars, row.stars.stars)) {
      failures.push(`${row.level.id}: levels.js stars do not match derived bot data`);
    }
  }

  const zeroRemaining = rows.filter((row) => row.bestRemaining === 0).map((row) => row.level.id);
  const singleSolution = rows.filter((row) => row.stars?.singleSolution).map((row) => row.level.id);
  const atBest = rows.filter((row) => row.stars?.atBest).map((row) => row.level.id);
  const laterSeed = rows.filter((row) => row.firstClear > 0).map((row) =>
    `${row.level.id} (seed ${row.firstClear + 1}/${SEEDS.length})`);
  console.log(`\nzero critters remaining: ${zeroRemaining.join(', ') || 'none'}`);
  console.log(`single-solution (best within 3% of median): ${singleSolution.join(', ') || 'none'}`);
  console.log(`3★ at bot best: ${atBest.join(', ') || 'none'}`);
  console.log(`needed more than one seed: ${laterSeed.join(', ') || 'none'}`);

  if (failures.length) {
    console.error('\ncampaign balance failed:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (writeStars) await importStars(rows);
  console.log(`\ncampaign balance passed: bot completed ${rows.length}/${rows.length} levels.`);
}

function nonZeroSeed(value) {
  const seed = value >>> 0;
  return seed === 0 ? 0x9e3779b9 : seed;
}

function seedWord(seed, salt) {
  const random = rng(nonZeroSeed((seed ^ Math.imul(salt + 1, 0x45d9f3b)) | 0));
  return nonZeroSeed(Math.floor(random() * 0x100000000));
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function wilson95(wins, total) {
  if (!total) return [0, 1];
  const rate = wins / total;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / total;
  const centre = (rate + z2 / (2 * total)) / denominator;
  const radius = Z_95 / denominator * Math.sqrt(
    rate * (1 - rate) / total + z2 / (4 * total * total)
  );
  return [Math.max(0, centre - radius), Math.min(1, centre + radius)];
}

function cardIds(cards) {
  return cards.length ? cards.join(',') : 'none';
}

function zeroBreakdown() {
  return Object.fromEntries(BREAKDOWN_KEYS.map((key) => [key, 0]));
}

function addBreakdown(total, part) {
  for (const key of BREAKDOWN_KEYS) total[key] += part[key] ?? 0;
}

function blueprintFailure(label, result) {
  return `${label}: ${result.errors.map((entry) =>
    `${entry.code} [${entry.pieceIds.join(',') || 'no piece ids'}]`).join('; ')}`;
}

function buildFortress({ round, baseBudget, cards, templateIndex, seed, noLaneRespend = false }) {
  const key = `${round}|${baseBudget}|${cards.join(',')}|${templateIndex}|` +
    (noLaneRespend ? 'no-respend' : 'respend');
  const cached = fortressCache.get(key);
  if (cached) return cached;

  const initial = fortressForBudget(baseBudget, templateIndex);
  const draft = fromBlueprint(initial.blueprint, { round, budget: baseBudget, cards });
  const effects = cards.map((id) => CARDS.find((card) => card.id === id)?.effect)
    .filter(Boolean);
  // The stock templates flank the King with posts. Airlift's authored 1.5-unit
  // drift would drive the balloon-carried King through them, so its card-aware
  // version opens that flight lane before spending the released scrap elsewhere.
  // --no-lane-respend (below) keeps the lane open but withholds that respend, so
  // the harness can measure whether the respend — not the balloon — was carrying
  // the card's parity numbers.
  let laneCredit = 0;
  if (effects.some((effect) => effect.kind === 'kingBalloon')) {
    const beforeLane = spent(draft);
    draft.pieces = draft.pieces.filter((piece) =>
      piece.kind !== 'block' || piece.x < 10 || piece.x > 14);
    if (noLaneRespend) laneCredit = beforeLane - spent(draft);
  }
  const addPig = (source, label) => {
    const result = place(draft, source);
    if (!result.ok) throw new Error(
      `harness build rejected ${label} for [${cardIds(cards)}]: ${result.reason}`
    );
  };
  if (effects.some((effect) => effect.kind === 'decoyKing')) {
    const x = initial.template === 'low-keep' ? 6 : 9;
    addPig({ pig: 'king', decoy: true, x, y: TUNE.plotH }, 'Decoy King');
  }
  if (effects.some((effect) => effect.kind === 'pigAbility' && effect.ability === 'flak')) {
    const x = initial.template === 'low-keep' ? 18 : 15;
    addPig({ pig: 'runt', flak: true, x, y: TUNE.plotH }, 'Flak Hog');
  }

  const blockCost = (material, shape) =>
    (effects.find((effect) =>
      effect.kind === 'materialCost' && effect.material === material)?.cost ??
      MATERIALS[material].cost) * SHAPES[shape].area;
  const groundSources = (shape) => {
    const sources = [];
    const airlift = effects.some((effect) => effect.kind === 'kingBalloon');
    const add = (source) => {
      if (!airlift || source.x < 9.5 || source.x > 14.5) sources.push(source);
    };
    if (shape === 'pillar') {
      for (const y of [2, 6]) {
        for (let index = 0; index < TUNE.plotW * 2; index++) {
          add({ shape, x: 0.25 + index * 0.5, y });
        }
      }
    } else {
      for (let index = 0; index < TUNE.plotW; index++) {
        add({ shape, x: 0.5 + index, y: 0.5 });
      }
    }
    return sources;
  };
  const placeLegal = (material, shape = 'pillar') => {
    if (spent(draft) + blockCost(material, shape) > draft.budget) return false;
    for (const source of groundSources(shape)) {
      const result = place(draft, { ...source, material });
      if (!result.ok) continue;
      const legality = validate(draft, { mode: 'siege' });
      if (legality.ok) return true;
      undo(draft);
    }
    return false;
  };
  for (const effect of effects) {
    if (effect.kind !== 'unlock') continue;
    for (let index = 0; index < effect.perRound; index++) {
      if (!placeLegal(effect.material)) {
        throw new Error(`harness could not place reserved ${effect.material} for ` +
          `[${cardIds(cards)}]`);
      }
    }
  }
  // Withhold the lane's freed scrap from the filler only — after the King-balloon
  // card's own obligatory placements (decoy/flak pigs, unlocked-material reserves)
  // have already spent against the untouched budget, exactly as they would without
  // this flag. Only the discretionary top-up below is denied the credit. Clamped so
  // a combo whose mandatory placements already exceed the reduced target cannot
  // manufacture a spurious over-budget rejection; with the flag off laneCredit is
  // always 0 and this is a no-op.
  draft.budget = Math.max(spent(draft), draft.budget - laneCredit);
  const preferred = effects.some((effect) =>
    effect.kind === 'materialCost' && effect.material === 'iron') ? 'iron' :
    effects.some((effect) => effect.kind === 'materialCost' && effect.material === 'stone')
      ? 'stone' : null;
  while (spent(draft) < draft.budget) {
    const materials = preferred ? [preferred, 'stone', 'wood', 'glass'] :
      ['stone', 'wood', 'glass'];
    const candidates = [
      ...materials.map((material) => [material, 'pillar']),
      ['glass', 'cube']
    ];
    let added = false;
    for (const [material, shape] of candidates) {
      if (placeLegal(material, shape)) { added = true; break; }
    }
    if (!added) {
      throw new Error(`harness could not spend ${draft.budget - spent(draft)} scrap for ` +
        `[${cardIds(cards)}]`);
    }
  }

  const legality = validate(draft, { mode: 'siege' });
  if (!legality.ok) {
    throw new Error(blueprintFailure(
      `harness blueprint rejected (round ${round}, cards [${cardIds(cards)}])`, legality
    ));
  }
  const settled = settleTest(draft, { seed: nonZeroSeed(seed) });
  if (!settled.ok) {
    const pieces = [...settled.movedPieces, ...settled.deadPigs];
    throw new Error(`harness blueprint failed settle (round ${round}, cards ` +
      `[${cardIds(cards)}]): settled=${settled.settled}; movement=${settled.maxMovement}; ` +
      `piece ids [${pieces.join(',') || 'none'}]`);
  }
  const result = {
    blueprint: toBlueprint(draft), budget: draft.budget, spent: spent(draft),
    pieces: draft.pieces.length, template: initial.template
  };
  fortressCache.set(key, result);
  return result;
}

function assaultDone(round) {
  return isRoundOver(round) ||
    (round.phase === 'aiming' && round.shotIndex >= round.bag.length);
}

function launchBot(round, state) {
  if (round.phase !== 'aiming' || round.shotIndex >= round.bag.length) return;
  const plan = planShot(round, SIEGE_BOT_DIFFICULTY, round.rng);
  if (!plan?.aim || !launch(round, plan.aim.dx, plan.aim.dy)) {
    throw new Error(`bot launch failed at shot ${round.shotIndex + 1}/${round.bag.length}`);
  }
  state.plan = plan;
  if (!state.remoteTriggered && remoteDetonate(round)) state.remoteTriggered = true;
}

function driveAssault(rounds, states, preflight = true) {
  if (preflight) {
    const settleSteps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
    for (let step = 0; step < settleSteps; step++) {
      for (const round of rounds) stepRound(round, TUNE.step);
    }
  }
  const maxSteps = Math.ceil(TUNE.roundSeconds / TUNE.step);
  for (let step = 0; step < maxSteps; step++) {
    for (let index = 0; index < rounds.length; index++) launchBot(rounds[index], states[index]);
    if (rounds.some((round) => round.pigs.some((pig) => pig.isKing && pig.dead)) ||
        rounds.every(assaultDone)) return;
    for (const round of rounds) if (!assaultDone(round)) stepRound(round, TUNE.step);
    for (let index = 0; index < rounds.length; index++) {
      const round = rounds[index];
      const homing = round.flying?.homing;
      if (round.flying && (homing && !homing.active || shouldTap(round, states[index].plan))) {
        if (tap(round)) states[index].plan = null;
      }
      if (round.phase === 'aiming') states[index].plan = null;
    }
  }
  throw new Error(`match failed to terminate within ${maxSteps} fixed assault steps`);
}

function playerRoundState(pid, assault, fortress, sudden = false) {
  const king = assault.pigs.find((pig) => pig.isKing);
  finalizeSiegeScore(assault);
  return {
    pid,
    score: sudden ? assault.regulationScore : assault.score,
    kingPopped: Boolean(king?.dead),
    suddenDeathDamage: sudden
      ? assault.scoreBreakdown.damage - assault.regulationDamage : undefined,
    fortressCost: fortress.spent,
    // Observational only: threads the shot count and score composition already
    // computed by finalizeSiegeScore out to the reporting layer, so the parity
    // sweep can explain a win rather than only score it.
    shotsFired: assault.shotIndex,
    unusedCount: assault.bag.length - assault.shotIndex,
    breakdown: { ...assault.scoreBreakdown }
  };
}

function simulateRound({ matchSeed, round, players, baseBudgets, orientation = 0,
  noLaneRespend = false }) {
  const fortresses = players.map((player, index) => {
    const physical = orientation ? 1 - index : index;
    const templateSeed = seedWord(matchSeed, round * 31 + physical);
    return buildFortress({
      round,
      baseBudget: baseBudgets[index],
      cards: player.cards,
      templateIndex: templateSeed & 1,
      seed: templateSeed,
      noLaneRespend
    });
  });
  const assaults = players.map((player, index) => {
    const physical = orientation ? 1 - index : index;
    return makeRound({
      mode: 'siege',
      seed: seedWord(matchSeed, round * 67 + physical),
      bag: bagForRound(matchSeed, round, player.cards),
      blueprint: fortresses[1 - index].blueprint,
      attackerCards: player.cards,
      defenderCards: players[1 - index].cards
    });
  });
  const states = assaults.map(() => ({ plan: null, remoteTriggered: false }));
  driveAssault(assaults, states);
  let playerStates = assaults.map((assault, index) =>
    playerRoundState(players[index].pid, assault, fortresses[index]));
  let result = resolveRound(playerStates);
  if (!result.resolved && result.reason === 'sudden-death') {
    for (const assault of assaults) beginSuddenDeath(assault);
    driveAssault(assaults, states, false);
    playerStates = assaults.map((assault, index) =>
      playerRoundState(players[index].pid, assault, fortresses[index], true));
    result = resolveRound(playerStates);
  }
  if (!result.resolved) {
    const winner = players[(matchSeed ^ round) & 1].pid;
    result = { resolved: true, winner, reason: 'unresolved', detail: result.reason };
  }
  return { result, fortresses, playerStates };
}

function simulateMatch({ seed, initialCards = [[], []], natural = false, orientation = 0,
  noLaneRespend = false }) {
  const players = [1, 2].map((pid, index) => ({
    pid, wins: 0, cards: [...initialCards[index]], bankedScrap: 0
  }));
  const rounds = [];
  for (let round = 1; round <= TUNE.maxRounds && matchWinner(players) === null; round++) {
    const leadingWins = Math.max(...players.map((player) => player.wins));
    const baseBudgets = players.map((player) => {
      const carry = natural ? player.bankedScrap : 0;
      player.bankedScrap = 0;
      return budgetFor({
        round,
        roundsBehind: natural ? leadingWins - player.wins : 0,
        bankedScrap: carry
      });
    });
    if (natural) {
      for (const player of players) player.bankedScrap += earlyLockScrap(TUNE.buildSeconds);
    }
    const played = simulateRound({
      matchSeed: seed, round, players, baseBudgets, orientation, noLaneRespend
    });
    const winner = players.find((player) => player.pid === played.result.winner);
    const loser = players.find((player) => player.pid !== played.result.winner);
    if (!winner || !loser) throw new Error(`round ${round} returned no valid winner`);
    winner.wins++;
    rounds.push({ ...played.result, playerStates: played.playerStates });
    if (natural) {
      winner.bankedScrap += BUDGET.winnerBonus;
      if (matchWinner(players) === null) {
        const offer = rollDraft(seed, round, winner.wins - loser.wins,
          loser.cards, loser.pid);
        const picked = defaultDraftPick(offer);
        if (picked) loser.cards.push(picked);
      }
    }
  }
  const winner = matchWinner(players);
  if (winner === null) throw new Error(`match failed to terminate after ${rounds.length} rounds`);
  return { winner, rounds, players };
}

function buildCoveragePair(card, support = []) {
  const seed = seedWord(PARITY_SEED, 700 + CARDS.indexOf(card));
  const beforeCards = [...support];
  const afterCards = [...support, card.id];
  const options = { round: 3, baseBudget: budgetFor({ round: 3 }), templateIndex: 0, seed };
  return {
    beforeCards,
    afterCards,
    before: buildFortress({ ...options, cards: beforeCards }),
    after: buildFortress({ ...options, cards: afterCards })
  };
}

function countMaterial(blueprint, material) {
  return blueprint.blocks.filter((tuple) => tuple[1] === material).length;
}

function coverageRound(blueprint, cards, side = 'defender', bag = ['nib', 'chip']) {
  return makeRound({
    mode: 'siege', seed: 0x51a9, blueprint, bag,
    attackerCards: side === 'attacker' ? cards : [],
    defenderCards: side === 'defender' ? cards : []
  });
}

function restoredHp(blueprint, cards, shots) {
  const round = coverageRound(blueprint, cards, 'defender', Array(shots).fill('nib'));
  const original = round.blocks[0];
  original.dead = true;
  original.destroyedStep = 1;
  removeBody(round.world, original);
  for (let shot = 0; shot < shots; shot++) {
    launch(round, 0, 0);
    if (round.flying) {
      round.flying.dead = true;
      removeBody(round.world, round.flying);
    }
    round.flying = null;
    round.phase = 'aiming';
  }
  return round.blocks[0].dead ? 0 : round.blocks[0].hp;
}

function cardCoverage(card) {
  const effect = card.effect;
  const support = effect.kind === 'materialAbility' || effect.kind === 'remoteTnt'
    ? ['sapper'] : [];
  const pair = buildCoveragePair(card, support);
  const beforeBag = bagForRound(0x51a9, 3, pair.beforeCards);
  const afterBag = bagForRound(0x51a9, 3, pair.afterCards);
  const beforeDefence = coverageRound(pair.before.blueprint, pair.beforeCards);
  const afterDefence = coverageRound(pair.after.blueprint, pair.afterCards);
  let before;
  let after;
  let ok = false;

  if (effect.kind === 'unlock' || effect.kind === 'materialCost') {
    before = countMaterial(pair.before.blueprint, effect.material);
    after = countMaterial(pair.after.blueprint, effect.material);
    ok = after > before;
  } else if (effect.kind === 'budget') {
    before = pair.before.budget;
    after = pair.after.budget;
    ok = after - before === effect.delta && pair.after.spent - pair.before.spent === effect.delta;
  } else if (effect.kind === 'bagSize') {
    before = beforeBag.length;
    after = afterBag.length;
    ok = after - before === effect.delta;
  } else if (effect.kind === 'ammoPool') {
    const sets = [new Set(), new Set()];
    for (let seed = 1; seed <= 96; seed++) {
      for (const id of bagForRound(seed, 5, pair.beforeCards)) sets[0].add(id);
      for (const id of bagForRound(seed, 5, pair.afterCards)) sets[1].add(id);
    }
    before = effect.add.filter((id) => sets[0].has(id)).join(',') || 'none';
    after = effect.add.filter((id) => sets[1].has(id)).join(',') || 'none';
    ok = effect.add.every((id) => !sets[0].has(id) && sets[1].has(id));
  } else if (effect.kind === 'pigHp') {
    before = beforeDefence.pigs.reduce((sum, pig) => sum + pig.maxHp, 0);
    after = afterDefence.pigs.reduce((sum, pig) => sum + pig.maxHp, 0);
    ok = after - before === afterDefence.pigs.length * effect.delta;
  } else if (effect.kind === 'plotRow') {
    before = beforeDefence.blocks.filter((block) => block.indestructible).length;
    after = afterDefence.blocks.filter((block) => block.indestructible).length;
    ok = before === 0 && after > 0;
  } else if (effect.kind === 'previewRate') {
    before = `${previewInterval(pair.beforeCards)} ms`;
    after = `${previewInterval(pair.afterCards)} ms`;
    ok = previewInterval(pair.afterCards) === effect.intervalSeconds * 1000;
  } else if (effect.kind === 'decoyKing') {
    before = beforeDefence.pigs.filter((pig) => pig.decoy).length;
    after = afterDefence.pigs.filter((pig) => pig.decoy).length;
    ok = before === 0 && after === 1;
  } else if (effect.kind === 'pigAbility') {
    before = beforeDefence.pigs.filter((pig) => pig.flakEffect).length;
    after = afterDefence.pigs.filter((pig) => pig.flakEffect).length;
    ok = before === 0 && after === effect.pigCount;
  } else if (effect.kind === 'headwind') {
    launch(beforeDefence, -TUNE.slingRadius, 0);
    launch(afterDefence, -TUNE.slingRadius, 0);
    stepRound(beforeDefence, TUNE.step);
    stepRound(afterDefence, TUNE.step);
    before = beforeDefence.flying.vx.toFixed(5);
    after = afterDefence.flying.vx.toFixed(5);
    ok = Number(after) < Number(before);
  } else if (effect.kind === 'bonusShot') {
    before = `${beforeBag.length}/${beforeBag[0]}`;
    after = `${afterBag.length}/${afterBag[0]}`;
    ok = afterBag.length === beforeBag.length + 1 && afterBag[0] === effect.ammo;
  } else if (effect.kind === 'restoreBlock') {
    before = restoredHp(pair.before.blueprint, pair.beforeCards, effect.everyEnemyShots);
    after = restoredHp(pair.after.blueprint, pair.afterCards, effect.everyEnemyShots);
    ok = before === 0 && after > 0;
  } else if (effect.kind === 'materialAbility') {
    const beforeBlock = beforeDefence.blocks.find((block) => block.materialId === effect.material);
    const afterBlock = afterDefence.blocks.find((block) => block.materialId === effect.material);
    before = beforeBlock ? `${beforeBlock.mat.blastDamage}/${beforeBlock.mat.blastRadius}` : 'none';
    after = afterBlock ? `${afterBlock.blast?.blastDamage}/${afterBlock.blast?.blastRadius}` : 'none';
    ok = Boolean(beforeBlock && afterBlock?.blast &&
      afterBlock.blast.blastDamage === beforeBlock.mat.blastDamage * effect.damageMultiplier &&
      afterBlock.blast.blastRadius === beforeBlock.mat.blastRadius * effect.radiusMultiplier);
  } else if (effect.kind === 'slingPull') {
    const beforeRound = coverageRound(pair.before.blueprint, pair.beforeCards, 'attacker', ['nib']);
    const afterRound = coverageRound(pair.before.blueprint, pair.afterCards, 'attacker', ['nib']);
    const draw = -TUNE.slingRadius * effect.multiplier;
    before = launch(beforeRound, draw, 0).vx;
    after = launch(afterRound, draw, 0).vx;
    ok = after / before === effect.multiplier;
  } else if (effect.kind === 'kingBalloon') {
    before = beforeDefence.balloons.length;
    after = afterDefence.balloons.length;
    ok = before === 0 && after === 1 && afterDefence.pigs.some((pig) =>
      pig.isKing && pig.invulnerableWhileBalloon);
  } else if (effect.kind === 'remoteTnt') {
    before = Number(remoteDetonate(beforeDefence));
    after = remoteDetonate(afterDefence);
    ok = before === 0 && after > 0 && afterDefence.pendingExplosions.length > 0;
  } else if (effect.kind === 'slingshots') {
    const measure = (cards) => {
      const round = coverageRound(pair.before.blueprint, cards, 'attacker', ['nib', 'nib']);
      launch(round, -1, 0);
      round.phase = 'aiming';
      round.flying = null;
      launch(round, -1, 0);
      return round.shots.map((shot) => shot.slingY);
    };
    const a = measure(pair.beforeCards);
    const b = measure(pair.afterCards);
    before = a.join('/');
    after = b.join('/');
    ok = a[0] === a[1] && b[1] - b[0] === effect.secondSlingYOffset;
  } else if (effect.kind === 'ammoHoming') {
    const beforeRound = coverageRound(pair.before.blueprint, pair.beforeCards, 'attacker', ['nib']);
    const afterRound = coverageRound(pair.before.blueprint, pair.afterCards, 'attacker', ['nib']);
    launch(beforeRound, -TUNE.slingRadius, 0);
    launch(afterRound, -TUNE.slingRadius, 0);
    const beforeTap = tap(beforeRound);
    const afterTap = tap(afterRound);
    stepRound(beforeRound, TUNE.step);
    stepRound(afterRound, TUNE.step);
    before = `${beforeTap}/${beforeRound.flying.vy.toFixed(5)}`;
    after = `${afterTap}/${afterRound.flying.vy.toFixed(5)}`;
    ok = !beforeTap && afterTap && afterRound.flying.vy !== beforeRound.flying.vy;
  } else if (effect.kind === 'plotTilt') {
    before = beforeDefence.world.bodies.find((body) => body.role === 'ground').s;
    after = afterDefence.world.bodies.find((body) => body.role === 'ground').s;
    ok = before === 0 && after === effect.sin;
  } else if (effect.kind === 'autoPig') {
    before = beforeDefence.pigs.length;
    after = afterDefence.pigs.length;
    ok = afterDefence.pigs.filter((pig) => pig.autoPlaced).length === effect.count;
  } else {
    before = 'unsupported';
    after = effect.kind;
  }
  return { id: card.id, kind: effect.kind, before: String(before), after: String(after), ok };
}

function parseSiegeN(args) {
  if (args[0] !== '--siege') return null;
  if (args.length === 1) return SIEGE_N_DEFAULT;
  if (args.length !== 3 || args[1] !== '-n' || !/^\d+$/.test(args[2])) return NaN;
  const value = Number(args[2]);
  // Complete mirror pairs and a <=1 card-allocation spread can coexist only when
  // each of the 25 cards receives an even number of matches.
  return Number.isSafeInteger(value) && value > 0 && value % (CARDS.length * 2) === 0
    ? value : NaN;
}

function printControl(control) {
  const rate = control.p1Wins / control.rounds;
  console.log('\nnull/control pairing');
  console.log(`P1 ${control.p1Wins}/${control.rounds} rounds = ${percentage(rate)}; ` +
    `P2 ${control.rounds - control.p1Wins}/${control.rounds} = ${percentage(1 - rate)}; ` +
    `near-50 band ${percentage(CONTROL_LOW)}–${percentage(CONTROL_HIGH)}`);
  for (const leg of control.legs) {
    console.log(`${leg.name}: P1 ${leg.p1Wins}/${leg.rounds} = ` +
      `${percentage(leg.p1Wins / leg.rounds)}`);
  }
  const [a, b] = control.legs.map((leg) => leg.p1Wins / leg.rounds);
  console.log(`unmirrored P1 side delta ${percentage(Math.abs(a - b))}; each leg must be ` +
    `${percentage(CONTROL_LOW)}–${percentage(CONTROL_HIGH)}`);
}

function printCardRows(rows) {
  console.log('\nparity card round win rates');
  console.log('card                 tier  effect             rounds  holder win rate  95% CI          flag');
  for (const row of rows) {
    const rate = row.wins / row.rounds;
    const [low, high] = wilson95(row.wins, row.rounds);
    let flag = '—';
    if (rate > CARD_HIGH) flag = low <= CARD_HIGH ? 'HIGH (CI crosses 65%)' : 'HIGH';
    if (rate < CARD_LOW) flag = high >= CARD_LOW ? 'LOW (CI crosses 40%)' : 'LOW';
    row.rate = rate;
    row.interval = [low, high];
    row.flag = flag;
    console.log(`${row.card.id.padEnd(21)}${String(row.card.tier).padStart(4)}  ` +
      `${row.card.effect.kind.padEnd(18)}${String(row.rounds).padStart(6)}  ` +
      `${percentage(rate).padStart(15)}  ` +
      `${`[${percentage(low)}, ${percentage(high)}]`.padEnd(15)}  ${flag}`);
  }
}

function printCardConditions(rows) {
  console.log('\nparity card win-condition breakdown (same rounds counted above)');
  console.log('card                 rounds  won king/score/tail  lost king/score/tail');
  for (const row of rows) {
    const won = `${row.wonBy['king-pop']}/${row.wonBy.score}/${row.wonBy.tail}`;
    const lost = `${row.lostBy['king-pop']}/${row.lostBy.score}/${row.lostBy.tail}`;
    console.log(`${row.card.id.padEnd(21)}${String(row.rounds).padStart(6)}  ` +
      `${won.padStart(19)}  ${lost.padStart(21)}`);
  }
}

function printCardShotsScore(rows) {
  console.log('\nparity card shots and score (means/round; score shown as total(unused-ammo term))');
  console.log('card                 h.shots  o.shots  h.unused  o.unused     holder score       opp score');
  for (const row of rows) {
    const n = row.rounds;
    const holderScore = `${formatScore(row.holderScore / n)}(${formatScore(row.holderBreakdown.unused / n)})`;
    const opponentScore = `${formatScore(row.opponentScore / n)}(${formatScore(row.opponentBreakdown.unused / n)})`;
    console.log(`${row.card.id.padEnd(21)}${(row.holderShots / n).toFixed(2).padStart(7)}  ` +
      `${(row.opponentShots / n).toFixed(2).padStart(7)}  ${(row.holderUnused / n).toFixed(2).padStart(8)}  ` +
      `${(row.opponentUnused / n).toFixed(2).padStart(8)}  ${holderScore.padStart(17)}  ` +
      `${opponentScore.padStart(15)}`);
  }
}

function printCardExplain(rows) {
  if (!rows.length) return;
  console.log('\nparity card score components (means/round: blocks/off-plot/pigs/breach; unused above)');
  for (const row of rows) {
    const n = row.rounds;
    const hb = row.holderBreakdown;
    const ob = row.opponentBreakdown;
    console.log(`${row.card.id}: holder ${formatScore(hb.destroyedBlocks / n)}/` +
      `${formatScore(hb.offPlotBlocks / n)}/${formatScore(hb.pigs / n)}/${formatScore(hb.breach / n)}` +
      ` vs opponent ${formatScore(ob.destroyedBlocks / n)}/${formatScore(ob.offPlotBlocks / n)}/` +
      `${formatScore(ob.pigs / n)}/${formatScore(ob.breach / n)}`);
  }
}

function printCardFortressSpend(rows) {
  console.log('\nparity card fortress scrap spent (means/round; --no-lane-respend only — this is ' +
    'the "genuine cost" the respend used to hide)');
  console.log('card                 holder spent  opponent spent');
  for (const row of rows) {
    const n = row.rounds;
    console.log(`${row.card.id.padEnd(21)}${formatScore(row.holderFortressSpent / n).padStart(12)}  ` +
      `${formatScore(row.opponentFortressSpent / n).padStart(14)}`);
  }
}

function printCoverage(rows) {
  console.log('\ncard coverage');
  console.log('card                 effect             before              after               state');
  for (const row of rows) {
    console.log(`${row.id.padEnd(21)}${row.kind.padEnd(19)}` +
      `${row.before.slice(0, 18).padEnd(20)}${row.after.slice(0, 18).padEnd(20)}` +
      `${row.ok ? 'exercised' : 'UNEXERCISED'}`);
  }
  const missing = rows.filter((row) => !row.ok);
  if (missing.length) {
    console.log('\nunexercised');
    for (const row of missing) console.log(`  ${row.id} (${row.kind})`);
  }
}

function printDistribution(distribution, rounds) {
  console.log('\nnatural-sweep win conditions');
  for (const reason of REASONS) {
    const count = distribution[reason] ?? 0;
    console.log(`${reason.padEnd(22)}${String(count).padStart(5)}  ${percentage(count / rounds)}`);
  }
  const kingShare = (distribution['king-pop'] ?? 0) / rounds;
  const pointsShare = 1 - kingShare;
  console.log(`King-pop share ${percentage(kingShare)}; points/non-King share ` +
    `${percentage(pointsShare)} against maximum ${percentage(POINTS_HIGH)}`);
  return pointsShare;
}

async function siege(n, { noLaneRespend = false } = {}) {
  const started = performance.now();
  const matchesPerCard = n / CARDS.length;
  const pairingsPerCard = matchesPerCard / 2;
  const naturalMatches = Math.max(50, Math.ceil(n / 4));
  const cardRows = CARDS.map((card) => ({
    card, matches: 0, rounds: 0, wins: 0,
    // Observational breakdown of the same rounds already being counted above —
    // nothing here feeds back into wins/rounds/rate.
    wonBy: { 'king-pop': 0, score: 0, tail: 0 },
    lostBy: { 'king-pop': 0, score: 0, tail: 0 },
    holderShots: 0, opponentShots: 0, holderUnused: 0, opponentUnused: 0,
    holderScore: 0, opponentScore: 0,
    // Total scrap actually spent on each side's fortress, printed only under
    // --no-lane-respend — otherwise both sides always spend their full budget
    // and the number says nothing.
    holderFortressSpent: 0, opponentFortressSpent: 0,
    holderBreakdown: zeroBreakdown(), opponentBreakdown: zeroBreakdown()
  }));
  let parityRounds = 0;
  for (let cardIndex = 0; cardIndex < CARDS.length; cardIndex++) {
    const row = cardRows[cardIndex];
    for (let pairing = 0; pairing < pairingsPerCard; pairing++) {
      const seed = seedWord(PARITY_SEED, cardIndex * pairingsPerCard + pairing);
      for (let leg = 0; leg < 2; leg++) {
        const holderPid = leg + 1;
        const cards = leg === 0 ? [[row.card.id], []] : [[], [row.card.id]];
        const match = simulateMatch({ seed, initialCards: cards, noLaneRespend });
        row.matches++;
        row.rounds += match.rounds.length;
        parityRounds += match.rounds.length;
        row.wins += match.rounds.filter((round) => round.winner === holderPid).length;
        for (const round of match.rounds) {
          const holderWon = round.winner === holderPid;
          const reason = REASONS.includes(round.reason) ? round.reason : 'unresolved';
          const bucket = TAIL_REASONS.includes(reason) ? 'tail' : reason;
          (holderWon ? row.wonBy : row.lostBy)[bucket]++;
          const holderState = round.playerStates?.find((state) => state.pid === holderPid);
          const opponentState = round.playerStates?.find((state) => state.pid !== holderPid);
          if (!holderState || !opponentState) continue;
          row.holderShots += holderState.shotsFired;
          row.opponentShots += opponentState.shotsFired;
          row.holderUnused += holderState.unusedCount;
          row.opponentUnused += opponentState.unusedCount;
          row.holderScore += holderState.score;
          row.opponentScore += opponentState.score;
          row.holderFortressSpent += holderState.fortressCost;
          row.opponentFortressSpent += opponentState.fortressCost;
          addBreakdown(row.holderBreakdown, holderState.breakdown);
          addBreakdown(row.opponentBreakdown, opponentState.breakdown);
        }
      }
    }
  }

  const control = {
    matches: matchesPerCard, rounds: 0, p1Wins: 0,
    legs: [{ name: 'unmirrored leg A', rounds: 0, p1Wins: 0 },
      { name: 'mirrored leg B', rounds: 0, p1Wins: 0 }]
  };
  for (let pairing = 0; pairing < pairingsPerCard; pairing++) {
    const seed = seedWord(PARITY_SEED, 0x4000 + pairing);
    for (let leg = 0; leg < 2; leg++) {
      const match = simulateMatch({ seed, orientation: leg, noLaneRespend });
      const bucket = control.legs[leg];
      bucket.rounds += match.rounds.length;
      bucket.p1Wins += match.rounds.filter((round) => round.winner === 1).length;
      control.rounds += match.rounds.length;
      control.p1Wins += match.rounds.filter((round) => round.winner === 1).length;
    }
  }
  parityRounds += control.rounds;

  const distribution = Object.fromEntries(REASONS.map((reason) => [reason, 0]));
  let naturalRounds = 0;
  for (let index = 0; index < naturalMatches; index++) {
    const seed = seedWord(NATURAL_SEED, index);
    const match = simulateMatch({ seed, natural: true, noLaneRespend });
    for (const round of match.rounds) {
      distribution[REASONS.includes(round.reason) ? round.reason : 'unresolved']++;
      naturalRounds++;
    }
  }
  const coverageRows = CARDS.map(cardCoverage);

  console.log('siege balance configuration');
  if (noLaneRespend) {
    console.log('--no-lane-respend: airlift opens its King-balloon lane but keeps the ' +
      'freed scrap unspent instead of respending it elsewhere on the fortress');
  }
  console.log(`n=${n} parity card matches (${n / 2} mirrored pairings) + ` +
    `${control.matches} null/control matches; natural=${naturalMatches} matches`);
  console.log(`seeds parity=0x${PARITY_SEED.toString(16)} natural=0x${NATURAL_SEED.toString(16)}; ` +
    `bot difficulty=${SIEGE_BOT_DIFFICULTY}`);
  console.log(`allocation=${matchesPerCard} matches/card (${pairingsPerCard} mirrored pairings); ` +
    `round samples/card=${Math.min(...cardRows.map((row) => row.rounds))}–` +
    `${Math.max(...cardRows.map((row) => row.rounds))}`);
  console.log(`simulated rounds parity=${parityRounds} ` +
    `(cards=${parityRounds - control.rounds}, control=${control.rounds}); natural=${naturalRounds}`);
  printControl(control);
  printCardRows(cardRows);
  printCardConditions(cardRows);
  printCardShotsScore(cardRows);
  const flagged = cardRows.filter((row) => row.rate > CARD_HIGH || row.rate < CARD_LOW);
  printCardExplain(cardRows);
  if (noLaneRespend) printCardFortressSpend(cardRows);
  printCoverage(coverageRows);
  const pointsShare = printDistribution(distribution, naturalRounds);

  const unexercised = coverageRows.filter((row) => !row.ok);
  const controlRate = control.p1Wins / control.rounds;
  const sideRates = control.legs.map((leg) => leg.p1Wins / leg.rounds);
  const controlFailed = controlRate < CONTROL_LOW || controlRate > CONTROL_HIGH ||
    sideRates.some((rate) => rate < CONTROL_LOW || rate > CONTROL_HIGH);
  const pointsFailed = pointsShare > POINTS_HIGH;
  console.log(`\nsummary: ${flagged.length}/25 cards outside ${percentage(CARD_LOW)}–` +
    `${percentage(CARD_HIGH)}; ${coverageRows.length - unexercised.length}/25 exercised; ` +
    `control P1 ${percentage(controlRate)}; points/non-King ${percentage(pointsShare)}`);
  if (flagged.length) {
    console.error(`siege balance failed: card thresholds — ${flagged.map((row) =>
      `${row.card.id} ${percentage(row.rate)}`).join(', ')}`);
  }
  if (unexercised.length) {
    console.error(`siege balance failed: unexercised cards — ` +
      unexercised.map((row) => row.id).join(', '));
  }
  if (controlFailed) {
    console.error(`siege balance failed: null control aggregate P1 ${percentage(controlRate)}; ` +
      `unmirrored P1 legs ${sideRates.map(percentage).join('/')} must each be ` +
      `${percentage(CONTROL_LOW)}–${percentage(CONTROL_HIGH)}`);
  }
  if (pointsFailed) {
    console.error(`siege balance failed: points/non-King rounds ${percentage(pointsShare)} ` +
      `exceeds ${percentage(POINTS_HIGH)} (${naturalRounds - distribution['king-pop']}/` +
      `${naturalRounds})`);
  }
  const elapsed = (performance.now() - started) / 1000;
  const totalRounds = parityRounds + naturalRounds;
  console.log(`throughput: ${(totalRounds / elapsed).toFixed(1)} rounds/s ` +
    `(${elapsed.toFixed(2)} s elapsed)`);
  if (flagged.length || unexercised.length || controlFailed || pointsFailed) {
    process.exitCode = 1;
  }
}

async function main(args) {
  // Pulled out before parseSiegeN/campaign validation runs, so the flag's presence
  // or absence never changes how the rest of args is parsed — the flag-absent path
  // below is untouched, byte for byte, from before this flag existed.
  const noLaneRespend = args.includes('--no-lane-respend');
  const rest = noLaneRespend ? args.filter((arg) => arg !== '--no-lane-respend') : args;
  const siegeN = parseSiegeN(rest);
  if (Number.isFinite(siegeN)) {
    await siege(siegeN, { noLaneRespend });
    return;
  }
  if (rest[0] === '--siege') {
    usage(`-n must be a positive multiple of ${CARDS.length * 2} so all card matches ` +
      'have complete mirrors');
    return;
  }
  if (noLaneRespend) {
    usage('--no-lane-respend only applies to --siege');
    return;
  }
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
