import { BUDGET, CARDS, CARDS_BY_ID, MATERIALS, PIGS, SHAPES, TUNE } from './data.js?v=20260904-2';
import { fromDegrees, makeWorld, maxPenetration, raycast } from './physics.js?v=20260904-2';
import { BLUEPRINT_VERSION, PIG_FLAG_DECOY, PIG_FLAG_FLAK, PIG_FLAGS,
  blockRayDepth, blueprintFromLevel, instantiate, makeRound, stepRound } from './sim.js?v=20260904-2';
const HISTORY_LIMIT = 64;
const LEGACY_CODEC_VERSION = 1;
const FLAGS_CODEC_VERSION = 2;
const CODEC_VERSION = 3;
const LEGACY_GRID_SNAP = 0.5;
export const PIG_Y_QUANTUM = 1 / 64;
export const SETTLE_MOVE_TOLERANCE = TUNE.slop * 10;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64_INDEX = Object.create(null);
for (let index = 0; index < BASE64.length; index++) BASE64_INDEX[BASE64[index]] = index;
const SHAPE_IDS = Object.keys(SHAPES);
const MATERIAL_IDS = Object.keys(MATERIALS);
const PIG_IDS = Object.keys(PIGS);
const SHAPE_INDEX = indexById(SHAPE_IDS);
const MATERIAL_INDEX = indexById(MATERIAL_IDS);
const PIG_INDEX = indexById(PIG_IDS);
const MAX_PIGS = 255;
const MAX_CODEC_BYTES = 3 + TUNE.maxBlocks * 4 + MAX_PIGS * 4;
const MAX_CODEC_CHARS = Math.ceil(MAX_CODEC_BYTES * 4 / 3);
// These are literal 64ths of a turn. Generating them with a Math.cos/Math.sin loop
// would make burial legality depend on the relay's JS engine in last-bit edge cases.
const BURIAL_DIRECTIONS = [
  [1, 0], [0.9951847266721969, 0.0980171403295606], [0.9807852804032304, 0.19509032201612825], [0.9569403357322088, 0.29028467725446233], [0.9238795325112867, 0.3826834323650898],
  [0.881921264348355, 0.47139673682599764], [0.8314696123025452, 0.5555702330196022], [0.773010453362737, 0.6343932841636455],
  [0.7071067811865476, 0.7071067811865476], [0.6343932841636455, 0.773010453362737], [0.5555702330196022, 0.8314696123025452],
  [0.47139673682599764, 0.881921264348355], [0.3826834323650898, 0.9238795325112867], [0.29028467725446233, 0.9569403357322088],
  [0.19509032201612825, 0.9807852804032304], [0.0980171403295606, 0.9951847266721969],
  [0, 1], [-0.0980171403295606, 0.9951847266721969],
  [-0.19509032201612825, 0.9807852804032304], [-0.29028467725446233, 0.9569403357322088],
  [-0.3826834323650898, 0.9238795325112867], [-0.47139673682599764, 0.881921264348355],
  [-0.5555702330196022, 0.8314696123025452], [-0.6343932841636455, 0.773010453362737],
  [-0.7071067811865476, 0.7071067811865476], [-0.773010453362737, 0.6343932841636455],
  [-0.8314696123025452, 0.5555702330196022], [-0.881921264348355, 0.47139673682599764],
  [-0.9238795325112867, 0.3826834323650898], [-0.9569403357322088, 0.29028467725446233],
  [-0.9807852804032304, 0.19509032201612825], [-0.9951847266721969, 0.0980171403295606],
  [-1, 0], [-0.9951847266721969, -0.0980171403295606],
  [-0.9807852804032304, -0.19509032201612825], [-0.9569403357322088, -0.29028467725446233],
  [-0.9238795325112867, -0.3826834323650898], [-0.881921264348355, -0.47139673682599764],
  [-0.8314696123025452, -0.5555702330196022], [-0.773010453362737, -0.6343932841636455],
  [-0.7071067811865476, -0.7071067811865476], [-0.6343932841636455, -0.773010453362737],
  [-0.5555702330196022, -0.8314696123025452], [-0.47139673682599764, -0.881921264348355],
  [-0.3826834323650898, -0.9238795325112867], [-0.29028467725446233, -0.9569403357322088],
  [-0.19509032201612825, -0.9807852804032304], [-0.0980171403295606, -0.9951847266721969],
  [0, -1], [0.0980171403295606, -0.9951847266721969],
  [0.19509032201612825, -0.9807852804032304], [0.29028467725446233, -0.9569403357322088],
  [0.3826834323650898, -0.9238795325112867], [0.47139673682599764, -0.881921264348355],
  [0.5555702330196022, -0.8314696123025452], [0.6343932841636455, -0.773010453362737],
  [0.7071067811865476, -0.7071067811865476], [0.773010453362737, -0.6343932841636455],
  [0.8314696123025452, -0.5555702330196022], [0.881921264348355, -0.47139673682599764],
  [0.9238795325112867, -0.3826834323650898], [0.9569403357322088, -0.29028467725446233],
  [0.9807852804032304, -0.19509032201612825], [0.9951847266721969, -0.0980171403295606]
];
function indexById(ids) {
  const result = Object.create(null);
  for (let index = 0; index < ids.length; index++) result[ids[index]] = index;
  return result;
}
function normaliseCards(cards = []) {
  const wanted = Object.create(null);
  for (const card of cards) {
    const id = typeof card === 'string' ? card : card?.id;
    if (CARDS_BY_ID[id]) wanted[id] = true;
  }
  return CARDS.filter((card) => wanted[card.id]).map((card) => card.id);
}
function rulesFor(cards) {
  const rules = {
    unlocked: Object.create(null),
    costs: Object.create(null),
    limits: Object.create(null),
    budgetBonus: 0,
    decoy: null,
    flak: null,
    autoPigs: Object.create(null)
  };
  for (const id of MATERIAL_IDS) {
    rules.unlocked[id] = true;
    rules.costs[id] = MATERIALS[id].cost;
    rules.limits[id] = Infinity;
  }
  // A material referenced by an unlock, or by a cost effect carrying an explicit
  // limit, is draft-only. This derives the base palette from the card data itself.
  for (const card of CARDS) {
    const effect = card.effect;
    if (effect.kind === 'unlock' ||
        effect.kind === 'materialCost' && Object.hasOwn(effect, 'limit')) {
      rules.unlocked[effect.material] = false;
      rules.limits[effect.material] = 0;
    }
  }
  const selected = normaliseCards(cards);
  for (const id of selected) {
    const effect = CARDS_BY_ID[id].effect;
    if (effect.kind === 'unlock') {
      rules.unlocked[effect.material] = true;
      rules.limits[effect.material] = effect.perRound ?? Infinity;
    } else if (effect.kind === 'materialCost') {
      rules.costs[effect.material] = effect.cost;
      if (Object.hasOwn(effect, 'limit')) {
        rules.unlocked[effect.material] = true;
        rules.limits[effect.material] = effect.limit ?? Infinity;
      }
    } else if (effect.kind === 'budget') {
      rules.budgetBonus += effect.delta;
    } else if (effect.kind === 'decoyKing') {
      rules.decoy = effect;
    } else if (effect.kind === 'pigAbility' && effect.ability === 'flak') {
      rules.flak = effect;
    } else if (effect.kind === 'autoPig') {
      rules.autoPigs[effect.pig] = effect;
    }
  }
  return rules;
}
export function earlyLockScrap(secondsRemaining) {
  return Number.isFinite(secondsRemaining) ? Math.floor(Math.max(0, secondsRemaining) / 10) * BUDGET.earlyLockPer10s : 0;
}
export function budgetFor(opts = {}) {
  const round = opts.round ?? 1;
  const roundsBehind = opts.roundsBehind ?? 0;
  const base = opts.budget ??
    BUDGET.base + BUDGET.perRound * (round - 1) + BUDGET.perDeficit * roundsBehind;
  const banked = opts.bankedScrap ?? opts.bankedEarlyLockScrap ?? opts.banked ?? 0;
  return base + banked + rulesFor(opts.cards ?? []).budgetBonus;
}
function clonePiece(piece) { return { ...piece }; }
function snapshot(draft) { return { pieces: draft.pieces.map(clonePiece), nextId: draft.nextId }; }
function restore(draft, state) {
  draft.pieces = state.pieces.map(clonePiece);
  draft.nextId = state.nextId;
}
function remember(draft) {
  draft.history.push(snapshot(draft));
  if (draft.history.length > draft.historyLimit) draft.history.shift();
  draft.future.length = 0;
}
function result(ok, reason = null, extra = {}) { return { ok, reason, ...extra }; }
function snap(value) {
  const snapped = Math.round(value / TUNE.gridSnap) * TUNE.gridSnap;
  return snapped === 0 ? 0 : snapped;
}
function quantise(value, quantum) {
  const quantised = Math.round(value / quantum) * quantum;
  return quantised === 0 ? 0 : quantised;
}
function blockTuples(pieces) {
  return pieces.filter((piece) => piece.kind === 'block').map((piece) => [
    piece.shape, piece.material, piece.x, piece.y, rotationStep(piece.rotation)
  ]);
}
export function seatPigY(blocks, pigId, x, placementY) {
  if (!PIGS[pigId]) throw new RangeError(`unknown pig: ${pigId}`);
  if (!Number.isFinite(x) || !Number.isFinite(placementY)) {
    throw new TypeError('pig placement must be finite');
  }
  const world = makeWorld({ gravity: 0 });
  instantiate(world, { v: BLUEPRINT_VERSION, blocks, pigs: [] });
  const hit = raycast(world, x, placementY, x, -TUNE.gridSnap,
    (body) => body.role === 'ground' || body.role === 'block');
  if (!hit) return null;
  // Store the wire-representable centre now so export/import cannot move a pig
  // after the editor has already validated the authored pose.
  return quantise(hit.y + PIGS[pigId].radius, PIG_Y_QUANTUM);
}
function rotationStep(value) {
  const step = Number.isInteger(value) ? value : 0;
  return step - Math.floor(step / 24) * 24;
}
function pieceRotation(piece) {
  return fromDegrees(rotationStep(piece.rotation) * TUNE.rotSnapDeg);
}
function normalisePiece(draft, source) {
  if (!source || typeof source !== 'object') return result(false, 'invalid-piece');
  const kind = source.kind ?? source.type ?? (source.shape ? 'block' : source.pig ? 'pig' : null);
  if (kind !== 'block' && kind !== 'pig') return result(false, 'invalid-piece');
  if (!Number.isFinite(source.x) || !Number.isFinite(source.y)) return result(false, 'invalid-position');
  const id = source.id ?? draft.nextId;
  if (draft.pieces.some((piece) => piece.id === id)) return result(false, 'duplicate-id');
  if (kind === 'pig') {
    const pig = source.pig ?? source.pigId;
    if (!PIGS[pig]) return result(false, 'invalid-pig');
    const x = snap(source.x);
    const y = seatPigY(blockTuples(draft.pieces), pig, x, source.y);
    if (y === null) return result(false, 'no-support');
    return result(true, null, {
      piece: {
        id, kind, pig, x, y,
        decoy: Boolean(source.decoy), flak: Boolean(source.flak)
      }
    });
  }
  const shape = source.shape ?? source.shapeId;
  const material = source.material ?? source.materialId;
  if (!SHAPES[shape]) return result(false, 'invalid-shape');
  if (!MATERIALS[material]) return result(false, 'invalid-material');
  if (source.c !== undefined || source.s !== undefined || typeof source.rotation === 'object') {
    return result(false, 'invalid-rotation');
  }
  const rotation = source.rotation ?? source.steps ?? 0;
  if (!Number.isInteger(rotation)) return result(false, 'invalid-rotation');
  return result(true, null, { piece: {
    id, kind, shape, material,
    x: snap(source.x), y: snap(source.y),
    rotation: rotationStep(rotation)
  } });
}
export function makeDraft(opts = {}) {
  const cards = normaliseCards(opts.cards ?? []);
  return {
    budget: budgetFor({ ...opts, cards }), cards, pieces: [], nextId: 1,
    history: [], future: [], historyLimit: Math.max(1,
      Math.min(HISTORY_LIMIT, Math.floor(opts.historyLimit ?? HISTORY_LIMIT)))
  };
}
function basePieceCost(piece, rules) {
  if (piece.kind === 'block') return rules.costs[piece.material] * SHAPES[piece.shape].area;
  if (piece.decoy) return rules.decoy?.cost ?? Infinity;
  return PIGS[piece.pig].cost;
}
function totalCost(pieces, rules) {
  let total = 0;
  for (const piece of pieces) {
    total += basePieceCost(piece, rules);
  }
  return total;
}
export function spent(draft) { return totalCost(draft.pieces, rulesFor(draft.cards)); }
export function place(draft, source) {
  const made = normalisePiece(draft, source);
  if (!made.ok) return made;
  const piece = made.piece;
  const rules = rulesFor(draft.cards);
  if (piece.kind === 'block') {
    if (!rules.unlocked[piece.material]) return result(false, 'locked-material');
    const used = draft.pieces.filter((other) =>
      other.kind === 'block' && other.material === piece.material).length;
    if (used >= rules.limits[piece.material]) return result(false, 'material-limit');
  }
  if (piece.decoy) {
    if (!rules.decoy) return result(false, 'locked-piece');
    const used = draft.pieces.filter((other) => other.decoy).length;
    if (used >= rules.decoy.limit) return result(false, 'piece-limit');
  }
  if (piece.flak) {
    if (!rules.flak) return result(false, 'locked-piece');
    const used = draft.pieces.filter((other) => other.flak).length;
    if (used >= rules.flak.pigCount) return result(false, 'piece-limit');
  }
  const nextCost = totalCost([...draft.pieces, piece], rules);
  if (nextCost > draft.budget) return result(false, 'over-budget');
  remember(draft);
  draft.pieces.push(piece);
  if (source.id === undefined) draft.nextId++;
  else if (Number.isInteger(piece.id) && piece.id >= draft.nextId) draft.nextId = piece.id + 1;
  return result(true, null, { piece: clonePiece(piece), spent: nextCost });
}
function contains(piece, x, y) {
  const dx = x - piece.x;
  const dy = y - piece.y;
  if (piece.kind === 'pig') {
    const radius = PIGS[piece.pig].radius;
    return dx * dx + dy * dy <= radius * radius;
  }
  const shape = SHAPES[piece.shape];
  const rotation = pieceRotation(piece);
  const lx = rotation.c * dx + rotation.s * dy;
  const ly = -rotation.s * dx + rotation.c * dy;
  if (shape.kind === 'circle') return lx * lx + ly * ly <= shape.r * shape.r;
  if (shape.kind === 'box') {
    return Math.abs(lx) <= shape.w / 2 && Math.abs(ly) <= shape.h / 2;
  }
  const vertices = [
    [-shape.w / 3, -shape.h / 3],
    [2 * shape.w / 3, -shape.h / 3],
    [-shape.w / 3, 2 * shape.h / 3]
  ];
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    if ((b[0] - a[0]) * (ly - a[1]) - (b[1] - a[1]) * (lx - a[0]) < 0) return false;
  }
  return true;
}
export function removeAt(draft, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return result(false, 'invalid-position');
  for (let index = draft.pieces.length - 1; index >= 0; index--) {
    if (!contains(draft.pieces[index], x, y)) continue;
    remember(draft);
    const removed = draft.pieces.splice(index, 1)[0];
    return result(true, null, { piece: clonePiece(removed) });
  }
  return result(false, 'not-found');
}
export function moveTo(draft, id, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return result(false, 'invalid-position');
  const piece = draft.pieces.find((candidate) => candidate.id === id);
  if (!piece) return result(false, 'not-found');
  const nextX = snap(x);
  const nextY = piece.kind === 'pig'
    ? seatPigY(blockTuples(draft.pieces), piece.pig, nextX, y)
    : snap(y);
  if (nextY === null) return result(false, 'no-support');
  remember(draft);
  piece.x = nextX;
  piece.y = nextY;
  return result(true);
}
export function rotate(draft, id, steps) {
  const piece = draft.pieces.find((candidate) => candidate.id === id);
  if (!piece) return result(false, 'not-found');
  if (piece.kind !== 'block') return result(false, 'not-rotatable');
  if (!Number.isInteger(steps)) return result(false, 'invalid-rotation');
  remember(draft);
  piece.rotation = rotationStep(piece.rotation + steps);
  return result(true);
}
export function undo(draft) {
  if (!draft.history.length) return result(false, 'empty-history');
  draft.future.push(snapshot(draft));
  restore(draft, draft.history.pop());
  return result(true);
}
export function redo(draft) {
  if (!draft.future.length) return result(false, 'empty-history');
  draft.history.push(snapshot(draft));
  if (draft.history.length > draft.historyLimit) draft.history.shift();
  restore(draft, draft.future.pop());
  return result(true);
}
export function toBlueprint(draft) {
  const blocks = [];
  const pigs = [];
  for (const piece of draft.pieces) {
    if (piece.kind === 'block') {
      blocks.push([piece.shape, piece.material, piece.x, piece.y, rotationStep(piece.rotation)]);
    } else {
      const flags = (piece.decoy ? PIG_FLAG_DECOY : 0) |
        (piece.flak ? PIG_FLAG_FLAK : 0);
      pigs.push([piece.pig, piece.x, piece.y, flags]);
    }
  }
  return { v: BLUEPRINT_VERSION, blocks, pigs };
}
export function fromBlueprint(blueprint, opts = {}) {
  const source = blueprintFromLevel(blueprint);
  const draft = makeDraft(opts);
  for (const tuple of source.blocks) {
    draft.pieces.push({
      id: draft.nextId++, kind: 'block', shape: tuple[0], material: tuple[1],
      x: tuple[2], y: tuple[3], rotation: rotationStep(tuple[4])
    });
  }
  for (const tuple of source.pigs) {
    const flags = tuple[PIG_FLAGS];
    draft.pieces.push({ id: draft.nextId++, kind: 'pig', pig: tuple[0],
      x: tuple[1], y: tuple[2],
      decoy: (flags & PIG_FLAG_DECOY) !== 0,
      flak: (flags & PIG_FLAG_FLAK) !== 0 });
  }
  return draft;
}
function contextFor(value, opts) {
  if (value && Array.isArray(value.pieces)) {
    const blueprint = toBlueprint(value);
    const blockIds = [];
    const pigIds = [];
    const kingFlags = [];
    for (const piece of value.pieces) {
      if (piece.kind === 'block') blockIds.push(piece.id);
      else {
        pigIds.push(piece.id);
        kingFlags.push(Boolean(PIGS[piece.pig]?.traits.king) && !piece.decoy);
      }
    }
    return {
      blueprint, pieces: value.pieces, blockIds, pigIds, kingFlags,
      cards: value.cards, budget: value.budget
    };
  }
  const blueprint = blueprintFromLevel(value);
  const blockIds = blueprint.blocks.map((unused, index) => `block:${index}`);
  const pigIds = blueprint.pigs.map((unused, index) => `pig:${index}`);
  const pieces = [
    ...blueprint.blocks.map((tuple, index) => ({
      id: blockIds[index], kind: 'block', shape: tuple[0], material: tuple[1],
      x: tuple[2], y: tuple[3], rotation: tuple[4]
    })),
    ...blueprint.pigs.map((tuple, index) => ({
      id: pigIds[index], kind: 'pig', pig: tuple[0], x: tuple[1], y: tuple[2],
      decoy: (tuple[PIG_FLAGS] & PIG_FLAG_DECOY) !== 0,
      flak: (tuple[PIG_FLAGS] & PIG_FLAG_FLAK) !== 0
    }))
  ];
  return {
    blueprint, pieces, blockIds, pigIds,
    kingFlags: blueprint.pigs.map((tuple) =>
      Boolean(PIGS[tuple[0]].traits.king) && (tuple[PIG_FLAGS] & PIG_FLAG_DECOY) === 0),
    cards: normaliseCards(opts.cards ?? []), budget: budgetFor(opts)
  };
}
function pieceIdForBody(context, body) {
  if (body.role === 'block') return context.blockIds[body.blueprintIndex];
  if (body.role === 'pig') return context.pigIds[body.blueprintIndex];
  if (body.role === 'balloon') return context.pigIds[body.pigBody.blueprintIndex];
  return null;
}
function declaredMovement(context, body) {
  const pig = body.role === 'pig' ? body :
    body.role === 'balloon' ? body.pigBody : null;
  if (!pig) return null;
  if (pig.pig.traits.balloon) return {
    reason: 'traits.balloon',
    driftRange: pig.balloon?.driftRange ?? pig.pig.traits.driftRange ?? 0
  };
  if (!pig.isKing) return null;
  for (const id of context.cards) {
    const effect = CARDS_BY_ID[id].effect;
    if (effect.kind === 'kingBalloon') return {
      reason: `cards.${id}.effect.kind=kingBalloon`,
      driftRange: effect.driftRange ?? 0
    };
  }
  return null;
}
function reportedBodyId(context, body) {
  const pieceId = pieceIdForBody(context, body);
  return body.role === 'balloon' ? `${pieceId}:balloon` : pieceId;
}
function pushUnique(ids, id) { if (id !== null && !ids.includes(id)) ids.push(id); }
function contactDepth(contact) {
  const a = contact.a;
  const b = contact.b;
  const ax = a.x + a.c * contact.localAx - a.s * contact.localAy;
  const ay = a.y + a.s * contact.localAx + a.c * contact.localAy;
  const bx = b.x + b.c * contact.localBx - b.s * contact.localBy;
  const by = b.y + b.s * contact.localBx + b.c * contact.localBy;
  return -((bx - ax) * contact.nx + (by - ay) * contact.ny);
}
function burialInWorld(world, context, kingIndex) {
  if (TUNE.burialRayCount !== BURIAL_DIRECTIONS.length) {
    throw new RangeError('burial direction table must match TUNE.burialRayCount');
  }
  const king = world.bodies.find((body) =>
    body.role === 'pig' && body.blueprintIndex === kingIndex);
  if (!king) return null;
  const reach = TUNE.plotW + TUNE.plotH + 2;
  let minimum = Infinity;
  for (const direction of BURIAL_DIRECTIONS) {
    const depth = blockRayDepth(world,
      king.x + direction[0] * reach,
      king.y + direction[1] * reach,
      king.x, king.y);
    minimum = Math.min(minimum, depth);
    if (minimum === 0) break;
  }
  return minimum;
}
export function burialDepth(value, opts = {}) {
  const context = contextFor(value, opts);
  const kings = [];
  for (let index = 0; index < context.kingFlags.length; index++) {
    if (context.kingFlags[index]) kings.push(index);
  }
  if (kings.length !== 1) return null;
  const world = makeWorld({ gravity: 0 });
  instantiate(world, context.blueprint);
  return burialInWorld(world, context, kings[0]);
}
function error(code, message, pieceIds) { return { code, message, pieceIds }; }
export function validate(value, opts = {}) {
  const mode = opts.mode ?? 'siege';
  if (mode !== 'siege' && mode !== 'campaign') {
    throw new RangeError(`unknown validation mode: ${mode}`);
  }
  const context = contextFor(value, opts);
  const world = makeWorld({ gravity: 0 });
  const bodies = instantiate(world, context.blueprint);
  const penetration = maxPenetration(world);
  const errors = [];
  const outIds = [];
  for (const body of [...bodies.blocks, ...bodies.pigs, ...bodies.balloons]) {
    const driftRange = declaredMovement(context, body)?.driftRange ?? 0;
    if (body.minX - driftRange < -TUNE.slop ||
        body.maxX + driftRange > TUNE.plotW + TUNE.slop ||
        body.minY < -TUNE.slop || body.maxY > TUNE.plotH + TUNE.slop) {
      pushUnique(outIds, pieceIdForBody(context, body));
    }
  }
  if (outIds.length) errors.push(error(
    'out-of-bounds', 'Every piece must remain inside the 24 by 16 plot.', outIds
  ));
  if (penetration > TUNE.slop) {
    const overlapIds = [];
    for (const contact of world.contacts) {
      if (contact.a.role === 'ground' || contact.b.role === 'ground') continue;
      if (contactDepth(contact) <= TUNE.slop) continue;
      pushUnique(overlapIds, pieceIdForBody(context, contact.a));
      pushUnique(overlapIds, pieceIdForBody(context, contact.b));
    }
    if (overlapIds.length) errors.push(error(
      'overlap', 'Pieces may touch, but they may not intersect.', overlapIds
    ));
  }
  if (context.blueprint.blocks.length > TUNE.maxBlocks) {
    errors.push(error(
      'too-many-blocks', `A fortress may contain at most ${TUNE.maxBlocks} blocks.`,
      context.blockIds.slice(TUNE.maxBlocks)
    ));
  }
  const kingIndices = [];
  for (let index = 0; index < context.kingFlags.length; index++) {
    if (context.kingFlags[index]) kingIndices.push(index);
  }
  if (mode === 'siege' && kingIndices.length !== 1) {
    const ids = kingIndices.length
      ? kingIndices.map((index) => context.pigIds[index])
      : context.pigIds.slice();
    errors.push(error('king-count', 'Exactly one real King Hog is required.', ids));
  }
  const otherPigIds = [];
  for (let index = 0; index < context.pigIds.length; index++) {
    if (!context.kingFlags[index]) otherPigIds.push(context.pigIds[index]);
  }
  const automaticOtherPigs = Object.values(rulesFor(context.cards).autoPigs)
    .reduce((count, effect) => count +
      (PIGS[effect.pig].traits.king ? 0 : effect.count), 0);
  if (mode === 'siege' && otherPigIds.length + automaticOtherPigs < TUNE.minOtherPigs) {
    errors.push(error(
      'too-few-pigs', `At least ${TUNE.minOtherPigs} pigs besides the King are required.`,
      otherPigIds
    ));
  }
  const rules = rulesFor(context.cards);
  const cost = totalCost(context.pieces, rules);
  if (mode === 'siege' && Number.isFinite(cost) && cost > context.budget) {
    errors.push(error(
      'over-budget', `Fortress costs ${cost} scrap but only ${context.budget} is available.`,
      context.pieces.filter((piece) => basePieceCost(piece, rules) > 0).map((piece) => piece.id)
    ));
  }
  const lockedIds = context.pieces.filter((piece) =>
    piece.kind === 'block' && !rules.unlocked[piece.material]).map((piece) => piece.id);
  if (lockedIds.length) errors.push(error(
    'locked-material', 'One or more blocks use a material that has not been unlocked.', lockedIds
  ));
  const decoyIds = context.pieces.filter((piece) => piece.kind === 'pig' && piece.decoy)
    .map((piece) => piece.id);
  const flakIds = context.pieces.filter((piece) => piece.kind === 'pig' && piece.flak)
    .map((piece) => piece.id);
  const lockedPieceIds = [
    ...(rules.decoy ? [] : decoyIds),
    ...(rules.flak ? [] : flakIds)
  ];
  if (lockedPieceIds.length) errors.push(error(
    'locked-piece', 'One or more pig flags require a card that has not been drafted.', lockedPieceIds
  ));
  const excessPieceIds = [
    ...(rules.decoy ? decoyIds.slice(rules.decoy.limit) : []),
    ...(rules.flak ? flakIds.slice(rules.flak.pigCount) : [])
  ];
  if (excessPieceIds.length) errors.push(error(
    'piece-limit', 'A drafted pig flag may be assigned to only one pig.', excessPieceIds
  ));
  if (mode === 'siege' && kingIndices.length === 1) {
    const depth = burialInWorld(world, context, kingIndices[0]);
    if (depth > TUNE.maxBurialDepth) errors.push(error(
      'buried-king', `The easiest route to the King crosses ${depth} blocks; maximum is ${TUNE.maxBurialDepth}.`,
      [context.pigIds[kingIndices[0]]]
    ));
  }
  return { ok: errors.length === 0, errors };
}
function movement(body, start) {
  const dx = body.x - start.x;
  const dy = body.y - start.y;
  let distance = Math.sqrt(dx * dx + dy * dy);
  if (body.role === 'block') {
    const dc = body.c - start.c;
    const ds = body.s - start.s;
    const radius = body.kind === 'circle' ? body.r :
      Math.sqrt(body.hw * body.hw + body.hh * body.hh);
    distance = Math.max(distance, radius * Math.sqrt(dc * dc + ds * ds));
  }
  return distance;
}
export function settleTest(value, opts = {}) {
  const context = contextFor(value, opts);
  // makeRound correctly declares a no-pig game won, but a structural motif often
  // has no occupants yet and still needs three seconds of physics. An isolated
  // off-plot sentinel keeps that test world active and is excluded from every
  // reported measurement.
  const needsSentinel = context.blueprint.pigs.length === 0;
  const testedBlueprint = needsSentinel ? {
    ...context.blueprint,
    pigs: [['runt', TUNE.slingX, PIGS.runt.radius, 0]]
  } : context.blueprint;
  const round = makeRound({
    mode: 'campaign', seed: opts.seed ?? 1, bag: [], blueprint: testedBlueprint,
    defenderCards: context.cards
  });
  const tested = [
    ...round.blocks,
    ...round.pigs.slice(0, context.blueprint.pigs.length),
    ...round.balloons
  ];
  const records = tested.map((body) => ({
    body,
    start: { x: body.x, y: body.y, c: body.c, s: body.s },
    declaration: declaredMovement(context, body)
  }));
  const exemptBodies = new Set(records.filter((record) => record.declaration)
    .map((record) => record.body));
  const steps = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
  for (let index = 0; index < steps; index++) stepRound(round, TUNE.step);
  const tolerance = opts.moveTolerance ?? SETTLE_MOVE_TOLERANCE;
  const movedPieces = [];
  const movementExemptions = [];
  let maxMovement = 0;
  for (const record of records) {
    const distance = movement(record.body, record.start);
    if (record.declaration) movementExemptions.push({
      bodyId: reportedBodyId(context, record.body),
      reason: record.declaration.reason,
      movement: distance
    });
    else maxMovement = Math.max(maxMovement, distance);
    if (record.body.dead || !record.declaration && distance > tolerance) {
      pushUnique(movedPieces, pieceIdForBody(context, record.body));
    }
  }
  const deadPigs = [];
  for (let index = 0; index < context.blueprint.pigs.length; index++) {
    if (round.pigs[index].dead) deadPigs.push(context.pigIds[index]);
  }
  const settled = round.world.bodies.every((body) =>
    body.dead || body.isStatic || body.isAsleep || exemptBodies.has(body));
  const ok = settled && movedPieces.length === 0 && deadPigs.length === 0;
  return { ok, settled, maxMovement, movedPieces, deadPigs, movementExemptions };
}
function encodeBase64(bytes) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const value = bytes[index] << 16 |
      (remaining > 1 ? bytes[index + 1] << 8 : 0) |
      (remaining > 2 ? bytes[index + 2] : 0);
    output += BASE64[(value >>> 18) & 63] + BASE64[(value >>> 12) & 63];
    if (remaining > 1) output += BASE64[(value >>> 6) & 63];
    if (remaining > 2) output += BASE64[value & 63];
  }
  return output;
}
function decodeBase64(source) {
  if (typeof source !== 'string') return { reason: 'invalid-type' };
  if (source.length > MAX_CODEC_CHARS) return { reason: 'absurd-length' };
  if (source.length % 4 === 1) return { reason: 'invalid-base64' };
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const char of source) {
    const digit = BASE64_INDEX[char];
    if (digit === undefined) return { reason: 'invalid-base64' };
    value = value << 6 | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  if (value !== 0) return { reason: 'invalid-base64' };
  return { bytes };
}
function packedCoordinate(value, quantum, max, label) {
  const scaled = value / quantum;
  if (!Number.isInteger(scaled) || scaled < 0 || scaled > max)
    throw new RangeError(`${label} must be on the ${quantum} grid inside the plot`);
  return scaled;
}
// When a build timer expires unlocked, DESIGN.md 6.2 says whatever is placed is completed
// to legality and locked. The ladder below is the candidate order: keep the author's work
// if it stands on its own, then keep their blocks and seat the pigs they are missing, then
// keep only their blocks, and finally fall back to a bare legal fortress. It lives here
// rather than in the relay because the solo client has to do exactly the same thing when
// nobody is on the other end of a socket, and two ladders would drift apart.
//
// This yields candidates only. Each caller validates with the validator it already trusts:
// the relay with its wire-shaped submission check, the client with `validate`.
const AUTO_LAYOUTS = [
  [['runt', 2, 0.296875, 0], ['king', 12, 0.6875, 0], ['runt', 22, 0.296875, 0]],
  [['runt', 4, 0.296875, 0], ['king', 12, 0.6875, 0], ['runt', 20, 0.296875, 0]],
  [['runt', 2, 0.296875, 0], ['king', 6, 0.6875, 0], ['runt', 10, 0.296875, 0]],
  [['runt', 14, 0.296875, 0], ['king', 18, 0.6875, 0], ['runt', 22, 0.296875, 0]]
];

