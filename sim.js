import {
  AMMO_BY_ID,
  CARDS,
  CARDS_BY_ID,
  MATERIALS,
  PIGS,
  SCORE,
  SHAPES,
  TUNE
} from './data.js?v=20260902-1';
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
  step,
  wakeBody
} from './physics.js?v=20260902-1';

export const BLUEPRINT_VERSION = 1;

export const EVENT_KINDS = Object.freeze([
  'launch',
  'hit',
  'shatter',
  'crumble',
  'stone-split',
  'boom',
  'pop',
  'balloon-pop',
  'spring-launch',
  'repair',
  'ability',
  'gel-absorb',
  'won',
  'lost',
  'settled'
]);
const EVENT_KIND = Object.freeze(Object.fromEntries(
  EVENT_KINDS.map((kind) => [kind, kind])
));

export const BLOCK_SHAPE_ID = 0;
export const BLOCK_MATERIAL_ID = 1;
export const BLOCK_X = 2;
export const BLOCK_Y = 3;
export const BLOCK_ROTATION = 4;

export const PIG_ID = 0;
export const PIG_X = 1;
export const PIG_Y = 2;
export const PIG_FLAGS = 3;
export const PIG_FLAG_DECOY = 1;
export const PIG_FLAG_FLAK = 2;
const PIG_FLAG_MASK = PIG_FLAG_DECOY | PIG_FLAG_FLAK;

const BODY_DIGEST_FIELDS = ['x', 'y', 'c', 's', 'vx', 'vy', 'av', 'hp', 'maxHp'];
const DIGEST_BUFFER = new ArrayBuffer(8);
const DIGEST_VIEW = new DataView(DIGEST_BUFFER);
const BALLOON_EFFECT = CARDS.find((card) => card.effect.kind === 'kingBalloon').effect;

function normaliseCards(cards = []) {
  const wanted = Object.create(null);
  for (const card of cards) {
    const id = typeof card === 'string' ? card : card?.id;
    if (CARDS_BY_ID[id]) wanted[id] = true;
  }
  return CARDS.filter((card) => wanted[card.id]).map((card) => card.id);
}

export function cardEffects(cards = []) {
  return normaliseCards(cards).map((id) => CARDS_BY_ID[id].effect);
}

function effectOf(effects, kind) {
  return effects.find((effect) => effect.kind === kind) ?? null;
}

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
    if (!Array.isArray(tuple) || tuple.length < 3 || tuple.length > 4) {
      throw new TypeError(`pig ${index} must be a three- or four-value tuple`);
    }
    const pigId = tuple[PIG_ID];
    if (!PIGS[pigId]) throw new RangeError(`unknown pig: ${pigId}`);
    const flags = tuple.length === 3 ? 0 : tuple[PIG_FLAGS];
    if (!Number.isInteger(flags)) {
      throw new TypeError(`pig ${index} flags must be an integer bitfield`);
    }
    if (flags < 0 || (flags & ~PIG_FLAG_MASK) !== 0) {
      throw new RangeError(`pig ${index} flags contain unsupported bits`);
    }
    return [
      pigId,
      finite(tuple[PIG_X], `pig ${index} x`),
      finite(tuple[PIG_Y], `pig ${index} y`),
      flags
    ];
  });

  return { v: BLUEPRINT_VERSION, blocks, pigs };
}

export function blueprintFromLevel(level) {
  const source = level?.blueprint ?? level;
  return normaliseBlueprint(source);
}

// Shared by build burial validation and the Siege breach bonus. Keeping the exact
// ray shape and distinct-block counting here prevents two subtly different line-of-
// sight rules from growing on either side of the blueprint/simulation boundary.
export function blockRayDepth(world, x0, y0, x1, y1) {
  const hits = raycastAll(world, x0, y0, x1, y1,
    (body) => body.role === 'block' && !body.dead);
  const seen = [];
  for (const hit of hits) {
    const identity = hit.body.blueprintIndex ?? hit.body.id;
    if (!seen.includes(identity)) seen.push(identity);
  }
  return seen.length;
}

function circleArea(radius) {
  const scale = radius / SHAPES.ball.r;
  return SHAPES.ball.area * scale * scale;
}

function transformPose(x, y, c, s, tilt) {
  if (!tilt) return { x, y, c, s };
  return {
    x: tilt.cos * x - tilt.sin * y,
    y: tilt.sin * x + tilt.cos * y,
    c: tilt.cos * c - tilt.sin * s,
    s: tilt.sin * c + tilt.cos * s
  };
}

function addGround(world, tilt) {
  const width = TUNE.viewMaxX - TUNE.viewMinX;
  // Only the top face at y=0 is a game rule. Deriving hidden depth from the grid
  // avoids a new ground-thickness tune that client, Worker and tests could disagree on.
  const height = TUNE.gridSnap * 2;
  const pose = transformPose((TUNE.viewMinX + TUNE.viewMaxX) / 2,
    -height / 2, 1, 0, tilt);
  const ground = addBody(world, {
    shape: { id: 'ground', kind: 'box', w: width, h: height, area: width * height },
    mat: { ...MATERIALS.stone, id: 'ground' },
    x: pose.x,
    y: pose.y,
    c: pose.c,
    s: pose.s,
    isStatic: true,
    filterTag: 'ground',
    tag: 'ground'
  });
  ground.role = 'ground';
  return ground;
}

function addPig(world, tuple, index, hpDelta = 0) {
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
  body.hp = pig.hp + hpDelta;
  body.maxHp = pig.hp + hpDelta;
  body.role = 'pig';
  body.pigId = pigId;
  body.pig = pig;
  body.flags = tuple[PIG_FLAGS];
  body.decoy = (body.flags & PIG_FLAG_DECOY) !== 0;
  body.flak = (body.flags & PIG_FLAG_FLAK) !== 0;
  body.isKing = Boolean(pig.traits.king) && !body.decoy;
  body.blueprintIndex = index;
  return body;
}

