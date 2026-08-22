import {
  AMMO_BY_ID,
  MATERIALS,
  PIGS,
  SCORE,
  SHAPES,
  TUNE
} from './data.js';
import {
  addBody,
  applyImpulse,
  digest,
  fromDegrees,
  isSettled,
  makeWorld,
  raycast,
  raycastAll,
  removeBody,
  rng,
  step
} from './physics.js';

export const BLUEPRINT_VERSION = 1;

export const BLOCK_SHAPE_ID = 0;
export const BLOCK_MATERIAL_ID = 1;
export const BLOCK_X = 2;
export const BLOCK_Y = 3;
export const BLOCK_ROTATION = 4;

export const PIG_ID = 0;
export const PIG_X = 1;
export const PIG_Y = 2;

const BODY_DIGEST_FIELDS = ['x', 'y', 'c', 's', 'vx', 'vy', 'av', 'hp', 'maxHp'];
const DIGEST_BUFFER = new ArrayBuffer(8);
const DIGEST_VIEW = new DataView(DIGEST_BUFFER);

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function normaliseBlueprint(source) {
  if (!source || typeof source !== 'object') throw new TypeError('blueprint must be an object');
  if (source.v !== BLUEPRINT_VERSION) {
    throw new RangeError(`unsupported blueprint version: ${source.v}`);
  }
  if (!Array.isArray(source.blocks) || !Array.isArray(source.pigs)) {
    throw new TypeError('blueprint blocks and pigs must be arrays');
  }

  const blocks = source.blocks.map((tuple, index) => {
    if (!Array.isArray(tuple) || tuple.length !== 5) {
      throw new TypeError(`block ${index} must be a five-value tuple`);
    }
    const shapeId = tuple[BLOCK_SHAPE_ID];
    const materialId = tuple[BLOCK_MATERIAL_ID];
    if (!SHAPES[shapeId]) throw new RangeError(`unknown block shape: ${shapeId}`);
    if (!MATERIALS[materialId]) throw new RangeError(`unknown block material: ${materialId}`);
    const x = finite(tuple[BLOCK_X], `block ${index} x`);
    const y = finite(tuple[BLOCK_Y], `block ${index} y`);
    const rotation = tuple[BLOCK_ROTATION];
    if (!Number.isInteger(rotation)) {
      throw new TypeError(`block ${index} rotation must be an integer step`);
    }
    return [shapeId, materialId, x, y, rotation];
  });

  const pigs = source.pigs.map((tuple, index) => {
    if (!Array.isArray(tuple) || tuple.length !== 3) {
      throw new TypeError(`pig ${index} must be a three-value tuple`);
    }
    const pigId = tuple[PIG_ID];
    if (!PIGS[pigId]) throw new RangeError(`unknown pig: ${pigId}`);
    return [
      pigId,
      finite(tuple[PIG_X], `pig ${index} x`),
      finite(tuple[PIG_Y], `pig ${index} y`)
    ];
  });

  return { v: BLUEPRINT_VERSION, blocks, pigs };
}

export function blueprintFromLevel(level) {
  const source = level?.blueprint ?? level;
  return normaliseBlueprint(source);
}

function circleArea(radius) {
  const scale = radius / SHAPES.ball.r;
  return SHAPES.ball.area * scale * scale;
}

function addGround(world) {
  const width = TUNE.viewMaxX - TUNE.viewMinX;
  // Only the top face at y=0 is a game rule. Deriving hidden depth from the grid
  // avoids a new ground-thickness tune that client, Worker and tests could disagree on.
  const height = TUNE.gridSnap * 2;
  const ground = addBody(world, {
    shape: { id: 'ground', kind: 'box', w: width, h: height, area: width * height },
    mat: { ...MATERIALS.stone, id: 'ground' },
    x: (TUNE.viewMinX + TUNE.viewMaxX) / 2,
    y: -height / 2,
    isStatic: true,
    filterTag: 'ground',
    tag: 'ground'
  });
  ground.role = 'ground';
  return ground;
}

