#!/usr/bin/env node

import {
  BUDGET,
  CARDS,
  MATERIALS,
  PIGS,
  SHAPES,
  TUNE
} from '../data.js?v=20260904-1';
import { isSettled, rng, rngInt } from '../physics.js?v=20260904-1';
import { digestRound, makeRound, stepRound } from '../sim.js?v=20260904-1';
import {
  assertNoMotifCollision,
  bridge,
  bunker,
  composeMotifs,
  keep,
  scaffold,
  stack,
  tower
} from '../motifs.js?v=20260904-1';
import {
  burialDepth,
  budgetFor,
  decode,
  earlyLockScrap,
  encode,
  fromBlueprint,
  makeDraft,
  moveTo,
  PIG_Y_QUANTUM,
  place,
  redo,
  removeAt,
  rotate,
  seatPigY,
  SETTLE_MOVE_TOLERANCE,
  settleTest,
  spent,
  toBlueprint,
  undo,
  validate
} from '../build.js?v=20260904-1';

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
      rngInt(random, TUNE.plotH / PIG_Y_QUANTUM + 1) * PIG_Y_QUANTUM,
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
  const boundary = {
    v: 1,
    blocks: [['cube', 'wood', TUNE.plotW, TUNE.plotH, 23]],
    pigs: [['king', TUNE.plotW, TUNE.plotH, 3]]
  };
  const boundaryWire = encode(boundary);
  report('codec v3 packs quarter-grid plot boundaries',
    bytesOf(boundaryWire)[0] === 3 && same(decode(boundaryWire), boundary),
    `${TUNE.plotW / TUNE.gridSnap} horizontal steps; ` +
    `${TUNE.plotH / TUNE.gridSnap} vertical steps; ${boundaryWire.length} characters`);
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