function addBalloon(world, pigBody, grant = {}) {
  const traits = { ...BALLOON_EFFECT, ...grant, ...pigBody.pig.traits };
  const area = circleArea(traits.balloonRadius);
  const material = {
    ...MATERIALS.wood,
    id: 'balloon',
    density: pigBody.pig.density,
    hp: traits.balloonHp / area,
    thresh: 0,
    frailty: 1
  };
  const balloon = addBody(world, {
    shape: {
      id: `${pigBody.pigId}-balloon`,
      kind: 'circle',
      r: traits.balloonRadius,
      area
    },
    mat: material,
    x: pigBody.x,
    y: pigBody.y + traits.lift,
    isStatic: true,
    filterTag: 'balloon',
    tag: `${pigBody.tag}:balloon`
  });
  balloon.hp = traits.balloonHp;
  balloon.maxHp = traits.balloonHp;
  balloon.role = 'balloon';
  balloon.pigBody = pigBody;
  balloon.anchorX = pigBody.x;
  balloon.anchorY = pigBody.y + traits.lift;
  balloon.pigAnchorY = pigBody.y;
  balloon.driftRange = traits.driftRange;
  balloon.driftSeconds = traits.driftSeconds;
  pigBody.balloon = balloon;
  return balloon;
}

function tupleBottom(tuple) {
  const shape = SHAPES[tuple[BLOCK_SHAPE_ID]];
  if (shape.kind === 'circle') return tuple[BLOCK_Y] - shape.r;
  const rotation = fromDegrees(tuple[BLOCK_ROTATION] * TUNE.rotSnapDeg);
  if (shape.kind === 'box') {
    return tuple[BLOCK_Y] - Math.abs(rotation.s) * shape.w / 2 -
      Math.abs(rotation.c) * shape.h / 2;
  }
  const vertices = [
    [-shape.w / 3, -shape.h / 3],
    [2 * shape.w / 3, -shape.h / 3],
    [-shape.w / 3, 2 * shape.h / 3]
  ];
  let bottom = Infinity;
  for (const vertex of vertices) {
    bottom = Math.min(bottom, tuple[BLOCK_Y] +
      rotation.s * vertex[0] + rotation.c * vertex[1]);
  }
  return bottom;
}

function autoPigPosition(world, blocks, pigs, radius, tilt) {
  for (let logicalX = TUNE.gridSnap * 2;
    logicalX <= TUNE.plotW - TUNE.gridSnap * 2; logicalX += TUNE.gridSnap * 2) {
    const start = transformPose(logicalX, TUNE.plotH, 1, 0, tilt);
    const end = transformPose(logicalX, -TUNE.gridSnap, 1, 0, tilt);
    const hit = raycast(world, start.x, start.y, end.x, end.y,
      (body) => body.role === 'ground' || body.role === 'block');
    if (!hit) continue;
    const upX = tilt ? -tilt.sin : 0;
    const upY = tilt ? tilt.cos : 1;
    const pose = {
      x: hit.x + upX * radius,
      y: hit.y + upY * radius,
      c: tilt?.cos ?? 1,
      s: tilt?.sin ?? 0
    };
    const logicalY = tilt
      ? -tilt.sin * pose.x + tilt.cos * pose.y : pose.y;
    if (logicalY + radius > TUNE.plotH) continue;
    const probe = { x: pose.x, y: pose.y, r: radius };
    let clear = true;
    for (const block of blocks) {
      if (!block.dead && pointToBlockDistanceSq(probe, block) < radius * radius) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    for (const pig of pigs) {
      const dx = pig.x - pose.x;
      const dy = pig.y - pose.y;
      const reach = pig.r + radius;
      if (!pig.dead && dx * dx + dy * dy < reach * reach) {
        clear = false;
        break;
      }
    }
    if (clear) return { logicalX, pose };
  }
  return null;
}

function restitutionFor(a, b) {
  if (a.mat?.ammoRestitution !== undefined && b.role === 'ammo') {
    return a.mat.ammoRestitution;
  }
  if (b.mat?.ammoRestitution !== undefined && a.role === 'ammo') {
    return b.mat.ammoRestitution;
  }
  return Math.max(a.rest, b.rest);
}

export function instantiate(world, blueprint, options = {}) {
  const source = normaliseBlueprint(blueprint);
  const effects = cardEffects(options.cards ?? options.defenderCards ?? []);
  const tilt = effectOf(effects, 'plotTilt');
  const pigHp = effectOf(effects, 'pigHp')?.delta ?? 0;
  const bedrock = effectOf(effects, 'plotRow');
  const kingBalloon = effectOf(effects, 'kingBalloon');
  const flak = effectOf(effects, 'pigAbility');
  const remoteTnt = effectOf(effects, 'remoteTnt');
  const materialAbilities = effects.filter((effect) => effect.kind === 'materialAbility');
  const autoPigs = effects.filter((effect) => effect.kind === 'autoPig');
  addGround(world, tilt);
  const blocks = [];
  const pigs = [];
  const balloons = [];

  for (let index = 0; index < source.blocks.length; index++) {
    const tuple = source.blocks[index];
    const rotation = fromDegrees(tuple[BLOCK_ROTATION] * TUNE.rotSnapDeg);
    const pose = transformPose(tuple[BLOCK_X], tuple[BLOCK_Y],
      rotation.c, rotation.s, tilt);
    const body = addBody(world, {
      shape: tuple[BLOCK_SHAPE_ID],
      mat: tuple[BLOCK_MATERIAL_ID],
      x: pose.x,
      y: pose.y,
      c: pose.c,
      s: pose.s,
      filterTag: tuple[BLOCK_MATERIAL_ID],
      tag: `block:${index}`
    });
    body.role = 'block';
    body.shapeId = tuple[BLOCK_SHAPE_ID];
    body.materialId = tuple[BLOCK_MATERIAL_ID];
    body.blueprintIndex = index;
    body.originalX = pose.x;
    body.originalY = pose.y;
    body.originalC = pose.c;
    body.originalS = pose.s;
    body.indestructible = Boolean(bedrock?.indestructible &&
      bedrock.row === 'bottom' && tupleBottom(tuple) <= TUNE.slop);
    const materialAbility = materialAbilities.find((effect) =>
      effect.material === body.materialId);
    if (materialAbility && body.mat.blastRadius !== undefined) {
      body.blast = {
        ...body.mat,
        blastRadius: body.mat.blastRadius * (materialAbility.radiusMultiplier ?? 1),
        blastDamage: body.mat.blastDamage * (materialAbility.damageMultiplier ?? 1)
      };
    }
    body.remoteTnt = Boolean(remoteTnt && body.materialId === 'tnt');
    blocks.push(body);
  }

  for (let index = 0; index < source.pigs.length; index++) {
    const tuple = source.pigs[index];
    const pose = transformPose(tuple[PIG_X], tuple[PIG_Y], 1, 0, tilt);
    const transformed = [tuple[PIG_ID], pose.x, pose.y, tuple[PIG_FLAGS]];
    const pig = addPig(world, transformed, index, pigHp);
    pigs.push(pig);
    if (pig.flak && flak?.ability === 'flak') pig.flakEffect = flak;
    if (pig.pig.traits.balloon) balloons.push(addBalloon(world, pig));
    else if (pig.isKing && kingBalloon) {
      pig.invulnerableWhileBalloon = Boolean(kingBalloon.invulnerableUntilPopped);
      balloons.push(addBalloon(world, pig, kingBalloon));
    }
  }

  for (const effect of autoPigs) {
    for (let automatic = 0; automatic < effect.count; automatic++) {
      const pigDefinition = PIGS[effect.pig];
      const position = autoPigPosition(world, blocks, pigs, pigDefinition.radius, tilt);
      if (!position) break;
      const pig = addPig(world, [
        effect.pig, position.pose.x, position.pose.y, 0
      ], source.pigs.length + automatic, pigHp);
      pig.autoPlaced = true;
      pigs.push(pig);
    }
  }
  return { blocks, pigs, balloons };
}

function queueAbilityEvent(round, body, ability, extra = {}) {
  round.queuedEvents.push({ kind: EVENT_KIND.ability, ability, x: body.x, y: body.y, ...extra });
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
      shotIndex: body.shotIndex,
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
  wakeBody(round.world, body);
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
  if (body.role === 'ammo') {
    body.ammoId = ammo.id;
    body.shotIndex = options.shotIndex ?? round.shotIndex;
    if (ammo.params.fuseSeconds !== undefined) body.fuseContactStep = null;
  }
  return body;
}

function interceptVelocity(source, target, speed) {
  const rx = target.x - source.x;
  const ry = target.y - source.y;
  const a = target.vx * target.vx + target.vy * target.vy - speed * speed;
  const b = 2 * (rx * target.vx + ry * target.vy);
  const c = rx * rx + ry * ry;
  let time = 0;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) time = Math.max(0, -c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const first = (-b - root) / (2 * a);
      const second = (-b + root) / (2 * a);
      if (first > 0 && second > 0) time = Math.min(first, second);
      else time = Math.max(first, second, 0);
    }
  }
  const dx = rx + target.vx * time;
  const dy = ry + target.vy * time;
  const length = Math.sqrt(dx * dx + dy * dy);
  return length > 0
    ? { vx: dx * speed / length, vy: dy * speed / length }
    : { vx: speed, vy: 0 };
}