function addPig(world, tuple, index) {
  const pigId = tuple[PIG_ID];
  const pig = PIGS[pigId];
  const area = circleArea(pig.radius);
  // Pig contact response has no separate authored coefficients. Wood is the neutral
  // baseline; inventing a ninth friction table here would violate data.js ownership.
  const material = {
    ...MATERIALS.wood,
    id: pig.id,
    density: pig.density,
    hp: pig.hp / area,
    thresh: pig.thresh,
    frailty: pig.frailty
  };
  const body = addBody(world, {
    shape: { id: pig.id, kind: 'circle', r: pig.radius, area },
    mat: material,
    x: tuple[PIG_X],
    y: tuple[PIG_Y],
    filterTag: material.id,
    tag: `pig:${index}`
  });
  body.hp = pig.hp;
  body.maxHp = pig.hp;
  body.role = 'pig';
  body.pigId = pigId;
  body.pig = pig;
  body.blueprintIndex = index;
  return body;
}

export function instantiate(world, blueprint) {
  const source = normaliseBlueprint(blueprint);
  addGround(world);
  const blocks = [];
  const pigs = [];

  for (let index = 0; index < source.blocks.length; index++) {
    const tuple = source.blocks[index];
    const rotation = fromDegrees(tuple[BLOCK_ROTATION] * TUNE.rotSnapDeg);
    const body = addBody(world, {
      shape: tuple[BLOCK_SHAPE_ID],
      mat: tuple[BLOCK_MATERIAL_ID],
      x: tuple[BLOCK_X],
      y: tuple[BLOCK_Y],
      c: rotation.c,
      s: rotation.s,
      filterTag: tuple[BLOCK_MATERIAL_ID],
      tag: `block:${index}`
    });
    body.role = 'block';
    body.shapeId = tuple[BLOCK_SHAPE_ID];
    body.materialId = tuple[BLOCK_MATERIAL_ID];
    body.blueprintIndex = index;
    blocks.push(body);
  }

  for (let index = 0; index < source.pigs.length; index++) {
    pigs.push(addPig(world, source.pigs[index], index));
  }
  return { blocks, pigs };
}

function queueAbilityEvent(round, body, ability, extra = {}) {
  round.queuedEvents.push({ kind: 'ability', ability, x: body.x, y: body.y, ...extra });
}

function splitAbility(round, body, ammo) {
  const { count, spreadCos: c, spreadSin: s } = ammo.params;
  const mass = 1 / body.im / count;
  const radius = body.r / Math.sqrt(count);
  const velocities = [
    { vx: body.vx * c + body.vy * s, vy: -body.vx * s + body.vy * c },
    { vx: body.vx, vy: body.vy },
    { vx: body.vx * c - body.vy * s, vy: body.vx * s + body.vy * c }
  ];
  const fragments = velocities.map((velocity, index) => addAmmoBody(
    round,
    ammo,
    velocity.vx,
    velocity.vy,
    {
      x: body.x,
      y: body.y,
      mass,
      radius,
      tag: `${body.tag}:split:${index}`
    }
  ));
  body.dead = true;
  removeBody(round.world, body);
  round.flying = fragments[Math.floor(count / 2)];
  queueAbilityEvent(round, body, ammo.ability, {
    fragments: fragments.map((fragment) => fragment.id)
  });
}

function accelAbility(round, body, ammo) {
  body.vx *= ammo.params.speedMultiplier;
  body.vy *= ammo.params.speedMultiplier;
  queueAbilityEvent(round, body, ammo.ability, { speedMultiplier: ammo.params.speedMultiplier });
}

function boomAbility(round, body, ammo) {
  queueExplosion(round, body, ammo.params);
  queueAbilityEvent(round, body, ammo.ability, { r: ammo.params.blastRadius });
  body.dead = true;
  removeBody(round.world, body);
  round.flying = null;
}

function dropAbility(round, body, ammo) {
  const params = ammo.params;
  const payload = addAmmoBody(round, ammo, body.vx, body.vy - params.payloadSpeed, {
    x: body.x,
    y: body.y,
    mass: params.payloadMass,
    radius: params.payloadRadius,
    role: 'payload',
    shapeId: `${ammo.id}-payload`,
    tag: `${body.tag}:payload`
  });
  body.vy += params.recoilSpeed;
  queueAbilityEvent(round, body, ammo.ability, { payloadId: payload.id });
}

