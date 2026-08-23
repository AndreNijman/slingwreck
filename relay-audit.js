// Pure, host-independent Siege audit mechanics. The Durable Object owns clocks,
// sockets and persistence; this module owns every deterministic replay decision.

import {
  AMMO,
  BAG,
  CARDS_BY_ID,
  MATERIALS,
  SCORE,
  SHAPES,
  TUNE
} from './data.js';
import { rng } from './physics.js';
import { digestRound, launch, makeRound, stepRound, tap } from './sim.js';

export const SETTLE_STEPS = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
export const ROUND_STEPS = Math.ceil(TUNE.roundSeconds / TUNE.step);
export const AUDIT_STEP_BUDGET = 160;
export const CLOCK_SLOP_STEPS = Math.ceil(1.5 / TUNE.step);
export const AUDIT_LAG_STEPS = CLOCK_SLOP_STEPS;
const SCORE_TOLERANCE = 1e-6;
const BASE_AMMO = ['nib', 'chip', 'wedge', 'lob', 'boomer', 'hulk', 'zip'];

function fail(code, message) { return { ok: false, code, message }; }

export function validationMode(env = {}) {
  return String(env.VALIDATE ?? '').toLowerCase() === 'lenient'
    ? 'lenient' : 'strict';
}

export function bagForRound(seed, round, cards = []) {
  const pool = [...BASE_AMMO];
  let count = BAG.base + BAG.perRound * round;
  let prefix = [];
  for (const id of cards) {
    const effect = CARDS_BY_ID[id]?.effect;
    if (!effect) continue;
    if (effect.kind === 'bagSize') count += effect.delta;
    if (effect.kind === 'ammoPool') {
      for (const ammo of effect.add) if (!pool.includes(ammo)) pool.push(ammo);
    }
    if (effect.kind === 'bonusShot') prefix = [effect.ammo, ...prefix];
  }
  const random = rng((seed ^ round * 0x45d9f3b) | 0);
  const bag = [...prefix];
  while (bag.length < count + prefix.length) {
    bag.push(pool[Math.floor(random() * pool.length) % pool.length]);
  }
  return bag;
}

export function scoreCeiling(blueprint, bagLength) {
  let total = SCORE.siege.breach + bagLength * SCORE.siege.unusedAmmo;
  for (const tuple of blueprint.blocks) {
    total += SHAPES[tuple[0]].area * MATERIALS[tuple[1]].cost *
      (SCORE.siege.blockDestroyedCostMultiplier +
        SCORE.siege.blockOffPlotBonusCostMultiplier);
  }
  for (const tuple of blueprint.pigs) total += SCORE.siege.pigs[tuple[0]] ?? 0;
  return total;
}

export function previewAllowed(lastAt, now) {
  return !Number.isFinite(lastAt) || now - lastAt >= 1000 / TUNE.previewHz;
}

function wallStepLimit(siege, now) {
  const elapsed = Math.max(0, now - siege.startedAt);
  return SETTLE_STEPS + Math.floor(elapsed / (TUNE.step * 1000)) +
    CLOCK_SLOP_STEPS;
}

export function checkShot(siege, message, now) {
  if (!Number.isInteger(message.step) || !Number.isInteger(message.ammoIndex)) {
    return fail('invalid-shot', 'shot step and ammoIndex must be integers');
  }
  if (message.ammoIndex !== siege.shotCount || message.ammoIndex >= siege.bag.length) {
    return fail('shot-order', 'shots must use the next critter in the bag');
  }
  if (!Number.isFinite(message.dx) || !Number.isFinite(message.dy)) {
    return fail('invalid-shot', 'shot aim must be finite');
  }
  if (message.dx * message.dx + message.dy * message.dy >
      TUNE.slingRadius * TUNE.slingRadius + 1e-9) {
    return fail('shot-bounds', 'shot aim exceeds the slingshot radius');
  }
  if (message.step < SETTLE_STEPS || message.step > wallStepLimit(siege, now)) {
    return fail('shot-timing', 'shot step is ahead of the real-time simulation clock');
  }
  if (siege.lastShotStep !== null) {
    const stepGap = message.step - siege.lastShotStep;
    if (stepGap < 2) {
      return fail('shot-timing', 'shots arrived faster than the simulation can settle');
    }
    const wallGap = now - siege.lastShotAt;
    if (wallGap + CLOCK_SLOP_STEPS * TUNE.step * 1000 <
        stepGap * TUNE.step * 1000) {
      return fail('shot-timing', 'shot timestamps advance faster than wall time');
    }
  }
  return { ok: true };
}

export function checkTap(siege, message, now) {
  if (!siege.shotCount || !Number.isInteger(message.step)) {
    return fail('invalid-tap', 'tap step must be an integer after a shot');
  }
  if (message.step < siege.lastShotStep || message.step > wallStepLimit(siege, now)) {
    return fail('tap-timing', 'tap step is outside the current shot clock');
  }
  if (siege.tappedShot === siege.shotCount - 1) {
    return fail('duplicate-tap', 'each critter ability can be tapped only once');
  }
  return { ok: true };
}