function fireFlak(round) {
  if (round.phase !== 'flying' && round.phase !== 'settling') {
    for (const pig of round.pigs) if (pig.flakEffect) pig.flakNextStep = null;
    return;
  }
  const incoming = round.world.bodies.filter((body) =>
    !body.dead && body.role === 'ammo' && body.shotIndex === round.shotIndex - 1)
    .sort((a, b) => a.id - b.id)[0];
  if (!incoming) {
    for (const pig of round.pigs) if (pig.flakEffect) pig.flakNextStep = null;
    return;
  }
  for (const pig of round.pigs) {
    const effect = pig.flakEffect;
    if (pig.dead || !effect) continue;
    const every = Math.ceil(effect.intervalSeconds / TUNE.step);
    if (pig.flakNextStep === null || pig.flakNextStep === undefined) {
      pig.flakNextStep = round.stepCount + every;
    }
    if (round.stepCount < pig.flakNextStep) continue;
    pig.flakNextStep += every;
    const velocity = interceptVelocity(pig, incoming, effect.stoneSpeed);
    const speed = Math.sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy);
    const clearance = pig.r + effect.stoneRadius + TUNE.slop;
    const area = circleArea(effect.stoneRadius);
    const stone = addBody(round.world, {
      shape: { id: 'flak-stone', kind: 'circle', r: effect.stoneRadius, area },
      mat: {
        ...MATERIALS.stone,
        id: 'flak-stone',
        density: effect.stoneMass / area
      },
      x: pig.x + velocity.vx / speed * clearance,
      y: pig.y + velocity.vy / speed * clearance,
      vx: velocity.vx,
      vy: velocity.vy,
      filterTag: 'flak-stone',
      tag: `${pig.tag}:flak:${round.stepCount}`
    });
    stone.role = 'defence';
    stone.hitSpeedMultiplier = effect.hitSpeedMultiplier;
    stone.ignoreGravity = true;
    round.events.push({
      kind: EVENT_KIND.ability,
      ability: effect.ability,
      x: pig.x,
      y: pig.y,
      projectileId: stone.id
    });
  }
}