function reverseAbility(round, body, ammo) {
  body.vx = -body.vx;
  queueAbilityEvent(round, body, ammo.ability);
}

function inflateAbility(round, body, ammo) {
  body.inflation = {
    startRadius: body.r,
    targetRadius: ammo.params.inflatedRadius,
    duration: ammo.params.inflateSeconds,
    elapsed: 0
  };
  queueAbilityEvent(round, body, ammo.ability, { radius: ammo.params.inflatedRadius });
}

function hardenAbility(round, body, ammo) {
  body.pierces = ammo.params.passThrough;
  body.stoneDamageMultiplier = ammo.params.stoneDamageMultiplier;
  queueAbilityEvent(round, body, ammo.ability, { pierces: body.pierces });
}

function blinkAbility(round, body, ammo) {
  const speedSq = body.vx * body.vx + body.vy * body.vy;
  if (speedSq > 0) {
    const speed = Math.sqrt(speedSq);
    const nx = body.vx / speed;
    const ny = body.vy / speed;
    const endX = body.x + nx * ammo.params.distance;
    const endY = body.y + ny * ammo.params.distance;
    const hit = raycast(round.world, body.x, body.y, endX, endY,
      (candidate) => candidate !== body);
    // Project the radius onto the travel direction. A plain `-body.r` backoff is only
    // safe for a head-on hit; at an oblique face it can still leave the circle inside.
    const alignment = hit ? -(nx * hit.nx + ny * hit.ny) : 0;
    const clearance = alignment > 0 ? body.r / alignment : body.r;
    const travel = hit ? Math.max(0, ammo.params.distance * hit.t - clearance)
      : ammo.params.distance;
    const fromX = body.x;
    const fromY = body.y;
    body.x += nx * travel;
    body.y += ny * travel;
    queueAbilityEvent(round, body, ammo.ability, {
      fromX,
      fromY,
      blocked: Boolean(hit)
    });
    return;
  }
  queueAbilityEvent(round, body, ammo.ability, { blocked: false });
}

const ABILITY_HANDLERS = {
  split: splitAbility,
  accel: accelAbility,
  boom: boomAbility,
  drop: dropAbility,
  reverse: reverseAbility,
  inflate: inflateAbility,
  harden: hardenAbility,
  blink: blinkAbility
};

function addAmmoBody(round, ammo, vx, vy, options = {}) {
  const radius = options.radius ?? ammo.radius;
  const mass = options.mass ?? ammo.mass;
  const area = circleArea(radius);
  // Mass and radius are authored per critter; only neutral surface response is shared.
  const material = {
    ...MATERIALS.wood,
    id: `ammo:${ammo.id}`,
    density: mass / area
  };
  const body = addBody(round.world, {
    shape: { id: options.shapeId ?? ammo.id, kind: 'circle', r: radius, area },
    mat: material,
    x: options.x ?? TUNE.slingX,
    y: options.y ?? TUNE.slingY,
    vx,
    vy,
    filterTag: material.id,
    tag: options.tag ?? `ammo:${round.shotIndex}`
  });
  body.role = options.role ?? 'ammo';
  if (body.role === 'ammo') body.ammoId = ammo.id;
  return body;
}

function eventPoint(contact) {
  const ax = contact.a.x + contact.rax;
  const ay = contact.a.y + contact.ray;
  const bx = contact.b.x + contact.rbx;
  const by = contact.b.y + contact.rby;
  return { x: (ax + bx) / 2, y: (ay + by) / 2 };
}

function queueExplosion(round, body, blast = body.mat) {
  round.pendingExplosions.push({
    sourceId: body.id,
    x: body.x,
    y: body.y,
    r: blast.blastRadius,
    impulse: blast.blastImpulse,
    damage: blast.blastDamage
  });
}