export function checkScore(siege, message, now, strict) {
  if (!Number.isInteger(message.step) || !Number.isInteger(message.ammoIndex)) {
    return fail('invalid-score', 'score step and ammoIndex must be integers');
  }
  if (message.ammoIndex !== siege.boundaries.length ||
      message.ammoIndex >= siege.shotCount) {
    return fail('score-order', 'scores must report each completed shot in order');
  }
  if (!Number.isFinite(message.score) || message.score < 0 ||
      message.score > siege.scoreCeiling + SCORE_TOLERANCE) {
    return fail('score-bounds', 'reported score exceeds the fortress maximum');
  }
  if (!siege.shotCount && message.score > 0) {
    return fail('score-bounds', 'a score cannot be earned before the first shot');
  }
  if (message.step < siege.lastShotStep || message.step > wallStepLimit(siege, now)) {
    return fail('score-timing', 'score step is outside the real-time simulation clock');
  }
  if (strict && !/^[0-9a-f]{8}$/.test(String(message.digest ?? ''))) {
    return fail('missing-digest', 'strict validation requires an eight-digit round digest');
  }
  return { ok: true };
}

export function createAudit({ blueprint, seed, bag }) {
  return {
    round: makeRound({ mode: 'siege', blueprint, seed, bag }),
    eventIndex: 0,
    boundaryIndex: 0
  };
}

function applyEvents(audit, siege) {
  const { round } = audit;
  while (audit.eventIndex < siege.log.length) {
    const event = siege.log[audit.eventIndex];
    if (event.step > round.stepCount) break;
    if (event.step < round.stepCount) {
      return fail('audit-late-input', 'an input arrived after its replay step');
    }
    if (event.t === 'shot') {
      if (round.shotIndex !== event.ammoIndex || !launch(round, event.dx, event.dy)) {
        return fail('audit-illegal-shot', 'the replay rejected a reported shot');
      }
    } else if (event.t === 'tap' && !tap(round)) {
      return fail('audit-illegal-tap', 'the replay rejected a reported ability tap');
    }
    audit.eventIndex++;
  }
  return { ok: true };
}

function verifyBoundary(audit, siege) {
  const boundary = siege.boundaries[audit.boundaryIndex];
  if (!boundary || boundary.step > audit.round.stepCount) return null;
  if (boundary.step < audit.round.stepCount) {
    return fail('audit-missed-boundary', 'replay advanced beyond a shot boundary');
  }
  const actualDigest = digestRound(audit.round);
  if (boundary.digest !== actualDigest) {
    return fail('audit-divergence',
      `round digest diverged: client ${boundary.digest}, relay ${actualDigest}`);
  }
  if (Math.abs(boundary.score - audit.round.score) > SCORE_TOLERANCE) {
    return fail('audit-score-divergence',
      `score diverged: client ${boundary.score}, relay ${audit.round.score}`);
  }
  if (audit.round.shotIndex !== boundary.ammoIndex + 1) {
    return fail('audit-shot-count', 'shot boundary does not match the replayed bag');
  }
  const king = audit.round.pigs.find((pig) => pig.isKing);
  if (boundary.kingPop && !king?.dead) {
    return fail('false-king-pop', 'the replay shows that the King did not pop');
  }
  const settled = audit.round.phase === 'aiming' || audit.round.phase === 'lost';
  if (!boundary.kingPop && !settled) {
    return fail('audit-unsettled-boundary', 'score was reported before the shot settled');
  }
  audit.boundaryIndex++;
  return {
    ok: true,
    boundary,
    digest: actualDigest,
    score: audit.round.score,
    kingPopped: Boolean(boundary.kingPop && king?.dead),
    settled,
    spent: audit.round.shotIndex >= audit.round.bag.length && settled,
    step: audit.round.stepCount
  };
}

export function auditTarget(audit, siege, now) {
  const elapsedSteps = Math.floor(Math.max(0, now - siege.startedAt) /
    (TUNE.step * 1000));
  let target = Math.max(SETTLE_STEPS,
    SETTLE_STEPS + elapsedSteps - AUDIT_LAG_STEPS);
  const event = siege.log[audit.eventIndex];
  const boundary = siege.boundaries[audit.boundaryIndex];
  if (audit.round.stepCount >= SETTLE_STEPS && audit.round.phase === 'aiming' &&
      !event && !boundary) return audit.round.stepCount;
  if (event) target = Math.max(target, event.step);
  if (boundary) target = Math.max(target, boundary.step);
  return Math.min(SETTLE_STEPS + ROUND_STEPS, target);
}

export function advanceAudit(audit, siege, budget, target) {
  const checks = [];
  let steps = 0;
  while (steps < budget) {
    const applied = applyEvents(audit, siege);
    if (!applied.ok) return { ...applied, checks, steps };
    let check;
    while ((check = verifyBoundary(audit, siege))) {
      if (!check.ok) return { ...check, checks, steps };
      checks.push(check);
    }
    if (audit.round.stepCount >= target ||
        audit.round.phase === 'won' || audit.round.phase === 'lost') break;
    stepRound(audit.round, TUNE.step);
    steps++;
  }
  return { ok: true, checks, steps };
}

export function auditSnapshot(audit) {
  return {
    step: audit.round.stepCount,
    digest: digestRound(audit.round),
    score: audit.round.score
  };
}

export function knownAmmoIds() { return AMMO.map((ammo) => ammo.id); }
