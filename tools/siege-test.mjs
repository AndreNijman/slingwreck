#!/usr/bin/env node

import {
  BUDGET,
  CARDS,
  MATERIALS,
  PIGS,
  SCORE,
  SHAPES,
  TUNE
} from '../data.js?v=20260902-1';
import {
  budgetFor,
  earlyLockScrap,
  makeDraft,
  place,
  spent,
  validate
} from '../build.js?v=20260902-1';
import { removeBody } from '../physics.js?v=20260902-1';
import {
  PIG_FLAG_DECOY,
  PIG_FLAG_FLAK,
  finalizeSiegeScore,
  launch,
  makeRound,
  remoteDetonate,
  scoreRound,
  stepRound,
  tap
} from '../sim.js?v=20260902-1';
import {
  bagForRound,
  defaultDraftPick,
  draftTiers,
  matchWinner,
  previewInterval,
  resolveRound,
  rollDraft
} from '../relay-audit.js?v=20260902-1';

let failures = 0;
const cardRows = [];

function report(name, ok, measurement) {
  const label = ok ? 'PASS' : 'FAIL';
  console.log(`${label}  ${name}: ${measurement}`);
  if (!ok) failures++;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const BASE = {
  v: 1,
  blocks: [],
  pigs: [
    ['king', 12, 0.6875, 0],
    ['runt', 2, 0.296875, 0],
    ['runt', 22, 0.296875, 0]
  ]
};

function withBlocks(blocks, pigs = BASE.pigs) {
  return { v: 1, blocks: clone(blocks), pigs: clone(pigs) };
}

function roundFor({ blueprint = BASE, bag = [], attackerCards = [], defenderCards = [] } = {}) {
  return makeRound({
    mode: 'siege',
    seed: 0x51a9,
    blueprint: clone(blueprint),
    bag,
    attackerCards,
    defenderCards
  });
}

function scoringGate() {
  const blockBlueprint = withBlocks([['cube', 'wood', 6, 1.25, 0]]);
  const destroyed = roundFor({ blueprint: blockBlueprint });
  destroyed.blocks[0].dead = true;
  scoreRound(destroyed);
  const blockValue = SHAPES.cube.area * MATERIALS.wood.cost;
  report('score destroyed block',
    destroyed.scoreBreakdown.destroyedBlocks ===
      blockValue * SCORE.siege.blockDestroyedCostMultiplier,
    `${destroyed.scoreBreakdown.destroyedBlocks} points for ${blockValue} scrap`);

  const offPlot = roundFor({ blueprint: blockBlueprint });
  offPlot.blocks[0].x = TUNE.plotW + 2;
  scoreRound(offPlot);
  report('score off-plot block',
    offPlot.scoreBreakdown.destroyedBlocks === blockValue * 10 &&
      offPlot.scoreBreakdown.offPlotBlocks === blockValue * 15,
    `${offPlot.scoreBreakdown.destroyedBlocks} base + ` +
      `${offPlot.scoreBreakdown.offPlotBlocks} off-plot`);

  const pig = roundFor();
  pig.pigs[1].dead = true;
  scoreRound(pig);
  report('score pig value', pig.scoreBreakdown.pigs === SCORE.siege.pigs.runt,
    `${pig.scoreBreakdown.pigs} points for Runt`);

  const ammo = roundFor({ bag: ['nib', 'chip'] });
  ammo.shotIndex = 1;
  finalizeSiegeScore(ammo);
  report('score unused critter', ammo.scoreBreakdown.unused === SCORE.siege.unusedAmmo,
    `${ammo.scoreBreakdown.unused} points for 1 unused`);

  const exposed = roundFor();
  const blocked = roundFor({ blueprint: blockBlueprint });
  finalizeSiegeScore(exposed);
  finalizeSiegeScore(blocked);
  report('score breach line of sight',
    exposed.scoreBreakdown.breach === SCORE.siege.breach &&
      blocked.scoreBreakdown.breach === 0,
    `exposed ${exposed.scoreBreakdown.breach}; blocked ${blocked.scoreBreakdown.breach}`);
}

function resolutionGate() {
  const king = resolveRound([
    { pid: 1, kingPopped: true, score: 100, fortressCost: 100 },
    { pid: 2, kingPopped: false, score: 9000, fortressCost: 100 }
  ]);
  report('round King pop priority', king.winner === 1 && king.reason === 'king-pop',
    `winner ${king.winner}; reason ${king.reason}; scores 100/9000`);

  const score = resolveRound([
    { pid: 1, score: 1500, fortressCost: 100 },
    { pid: 2, score: 1400, fortressCost: 90 }
  ]);
  report('round score resolution', score.winner === 1 && score.reason === 'score',
    `winner ${score.winner}; 1500 > 1400`);

  const sudden = resolveRound([
    { pid: 1, score: 1500, suddenDeathDamage: 260, fortressCost: 100 },
    { pid: 2, score: 1500, suddenDeathDamage: 180, fortressCost: 90 }
  ]);
  report('round sudden death damage',
    sudden.resolved && sudden.winner === 1 && sudden.reason === 'sudden-death-damage',
    `winner ${sudden.winner}; damage 260 > 180`);

  const efficient = resolveRound([
    { pid: 1, score: 1500, suddenDeathDamage: 200, fortressCost: 104 },
    { pid: 2, score: 1500, suddenDeathDamage: 200, fortressCost: 91 }
  ]);
  report('round cheaper-fortress tie-break',
    efficient.resolved && efficient.winner === 2 && efficient.reason === 'fortress-cost',
    `winner ${efficient.winner}; scrap 91 < 104`);
}

function budgetGate() {
  let exact = 0;
  const measurements = [];
  for (let round = 1; round <= 5; round++) {
    for (let deficit = 0; deficit <= 2; deficit++) {
      const expected = BUDGET.base + BUDGET.perRound * (round - 1) +
        BUDGET.perDeficit * deficit;
      const actual = budgetFor({ round, roundsBehind: deficit });
      if (actual === expected) exact++;
      measurements.push(`r${round}/d${deficit}=${actual}`);
    }
  }
  report('budget rounds 1-5 at deficits 0-2', exact === 15,
    `${exact}/15 exact; ${measurements.join(', ')}`);
  const seconds = [0, 9, 10, 29, 89, 90];
  const banked = seconds.map(earlyLockScrap);
  const expected = [0, 0, 2, 4, 16, 18];
  report('budget early-lock banking',
    banked.every((value, index) => value === expected[index]),
    seconds.map((value, index) => `${value}s→${banked[index]}`).join(', '));
  const winner = budgetFor({ round: 2, bankedScrap: BUDGET.winnerBonus });
  report('budget winner bonus',
    winner === BUDGET.base + BUDGET.perRound + BUDGET.winnerBonus,
    `round 2 with winner carry ${winner}`);
}

function draftGate() {
  const cases = [
    [-1, 3, [1]], [0, 3, [1]], [1, 1, [1]], [1, 3, [1]],
    [1, 4, [1, 2]], [1, 5, [1, 2]], [2, 3, [3]], [2, 5, [3]]
  ];
  const exact = cases.filter(([deficit, round, expected]) =>
    JSON.stringify(draftTiers(deficit, round)) === JSON.stringify(expected)).length;
  report('draft tier selection', exact === cases.length,
    `${exact}/${cases.length} deficit/round states exact`);

  const seed = 0x12345678;
  const first = rollDraft(seed, 4, 1, ['iron-ration'], 7);
  const again = rollDraft(seed, 4, 1, ['iron-ration'], 7);
  const unique = new Set(first);
  report('draft seeded reproducibility and uniqueness',
    JSON.stringify(first) === JSON.stringify(again) && unique.size === 3 &&
      !first.includes('iron-ration'),
    `seed ${seed}: [${first.join(', ')}], ${unique.size}/3 unique`);
  report('draft timeout default', defaultDraftPick(first) === first[0],
    `expired→${defaultDraftPick(first)} (candidate 1)`);
}

function buildUnlockMeasurement(card) {
  const effect = card.effect;
  const before = makeDraft({ budget: 1000 });
  const beforeResult = place(before, {
    shape: 'cube', material: effect.material, x: 1, y: 1
  });
  const after = makeDraft({ budget: 1000, cards: [card.id] });
  let accepted = 0;
  for (let index = 0; index < effect.perRound; index++) {
    if (place(after, {
      shape: 'cube', material: effect.material, x: index + 1, y: 1
    }).ok) accepted++;
  }
  const overflow = place(after, {
    shape: 'cube', material: effect.material, x: effect.perRound + 1, y: 1
  });
  return {
    before: beforeResult.ok ? 1 : 0,
    after: accepted,
    ok: !beforeResult.ok && accepted === effect.perRound &&
      !overflow.ok && overflow.reason === 'material-limit'
  };
}

function cardMeasurement(card) {
  const effect = card.effect;
  if (effect.kind === 'unlock') return buildUnlockMeasurement(card);
  if (effect.kind === 'materialCost') {
    const before = makeDraft({ budget: 1000 });
    const beforePlaced = place(before, {
      shape: 'cube', material: effect.material, x: 1, y: 1
    });
    const after = makeDraft({ budget: 1000, cards: [card.id] });
    let accepted = 0;
    for (let index = 0; index < 4; index++) {
      if (place(after, {
        shape: 'cube', material: effect.material, x: index + 1, y: 1
      }).ok) accepted++;
    }
    const afterCost = spent(after);
    const beforeValue = beforePlaced.ok ? spent(before) : 'locked';
    return {
      before: beforeValue,
      after: `${accepted} blocks/${afterCost} scrap`,
      ok: accepted === 4 && afterCost === effect.cost * 4 &&
        (Object.hasOwn(effect, 'limit') ? !beforePlaced.ok : beforeValue > effect.cost)
    };
  }
  if (effect.kind === 'budget') {
    const before = budgetFor({ round: 1 });
    const after = budgetFor({ round: 1, cards: [card.id] });
    return { before, after, ok: after - before === effect.delta };
  }
  if (effect.kind === 'bagSize') {
    const before = bagForRound(9, 2, []).length;
    const after = bagForRound(9, 2, [card.id]).length;
    return { before, after, ok: after - before === effect.delta };
  }
  if (effect.kind === 'ammoPool') {
    const beforeSet = new Set();
    const afterSet = new Set();
    for (let seed = 1; seed <= 96; seed++) {
      for (const id of bagForRound(seed, 5, [])) beforeSet.add(id);
      for (const id of bagForRound(seed, 5, [card.id])) afterSet.add(id);
    }
    const before = effect.add.filter((id) => beforeSet.has(id)).length;
    const after = effect.add.filter((id) => afterSet.has(id)).length;
    return { before, after, ok: before === 0 && after === effect.add.length };
  }
  if (effect.kind === 'pigHp') {
    const before = roundFor().pigs[1].maxHp;
    const after = roundFor({ defenderCards: [card.id] }).pigs[1].maxHp;
    return { before, after, ok: after - before === effect.delta };
  }
  if (effect.kind === 'plotRow') {
    const blueprint = withBlocks([['cube', 'wood', 4, 0.5, 0]]);
    const before = Number(roundFor({ blueprint }).blocks[0].indestructible);
    const after = Number(roundFor({ blueprint, defenderCards: [card.id] })
      .blocks[0].indestructible);
    return { before, after, ok: before === 0 && after === 1 };
  }
  if (effect.kind === 'previewRate') {
    const before = previewInterval([]);
    const after = previewInterval([card.id]);
    return { before: `${before} ms`, after: `${after} ms`,
      ok: after === effect.intervalSeconds * 1000 && after > before };
  }
  if (effect.kind === 'decoyKing') {
    const source = { pig: 'king', decoy: true, x: 8, y: 1 };
    const before = place(makeDraft({ budget: 100 }), source);
    const after = place(makeDraft({ budget: 100, cards: [card.id] }), source);
    const blueprint = {
      v: 1, blocks: [], pigs: [
        ['king', 12, 0.6875, 0], ['king', 8, 0.6875, PIG_FLAG_DECOY],
        ['runt', 2, 0.296875, 0], ['runt', 22, 0.296875, 0]
      ]
    };
    const decoy = roundFor({ blueprint, defenderCards: [card.id] }).pigs[1];
    return { before: before.reason, after: `${after.ok}/${decoy.decoy}/${decoy.isKing}`,
      ok: before.reason === 'locked-piece' && after.ok && decoy.decoy && !decoy.isKing };
  }
  if (effect.kind === 'pigAbility') {
    const pigs = [
      ['king', 12, 0.6875, 0], ['runt', 20, 0.296875, PIG_FLAG_FLAK],
      ['runt', 22, 0.296875, 0]
    ];
    const measure = (cards) => {
      const round = roundFor({ blueprint: withBlocks([], pigs), bag: ['nib'], defenderCards: cards });
      launch(round, -TUNE.slingRadius, 0);
      const interval = Math.ceil(effect.intervalSeconds / TUNE.step);
      round.stepCount = interval;
      const marked = round.pigs.find((pig) => pig.flak);
      if (marked?.flakEffect) marked.flakNextStep = interval;
      const events = stepRound(round, TUNE.step);
      return events.filter((event) =>
        event.kind === 'ability' && event.ability === effect.ability).length;
    };
    const before = measure([]);
    const after = measure([card.id]);
    return { before, after, ok: before === 0 && after > 0 };
  }
  if (effect.kind === 'headwind') {
    const beforeRound = roundFor({ bag: ['nib'] });
    const afterRound = roundFor({ bag: ['nib'], defenderCards: [card.id] });
    launch(beforeRound, -TUNE.slingRadius, 0);
    launch(afterRound, -TUNE.slingRadius, 0);
    stepRound(beforeRound, TUNE.step);
    stepRound(afterRound, TUNE.step);
    const before = beforeRound.flying.vx;
    const after = afterRound.flying.vx;
    return { before: before.toFixed(5), after: after.toFixed(5), ok: after < before };
  }
  if (effect.kind === 'bonusShot') {
    const before = bagForRound(11, 2, []);
    const after = bagForRound(11, 2, [card.id]);
    return { before: `${before.length}/${before[0]}`, after: `${after.length}/${after[0]}`,
      ok: after.length === before.length + 1 && after[0] === effect.ammo };
  }
  if (effect.kind === 'restoreBlock') {
    const blueprint = withBlocks([['cube', 'wood', 5, 0.5, 0]]);
    const measure = (cards) => {
      const round = roundFor({ blueprint, bag: ['nib', 'nib', 'nib'], defenderCards: cards });
      const original = round.blocks[0];
      original.dead = true;
      original.destroyedStep = 1;
      removeBody(round.world, original);
      for (let shot = 0; shot < effect.everyEnemyShots; shot++) {
        launch(round, 0, 0);
        if (round.flying) {
          round.flying.dead = true;
          removeBody(round.world, round.flying);
        }
        round.flying = null;
        round.phase = 'aiming';
      }
      return round.blocks[0].dead ? 0 : round.blocks[0].hp;
    };
    const before = measure([]);
    const after = measure([card.id]);
    return { before, after, ok: before === 0 && after === MATERIALS.wood.hp * effect.hpFraction };
  }
  if (effect.kind === 'materialAbility') {
    const blueprint = withBlocks([['cube', effect.material, 5, 0.5, 0]]);
    const beforeBlock = roundFor({ blueprint }).blocks[0];
    const afterBlock = roundFor({ blueprint, defenderCards: [card.id] }).blocks[0];
    const before = `${beforeBlock.mat.blastDamage}/${beforeBlock.mat.blastRadius}`;
    const after = `${afterBlock.blast.blastDamage}/${afterBlock.blast.blastRadius}`;
    return { before, after, ok:
      afterBlock.blast.blastDamage === beforeBlock.mat.blastDamage * effect.damageMultiplier &&
      afterBlock.blast.blastRadius === beforeBlock.mat.blastRadius * effect.radiusMultiplier };
  }
  if (effect.kind === 'slingPull') {
    const beforeRound = roundFor({ bag: ['nib'] });
    const afterRound = roundFor({ bag: ['nib'], attackerCards: [card.id] });
    const draw = -TUNE.slingRadius * effect.multiplier;
    const before = launch(beforeRound, draw, 0).vx;
    const after = launch(afterRound, draw, 0).vx;
    return { before, after, ok: after / before === effect.multiplier };
  }
  if (effect.kind === 'kingBalloon') {
    // Airlift's immunity was briefly removed on 2026-09-02 to weaken the card and then
    // restored, because measurement showed it is not what makes the card strong: parity
    // 82.5% with it versus 81.9% without, comeback 48.3% versus 45.0%, both pairs
    // overlapping. See the note on the card in data.js.
    //
    // The assertion kept the extra measurements that experiment added rather than
    // reverting to what it checked before. It used to prove only that a balloon appeared
    // and that immunity was set; it now also proves the King drifts and is held at its
    // seat height, which is the mobility half of the effect and was never covered.
    const plain = roundFor();
    const before = plain.balloons.length;
    const afterRound = roundFor({ defenderCards: [card.id] });
    const after = afterRound.balloons.length;
    const king = afterRound.pigs.find((pig) => pig.isKing);
    const seatY = king.y;
    const startX = king.x;
    for (let step = 0; step < 120; step++) stepRound(afterRound, TUNE.step);
    const drift = Math.abs(king.x - startX);
    const held = king.y === seatY;
    return { before, after,
      ok: before === 0 && after === 1 && king.invulnerableWhileBalloon === true &&
        drift > 0.1 && held };
  }
  if (effect.kind === 'remoteTnt') {
    const blueprint = withBlocks([['cube', 'tnt', 5, 0.5, 0]]);
    const before = remoteDetonate(roundFor({ blueprint }));
    const afterRound = roundFor({ blueprint, defenderCards: [card.id] });
    const after = remoteDetonate(afterRound);
    return { before: Number(before), after,
      ok: before === false && after === 1 && afterRound.pendingExplosions.length === 1 };
  }
  if (effect.kind === 'slingshots') {
    const measure = (cards) => {
      const round = roundFor({ bag: ['nib', 'nib'], attackerCards: cards });
      launch(round, -1, 0);
      round.phase = 'aiming';
      round.flying = null;
      launch(round, -1, 0);
      return round.shots.map((shot) => shot.slingY);
    };
    const before = measure([]);
    const after = measure([card.id]);
    return { before: before.join('/'), after: after.join('/'),
      ok: before[0] === before[1] && after[1] - after[0] === effect.secondSlingYOffset };
  }
  if (effect.kind === 'ammoHoming') {
    const homingBlueprint = {
      ...clone(BASE),
      pigs: [
        ['king', 12, 5, 0], ['runt', 2, 0.296875, 0], ['runt', 22, 0.296875, 0]
      ]
    };
    const beforeRound = roundFor({ blueprint: homingBlueprint, bag: ['nib'] });
    const afterRound = roundFor({
      blueprint: homingBlueprint, bag: ['nib'], attackerCards: [card.id]
    });
    launch(beforeRound, -TUNE.slingRadius, 0);
    launch(afterRound, -TUNE.slingRadius, 0);
    const beforeTap = tap(beforeRound);
    const afterTap = tap(afterRound);
    stepRound(beforeRound, TUNE.step);
    stepRound(afterRound, TUNE.step);
    const before = beforeRound.flying.vy;
    const after = afterRound.flying.vy;
    return { before: `${beforeTap}/${before.toFixed(5)}`,
      after: `${afterTap}/${after.toFixed(5)}`,
      ok: !beforeTap && afterTap && after > before };
  }
  if (effect.kind === 'plotTilt') {
    const before = roundFor().world.bodies.find((body) => body.role === 'ground').s;
    const after = roundFor({ defenderCards: [card.id] })
      .world.bodies.find((body) => body.role === 'ground').s;
    return { before, after, ok: before === 0 && after === effect.sin };
  }
  if (effect.kind === 'autoPig') {
    const onlyKing = { v: 1, blocks: [], pigs: [['king', 12, 0.6875, 0]] };
    const before = roundFor({ blueprint: onlyKing }).pigs.length;
    const afterRound = roundFor({ blueprint: onlyKing, defenderCards: [card.id] });
    const automatic = afterRound.pigs.filter((pig) => pig.autoPlaced).length;
    return { before, after: afterRound.pigs.length,
      ok: automatic === effect.count && afterRound.pigs.length - before === effect.count };
  }
  return { before: 'unsupported', after: effect.kind, ok: false };
}

function cardGate() {
  const knownKinds = new Set([
    'unlock', 'materialCost', 'budget', 'bagSize', 'ammoPool', 'pigHp', 'plotRow',
    'previewRate', 'decoyKing', 'pigAbility', 'headwind', 'bonusShot', 'restoreBlock',
    'materialAbility', 'slingPull', 'kingBalloon', 'remoteTnt', 'slingshots',
    'ammoHoming', 'plotTilt', 'autoPig'
  ]);
  for (const card of CARDS) {
    const measured = knownKinds.has(card.effect.kind)
      ? cardMeasurement(card) : { before: 'unsupported', after: card.effect.kind, ok: false };
    cardRows.push({
      id: card.id,
      kind: card.effect.kind,
      before: String(measured.before),
      after: String(measured.after),
      ok: measured.ok
    });
    report(`card ${card.id}`, measured.ok,
      `${card.effect.kind}: ${measured.before} → ${measured.after}`);
  }
  report('all declarative card effects covered',
    cardRows.length === 25 && cardRows.every((row) => row.ok),
    `${cardRows.filter((row) => row.ok).length}/${cardRows.length} measurable`);

  const hostile = clone(BASE);
  hostile.blocks.push(['cube', 'iron', 5, 0.5, 0]);
  const rejected = validate(hostile, { budget: 1000, cards: [] });
  const accepted = validate(hostile, { budget: 1000, cards: ['iron-ration'] });
  report('server-side card grant validation',
    rejected.errors.some((error) => error.code === 'locked-material') && accepted.ok,
    `ungranted [${rejected.errors.map((error) => error.code).join(',')}]; granted ${accepted.ok}`);
}

function fullMatchGate() {
  const bots = [
    { pid: 1, wins: 0, cards: [], fortressCost: 101 },
    { pid: 2, wins: 0, cards: [], fortressCost: 96 }
  ];
  const scripted = [1, 1, 2, 2, 1];
  const drafts = [];
  for (let round = 1; round <= TUNE.maxRounds && matchWinner(bots) === null; round++) {
    const roundWinner = scripted[round - 1];
    const firstScore = roundWinner === 1 ? 2000 + round : 1000 + round;
    const result = resolveRound([
      { pid: 1, score: firstScore, fortressCost: bots[0].fortressCost },
      { pid: 2, score: 3000 + round - firstScore, fortressCost: bots[1].fortressCost }
    ]);
    const winner = bots.find((bot) => bot.pid === result.winner);
    const loser = bots.find((bot) => bot.pid !== result.winner);
    winner.wins++;
    if (matchWinner(bots) !== null) break;
    const deficit = winner.wins - loser.wins;
    const offer = rollDraft(0x5eed, round, deficit, loser.cards, loser.pid);
    const picked = defaultDraftPick(offer);
    if (picked) loser.cards.push(picked);
    drafts.push({ round, picker: loser.pid, loser: loser.pid, picked });
  }
  const winner = matchWinner(bots);
  const loserOnly = drafts.every((draft) => draft.picker === draft.loser && draft.picked);
  report('full headless best-of-five',
    winner !== null && Math.max(...bots.map((bot) => bot.wins)) === TUNE.winsNeeded &&
      drafts.length <= TUNE.maxRounds - 1 && loserOnly,
    `winner P${winner}; standings ${bots[0].wins}-${bots[1].wins}; ` +
      `drafts ${drafts.map((draft) => `r${draft.round}→P${draft.picker}`).join(', ')}`);
}

scoringGate();
resolutionGate();
budgetGate();
draftGate();
cardGate();
fullMatchGate();

console.log('\n25-card measured table');
console.log('| card | effect | before | after | result |');
console.log('| --- | --- | ---: | ---: | --- |');
for (const row of cardRows) {
  console.log(`| ${row.id} | ${row.kind} | ${row.before} | ${row.after} | ` +
    `${row.ok ? 'PASS' : 'FAIL'} |`);
}

if (failures) {
  console.error(`\n${failures} Siege assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll Siege rules passed; ${cardRows.length}/25 cards changed a measured outcome.`);
}