function killBody(round, body) {
  if (body.dead) return;
  body.dead = true;
  round.deadThisStep.push(body);
  if (body.role === 'block') {
    round.events.push({
      kind: 'shatter',
      x: body.x,
      y: body.y,
      mat: body.materialId,
      shape: body.shapeId
    });
    if (body.materialId === 'tnt') queueExplosion(round, body);
  } else if (body.role === 'pig') {
    round.events.push({ kind: 'pop', pig: body.pigId, x: body.x, y: body.y });
  }
}

function armourScale(body, towardSourceX, towardSourceY) {
  if (body.role !== 'pig') return 1;
  const traits = body.pig.traits;
  const armoured = traits.armourFrom === 'above' && towardSourceY > 0 ||
    traits.armourFrom === 'sling' && towardSourceX < 0;
  return armoured ? 1 - traits.armourFraction : 1;
}

function damageTarget(round, body, source, contact, towardSourceX, towardSourceY, point) {
  if (body.dead || body.role !== 'block' && body.role !== 'pig') return;
  const definition = body.role === 'pig' ? body.pig : body.mat;
  let amount = Math.max(0, contact.pn - definition.thresh) * definition.frailty;
  if (definition.brittle) {
    amount += TUNE.brittleTangentFactor *
      Math.max(0, Math.abs(contact.pt) - definition.thresh);
  }
  amount *= armourScale(body, towardSourceX, towardSourceY);
  if (body.role === 'block' && body.materialId === 'stone' &&
      source?.stoneDamageMultiplier !== undefined) {
    amount *= source.stoneDamageMultiplier;
  }
  if (!(amount > 0)) return;

  body.hp -= amount;
  round.events.push({
    kind: 'hit',
    x: point.x,
    y: point.y,
    impulse: contact.pn,
    mat: body.role === 'block' ? body.materialId : body.pigId
  });
  if (body.hp <= 0) killBody(round, body);
}

function applyContactDamage(round, world) {
  for (const contact of world.contacts) {
    const point = eventPoint(contact);
    // The normal points A -> B. For armour, the useful direction is target -> source.
    damageTarget(round, contact.a, contact.b, contact, contact.nx, contact.ny, point);
    damageTarget(round, contact.b, contact.a, contact, -contact.nx, -contact.ny, point);
  }
}

function applyPierceDamage(round, world) {
  for (const sweep of round.pierceStarts) {
    const source = sweep.body;
    if (source.dead || source.x === sweep.x && source.y === sweep.y) continue;
    const hits = raycastAll(world, sweep.x, sweep.y, source.x, source.y,
      (candidate) => candidate !== source && candidate.filterTag === source.pierces);
    for (const hit of hits) {
      const target = hit.body;
      // A zero-time hit means the critter started this step inside the same body. The
      // entrance was charged on the preceding sweep; charging the interior every step
      // would turn one pass-through into an arbitrary frame-rate-scaled damage source.
      if (hit.t <= 0 || target.dead) continue;
      const relativeX = source.vx - target.vx;
      const relativeY = source.vy - target.vy;
      const approach = Math.max(0, -(relativeX * hit.nx + relativeY * hit.ny));
      const inverseMass = source.im + target.im;
      if (!(approach > 0) || !(inverseMass > 0)) continue;
      // This is the normal impulse the two centres would exchange at a frictionless
      // contact, including their existing restitution. It drives the same damage path
      // as a solver contact without applying the impulse, so Spike keeps its speed.
      const pn = approach * (1 + Math.max(source.rest, target.rest)) / inverseMass;
      damageTarget(round, target, source, { pn, pt: 0 }, hit.nx, hit.ny,
        { x: hit.x, y: hit.y });
    }
  }
}

function explosionTargets(world, explosion) {
  const result = [];
  const radiusSq = explosion.r * explosion.r;
  const bodies = world.bodies.slice().sort((a, b) => a.id - b.id);
  for (const body of bodies) {
    if (body.dead || body.id === explosion.sourceId || body.role === 'ground') continue;
    const dx = body.x - explosion.x;
    const dy = body.y - explosion.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq >= radiusSq) continue;
    const blocker = raycast(world, explosion.x, explosion.y, body.x, body.y,
      (candidate) => candidate.id !== explosion.sourceId && candidate !== body &&
        candidate.role !== 'ground');
    if (blocker) continue;
    const distance = Math.sqrt(distanceSq);
    const falloff = 1 - distance / explosion.r;
    const nx = distance > 0 ? dx / distance : body.id < explosion.sourceId ? -1 : 1;
    const ny = distance > 0 ? dy / distance : 0;
    result.push({ body, falloff, nx, ny });
  }
  return result;
}