function realKing(tuple) {
  return Boolean(PIGS[tuple[0]]?.traits.king) &&
    ((tuple[3] ?? 0) & PIG_FLAG_DECOY) === 0;
}

function completePigs(pigs, layout) {
  const completed = pigs.map((tuple) => tuple.slice());
  let kings = completed.filter(realKing).length;
  let others = completed.length - kings;
  for (const tuple of layout) {
    if (realKing(tuple)) {
      if (kings) continue;
      kings++;
    } else {
      if (others >= TUNE.minOtherPigs) continue;
      others++;
    }
    completed.push(tuple.slice());
  }
  return completed;
}

export function autoCompleteCandidates(blueprint) {
  const candidates = [];
  if (blueprint && blueprint.ok !== false && Array.isArray(blueprint.blocks)) {
    const blocks = () => blueprint.blocks.map((tuple) => tuple.slice());
    candidates.push(blueprint);
    for (const layout of AUTO_LAYOUTS) candidates.push({
      v: blueprint.v, blocks: blocks(), pigs: completePigs(blueprint.pigs ?? [], layout)
    });
    for (const layout of AUTO_LAYOUTS) candidates.push({
      v: blueprint.v, blocks: blocks(), pigs: layout.map((tuple) => tuple.slice())
    });
  }
  for (const layout of AUTO_LAYOUTS) candidates.push({
    v: BLUEPRINT_VERSION, blocks: [], pigs: layout.map((tuple) => tuple.slice())
  });
  return candidates;
}