function lockedPieceBlueprint() {
  const blueprint = copy(VALID);
  blueprint.pigs[1].push(1);
  return blueprint;
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
    ['locked-piece', lockedPieceBlueprint(), {}],
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

function modeRulesGate() {
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
  const cases = [
    ['out-of-bounds', out, {}],
    ['overlap', overlap, {}],
    ['too-many-blocks', tooManyBlueprint(), { budget: 1000 }],
    ['king-count', noKing, {}],
    ['too-few-pigs', tooFew, {}],
    ['over-budget', VALID, { budget: 8 }],
    ['locked-material', locked, { budget: 1000 }],
    ['locked-piece', lockedPieceBlueprint(), {}],
    ['piece-limit', flaggedLimitBlueprint(), {
      budget: 100, cards: ['understudy', 'flak-hog']
    }],
    ['buried-king', deepBlueprint(), {}]
  ];
  const siegeRules = [];
  const campaignRules = [];
  let defaultsMatch = 0;
  for (const [code, blueprint, opts] of cases) {
    const implicit = validate(blueprint, opts);
    const siege = validate(blueprint, { ...opts, mode: 'siege' });
    const campaign = validate(blueprint, { ...opts, mode: 'campaign' });
    if (same(implicit, siege)) defaultsMatch++;
    if (onlyCodes(siege).includes(code)) siegeRules.push(code);
    if (onlyCodes(campaign).includes(code)) campaignRules.push(code);
  }
  const difference = [...new Set([
    ...siegeRules.filter((code) => !campaignRules.includes(code)),
    ...campaignRules.filter((code) => !siegeRules.includes(code))
  ])];
  const dropped = ['king-count', 'too-few-pigs', 'over-budget', 'buried-king'];
  const common = [
    'out-of-bounds', 'overlap', 'too-many-blocks', 'locked-material',
    'locked-piece', 'piece-limit'
  ];
  const exactSplit = same(difference, dropped) &&
    common.every((code) => siegeRules.includes(code) && campaignRules.includes(code)) &&
    dropped.every((code) => siegeRules.includes(code) && !campaignRules.includes(code));
  report('campaign and Siege rule-set split', exactSplit,
    `only Siege [${difference.join(', ')}]; shared [${common.join(', ')}]`);
  report('implicit validation remains Siege', defaultsMatch === cases.length,
    `${defaultsMatch}/${cases.length} fixtures byte-identical to explicit Siege results`);
  let invalidMode = null;
  try {
    validate(VALID, { mode: 'practice' });
  } catch (error) {
    invalidMode = error;
  }
  report('validation rejects unknown modes', invalidMode instanceof RangeError,
    invalidMode?.message ?? 'accepted unknown mode');
  return { difference, defaultsMatch, total: cases.length };
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
  const legacyExpected = copy(fixture);
  legacyExpected.pigs[0].push(0);
  const legacyV1 = decode('AQEBEIAIAIAE');
  const legacyV2 = decode('AgEBEIAIAIAEAA');
  report('legacy codecs retain half-grid positions and flags',
    same(legacyV1, legacyExpected) && same(legacyV2, legacyExpected),
    `v1/v2 y ${legacyV1.pigs?.[0]?.[2] ?? 'missing'}/` +
    `${legacyV2.pigs?.[0]?.[2] ?? 'missing'}; flags ` +
    `${legacyV1.pigs?.[0]?.[3] ?? 'missing'}/${legacyV2.pigs?.[0]?.[3] ?? 'missing'}`);
  return { rejected, total: attacks.length };
}

function editingGate() {
  const draft = makeDraft({ budget: 20, historyLimit: 3 });
  const placed = place(draft, {
    kind: 'block', shape: 'cube', material: 'wood', x: 1.24, y: 0.74, rotation: 25
  });
  const id = placed.piece?.id;
  const snapped = placed.ok && draft.pieces[0].x === 1.25 && draft.pieces[0].y === 0.75 &&
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

function seatingGate() {
  const supported = makeDraft({ budget: 1000 });
  place(supported, { shape: 'slab', material: 'wood', x: 4, y: 0.5 });
  const placed = place(supported, { pig: 'runt', x: 4.12, y: 4 });
  const expectedBlockY = seatPigY(toBlueprint(supported).blocks, 'runt', 4, 4);
  const blockSeated = placed.ok && placed.piece.x === 4 && placed.piece.y === expectedBlockY;
  const moved = moveTo(supported, placed.piece.id, 8.12, 4);
  const expectedGroundY = seatPigY(toBlueprint(supported).blocks, 'runt', 8, 4);
  const groundSeated = moved.ok && supported.pieces.find((piece) =>
    piece.id === placed.piece.id)?.y === expectedGroundY;

  const allPigs = makeDraft({ budget: 1000 });
  let exact = 0;
  for (let index = 0; index < pigIds.length; index++) {
    const id = pigIds[index];
    const x = 2 + index * 2.5;
    const result = place(allPigs, { pig: id, x, y: 4 });
    if (result.ok && result.piece.y === seatPigY([], id, x, 4) &&
        Number.isInteger(result.piece.y / PIG_Y_QUANTUM)) exact++;
  }
  const seatedBlueprint = toBlueprint(allPigs);
  const physicalPigs = seatedBlueprint.pigs.filter((tuple) => !PIGS[tuple[0]].traits.balloon);
  const tested = settleTest({ ...seatedBlueprint, pigs: physicalPigs });
  report('pig placement ray-seats ground and block surfaces',
    blockSeated && groundSeated && exact === pigIds.length && tested.ok,
    `block y ${placed.piece?.y}; ground y ${expectedGroundY}; ` +
    `${exact}/${pigIds.length} quantised; ${physicalPigs.length} physical pig residual ` +
    tested.maxMovement.toFixed(5));
  return tested.maxMovement;
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
      const manual = place(draft, { pig: effect.pig, x: 1, y: 1 });
      const round = makeRound({
        mode: 'siege', seed: 1, bag: [], defenderCards: [card.id],
        blueprint: { v: 1, blocks: [], pigs: [['king', 12, 0.6875, 0]] }
      });
      const automatic = round.pigs.filter((pig) => pig.autoPlaced).length;
      if (!manual.ok && manual.reason === 'over-budget' && automatic === effect.count) authored++;
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

function balloonSettleGate() {
  const drifting = {
    v: 1,
    blocks: [['cube', 'wood', 10, 0.5, 0]],
    pigs: [['runt', 6, 0.3, 0], ['zep', 14, 3, 0]]
  };
  const drifted = settleTest(drifting);
  const exemptions = drifted.movementExemptions.map((item) =>
    `${item.bodyId} (${item.reason}, ${item.movement.toFixed(5)})`);
  const expectedBodies = ['pig:1', 'pig:1:balloon'];
  report('declared balloon drift is movement-exempt', drifted.ok && drifted.settled &&
    drifted.maxMovement <= SETTLE_MOVE_TOLERANCE &&
    same(drifted.movementExemptions.map((item) => item.bodyId), expectedBodies) &&
    drifted.movementExemptions.every((item) => item.reason === 'traits.balloon'),
  `max strict move ${drifted.maxMovement.toFixed(5)}; exempt [${exemptions.join(', ')}]`);

  const edge = { v: 1, blocks: [], pigs: [['zep', 1.2, 3, 0]] };
  const edgeValidation = validate(edge, { mode: 'campaign' });
  const edgeError = edgeValidation.errors.find((item) => item.code === 'out-of-bounds');
  report('balloon drift extremes remain inside the plot', !edgeValidation.ok &&
    same(edgeError?.pieceIds, ['pig:0']),
  `errors [${onlyCodes(edgeValidation).join(', ')}]; pieces ` +
    `[${edgeError?.pieceIds.join(', ') ?? ''}]`);

  const embedded = {
    v: 1,
    blocks: [['cube', 'wood', 10, 0.5, 0]],
    pigs: [['zep', 10, 0.5, 0]]
  };
  const embeddedValidation = validate(embedded, { mode: 'campaign' });
  const embeddedSettle = settleTest(embedded);
  const embeddedRejected = onlyCodes(embeddedValidation).includes('overlap') ||
    embeddedSettle.deadPigs.length > 0 || embeddedSettle.movedPieces.length > 0;
  report('balloon movement exemption does not hide broken placement',
    embeddedRejected && (!embeddedValidation.ok || !embeddedSettle.ok),
    `validation [${onlyCodes(embeddedValidation).join(', ')}]; settle ok ` +
    `${embeddedSettle.ok}; dead [${embeddedSettle.deadPigs.join(', ')}]; ` +
    `moved [${embeddedSettle.movedPieces.join(', ')}]`);

  const ordinary = { v: 1, blocks: [], pigs: [['runt', 6, 0.9, 0]] };
  const ordinarySettle = settleTest(ordinary);
  report('undeclared pig movement keeps the strict tolerance', !ordinarySettle.ok &&
    ordinarySettle.maxMovement > 0.59 && ordinarySettle.maxMovement < 0.61 &&
    same(ordinarySettle.movedPieces, ['pig:0']) &&
    ordinarySettle.movementExemptions.length === 0,
  `max move ${ordinarySettle.maxMovement.toFixed(5)}; moved ` +
    `[${ordinarySettle.movedPieces.join(', ')}]; exempt ` +
    `${ordinarySettle.movementExemptions.length}`);
}

function motifGate() {
  const fixtures = [
    ['tower default', tower({ x: 2 })],
    ['tower minimum', tower({
      x: 2, width: 2, storeys: 1, materials: 'glass', capped: false,
      pigs: ['runt']
    })],
    ['tower maximum', tower({
      x: 2, width: 12, storeys: 3, materials: 'wood', capped: true,
      pigs: [{ id: 'swine', bay: 5, storey: 2 }]
    })],
    ['bunker default', bunker({ x: 2 })],
    ['bunker minimum', bunker({
      x: 2, width: 2, wallHeight: 1, wallMaterial: 'glass',
      roofMaterial: 'wood', pigs: ['runt']
    })],
    ['bunker maximum', bunker({
      x: 2, width: 12, wallHeight: 5, wallMaterial: 'wood',
      roofMaterial: 'glass', pigs: ['runt', 'swine', 'runt', 'swine', 'runt', 'swine']
    })],
    ['bridge default', bridge({ x: 2 })],
    ['bridge minimum', bridge({
      x: 2, span: 2, supports: 2, supportHeight: 1,
      supportMaterial: 'glass', deckMaterial: 'wood', pigs: ['runt']
    })],
    ['bridge maximum', bridge({
      x: 2, span: 12, supports: 7, supportHeight: 4,
      supportMaterial: 'wood', deckMaterial: 'glass',
      pigs: [{ id: 'swine', bay: 5 }]
    })],
    ['stack default', stack({ x: 2 })],
    ['stack minimum', stack({ x: 2, height: 1, shape: 'slab', materials: 'glass' })],
    ['stack maximum', stack({
      x: 2, height: 10, shape: 'cube', materials: ['wood', 'glass']
    })],
    ['keep default', keep({ x: 2 })],
    ['keep minimum', keep({
      x: 2, outerWidth: 8, towerWidth: 2, wallHeight: 1, storeys: 1,
      wallMaterial: 'glass', towerMaterials: 'wood'
    })],
    ['keep maximum', keep({
      x: 2, outerWidth: 16, towerWidth: 8, wallHeight: 5, storeys: 3,
      wallMaterial: 'stone', towerMaterials: 'wood'
    })],
    ['scaffold default', scaffold({ x: 2 })],
    ['scaffold minimum', scaffold({
      x: 2, bays: 1, height: 2, postMaterial: 'glass',
      plankMaterial: 'wood', pigs: ['runt']
    })],
    ['scaffold maximum', scaffold({
      x: 2, bays: 4, height: 4, postMaterial: 'wood',
      plankMaterial: 'glass', pigs: [{ id: 'swine', bay: 3 }]
    })]
  ];
  let stable = 0;
  let largestMovement = 0;
  for (const [name, fragment] of fixtures) {
    const blueprint = composeMotifs(fragment);
    const tested = settleTest(blueprint);
    largestMovement = Math.max(largestMovement, tested.maxMovement);
    const strict = tested.ok && tested.maxMovement <= SETTLE_MOVE_TOLERANCE;
    if (strict) stable++;
    report(`motif settles: ${name}`, strict,
      `${fragment.blocks.length} blocks/${fragment.pigs.length} pigs; ` +
      `max move ${tested.maxMovement.toFixed(5)}`);
  }

  let collisionRejected = false;
  try {
    assertNoMotifCollision(stack({ x: 4 }), stack({ x: 4 }));
  } catch (error) {
    collisionRejected = error instanceof RangeError && error.message.includes('overlap');
  }
  const separated = assertNoMotifCollision(stack({ x: 4 }), stack({ x: 8 }));
  report('motif composition collision guard', collisionRejected && separated,
    `overlap rejected ${collisionRejected}; separated accepted ${separated}`);
  const snapped = scaffold({ x: 2.24, y: 0.24, pigs: ['runt'] });
  const gridExact = snapped.blocks.every((tuple) =>
    Number.isInteger(tuple[2] / TUNE.gridSnap) &&
    Number.isInteger(tuple[3] / TUNE.gridSnap) && Number.isInteger(tuple[4])) &&
    snapped.pigs.every((tuple) =>
      Number.isInteger(tuple[1] / TUNE.gridSnap) &&
      Number.isInteger(tuple[2] / PIG_Y_QUANTUM));
  report('motif grid and rotation contract', gridExact,
    `${snapped.blocks.length} blocks at ${TUNE.gridSnap}; ` +
    `${snapped.pigs.length} pig Y at ${PIG_Y_QUANTUM}`);
  return { stable, total: fixtures.length, largestMovement };
}

const sizes = roundTripGate();
const rules = rulesGate();
const modeRules = modeRulesGate();
const hostile = hostileGate();
editingGate();
budgetGate();
flagsGate();
const pigResidual = seatingGate();
const settling = settleGate();
balloonSettleGate();
const motifs = motifGate();

console.log('\nMeasurements');
console.log(`  encoded average: ${sizes.averageEncoded.toFixed(1)} B; JSON average: ` +
  `${sizes.averageJson.toFixed(1)} B; saving ` +
  `${((1 - sizes.averageEncoded / sizes.averageJson) * 100).toFixed(1)}%`);
console.log(`  burial depth: shallow ${rules.shallowDepth}; deep ${rules.deepDepth}`);
console.log(`  hostile payloads rejected: ${hostile.rejected}/${hostile.total}`);
console.log(`  seated pig residual movement: ${pigResidual.toFixed(5)}`);
console.log(`  further-settle guarantee: ${settling.guaranteed}/${settling.total}`);
console.log(`  validation modes differ only in: ${modeRules.difference.join(', ')}`);
console.log(`  motif settles: ${motifs.stable}/${motifs.total}; largest movement ` +
  motifs.largestMovement.toFixed(5));

if (failures) {
  console.error(`\n${failures} editor assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll editor assertions passed.');
}