function applyExplosion(round, world, explosion) {
  round.events.push({ kind: 'boom', x: explosion.x, y: explosion.y, r: explosion.r });
  // Occlusion is captured before applying damage. Letting a wall disappear halfway
  // through this loop made later ids receive a different blast than earlier ids.
  const targets = explosionTargets(world, explosion);
  for (const target of targets) {
    const impulse = explosion.impulse * target.falloff;
    applyImpulse(world, target.body, target.nx * impulse, target.ny * impulse);
    if (target.body.role !== 'block' && target.body.role !== 'pig') continue;
    target.body.hp -= explosion.damage * target.falloff;
    if (target.body.hp <= 0) killBody(round, target.body);
  }
}

function damageStep(round, world) {
  // Only the queue present at step entry is eligible now. New TNT deaths append to
  // the replacement queue, so a chain advances one step at a time without recursion.
  const readyExplosions = round.pendingExplosions;
  round.pendingExplosions = [];
  applyContactDamage(round, world);
  applyPierceDamage(round, world);

  for (const body of round.blocks) if (!body.dead && body.hp <= 0) killBody(round, body);
  for (const body of round.pigs) if (!body.dead && body.hp <= 0) killBody(round, body);

  readyExplosions.sort((a, b) => a.sourceId - b.sourceId);
  for (const explosion of readyExplosions) applyExplosion(round, world, explosion);
}

function advanceInflations(world, dt) {
  for (const body of world.bodies) {
    const inflation = body.inflation;
    if (!inflation || body.dead) continue;
    inflation.elapsed = Math.min(inflation.duration, inflation.elapsed + dt);
    const progress = inflation.elapsed / inflation.duration;
    const radius = inflation.startRadius +
      (inflation.targetRadius - inflation.startRadius) * progress;
    const area = circleArea(radius);
    const mass = area * body.mat.density;
    body.r = radius;
    body.shape.r = radius;
    body.shape.area = area;
    body.im = 1 / mass;
    body.ii = 1 / (mass * radius * radius / 2);
    if (inflation.elapsed >= inflation.duration) delete body.inflation;
  }
}

function capturePierceStarts(round) {
  round.pierceStarts = [];
  for (const body of round.world.bodies) {
    if (body.dead || body.pierces === null || body.stoneDamageMultiplier === undefined) continue;
    round.pierceStarts.push({ body, x: body.x, y: body.y });
  }
}

function removeDeadAtStepEnd(round) {
  round.deadThisStep.sort((a, b) => a.id - b.id);
  for (const body of round.deadThisStep) removeBody(round.world, body);
  round.deadThisStep = [];
}

function allPigsDead(round) {
  for (const pig of round.pigs) if (!pig.dead) return false;
  return true;
}

function flyingIsOutOfPlay(body) {
  return body.x + body.r < TUNE.viewMinX || body.x - body.r > TUNE.viewMaxX ||
    body.y + body.r < -TUNE.gridSnap;
}

function retireFlyingBody(round) {
  const body = round.flying;
  if (!body || body.dead || !flyingIsOutOfPlay(body)) return false;
  // This runs after physics.step returns, never while contacts still own the body.
  body.dead = true;
  removeBody(round.world, body);
  return true;
}

function finishSettling(round) {
  round.events.push({ kind: 'settled' });
  round.flying = null;
  if (round.shotIndex >= round.bag.length && !allPigsDead(round)) {
    round.phase = 'lost';
    round.events.push({ kind: 'lost' });
  } else {
    round.phase = 'aiming';
  }
}

function settleTimedOut(round) {
  const shot = round.shots[round.shots.length - 1];
  return round.stepCount - shot.step >= Math.ceil(TUNE.settleTimeout / TUNE.step);
}