export function encode(blueprint) {
  const source = blueprintFromLevel(blueprint);
  if (source.blocks.length > TUNE.maxBlocks || source.pigs.length > MAX_PIGS)
    throw new RangeError('blueprint is too large to encode');
  const bytes = [CODEC_VERSION, source.blocks.length, source.pigs.length];
  for (const tuple of source.blocks) {
    const shape = SHAPE_INDEX[tuple[0]];
    const material = MATERIAL_INDEX[tuple[1]];
    const rotation = tuple[4];
    const x = packedCoordinate(tuple[2], TUNE.gridSnap,
      TUNE.plotW / TUNE.gridSnap, 'block x');
    const y = packedCoordinate(tuple[3], TUNE.gridSnap,
      TUNE.plotH / TUNE.gridSnap, 'block y');
    if (!Number.isInteger(rotation) || rotation < 0 || rotation >= 24) {
      throw new RangeError('block rotation must be between 0 and 23');
    }
    const packed = rotation | x << 5 | y << 12;
    bytes.push(shape | material << 4, packed & 255, (packed >>> 8) & 255,
      (packed >>> 16) & 255);
  }
  for (const tuple of source.pigs) {
    const pig = PIG_INDEX[tuple[0]];
    const x = packedCoordinate(tuple[1], TUNE.gridSnap,
      TUNE.plotW / TUNE.gridSnap, 'pig x');
    const y = packedCoordinate(tuple[2], PIG_Y_QUANTUM,
      TUNE.plotH / PIG_Y_QUANTUM, 'pig y');
    const flags = tuple[PIG_FLAGS];
    const packed = pig | x << 4 | y << 11;
    bytes.push(packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255, flags);
  }
  return encodeBase64(bytes);
}
function reject(reason) { return { ok: false, reason }; }
export function decode(source) {
  try {
    const decoded = decodeBase64(source);
    if (decoded.reason) return reject(decoded.reason);
    const bytes = decoded.bytes;
    if (bytes.length < 3) return reject('truncated');
    const codecVersion = bytes[0];
    if (codecVersion !== LEGACY_CODEC_VERSION && codecVersion !== FLAGS_CODEC_VERSION &&
        codecVersion !== CODEC_VERSION) {
      return reject('wrong-version');
    }
    const blockCount = bytes[1];
    const pigCount = bytes[2];
    if (blockCount > TUNE.maxBlocks || pigCount > MAX_PIGS) return reject('absurd-length');
    const pigBytes = codecVersion === LEGACY_CODEC_VERSION ? 2 :
      codecVersion === FLAGS_CODEC_VERSION ? 3 : 4;
    const expected = 3 + blockCount * 4 + pigCount * pigBytes;
    if (bytes.length < expected) return reject('truncated');
    if (bytes.length > expected) return reject('trailing-data');
    const blocks = [];
    const pigs = [];
    let offset = 3;
    for (let index = 0; index < blockCount; index++) {
      const indices = bytes[offset++];
      const packed = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
      offset += 3;
      const current = codecVersion === CODEC_VERSION;
      if (packed & (current ? 0xf80000 : 0xfe0000)) return reject('non-canonical');
      const shape = indices & 15;
      const material = indices >>> 4;
      const rotation = packed & 31;
      const x = packed >>> 5 & (current ? 127 : 63);
      const y = packed >>> (current ? 12 : 11) & (current ? 127 : 63);
      if (!SHAPE_IDS[shape]) return reject('out-of-range-shape');
      if (!MATERIAL_IDS[material]) return reject('out-of-range-material');
      if (rotation >= 24) return reject('out-of-range-rotation');
      const grid = current ? TUNE.gridSnap : LEGACY_GRID_SNAP;
      if (x > TUNE.plotW / grid || y > TUNE.plotH / grid) {
        return reject('out-of-range-position');
      }
      blocks.push([
        SHAPE_IDS[shape], MATERIAL_IDS[material],
        x * grid, y * grid, rotation
      ]);
    }
    for (let index = 0; index < pigCount; index++) {
      const current = codecVersion === CODEC_VERSION;
      const packed = bytes[offset] | bytes[offset + 1] << 8 |
        (current ? bytes[offset + 2] << 16 : 0);
      offset += current ? 3 : 2;
      if (current && (packed & 0xc00000)) return reject('non-canonical');
      const pig = packed & 15;
      const x = packed >>> 4 & (current ? 127 : 63);
      const y = packed >>> (current ? 11 : 10) & (current ? 2047 : 63);
      const flags = codecVersion === LEGACY_CODEC_VERSION ? 0 : bytes[offset++];
      if (!PIG_IDS[pig]) return reject('out-of-range-pig');
      if ((flags & ~(PIG_FLAG_DECOY | PIG_FLAG_FLAK)) !== 0) {
        return reject('out-of-range-flags');
      }
      const xGrid = current ? TUNE.gridSnap : LEGACY_GRID_SNAP;
      const yGrid = current ? PIG_Y_QUANTUM : LEGACY_GRID_SNAP;
      if (x > TUNE.plotW / xGrid || y > TUNE.plotH / yGrid) {
        return reject('out-of-range-position');
      }
      pigs.push([PIG_IDS[pig], x * xGrid, y * yGrid, flags]);
    }
    return { v: BLUEPRINT_VERSION, blocks, pigs };
  } catch (unused) {
    return reject('malformed');
  }
}
