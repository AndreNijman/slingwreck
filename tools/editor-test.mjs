#!/usr/bin/env node

import {
  BUDGET,
  CARDS,
  MATERIALS,
  PIGS,
  SHAPES,
  TUNE
} from '../data.js';
import { isSettled, rng, rngInt } from '../physics.js';
import { digestRound, makeRound, stepRound } from '../sim.js';
import {
  burialDepth,
  budgetFor,
  decode,
  earlyLockScrap,
  encode,
  fromBlueprint,
  makeDraft,
  moveTo,
  place,
  redo,
  removeAt,
  rotate,
  settleTest,
  spent,
  toBlueprint,
  undo,
  validate
} from '../build.js';

let failures = 0;

function report(name, passed, measurement) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${measurement}`);
  if (!passed) failures++;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

const shapeIds = Object.keys(SHAPES);
const materialIds = Object.keys(MATERIALS);
const pigIds = Object.keys(PIGS);

function generatedBlueprint(random) {
  const blocks = [];
  const pigs = [];
  const blockCount = rngInt(random, TUNE.maxBlocks + 1);
  const pigCount = rngInt(random, 24);
  for (let index = 0; index < blockCount; index++) {
    blocks.push([
      shapeIds[rngInt(random, shapeIds.length)],
      materialIds[rngInt(random, materialIds.length)],
      rngInt(random, TUNE.plotW / TUNE.gridSnap + 1) * TUNE.gridSnap,
      rngInt(random, TUNE.plotH / TUNE.gridSnap + 1) * TUNE.gridSnap,
      rngInt(random, 24)
    ]);
  }
  for (let index = 0; index < pigCount; index++) {
    pigs.push([
      pigIds[rngInt(random, pigIds.length)],
      rngInt(random, TUNE.plotW / TUNE.gridSnap + 1) * TUNE.gridSnap,
      rngInt(random, TUNE.plotH / TUNE.gridSnap + 1) * TUNE.gridSnap,
      index & 3
    ]);
  }
  return { v: 1, blocks, pigs };
}

function roundTripGate() {
  const random = rng(0x51a9b17d);
  let encodedBytes = 0;
  let jsonBytes = 0;
  let exact = 0;
  for (let index = 0; index < 200; index++) {
    const blueprint = generatedBlueprint(random);
    const wire = encode(blueprint);
    const decoded = decode(wire);
    if (same(decoded, blueprint)) exact++;
    encodedBytes += wire.length;
    jsonBytes += JSON.stringify(blueprint).length;
  }
  const averageEncoded = encodedBytes / 200;
  const averageJson = jsonBytes / 200;
  report('200 seeded codec round trips', exact === 200,
    `${exact}/200 exact; average ${averageEncoded.toFixed(1)} B encoded vs ` +
    `${averageJson.toFixed(1)} B JSON (${(averageEncoded / averageJson * 100).toFixed(1)}%)`);
  return { averageEncoded, averageJson };
}

const VALID = {
  v: 1,
  blocks: [
    ['cube', 'wood', 2, 0.5, 0],
    ['cube', 'glass', 4, 0.5, 0]
  ],
  pigs: [
    ['king', 12, PIGS.king.radius],
    ['runt', 10, PIGS.runt.radius],
    ['runt', 14, PIGS.runt.radius]
  ]
};

function tooManyBlueprint() {
  const blocks = [];
  for (let index = 0; index <= TUNE.maxBlocks; index++) {
    blocks.push([
      'beam', 'glass',
      1 + index % 12 * 2,
      2.25 + Math.floor(index / 12) * 0.5,
      0
    ]);
  }
  return { v: 1, blocks, pigs: copy(VALID.pigs) };
}

function deepBlueprint() {
  const blocks = [];
  const kingX = 12;
  const kingY = 8;
  // Each square shell meets only at endpoints. Six shells therefore give every
  // sampled route six distinct hits without making the overlap rule fail too.
  for (let ring = 1; ring <= 6; ring++) {
    const radius = ring + 0.25;
    for (let segment = 0; segment < ring; segment++) {
      const along = -ring + 1 + segment * 2;
      blocks.push(['beam', 'glass', kingX + along, kingY + radius, 0]);
      blocks.push(['beam', 'glass', kingX + along, kingY - radius, 0]);
      blocks.push(['post', 'glass', kingX + radius, kingY + along, 0]);
      blocks.push(['post', 'glass', kingX - radius, kingY + along, 0]);
    }
  }
  return {
    v: 1,
    blocks,
    pigs: [
      ['king', kingX, kingY],
      ['runt', 2, PIGS.runt.radius],
      ['runt', 22, PIGS.runt.radius]
    ]
  };
}

function flaggedLimitBlueprint() {
  return {
    v: 1,
    blocks: [],
    pigs: [
      ['king', 4, 1, 1],
      ['king', 6, 1, 1],
      ['king', 8, 1, 1],
      ['king', 12, 1, 0],
      ['runt', 10, 1, 2],
      ['runt', 14, 1, 2]
    ]
  };
}

function onlyCodes(result) {
  return result.errors.map((item) => item.code);
}

function rulesGate() {
  const out = copy(VALID);
  out.blocks[0][2] = -0.5;
  const overlap = copy(VALID);
  overlap.blocks[1] = copy(overlap.blocks[0]);
  const noKing = copy(VALID);
  noKing.pigs.shift();
  const tooFew = copy(VALID);
  tooFew.pigs.pop();
  const locked = copy(VALID);
  locked.blocks[0][1] = 'iron';
  const deep = deepBlueprint();
  const cases = [
    ['out-of-bounds', out, {}],
    ['overlap', overlap, {}],
    ['too-many-blocks', tooManyBlueprint(), { budget: 1000 }],
    ['king-count', noKing, {}],
    ['too-few-pigs', tooFew, {}],
    ['over-budget', VALID, { budget: 8 }],
    ['locked-material', locked, { budget: 1000 }],
    ['piece-limit', flaggedLimitBlueprint(), {
      budget: 100, cards: ['understudy', 'flak-hog']
    }],
    ['buried-king', deep, {}]
  ];
  let exact = 0;
  for (const [code, blueprint, opts] of cases) {
    const result = validate(blueprint, opts);
    const codes = onlyCodes(result);
    const hasPieceIds = result.errors.every((item) => Array.isArray(item.pieceIds));
    const passed = !result.ok && codes.length === 1 && codes[0] === code && hasPieceIds;
    if (passed) exact++;
    report(`legality ${code}`, passed, `errors [${codes.join(', ')}]`);
  }
  const valid = validate(VALID);
  report('legality valid blueprint', valid.ok && valid.errors.length === 0,
    `${valid.ok ? 'accepted' : `errors [${onlyCodes(valid).join(', ')}]`}`);
  return {
    exact,
    shallowDepth: burialDepth(VALID),
    deepDepth: burialDepth(deep)
  };
}

function bytesOf(wire) {
  return Buffer.from(wire, 'base64url');
}

function wireOf(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function hostileGate() {
  const fixture = {
    v: 1,
    blocks: [['cube', 'wood', 2, 0.5, 0]],
    pigs: [['runt', 4, 0.5]]
  };
  const good = encode(fixture);
  const mutate = (change) => {
    const bytes = bytesOf(good);
    change(bytes);
    return wireOf(bytes);
  };
  const attacks = [
    ['truncated', good.slice(0, -2)],
    ['wrong version', mutate((bytes) => { bytes[0] = 99; })],
    ['shape index', mutate((bytes) => { bytes[3] = bytes[3] & 0xf0 | 0x0f; })],
    ['material index', mutate((bytes) => { bytes[3] = bytes[3] & 0x0f | 0xf0; })],
    ['rotation index', mutate((bytes) => { bytes[4] = bytes[4] & 0xe0 | 31; })],
    ['pig index', mutate((bytes) => { bytes[7] = bytes[7] & 0xf0 | 0x0f; })],
    ['pig flags', mutate((bytes) => { bytes[bytes.length - 1] = 4; })],
    ['absurd declared length', wireOf(Uint8Array.from([1, 255, 0]))],
    ['absurd input length', 'A'.repeat(4096)],
    ['invalid alphabet', '@@@@']
  ];
  let rejected = 0;
  for (const [name, attack] of attacks) {
    let value;
    let threw = false;
    try {
      value = decode(attack);
    } catch (error) {
      threw = true;
      value = error;
    }
    const passed = !threw && value?.ok === false && typeof value.reason === 'string';
    if (passed) rejected++;
    report(`hostile decode ${name}`, passed,
      threw ? `threw ${value.message}` : `reason ${value?.reason ?? 'missing'}`);
  }
  const legacyBytes = bytesOf(good).slice(0, -1);
  legacyBytes[0] = 1;
  const legacy = decode(wireOf(legacyBytes));
  const legacyExpected = copy(fixture);
  legacyExpected.pigs[0].push(0);
  report('legacy codec defaults pig flags', same(legacy, legacyExpected),
    `decoded flags ${legacy.pigs?.[0]?.[3] ?? 'missing'}`);
  return { rejected, total: attacks.length };
}

function editingGate() {
  const draft = makeDraft({ budget: 20, historyLimit: 3 });
  const placed = place(draft, {
    kind: 'block', shape: 'cube', material: 'wood', x: 1.24, y: 0.74, rotation: 25
  });
  const id = placed.piece?.id;
  const snapped = placed.ok && draft.pieces[0].x === 1 && draft.pieces[0].y === 0.5 &&
    draft.pieces[0].rotation === 1;
  moveTo(draft, id, 2.26, 1.26);
  rotate(draft, id, 2);
  const removed = removeAt(draft, 2.5, 1.5);
  const undoRemove = undo(draft).ok && draft.pieces.length === 1;
  const undoRotate = undo(draft).ok && draft.pieces[0].rotation === 1;
  const redoRotate = redo(draft).ok && draft.pieces[0].rotation === 3;
  const direct = rotate(draft, id, { c: 0, s: 1 });
  const steppedOnly = !direct.ok && direct.reason === 'invalid-rotation' &&
    draft.pieces[0].rotation === 3 && toBlueprint(draft).blocks[0][4] === 3;
  const serialisable = same(JSON.parse(JSON.stringify(draft)), draft);
  report('draft edit history', snapped && removed.ok && undoRemove && undoRotate && redoRotate &&
    steppedOnly && serialisable,
    `snap ${snapped}; remove ${removed.ok}; undo/redo ${undoRemove}/${undoRotate}/${redoRotate}; ` +
    `free rotation ${direct.reason}; history ${draft.history.length}/${draft.historyLimit}`);
  return draft;
}

function flagsGate() {
  const flagged = {
    v: 1,
    blocks: copy(VALID.blocks),
    pigs: [
      ['king', 12, 1, 1],
      ['runt', 10, 1, 2],
      ['runt', 14, 1, 0]
    ]
  };
  const decoded = decode(encode(flagged));
  const draft = fromBlueprint(decoded, {
    budget: 100, cards: ['understudy', 'flak-hog']
  });
  const round = makeRound({ mode: 'campaign', seed: 1, bag: [], blueprint: decoded });
  const codes = onlyCodes(validate(decoded, {
    budget: 100, cards: ['understudy', 'flak-hog']
  }));
  const understudyOnly = validate(decoded, { budget: 100, cards: ['understudy'] });
  const flakOnly = validate(decoded, { budget: 100, cards: ['flak-hog'] });
  const understudyLocked = understudyOnly.errors.find((item) => item.code === 'locked-piece');
  const flakLocked = flakOnly.errors.find((item) => item.code === 'locked-piece');
  const survived = same(decoded, flagged) && same(toBlueprint(draft), flagged) &&
    draft.pieces.find((piece) => piece.pig === 'king')?.decoy === true &&
    draft.pieces.find((piece) => piece.pig === 'runt' && piece.flak)?.flak === true &&
    round.pigs[0].decoy && !round.pigs[0].isKing && round.pigs[1].flak;
  const gated = same(understudyLocked?.pieceIds, ['pig:1']) &&
    same(flakLocked?.pieceIds, ['pig:0']);
  report('pig flags survive codec, draft and simulation', survived && gated &&
    same(codes, ['king-count']),
    `decoy ${round.pigs[0].decoy}; flak ${round.pigs[1].flak}; gated ${gated}; ` +
    `errors [${codes.join(', ')}]`);
}

function budgetGate() {
  const expected = BUDGET.base + BUDGET.perRound * 2 + BUDGET.perDeficit * 2 + 6;
  const formula = budgetFor({ round: 3, roundsBehind: 2, bankedScrap: 6 });
  const banked = earlyLockScrap(89);
  report('budget formula and early lock', formula === expected && banked === 16,
    `round 3/down 2/banked 6 = ${formula}; 89 s early lock = ${banked}`);

  const tight = makeDraft({ budget: 3 });
  const first = place(tight, { shape: 'cube', material: 'wood', x: 1, y: 1 });
  const beyond = place(tight, { shape: 'cube', material: 'wood', x: 2, y: 1 });
  const locked = place(makeDraft({ budget: 100 }),
    { shape: 'cube', material: 'iron', x: 1, y: 1 });
  report('placement budget and material refusal', first.ok && !beyond.ok &&
    beyond.reason === 'over-budget' && !locked.ok && locked.reason === 'locked-material',
  `beyond reason ${beyond.reason}; locked reason ${locked.reason}`);

  let authored = 0;
  let checked = 0;
  for (const card of CARDS) {
    const effect = card.effect;
    if (effect.kind === 'unlock') {
      checked++;
      const draft = makeDraft({ budget: 1000, cards: [card.id] });
      let accepted = true;
      for (let index = 0; index < effect.perRound; index++) {
        accepted &&= place(draft, {
          shape: 'cube', material: effect.material, x: index + 1, y: 1
        }).ok;
      }
      const refused = place(draft, {
        shape: 'cube', material: effect.material, x: effect.perRound + 1, y: 1
      });
      if (accepted && !refused.ok && refused.reason === 'material-limit') authored++;
    } else if (effect.kind === 'materialCost') {
      checked++;
      const draft = makeDraft({ budget: 1000, cards: [card.id] });
      const placed = place(draft, { shape: 'cube', material: effect.material, x: 1, y: 1 });
      const unlimited = !Object.hasOwn(effect, 'limit') || effect.limit !== null ||
        [2, 3, 4].every((x) => place(draft, {
          shape: 'cube', material: effect.material, x, y: 1
        }).ok);
      if (placed.ok && spent(draft) === effect.cost * draft.pieces.length && unlimited) authored++;
    } else if (effect.kind === 'budget') {
      checked++;
      const draft = makeDraft({ budget: 10, cards: [card.id] });
      if (draft.budget === 10 + effect.delta) authored++;
    } else if (effect.kind === 'autoPig') {
      checked++;
      const draft = makeDraft({ budget: 0, cards: [card.id] });
      let accepted = true;
      for (let index = 0; index < effect.count; index++) {
        accepted &&= place(draft, { pig: effect.pig, x: index + 1, y: 1 }).ok;
      }
      const extra = place(draft, { pig: effect.pig, x: effect.count + 1, y: 1 });
      if (accepted && !extra.ok && extra.reason === 'over-budget') authored++;
    }
  }
  report('declarative build card effects', authored === checked,
    `${authored}/${checked} authored unlock, limit, cost, budget and auto-pig effects`);

  const decoy = makeDraft({ budget: 100, cards: ['understudy'] });
  place(decoy, { pig: 'king', decoy: true, x: 12, y: 1 });
  place(decoy, { pig: 'runt', x: 10, y: 0.5 });
  place(decoy, { pig: 'runt', x: 14, y: 0.5 });
  const decoyErrors = onlyCodes(validate(decoy));
  report('Decoy King does not satisfy King rule', same(decoyErrors, ['king-count']),
    `errors [${decoyErrors.join(', ')}]`);
}

function stableBlueprints() {
  return [
    VALID,
    { v: 1, blocks: [], pigs: copy(VALID.pigs) },
    {
      v: 1,
      blocks: [1, 2, 3, 4, 5].map((x) => ['cube', 'wood', x, 0.5, 0]),
      pigs: copy(VALID.pigs)
    },
    {
      v: 1,
      blocks: [['cube', 'wood', 2, 0.5, 0], ['cube', 'wood', 2, 1.5, 0]],
      pigs: copy(VALID.pigs)
    },
    {
      v: 1,
      blocks: [['plank', 'glass', 4, 0.25, 0]],
      pigs: copy(VALID.pigs)
    },
    {
      v: 1,
      blocks: [['slab', 'stone', 3, 0.5, 0]],
      pigs: [
        ['king', 12, PIGS.king.radius],
        ['swine', 10, PIGS.swine.radius],
        ['hogg', 14, PIGS.hogg.radius]
      ]
    }
  ];
}

function settleGate() {
  let guaranteed = 0;
  const fixtures = stableBlueprints();
  const settleSteps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
  const settleAuthored = (blueprint) => {
    const round = makeRound({ mode: 'campaign', seed: 1, bag: [], blueprint });
    for (let index = 0; index < settleSteps; index++) stepRound(round, TUNE.step);
    return round;
  };
  for (const blueprint of fixtures) {
    const legal = validate(blueprint);
    const tested = settleTest(blueprint);
    if (!legal.ok || !tested.ok) continue;
    const round = settleAuthored(blueprint);
    for (let index = 0; index < Math.ceil(10 / TUNE.step); index++) {
      stepRound(round, TUNE.step);
    }
    if (isSettled(round.world) && round.pigs.every((pig) => !pig.dead)) guaranteed++;
  }
  report('settle guarantee plus 10 seconds', guaranteed === fixtures.length,
    `${guaranteed}/${fixtures.length} authored blueprints remain asleep with every pig alive`);

  const contract = settleTest(VALID);
  const twinA = settleAuthored(VALID);
  const twinB = settleAuthored(VALID);
  const digestA = digestRound(twinA);
  const digestB = digestRound(twinB);
  const twins = twinA.world !== twinB.world && digestA === digestB;
  report('authored settle is deterministic without a wire-state result', twins &&
    !Object.hasOwn(contract, 'settledBlueprint'),
    `digests ${digestA}/${digestB}; settledBlueprint ${Object.hasOwn(contract, 'settledBlueprint')}`);

  const falling = copy(VALID);
  falling.blocks.push(['cube', 'wood', 8, 8, 0]);
  const rejection = settleTest(falling);
  report('settle rejects self-collapse', !rejection.ok && rejection.movedPieces.length > 0,
    `settled ${rejection.settled}; moved [${rejection.movedPieces.join(', ')}]`);

  const lethal = { v: 1, blocks: [], pigs: copy(VALID.pigs) };
  lethal.pigs[1][2] = 15;
  const pigDeath = settleTest(lethal);
  report('settle rejects pig death', !pigDeath.ok && pigDeath.deadPigs.length === 1,
    `dead pigs [${pigDeath.deadPigs.join(', ')}]`);
  return { guaranteed, total: fixtures.length };
}

const sizes = roundTripGate();
const rules = rulesGate();
const hostile = hostileGate();
editingGate();
budgetGate();
flagsGate();
const settling = settleGate();

console.log('\nMeasurements');
console.log(`  encoded average: ${sizes.averageEncoded.toFixed(1)} B; JSON average: ` +
  `${sizes.averageJson.toFixed(1)} B; saving ` +
  `${((1 - sizes.averageEncoded / sizes.averageJson) * 100).toFixed(1)}%`);
console.log(`  burial depth: shallow ${rules.shallowDepth}; deep ${rules.deepDepth}`);
console.log(`  hostile payloads rejected: ${hostile.rejected}/${hostile.total}`);
console.log(`  further-settle guarantee: ${settling.guaranteed}/${settling.total}`);

if (failures) {
  console.error(`\n${failures} editor assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll editor assertions passed.');
}