export function makeRound(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('round spec must be an object');
  if (spec.mode !== 'campaign' && spec.mode !== 'siege') {
    throw new RangeError(`unknown round mode: ${spec.mode}`);
  }
  if (!Array.isArray(spec.bag)) throw new TypeError('round bag must be an array');
  const bag = spec.bag.map((ammoId) => {
    if (!AMMO_BY_ID[ammoId]) throw new RangeError(`unknown ammo: ${ammoId}`);
    return ammoId;
  });
  if (!Number.isInteger(spec.seed)) throw new TypeError('round seed must be an integer');

  const blueprint = blueprintFromLevel(spec.blueprint);
  const round = {};
  const world = makeWorld({ onDamage: (activeWorld) => damageStep(round, activeWorld) });
  const bodies = instantiate(world, blueprint);
  Object.assign(round, {
    world,
    blueprint,
    seed: spec.seed >>> 0,
    rng: rng(spec.seed),
    bag,
    shotIndex: 0,
    shots: [],
    phase: bodies.pigs.length ? 'aiming' : 'won',
    mode: spec.mode,
    time: 0,
    stepCount: 0,
    events: [],
    queuedEvents: [],
    score: 0,
    pigs: bodies.pigs,
    blocks: bodies.blocks,
    flying: null,
    settleTimer: 0,
    pendingExplosions: [],
    deadThisStep: [],
    pierceStarts: []
  });
  scoreRound(round);
  return round;
}

export function launch(round, dx, dy) {
  if (round.phase !== 'aiming' || round.shotIndex >= round.bag.length) return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;

  const drawLength = Math.sqrt(dx * dx + dy * dy);
  const clampedLength = Math.min(drawLength, TUNE.slingRadius);
  const drawScale = drawLength > 0 ? clampedLength / drawLength : 0;
  const clampedDx = dx * drawScale;
  const clampedDy = dy * drawScale;
  const launchScale = TUNE.launchSpeedMax / TUNE.slingRadius;
  const vx = -clampedDx * launchScale;
  const vy = -clampedDy * launchScale;
  const ammoId = round.bag[round.shotIndex];
  const ammo = AMMO_BY_ID[ammoId];
  const body = addAmmoBody(round, ammo, vx, vy);

  round.shots.push({
    step: round.stepCount,
    ammo: ammoId,
    dx: clampedDx,
    dy: clampedDy,
    tapStep: null
  });
  round.shotIndex++;
  round.phase = 'flying';
  round.flying = body;
  round.settleTimer = 0;
  round.queuedEvents.push({ kind: 'launch', ammo: ammoId });
  scoreRound(round);
  return body;
}

export function tap(round) {
  if (round.phase !== 'flying' || !round.flying || round.flying.dead) return false;
  const ammo = AMMO_BY_ID[round.flying.ammoId];
  if (!ammo.ability) return false;
  const shot = round.shots[round.shots.length - 1];
  if (shot.tapStep !== null) return false;
  const handler = ABILITY_HANDLERS[ammo.ability];
  if (!handler) throw new Error(`no ability handler for '${ammo.ability}'`);
  handler(round, round.flying, ammo);
  shot.tapStep = round.stepCount;
  return true;
}

export function stepRound(round, dt = TUNE.step) {
  if (dt !== TUNE.step) {
    throw new RangeError(`stepRound requires the fixed timestep ${TUNE.step}`);
  }
  if (isRoundOver(round)) {
    round.events = [];
    return round.events;
  }

  const wasSettling = round.phase === 'settling';
  round.events = round.queuedEvents;
  round.queuedEvents = [];
  round.deadThisStep = [];
  advanceInflations(round.world, dt);
  capturePierceStarts(round);
  step(round.world, dt);
  round.pierceStarts = [];
  round.time += dt;
  round.stepCount++;
  if (round.phase === 'flying' || round.phase === 'settling') round.settleTimer += dt;
  const timedOut = round.phase === 'flying' || round.phase === 'settling'
    ? settleTimedOut(round) : false;
  if (timedOut) round.settleTimer = TUNE.settleTimeout;
  removeDeadAtStepEnd(round);
  const retired = retireFlyingBody(round);

  if (allPigsDead(round)) {
    round.phase = 'won';
    round.flying = null;
    round.events.push({ kind: 'won' });
  } else if (round.phase === 'flying') {
    const flightFinished = retired || round.flying?.isAsleep || isSettled(round.world) || timedOut;
    if (flightFinished) round.phase = 'settling';
  } else if (wasSettling &&
      (isSettled(round.world) || timedOut)) {
    finishSettling(round);
  }

  scoreRound(round);
  return round.events;
}