function applyCardForces(round, dt) {
  const headwind = round.defenderEffects.find((effect) =>
    effect.kind === 'headwind' && effect.appliesTo === 'ammo');
  for (const body of round.world.bodies) {
    if (body.dead) continue;
    if (body.ignoreGravity) body.vy += round.world.gravity * dt;
    if (headwind && body.role === 'ammo') body.vx -= headwind.accel * dt;
  }
  const body = round.flying;
  const homing = body?.homing;
  if (!body || body.dead || !homing?.active || round.stepCount >= homing.untilStep) return;
  const king = round.pigs.find((pig) => pig.isKing && !pig.dead);
  if (!king) return;
  const speedSq = body.vx * body.vx + body.vy * body.vy;
  if (!(speedSq > 0)) return;
  const speed = Math.sqrt(speedSq);
  const dx = king.x - body.x;
  const dy = king.y - body.y;
  const cross = body.vx * dy - body.vy * dx;
  const direction = cross < 0 ? -1 : 1;
  const vx = body.vx;
  const vy = body.vy;
  body.vx += -vy / speed * homing.steerAccel * dt * direction;
  body.vy += vx / speed * homing.steerAccel * dt * direction;
  const nextSpeed = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
  if (nextSpeed > 0) {
    body.vx *= speed / nextSpeed;
    body.vy *= speed / nextSpeed;
  }
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

export function remoteDetonate(round) {
  const effect = round.defenderEffects?.find((candidate) =>
    candidate.kind === 'remoteTnt');
  if (!effect || round.remoteTntTaps >= effect.tapsPerRound) return false;
  const crates = round.blocks.filter((block) =>
    block.remoteTnt && !block.remoteFired).sort((a, b) => a.blueprintIndex - b.blueprintIndex);
  if (!crates.length) return false;
  round.remoteTntTaps++;
  for (const block of crates) {
    block.remoteFired = true;
    queueExplosion(round, block, block.blast ?? block.mat);
    if (!block.dead) {
      block.dead = true;
      block.destroyedStep = round.stepCount;
      removeBody(round.world, block);
      round.queuedEvents.push({
        kind: EVENT_KIND.shatter,
        x: block.x,
        y: block.y,
        mat: block.materialId,
        shape: block.shapeId
      });
    }
  }
  round.queuedEvents.push({
    kind: EVENT_KIND.ability,
    ability: 'remote-tnt',
    x: crates[0].x,
    y: crates[0].y,
    count: crates.length
  });
  return crates.length;
}

function springPair(a, b) {
  if (a.mat?.ammoRestitution !== undefined && b.role === 'ammo') {
    return { spring: a, critter: b };
  }
  if (b.mat?.ammoRestitution !== undefined && a.role === 'ammo') {
    return { spring: b, critter: a };
  }
  return null;
}

function springLaunchEvent(round, contact, point) {
  if (!(contact.restitutionBias > 0)) return;
  const pair = springPair(contact.a, contact.b);
  if (!pair) return;
  const duplicate = round.events.some((event) => event.kind === EVENT_KIND['spring-launch'] &&
    event.springId === pair.spring.id && event.critterId === pair.critter.id);
  if (duplicate) return;
  round.events.push({
    kind: EVENT_KIND['spring-launch'],
    x: point.x,
    y: point.y,
    springId: pair.spring.id,
    critterId: pair.critter.id,
    impulse: contact.pn
  });
}

function killBody(round, body) {
  if (body.dead) return;
  body.dead = true;
  round.deadThisStep.push(body);
  if (body.role === 'block') {
    body.destroyedStep = round.stepCount;
    round.events.push({
      kind: EVENT_KIND.shatter,
      x: body.x,
      y: body.y,
      mat: body.materialId,
      shape: body.shapeId
    });
    if (body.mat.chunks) {
      round.events.push({
        kind: EVENT_KIND.crumble,
        x: body.x,
        y: body.y,
        mat: body.materialId,
        chunks: body.mat.chunks
      });
    }
    if (body.materialId === 'tnt' && !body.remoteTnt) {
      queueExplosion(round, body, body.blast ?? body.mat);
    }
  } else if (body.role === 'pig') {
    round.events.push({ kind: EVENT_KIND.pop, pig: body.pigId, x: body.x, y: body.y });
    if (body.balloon && !body.balloon.dead) killBody(round, body.balloon);
  } else if (body.role === 'balloon') {
    const pig = body.pigBody;
    if (pig?.balloon === body) {
      pig.balloon = null;
      wakeBody(round.world, pig);
    }
    round.events.push({
      kind: EVENT_KIND['balloon-pop'],
      x: body.x,
      y: body.y,
      pigId: pig?.id ?? null
    });
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
  if (body.dead || body.role !== 'block' && body.role !== 'pig' &&
      body.role !== 'balloon') return;
  if (body.indestructible) return;
  if (body.role === 'pig' && body.invulnerableWhileBalloon &&
      body.balloon && !body.balloon.dead) return;
  const definition = body.role === 'pig' ? body.pig : body.mat;
  let amount = Math.max(0, contact.pn - definition.thresh) * definition.frailty;
  if (definition.brittle) {
    amount += TUNE.brittleTangentFactor *
      Math.max(0, Math.abs(contact.pt) - definition.thresh);
  }
  amount *= armourScale(body, towardSourceX, towardSourceY);
  let absorbed = 0;
  if (source?.role === 'block' && source.mat.absorb !== undefined) {
    absorbed = amount * source.mat.absorb;
    amount *= 1 - source.mat.absorb;
  }
  if (body.role === 'block' && body.materialId === 'stone' &&
      source?.stoneDamageMultiplier !== undefined) {
    amount *= source.stoneDamageMultiplier;
  }
  if (!(amount > 0)) return;

  body.hp -= amount;
  if (absorbed > 0) {
    round.events.push({
      kind: EVENT_KIND['gel-absorb'],
      x: point.x,
      y: point.y,
      gelId: source.id,
      targetId: body.id,
      amount: absorbed
    });
  }
  round.events.push({
    kind: EVENT_KIND.hit,
    x: point.x,
    y: point.y,
    impulse: contact.pn,
    mat: body.role === 'block' ? body.materialId :
      body.role === 'pig' ? body.pigId : 'balloon'
  });
  if (body.hp <= 0) killBody(round, body);
}

function applyContactDamage(round, world) {
  for (const contact of world.contacts) {
    const point = eventPoint(contact);
    springLaunchEvent(round, contact, point);
    const stone = contact.a.role === 'defence' ? contact.a
      : contact.b.role === 'defence' ? contact.b : null;
    if (stone) {
      if (stone.dead) continue;
      const other = contact.a === stone ? contact.b : contact.a;
      if (other.role === 'ammo') {
        other.vx *= stone.hitSpeedMultiplier;
        other.vy *= stone.hitSpeedMultiplier;
      }
      stone.dead = true;
      removeBody(world, stone);
      round.events.push({
        kind: EVENT_KIND.ability,
        ability: 'flak',
        x: point.x,
        y: point.y,
        speedMultiplier: other.role === 'ammo' ? stone.hitSpeedMultiplier : 1
      });
      continue;
    }
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
  round.events.push({ kind: EVENT_KIND.boom, x: explosion.x, y: explosion.y, r: explosion.r });
  // Occlusion is captured before applying damage. Letting a wall disappear halfway
  // through this loop made later ids receive a different blast than earlier ids.
  const targets = explosionTargets(world, explosion);
  for (const target of targets) {
    if (target.body.indestructible || target.body.role === 'pig' &&
        target.body.invulnerableWhileBalloon && target.body.balloon &&
        !target.body.balloon.dead) continue;
    const impulse = explosion.impulse * target.falloff;
    applyImpulse(world, target.body, target.nx * impulse, target.ny * impulse);
    if (target.body.role !== 'block' && target.body.role !== 'pig' &&
        target.body.role !== 'balloon') continue;
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
  for (const body of round.balloons) if (!body.dead && body.hp <= 0) killBody(round, body);

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

function balloonDrift(balloon, time) {
  const cycle = time / balloon.driftSeconds;
  const phase = cycle - Math.floor(cycle);
  let wave;
  let direction;
  if (phase < 0.25) {
    wave = phase * 4;
    direction = 1;
  } else if (phase < 0.75) {
    wave = 2 - phase * 4;
    direction = -1;
  } else {
    wave = phase * 4 - 4;
    direction = 1;
  }
  return {
    x: balloon.anchorX + balloon.driftRange * wave,
    vx: direction * balloon.driftRange * 4 / balloon.driftSeconds
  };
}

function positionBalloons(round, time, neutraliseGravity) {
  for (const balloon of round.balloons) {
    const pig = balloon.pigBody;
    if (balloon.dead || pig.dead || pig.balloon !== balloon) continue;
    const drift = balloonDrift(balloon, time);
    balloon.x = drift.x;
    balloon.y = balloon.anchorY;
    balloon.vx = drift.vx;
    balloon.vy = 0;
    pig.x = drift.x;
    pig.y = balloon.pigAnchorY;
    pig.vx = drift.vx;
    pig.vy = neutraliseGravity ? round.world.gravity * TUNE.step : 0;
    pig.av = 0;
    pig.isAsleep = false;
    pig.sleepTimer = 0;
  }
}

function addDebrisBody(round, parent, shape, material, localX, localY, tag) {
  const offsetX = parent.c * localX - parent.s * localY;
  const offsetY = parent.s * localX + parent.c * localY;
  const body = addBody(round.world, {
    shape,
    mat: material,
    x: parent.x + offsetX,
    y: parent.y + offsetY,
    c: parent.c,
    s: parent.s,
    vx: parent.vx - parent.av * offsetY,
    vy: parent.vy + parent.av * offsetX,
    av: parent.av,
    filterTag: parent.filterTag,
    tag
  });
  body.role = 'debris';
  body.materialId = parent.materialId;
  body.shapeId = shape.id;
  body.parentId = parent.id;
  round.debris.push(body);
  return body;
}

function spawnSandChunks(round, body) {
  const count = body.mat.chunks;
  const parentMass = 1 / body.im;
  let radius;
  let offsets;
  if (body.kind === 'circle') {
    radius = body.r / count;
    offsets = [];
    for (let index = 0; index < count; index++) {
      offsets.push({
        x: 2 * body.r * (index - (count - 1) / 2) / count,
        y: 0
      });
    }
  } else if (body.kind === 'tri' && count === 3) {
    radius = Math.min(body.shape.w, body.shape.h) / 12;
    offsets = [
      { x: -body.shape.w / 6, y: -body.shape.h / 6 },
      { x: body.shape.w / 3, y: -body.shape.h / 6 },
      { x: -body.shape.w / 6, y: body.shape.h / 3 }
    ];
  } else {
    const longIsX = body.shape.w >= body.shape.h;
    const length = longIsX ? body.shape.w : body.shape.h;
    radius = Math.min(body.shape.w, body.shape.h) / (count * 2);
    offsets = [];
    for (let index = 0; index < count; index++) {
      const along = length * (index - (count - 1) / 2) / count;
      offsets.push({ x: longIsX ? along : 0, y: longIsX ? 0 : along });
    }
  }
  const area = circleArea(radius);
  const material = {
    ...body.mat,
    id: 'sand-chunk',
    density: parentMass / count / area
  };
  for (let index = 0; index < count; index++) {
    const offset = offsets[index];
    addDebrisBody(round, body, {
      id: 'sand-chunk', kind: 'circle', r: radius, area
    }, material, offset.x, offset.y, `${body.tag}:chunk:${index}`);
  }
}

function splitLargeStone(round, body) {
  const splitX = body.shape.w >= body.shape.h;
  const shape = {
    id: 'stone-half',
    kind: 'box',
    w: splitX ? body.shape.w / 2 : body.shape.w,
    h: splitX ? body.shape.h : body.shape.h / 2,
    area: body.shape.area / 2
  };
  const along = splitX ? body.shape.w / 4 : body.shape.h / 4;
  addDebrisBody(round, body, shape, body.mat,
    splitX ? -along : 0, splitX ? 0 : -along, `${body.tag}:half:0`);
  addDebrisBody(round, body, shape, body.mat,
    splitX ? along : 0, splitX ? 0 : along, `${body.tag}:half:1`);
  round.events.push({
    kind: EVENT_KIND['stone-split'],
    x: body.x,
    y: body.y,
    parentId: body.id,
    halves: 2
  });
}

function spawnBreakup(round, body) {
  if (body.role !== 'block') return;
  if (body.mat.chunks) {
    spawnSandChunks(round, body);
  } else if (body.materialId === 'stone' && body.shape.area >= 2 &&
      body.kind === 'box') {
    splitLargeStone(round, body);
  }
}

function pointToBlockDistanceSq(pig, block) {
  const dx = pig.x - block.x;
  const dy = pig.y - block.y;
  if (block.kind === 'circle') {
    const centreDistance = Math.sqrt(dx * dx + dy * dy);
    const distance = Math.max(0, centreDistance - block.r);
    return distance * distance;
  }
  const x = block.c * dx + block.s * dy;
  const y = -block.s * dx + block.c * dy;
  let inside = true;
  let nearest = Infinity;
  const count = block.verts.length / 2;
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    const x0 = block.verts[index * 2];
    const y0 = block.verts[index * 2 + 1];
    const ex = block.verts[next * 2] - x0;
    const ey = block.verts[next * 2 + 1] - y0;
    if (ex * (y - y0) - ey * (x - x0) < 0) inside = false;
    const lengthSq = ex * ex + ey * ey;
    const t = Math.max(0, Math.min(1, ((x - x0) * ex + (y - y0) * ey) / lengthSq));
    const qx = x0 + ex * t;
    const qy = y0 + ey * t;
    const qdx = x - qx;
    const qdy = y - qy;
    nearest = Math.min(nearest, qdx * qdx + qdy * qdy);
  }
  return inside ? 0 : nearest;
}

function bodyBounds(body) {
  if (body.kind === 'circle') {
    return {
      minX: body.x - body.r,
      minY: body.y - body.r,
      maxX: body.x + body.r,
      maxY: body.y + body.r
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < body.verts.length / 2; index++) {
    const x = body.x + body.c * body.verts[index * 2] -
      body.s * body.verts[index * 2 + 1];
    const y = body.y + body.s * body.verts[index * 2] +
      body.c * body.verts[index * 2 + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function repairSpaceOccupied(world, block, original = false) {
  const targetBody = original ? {
    ...block,
    x: block.originalX,
    y: block.originalY,
    c: block.originalC,
    s: block.originalS
  } : block;
  const target = bodyBounds(targetBody);
  for (const other of world.bodies) {
    if (other.dead || other === block) continue;
    const bounds = bodyBounds(other);
    const overlapX = Math.min(target.maxX, bounds.maxX) - Math.max(target.minX, bounds.minX);
    const overlapY = Math.min(target.maxY, bounds.maxY) - Math.max(target.minY, bounds.minY);
    if (overlapX > TUNE.slop && overlapY > TUNE.slop) return true;
  }
  return false;
}

function respawnBlock(round, block, original = false) {
  const restored = addBody(round.world, {
    shape: block.shape,
    mat: block.mat,
    x: original ? block.originalX : block.x,
    y: original ? block.originalY : block.y,
    c: original ? block.originalC : block.c,
    s: original ? block.originalS : block.s,
    filterTag: block.filterTag,
    tag: block.tag
  });
  restored.hp = 0;
  restored.maxHp = block.maxHp;
  restored.role = 'block';
  restored.shapeId = block.shapeId;
  restored.materialId = block.materialId;
  restored.blueprintIndex = block.blueprintIndex;
  restored.originalX = block.originalX;
  restored.originalY = block.originalY;
  restored.originalC = block.originalC;
  restored.originalS = block.originalS;
  restored.indestructible = block.indestructible;
  restored.blast = block.blast;
  restored.remoteTnt = block.remoteTnt;
  restored.cardRestored = block.cardRestored;
  round.blocks[round.blocks.indexOf(block)] = restored;
  return restored;
}

function restoreBlock(round, sarge, block, fraction = sarge.pig.traits.repairFraction,
  original = false) {
  const resurrected = block.dead;
  const target = resurrected ? respawnBlock(round, block, original) : block;
  const before = target.hp;
  target.hp = Math.min(target.maxHp,
    target.hp + target.maxHp * fraction);
  wakeBody(round.world, target);
  if (sarge) wakeBody(round.world, sarge);
  round.events.push({
    kind: EVENT_KIND.repair,
    x: target.x,
    y: target.y,
    pigId: sarge?.id ?? null,
    blockId: target.id,
    amount: target.hp - before,
    resurrected
  });
  return target;
}

function restoreMasonBlock(round) {
  const effect = round.defenderEffects.find((candidate) =>
    candidate.kind === 'restoreBlock');
  if (!effect || round.shotIndex % effect.everyEnemyShots !== 0) return null;
  const candidates = round.blocks.filter((block) =>
    block.dead && !block.cardRestored).sort((a, b) =>
    (a.destroyedStep ?? Infinity) - (b.destroyedStep ?? Infinity) || a.id - b.id);
  for (const block of candidates) {
    if (effect.requireClearSpace && repairSpaceOccupied(round.world, block, true)) continue;
    block.cardRestored = true;
    const restored = restoreBlock(round, null, block, effect.hpFraction, true);
    restored.cardRestored = true;
    return restored;
  }
  return null;
}

function repairSarges(round) {
  if (round.mode !== 'siege') return;
  const sarges = round.pigs.filter((pig) =>
    !pig.dead && pig.pig.traits.repairEvery !== undefined).sort((a, b) => a.id - b.id);
  for (const sarge of sarges) {
    const every = Math.ceil(sarge.pig.traits.repairEvery / TUNE.step);
    if (round.stepCount % every !== 0) continue;
    let best = null;
    let bestDistanceSq = Infinity;
    for (const block of round.blocks) {
      if (block.hp >= block.maxHp) continue;
      const surfaceDistanceSq = pointToBlockDistanceSq(sarge, block);
      const adjacent = sarge.r + TUNE.gridSnap;
      if (surfaceDistanceSq > adjacent * adjacent) continue;
      if (block.dead && repairSpaceOccupied(round.world, block)) continue;
      const dx = block.x - sarge.x;
      const dy = block.y - sarge.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq ||
          distanceSq === bestDistanceSq && block.id < best.id) {
        best = block;
        bestDistanceSq = distanceSq;
      }
    }
    if (best) restoreBlock(round, sarge, best);
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
  for (const body of round.deadThisStep) {
    removeBody(round.world, body);
    spawnBreakup(round, body);
  }
  round.deadThisStep = [];
}

function cullDefenceProjectiles(round) {
  for (const body of round.world.bodies.slice()) {
    if (body.role !== 'defence') continue;
    if (body.x + body.r < TUNE.viewMinX || body.x - body.r > TUNE.viewMaxX ||
        body.y + body.r < -TUNE.gridSnap || body.y - body.r > TUNE.plotH + 4) {
      body.dead = true;
      removeBody(round.world, body);
    }
  }
}

function allPigsDead(round) {
  for (const pig of round.pigs) if (!pig.dead) return false;
  return true;
}

function flyingIsOutOfPlay(body) {
  return body.x + body.r < TUNE.viewMinX || body.x - body.r > TUNE.viewMaxX ||
    body.y + body.r < -TUNE.gridSnap;
}

function activeFuse(round) {
  const body = round.flying;
  if (!body || body.dead || body.fuseContactStep === undefined) return null;
  const ammo = AMMO_BY_ID[body.ammoId];
  const shot = round.shots[round.shots.length - 1];
  if (!ammo || !shot || shot.tapStep !== null) return null;
  return { body, ammo };
}

function recordFuseContact(round) {
  const fuse = activeFuse(round);
  if (!fuse || fuse.body.fuseContactStep !== null) return;
  const contacted = round.world.contacts.some((contact) =>
    contact.a === fuse.body || contact.b === fuse.body);
  if (contacted) fuse.body.fuseContactStep = round.stepCount;
}

function fireReadyFuse(round) {
  const fuse = activeFuse(round);
  if (!fuse || fuse.body.fuseContactStep === null) return false;
  const fuseSteps = Math.ceil(fuse.ammo.params.fuseSeconds / TUNE.step);
  // Contact is observed at the end of a fixed step. Include the step about to run so
  // the boom event lands exactly `fuseSteps` later, rather than one step late.
  if (round.stepCount - fuse.body.fuseContactStep + 1 < fuseSteps) return false;
  boomAbility(round, fuse.body, fuse.ammo);
  return true;
}

function detonateUncontactedFuse(round) {
  const fuse = activeFuse(round);
  if (!fuse || fuse.body.fuseContactStep !== null) return false;
  boomAbility(round, fuse.body, fuse.ammo);
  return true;
}

function armedFuseIsPending(round) {
  const fuse = activeFuse(round);
  return Boolean(fuse && fuse.body.fuseContactStep !== null);
}

function retireFlyingBody(round) {
  const body = round.flying;
  if (!body || body.dead || !flyingIsOutOfPlay(body)) return false;
  // This runs after physics.step returns, never while contacts still own the body.
  if (detonateUncontactedFuse(round)) return true;
  // Once contact starts the fuse, preserve its exact deadline even if the rebound
  // carries Lob outside the view before then.
  if (armedFuseIsPending(round)) return false;
  body.dead = true;
  removeBody(round.world, body);
  return true;
}

function finishSettling(round) {
  round.events.push({ kind: EVENT_KIND.settled });
  round.flying = null;
  if (round.shotIndex >= round.bag.length && !allPigsDead(round)) {
    round.phase = 'lost';
    round.events.push({ kind: EVENT_KIND.lost });
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
  const attackerCards = normaliseCards(spec.attackerCards ?? spec.cards ?? []);
  const defenderCards = normaliseCards(spec.defenderCards ?? []);
  const attackerEffects = cardEffects(attackerCards);
  const defenderEffects = cardEffects(defenderCards);
  const round = {};
  const world = makeWorld({
    onDamage: (activeWorld) => damageStep(round, activeWorld),
    restitutionFor
  });
  const bodies = instantiate(world, blueprint, { cards: defenderCards });
  Object.assign(round, {
    world,
    blueprint,
    seed: spec.seed >>> 0,
    rng: rng(spec.seed),
    bag,
    attackerCards,
    defenderCards,
    attackerEffects,
    defenderEffects,
    shotIndex: 0,
    shots: [],
    phase: bodies.pigs.length ? 'aiming' : 'won',
    mode: spec.mode,
    time: 0,
    stepCount: 0,
    events: [],
    queuedEvents: [],
    score: 0,
    scoreBreakdown: null,
    pigs: bodies.pigs,
    blocks: bodies.blocks,
    balloons: bodies.balloons,
    debris: [],
    flying: null,
    settleTimer: 0,
    pendingExplosions: [],
    deadThisStep: [],
    pierceStarts: [],
    remoteTntTaps: 0,
    homingAssigned: 0,
    suddenDeath: false,
    scoreFinal: false
  });
  scoreRound(round);
  return round;
}

function slingForShot(round, index) {
  const effect = round.attackerEffects.find((candidate) =>
    candidate.kind === 'slingshots');
  const alternate = effect?.alternating && effect.count > 1 && index % effect.count !== 0;
  return {
    x: TUNE.slingX,
    y: TUNE.slingY + (alternate ? effect.secondSlingYOffset : 0)
  };
}

function slingPullMultiplier(round) {
  return round.attackerEffects.find((effect) =>
    effect.kind === 'slingPull')?.multiplier ?? 1;
}

export function launch(round, dx, dy) {
  if (round.phase !== 'aiming' || round.shotIndex >= round.bag.length) return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;

  const pullMultiplier = slingPullMultiplier(round);
  const drawLength = Math.sqrt(dx * dx + dy * dy);
  const clampedLength = Math.min(drawLength, TUNE.slingRadius * pullMultiplier);
  const drawScale = drawLength > 0 ? clampedLength / drawLength : 0;
  const clampedDx = dx * drawScale;
  const clampedDy = dy * drawScale;
  const launchScale = TUNE.launchSpeedMax / TUNE.slingRadius;
  const vx = -clampedDx * launchScale;
  const vy = -clampedDy * launchScale;
  const ammoId = round.bag[round.shotIndex];
  const ammo = AMMO_BY_ID[ammoId];
  const sling = slingForShot(round, round.shotIndex);
  const body = addAmmoBody(round, ammo, vx, vy, { x: sling.x, y: sling.y });
  const homing = round.attackerEffects.find((effect) => effect.kind === 'ammoHoming');
  if (homing && round.homingAssigned < homing.ammoCount) {
    body.homing = { ...homing, active: false, untilStep: -1 };
    round.homingAssigned++;
  }

  round.shots.push({
    step: round.stepCount,
    ammo: ammoId,
    dx: clampedDx,
    dy: clampedDy,
    slingY: sling.y,
    tapStep: null
  });
  round.shotIndex++;
  round.phase = 'flying';
  round.flying = body;
  round.settleTimer = 0;
  round.queuedEvents.push({ kind: EVENT_KIND.launch, ammo: ammoId });
  restoreMasonBlock(round);
  scoreRound(round);
  return body;
}

export function tap(round) {
  if (!round.flying || round.flying.dead) return false;
  const ammo = AMMO_BY_ID[round.flying.ammoId];
  const homing = round.flying.homing;
  if (!ammo.ability && !homing) return false;
  const usableNow = round.phase === 'flying' ||
    round.phase === 'settling' && ammo.params.tappableAtRest;
  if (!usableNow) return false;
  const shot = round.shots[round.shots.length - 1];
  if (shot.tapStep !== null) return false;
  if (homing) {
    homing.active = true;
    homing.untilStep = round.stepCount + Math.ceil(homing.steerSeconds / TUNE.step);
  }
  if (ammo.ability) {
    const handler = ABILITY_HANDLERS[ammo.ability];
    if (!handler) throw new Error(`no ability handler for '${ammo.ability}'`);
    handler(round, round.flying, ammo);
  }
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
  fireReadyFuse(round);
  round.events = round.queuedEvents;
  round.queuedEvents = [];
  round.deadThisStep = [];
  fireFlak(round);
  applyCardForces(round, dt);
  advanceInflations(round.world, dt);
  positionBalloons(round, round.time, true);
  capturePierceStarts(round);
  step(round.world, dt);
  round.pierceStarts = [];
  round.time += dt;
  round.stepCount++;
  recordFuseContact(round);
  positionBalloons(round, round.time, false);
  if (round.phase === 'flying' || round.phase === 'settling') round.settleTimer += dt;
  const timedOut = round.phase === 'flying' || round.phase === 'settling'
    ? settleTimedOut(round) : false;
  if (timedOut) round.settleTimer = TUNE.settleTimeout;
  removeDeadAtStepEnd(round);
  cullDefenceProjectiles(round);
  repairSarges(round);
  const retired = retireFlyingBody(round);
  const timedOutFuse = timedOut && detonateUncontactedFuse(round);

  const king = round.pigs.find((pig) => pig.isKing);
  const objectiveWon = round.mode === 'siege' ? Boolean(king?.dead) : allPigsDead(round);
  if (objectiveWon) {
    round.phase = 'won';
    round.flying = null;
    round.events.push({ kind: EVENT_KIND.won });
  } else if (round.phase === 'flying') {
    const flightFinished = retired || timedOutFuse || round.flying?.isAsleep ||
      isSettled(round.world) || timedOut;
    if (flightFinished) round.phase = 'settling';
  } else if (wasSettling && !armedFuseIsPending(round) &&
      (isSettled(round.world) || timedOut)) {
    finishSettling(round);
  }

  scoreRound(round);
  return round.events;
}

export function isRoundOver(round) {
  return round.phase === 'won' || round.phase === 'lost';
}

export function beginSuddenDeath(round) {
  if (round.suddenDeath) return false;
  round.regulationScore = round.score;
  round.regulationDamage = round.scoreBreakdown?.damage ?? 0;
  round.bag.push('lob');
  round.phase = 'aiming';
  round.flying = null;
  round.settleTimer = 0;
  round.suddenDeath = true;
  round.scoreFinal = false;
  scoreRound(round);
  return true;
}

export function finalizeSiegeScore(round) {
  if (round.mode !== 'siege') return scoreRound(round);
  round.scoreFinal = true;
  return scoreRound(round);
}

export function scoreRound(round) {
  if (round.mode === 'siege') {
    const tilt = round.defenderEffects.find((effect) => effect.kind === 'plotTilt');
    let destroyedBlocks = 0;
    let offPlotBlocks = 0;
    for (const block of round.blocks) {
      let target = block;
      if (tilt) {
        target = {
          ...block,
          x: tilt.cos * block.x + tilt.sin * block.y,
          y: -tilt.sin * block.x + tilt.cos * block.y,
          c: tilt.cos * block.c + tilt.sin * block.s,
          s: -tilt.sin * block.c + tilt.cos * block.s
        };
      }
      const bounds = bodyBounds(target);
      const offPlot = bounds.maxX < 0 || bounds.minX > TUNE.plotW ||
        bounds.maxY < 0 || bounds.minY > TUNE.plotH;
      const value = block.shape.area * block.mat.cost;
      if (block.dead || offPlot) {
        destroyedBlocks += value * SCORE.siege.blockDestroyedCostMultiplier;
      }
      if (offPlot) {
        offPlotBlocks += value * SCORE.siege.blockOffPlotBonusCostMultiplier;
      }
    }
    let pigs = 0;
    for (const pig of round.pigs) {
      if (pig.dead) pigs += SCORE.siege.pigs[pig.pigId] ?? 0;
    }
    const atRoundEnd = round.scoreFinal || isRoundOver(round);
    const unused = atRoundEnd
      ? (round.bag.length - round.shotIndex) * SCORE.siege.unusedAmmo : 0;
    const king = round.pigs.find((pig) => pig.isKing && !pig.dead);
    const slingshots = round.attackerEffects.find((effect) => effect.kind === 'slingshots');
    const slingOrigins = [{ x: TUNE.slingX, y: TUNE.slingY }];
    if (slingshots?.count > 1) slingOrigins.push({
      x: TUNE.slingX,
      y: TUNE.slingY + slingshots.secondSlingYOffset
    });
    const breach = atRoundEnd && king && slingOrigins.some((origin) =>
      blockRayDepth(round.world, origin.x, origin.y, king.x, king.y) === 0)
      ? SCORE.siege.breach : 0;
    const damage = destroyedBlocks + offPlotBlocks + pigs;
    round.scoreBreakdown = {
      destroyedBlocks,
      offPlotBlocks,
      pigs,
      unused,
      breach,
      damage
    };
    round.score = damage + unused + breach;
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
  hash = hashNumber(hash, body.flags ?? 0);
  hash = fnvWord(hash, body.indestructible ? 1 : 0);
  hash = fnvWord(hash, body.remoteTnt ? 1 : 0);
  hash = fnvWord(hash, body.remoteFired ? 1 : 0);
  hash = fnvWord(hash, body.cardRestored ? 1 : 0);
  hash = fnvWord(hash, body.homing?.active ? 1 : 0);
  hash = hashNumber(hash, body.homing?.untilStep ?? -1);
  hash = hashNumber(hash, body.shotIndex ?? -1);
  hash = hashNumber(hash, body.flakNextStep ?? -1);
  hash = hashNumber(hash, body.destroyedStep ?? -1);
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
  hash = hashNumber(hash, round.remoteTntTaps);
  hash = hashNumber(hash, round.homingAssigned);
  hash = fnvWord(hash, round.suddenDeath ? 1 : 0);
  hash = fnvWord(hash, round.scoreFinal ? 1 : 0);
  hash = hashNumber(hash, round.flying?.id ?? -1);
  hash = hashNumber(hash, round.flying?.fuseContactStep ?? -1);
  hash = hashNumber(hash, round.world.nextId);

  hash = fnvWord(hash, round.attackerCards.length);
  for (const id of round.attackerCards) hash = hashString(hash, id);
  hash = fnvWord(hash, round.defenderCards.length);
  for (const id of round.defenderCards) hash = hashString(hash, id);

  hash = fnvWord(hash, round.bag.length);
  for (const ammoId of round.bag) hash = hashString(hash, ammoId);
  hash = fnvWord(hash, round.shots.length);
  for (const shot of round.shots) {
    hash = hashNumber(hash, shot.step);
    hash = hashString(hash, shot.ammo);
    hash = hashNumber(hash, shot.dx);
    hash = hashNumber(hash, shot.dy);
    hash = hashNumber(hash, shot.slingY);
    hash = hashNumber(hash, shot.tapStep ?? -1);
  }

  hash = fnvWord(hash, round.blocks.length);
  for (const block of round.blocks) hash = hashBody(hash, block);
  hash = fnvWord(hash, round.pigs.length);
  for (const pig of round.pigs) hash = hashBody(hash, pig);
  hash = fnvWord(hash, round.balloons.length);
  for (const balloon of round.balloons) hash = hashBody(hash, balloon);
  hash = fnvWord(hash, round.debris.length);
  for (const body of round.debris) hash = hashBody(hash, body);
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