export function isRoundOver(round) {
  return round.phase === 'won' || round.phase === 'lost';
}

export function scoreRound(round) {
  if (round.mode === 'siege') {
    // P7 owns the breach and off-plot tests; returning a partial score now would make
    // an intentionally incomplete result look authoritative to the relay.
    round.score = 0;
    return round.score;
  }

  let deadPigs = 0;
  for (const pig of round.pigs) if (pig.dead) deadPigs++;
  let destroyedCost = 0;
  for (const block of round.blocks) {
    if (block.dead) destroyedCost += block.shape.area * block.mat.cost;
  }
  const unused = round.bag.length - round.shotIndex;
  round.score = unused * SCORE.campaign.unusedAmmo +
    deadPigs * SCORE.campaign.pig +
    destroyedCost * SCORE.campaign.destroyedBlockCostMultiplier;
  return round.score;
}

function fnvWord(hash, word) {
  hash ^= word;
  return (hash + (hash << 1) + (hash << 4) + (hash << 7) +
    (hash << 8) + (hash << 24)) >>> 0;
}

function hashNumber(hash, value) {
  DIGEST_VIEW.setFloat64(0, value);
  hash = fnvWord(hash, DIGEST_VIEW.getUint32(0));
  return fnvWord(hash, DIGEST_VIEW.getUint32(4));
}

function hashString(hash, value) {
  hash = fnvWord(hash, value.length);
  for (let index = 0; index < value.length; index++) {
    hash = fnvWord(hash, value.charCodeAt(index));
  }
  return hash;
}

function hashBody(hash, body) {
  hash = hashNumber(hash, body.id);
  hash = fnvWord(hash, body.dead ? 1 : 0);
  for (const field of BODY_DIGEST_FIELDS) hash = hashNumber(hash, body[field]);
  return hash;
}

export function digestRound(round) {
  let hash = 2166136261;
  hash = hashString(hash, digest(round.world));
  hash = hashString(hash, round.phase);
  hash = hashNumber(hash, round.seed);
  hash = hashNumber(hash, round.shotIndex);
  hash = hashNumber(hash, round.stepCount);
  hash = hashNumber(hash, round.time);
  hash = hashNumber(hash, round.settleTimer);
  hash = hashNumber(hash, round.score);
  hash = hashNumber(hash, round.flying?.id ?? -1);

  hash = fnvWord(hash, round.bag.length);
  for (const ammoId of round.bag) hash = hashString(hash, ammoId);
  hash = fnvWord(hash, round.shots.length);
  for (const shot of round.shots) {
    hash = hashNumber(hash, shot.step);
    hash = hashString(hash, shot.ammo);
    hash = hashNumber(hash, shot.dx);
    hash = hashNumber(hash, shot.dy);
    hash = hashNumber(hash, shot.tapStep ?? -1);
  }

  hash = fnvWord(hash, round.blocks.length);
  for (const block of round.blocks) hash = hashBody(hash, block);
  hash = fnvWord(hash, round.pigs.length);
  for (const pig of round.pigs) hash = hashBody(hash, pig);
  hash = fnvWord(hash, round.pendingExplosions.length);
  for (const explosion of round.pendingExplosions) {
    hash = hashNumber(hash, explosion.sourceId);
    hash = hashNumber(hash, explosion.x);
    hash = hashNumber(hash, explosion.y);
    hash = hashNumber(hash, explosion.r);
    hash = hashNumber(hash, explosion.impulse);
    hash = hashNumber(hash, explosion.damage);
  }
  return hash.toString(16).padStart(8, '0');
}
