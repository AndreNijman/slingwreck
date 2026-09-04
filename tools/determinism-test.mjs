const BODY_FIELDS = ['x', 'y', 'c', 's', 'vx', 'vy', 'av'];
const CHECKPOINT_STEPS = [0, 300, 600, 900, 1200, 1500, 1800];
const SIM_BODY_FIELDS = [...BODY_FIELDS, 'hp', 'maxHp'];
const SIM_DURATION_STEPS = 5880;
const SIM_CHECKPOINT_STEPS = [0, 980, 1960, 2940, 3920, 4900, SIM_DURATION_STEPS];
const ENGINE_NAMES = ['Node', 'Chromium', 'Firefox', 'WebKit'];
const SHAPE_IDS = ['cube', 'slab', 'beam', 'plank', 'post', 'pillar', 'tri', 'ball'];
const MATERIAL_IDS = ['glass', 'wood', 'stone', 'iron', 'tnt', 'spring', 'gel', 'sand'];
const SIM_AMMO_IDS = ['nib', 'chip', 'wedge', 'lob', 'pebble', 'boomer', 'hulk', 'spike', 'zip'];
const SIM_ABILITY_IDS = ['split', 'accel', 'boom', 'drop', 'reverse', 'inflate', 'harden', 'blink'];

const SIM_SHOT_LOG = [
  { step: 0, tapStep: 1, ammo: 'nib', dx: -1.58, dy: 0.18 },
  { step: 420, tapStep: null, ammo: 'nib', dx: -1.56, dy: -0.36 },
  { step: 840, tapStep: null, ammo: 'nib', dx: -1.45, dy: -0.68 },
  { step: 1260, tapStep: null, ammo: 'nib', dx: -0.44, dy: -1.53 },
  { step: 1680, tapStep: null, ammo: 'nib', dx: -1.58, dy: -0.22 },
  { step: 2100, tapStep: null, ammo: 'nib', dx: -1.42, dy: -0.74 },
  { step: 2520, tapStep: 2521, ammo: 'chip', dx: 1.5, dy: -0.2 },
  { step: 2940, tapStep: 2941, ammo: 'wedge', dx: 1.5, dy: -0.2 },
  { step: 3360, tapStep: 3361, ammo: 'lob', dx: 1.5, dy: -0.2 },
  { step: 3780, tapStep: 3781, ammo: 'pebble', dx: 1.5, dy: -0.2 },
  { step: 4200, tapStep: 4201, ammo: 'boomer', dx: 1.5, dy: -0.2 },
  { step: 4620, tapStep: 4621, ammo: 'hulk', dx: 1.5, dy: -0.2 },
  { step: 5040, tapStep: 5041, ammo: 'spike', dx: 1.5, dy: -0.2 },
  { step: 5460, tapStep: 5461, ammo: 'zip', dx: 1.5, dy: -0.2 }
];

const SIM_BLUEPRINT = {
  v: 1,
  blocks: [
    ['ball', 'gel', 0.45, 1.5, 0],
    ['post', 'wood', 2.5, 1, 0],
    ['post', 'wood', 3.2, 1, 0],
    ['beam', 'glass', 2.85, 2.25, 0],
    ['cube', 'sand', 2.35, 3, 0],
    ['cube', 'gel', 3.35, 3, 0],
    ['beam', 'spring', 2.85, 3.75, 0],
    ['tri', 'glass', 3.9, 1 / 3, 0],
    ['post', 'stone', 5, 1, 0],
    ['post', 'stone', 6, 1, 0],
    ['slab', 'stone', 5.5, 2.5, 0],
    ['cube', 'glass', 5.5, 4.7, 0],
    ['ball', 'spring', 7, 0.5, 0],
    ['cube', 'tnt', 13, 0.5, 0],
    ['cube', 'tnt', 11.5, 0.5, 0],
    ['cube', 'tnt', 12.25, 1.5, 0],
    ['slab', 'stone', 14.7, 1, 6],
    ['cube', 'iron', 15.9, 0.5, 0],
    ['cube', 'sand', 18.5, 0.5, 0],
    ['cube', 'gel', 19.5, 0.5, 0],
    ['cube', 'iron', 20.5, 0.5, 0],
    ['cube', 'spring', 21.5, 0.5, 0],
    ['post', 'wood', 18.5, 2, 0],
    ['post', 'wood', 20.5, 2, 0],
    ['plank', 'stone', 19.5, 3.25, 0],
    ['cube', 'glass', 18.3, 4, 0],
    ['cube', 'glass', 20.7, 4, 0],
    ['beam', 'wood', 19.5, 4.75, 0],
    ['tri', 'sand', 22.5, 1 / 3, 0],
    ['slab', 'iron', 22.8, 0.5, 0],
    ['pillar', 'stone', 24.2, 2, 0],
    ['plank', 'wood', 23, 4.25, 0],
    ['cube', 'glass', 22, 5, 0],
    ['ball', 'spring', 23.2, 5, 0],
    ['beam', 'sand', 24.2, 5.75, 0],
    ['ball', 'gel', 17.2, 6, 0],
    ['tri', 'wood', 8.1, 1 / 3, 0]
  ],
  pigs: [
    ['tusk', 1.1, 0.44],
    ['helm', 5.5, 3.42],
    ['runt', 7.6, 0.3],
    ['swine', 8.7, 0.4],
    ['hogg', 9.7, 0.58],
    ['sarge', 17, 0.46],
    ['zep', 17.1, 6],
    ['king', 25.5, 0.68]
  ]
};

const SIM_FRONT_BLOCKS = [0, 1, 2, 3, 4, 5, 6];
const SIM_REAR_BLOCK_START = 18;
const SIM_SHIELD_BLOCK = 16;
const SIM_SHIELDED_BLOCK = 17;
const SIM_SPLIT_BLOCK = 24;

function bitsOf(value, view) {
  view.setFloat64(0, value);
  return view.getUint32(0).toString(16).padStart(8, '0') +
    view.getUint32(4).toString(16).padStart(8, '0');
}

function snapshot(world) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  return world.bodies.slice().sort((a, b) => a.id - b.id).map((body) => ({
    id: body.id,
    values: BODY_FIELDS.map((field) => body[field]),
    bits: BODY_FIELDS.map((field) => bitsOf(body[field], view))
  }));
}

export function runScenario(physics) {
  const { addBody, digest, fromDegrees, makeWorld, rng, rngInt, step } = physics;
  const random = rng(1337);
  const world = makeWorld();

  for (let i = 0; i < 40; i++) {
    const rotation = fromDegrees(rngInt(random, 24) * 15);
    const body = addBody(world, {
      shape: SHAPE_IDS[rngInt(random, SHAPE_IDS.length)],
      mat: MATERIAL_IDS[rngInt(random, MATERIAL_IDS.length)],
      x: -10 + random() * 44,
      y: 3 + random() * 24,
      c: rotation.c,
      s: rotation.s,
      hpScale: 0.75 + random() * 0.5,
      tag: `test-${i}`
    });
    body.vx = -12 + random() * 24;
    body.vy = -4 + random() * 16;
    body.av = -8 + random() * 16;
  }

  const digests = [];
  const snapshots = [];
  const capture = () => {
    digests.push(digest(world));
    snapshots.push(snapshot(world));
  };

  capture();
  for (let stepNumber = 1; stepNumber <= 1800; stepNumber++) {
    step(world);
    if (stepNumber % 300 === 0) capture();
  }

  return { steps: CHECKPOINT_STEPS, digests, snapshots };
}

function simBodySnapshot(round) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  const byId = new Map();
  for (const body of round.world.bodies) byId.set(body.id, body);
  for (const body of round.blocks) byId.set(body.id, body);
  for (const body of round.pigs) byId.set(body.id, body);
  for (const body of round.balloons) byId.set(body.id, body);
  for (const body of round.debris) byId.set(body.id, body);
  return [...byId.values()].sort((a, b) => a.id - b.id).map((body) => ({
    id: body.id,
    role: body.role ?? 'body',
    tag: body.tag,
    dead: body.dead,
    values: SIM_BODY_FIELDS.map((field) => body[field]),
    bits: SIM_BODY_FIELDS.map((field) => bitsOf(body[field], view))
  }));
}

function simSnapshot(round) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  const values = [
    round.seed,
    round.shotIndex,
    round.stepCount,
    round.time,
    round.settleTimer,
    round.score,
    round.flying?.id ?? -1,
    round.pendingExplosions.length,
    round.world.nextId
  ];
  return {
    phase: round.phase,
    values,
    bits: values.map((value) => bitsOf(value, view)),
    bodies: simBodySnapshot(round)
  };
}

function contactSides(contact, pig) {
  if (contact.a === pig) return { x: contact.nx, y: contact.ny };
  if (contact.b === pig) return { x: -contact.nx, y: -contact.ny };
  return null;
}

function observeArmourHits(round, hpBefore, armourHits) {
  const remaining = new Map();
  for (const pigId of ['helm', 'tusk']) {
    const pig = round.pigs.find((candidate) => candidate.pigId === pigId);
    remaining.set(pig, hpBefore.get(pig));
  }

  // Replaying contact order distinguishes a hit the armour code processed from a
  // later contact skipped because an earlier contact had already killed the pig.
  for (const contact of round.world.contacts) {
    for (const pig of [contact.a, contact.b]) {
      if (!remaining.has(pig) || !(remaining.get(pig) > 0)) continue;
      const towardSource = contactSides(contact, pig);
      let amount = Math.max(0, contact.pn - pig.pig.thresh) * pig.pig.frailty;
      const armoured = pig.pigId === 'helm'
        ? towardSource.y > 0
        : towardSource.x < 0;
      if (armoured) amount *= 1 - pig.pig.traits.armourFraction;
      if (!(amount > 0)) continue;
      armourHits[pig.pigId][armoured ? 'armoured' : 'unarmoured'] = true;
      remaining.set(pig, remaining.get(pig) - amount);
    }
  }
}

function contactHasBody(contact, body) {
  return contact.a === body || contact.b === body;
}

function observeOcclusion(round, events, hpBefore, physics, exercise) {
  const shield = round.blocks[SIM_SHIELD_BLOCK];
  const target = round.blocks[SIM_SHIELDED_BLOCK];
  for (const event of events) {
    if (event.kind !== 'boom' || target.dead) continue;
    const dx = target.x - event.x;
    const dy = target.y - event.y;
    if (dx * dx + dy * dy >= event.r * event.r) continue;
    const blocker = physics.raycast(round.world, event.x, event.y, target.x, target.y,
      (candidate) => candidate !== target && candidate.role !== 'ground');
    if (blocker?.body === shield && target.hp === hpBefore.get(target)) {
      exercise.occlusion = true;
    }
  }
}

function verifySimCoverage(data) {
  const materials = new Set(SIM_BLUEPRINT.blocks.map((block) => block[1]));
  const pigs = new Set(SIM_BLUEPRINT.pigs.map((pig) => pig[0]));
  const ammo = new Set(SIM_SHOT_LOG.map((shot) => shot.ammo));
  const tntCount = SIM_BLUEPRINT.blocks.filter((block) => block[1] === 'tnt').length;
  const missingMaterials = Object.keys(data.MATERIALS).filter((id) => !materials.has(id));
  const missingPigs = Object.keys(data.PIGS).filter((id) => !pigs.has(id));
  const missingAmmo = SIM_AMMO_IDS.filter((id) => !ammo.has(id));
  if (SIM_BLUEPRINT.blocks.length < 30 || SIM_BLUEPRINT.blocks.length > 40) {
    throw new Error(`sim blueprint must contain 30 to 40 blocks, found ${SIM_BLUEPRINT.blocks.length}`);
  }
  if (missingMaterials.length || missingPigs.length) {
    throw new Error(`sim blueprint coverage missing materials [${missingMaterials.join(', ')}] ` +
      `and pigs [${missingPigs.join(', ')}]`);
  }
  if (missingAmmo.length) {
    throw new Error(`sim shot log coverage missing ammo [${missingAmmo.join(', ')}]`);
  }
  if (tntCount < 3) throw new Error(`sim blueprint needs at least three TNT crates, found ${tntCount}`);
  const shield = SIM_BLUEPRINT.blocks[SIM_SHIELD_BLOCK];
  if (shield[0] !== 'slab' || shield[1] !== 'stone') {
    throw new Error('sim occlusion shield must be a stone slab');
  }
  const split = SIM_BLUEPRINT.blocks[SIM_SPLIT_BLOCK];
  if (split[0] !== 'plank' || split[1] !== 'stone') {
    throw new Error('sim breakup fixture must be a large stone plank');
  }
}

function verifySimExercise(exercise) {
  const missing = [];
  for (const field of [
    'blocksDestroyed',
    'pigsKilled',
    'explosionsTriggered',
    'tntCratesChained',
    'springLaunches',
    'gelAbsorptions',
    'sandbagsCrumbled',
    'largeStonesSplit',
    'balloonsPopped'
  ]) {
    if (exercise[field] === 0) missing.push(field);
  }
  if (exercise.shotsLaunched !== SIM_SHOT_LOG.length) missing.push('fixed shot log');
  for (const ammoId of SIM_AMMO_IDS) {
    if (!exercise.tapsAttempted.includes(ammoId)) missing.push(`${ammoId} tap`);
  }
  for (const ability of SIM_ABILITY_IDS) {
    if (!exercise.abilitiesTriggered.includes(ability)) missing.push(`${ability} ability event`);
  }
  if (!exercise.frontWallHit) missing.push('front-wall contact');
  if (!exercise.arcClearedFront || !exercise.arcHitRear) missing.push('over-wall rear hit');
  if (!exercise.tntSetOffByShot) missing.push('shot-triggered TNT');
  if (!exercise.occlusion) missing.push('stone-slab raycast occlusion');
  for (const pigId of ['helm', 'tusk']) {
    if (!exercise.armourHits[pigId].armoured) missing.push(`${pigId} armoured-side hit`);
    if (!exercise.armourHits[pigId].unarmoured) missing.push(`${pigId} unarmoured-side hit`);
  }
  if (missing.length) {
    throw new Error(`sim scenario did not exercise: ${missing.join(', ')}; ` +
      `observed ${JSON.stringify(exercise)}`);
  }
}

export function runSimScenario(physics, sim, data) {
  verifySimCoverage(data);
  const round = sim.makeRound({
    blueprint: SIM_BLUEPRINT,
    bag: SIM_SHOT_LOG.map((shot) => shot.ammo),
    seed: 0x51a6c0de,
    mode: 'campaign'
  });
  // These two zero-HP triggers are explicit scenario inputs rather than
  // incidental outcomes of the long shot log. They guarantee that body spawning and
  // balloon detachment remain in every engine's replay path even if nearby rubble is
  // rebalanced later.
  round.blocks[SIM_SPLIT_BLOCK].hp = 0;
  round.balloons[0].hp = 0;
  const digests = [];
  const snapshots = [];
  const exercise = {
    blocksDestroyed: 0,
    pigsKilled: 0,
    explosionsTriggered: 0,
    tntCratesChained: 0,
    springLaunches: 0,
    gelAbsorptions: 0,
    sandbagsCrumbled: 0,
    largeStonesSplit: 0,
    balloonsPopped: 0,
    shotsLaunched: 0,
    tapsAttempted: [],
    abilitiesTriggered: [],
    frontWallHit: false,
    arcClearedFront: false,
    arcHitRear: false,
    tntSetOffByShot: false,
    occlusion: false,
    armourHits: {
      helm: { armoured: false, unarmoured: false },
      tusk: { armoured: false, unarmoured: false }
    }
  };
  const capture = () => {
    digests.push(sim.digestRound(round));
    snapshots.push(simSnapshot(round));
  };

  capture();
  for (let scenarioStep = 0; scenarioStep < SIM_DURATION_STEPS; scenarioStep++) {
    const loggedShot = SIM_SHOT_LOG.find((shot) => shot.step === scenarioStep);
    if (loggedShot) {
      const body = sim.launch(round, loggedShot.dx, loggedShot.dy);
      if (!body) throw new Error(`fixed shot ${exercise.shotsLaunched + 1} rejected at step ${scenarioStep}`);
      exercise.shotsLaunched++;
    }

    const loggedTap = SIM_SHOT_LOG.find((shot) => shot.tapStep === scenarioStep);
    if (loggedTap) {
      const triggered = sim.tap(round);
      const expected = Boolean(data.AMMO_BY_ID[loggedTap.ammo].ability);
      if (triggered !== expected) {
        throw new Error(`${loggedTap.ammo} tap at step ${scenarioStep} returned ${triggered}; ` +
          `expected ${expected}`);
      }
      exercise.tapsAttempted.push(loggedTap.ammo);
    }

    const flying = round.flying;
    const shotIndex = round.shots.length - 1;
    const hpBefore = new Map([
      ...round.blocks.map((body) => [body, body.hp]),
      ...round.pigs.map((body) => [body, body.hp])
    ]);
    const liveTnt = round.blocks.filter((body) => body.materialId === 'tnt' && !body.dead);
    const phaseBefore = round.phase;
    const events = sim.stepRound(round, data.TUNE.step);
    for (const event of events) {
      if (event.kind === 'ability') exercise.abilitiesTriggered.push(event.ability);
      if (event.kind === 'spring-launch') exercise.springLaunches++;
      if (event.kind === 'gel-absorb') exercise.gelAbsorptions++;
      if (event.kind === 'crumble') exercise.sandbagsCrumbled++;
      if (event.kind === 'stone-split') exercise.largeStonesSplit++;
      if (event.kind === 'balloon-pop') exercise.balloonsPopped++;
    }

    observeArmourHits(round, hpBefore, exercise.armourHits);
    const boomCount = events.filter((event) => event.kind === 'boom').length;
    exercise.explosionsTriggered += boomCount;
    if (boomCount) {
      exercise.tntCratesChained += liveTnt.filter((body) => body.dead).length;
    }
    for (const body of liveTnt) {
      if (!body.dead) continue;
      if (phaseBefore === 'flying' || phaseBefore === 'settling') {
        exercise.tntSetOffByShot = true;
      }
    }
    observeOcclusion(round, events, hpBefore, physics, exercise);

    if (flying) {
      if (shotIndex === 2 && flying.x >= 4 && flying.y > 4.1) {
        exercise.arcClearedFront = true;
      }
      for (const contact of round.world.contacts) {
        if (!contactHasBody(contact, flying)) continue;
        const other = contact.a === flying ? contact.b : contact.a;
        if (other.role === 'block' && SIM_FRONT_BLOCKS.includes(other.blueprintIndex)) {
          exercise.frontWallHit = true;
        }
        if (shotIndex === 2 && other.role === 'block' &&
            other.blueprintIndex >= SIM_REAR_BLOCK_START) {
          exercise.arcHitRear = true;
        }
      }
    }

    if (SIM_CHECKPOINT_STEPS.includes(scenarioStep + 1)) capture();
  }

  exercise.blocksDestroyed = round.blocks.filter((body) => body.dead).length;
  exercise.pigsKilled = round.pigs.filter((body) => body.dead).length;
  verifySimExercise(exercise);
  return { steps: SIM_CHECKPOINT_STEPS, digests, snapshots, exercise };
}

export function runScenarios(physics, sim, data) {
  return {
    physics: runScenario(physics),
    sim: runSimScenario(physics, sim, data)
  };
}

function formatError(error) {
  const lines = String(error?.message ?? error).split('\n')
    .map((line) => line.replace(/[╔╗╚╝═║]/g, '').trim())
    .filter(Boolean);
  return lines.find((line) => /missing|does not exist|doesn't exist|cannot find|unavailable/i.test(line)) ??
    lines[0] ?? 'unknown error';
}

function formatNumber(value) {
  if (Object.is(value, -0)) return '-0';
  if (!Number.isFinite(value)) return String(value);
  return value.toPrecision(17);
}

function printDigestTable(label, steps, results, skipped, errors) {
  console.log(`\n${label}`);
  const headers = ['engine', ...steps.map((step, i) =>
    i === steps.length - 1 ? `final ${step}` : `step ${step}`)];
  const rows = ENGINE_NAMES.map((engine) => {
    const completed = results.find((entry) => entry.engine === engine);
    if (completed) return [engine, ...completed.result[label].digests];
    const state = errors.some((entry) => entry.engine === engine) ? 'ERROR' :
      skipped.some((entry) => entry.engine === engine) ? 'SKIPPED' : 'MISSING';
    return [engine, ...steps.map(() => state)];
  });

  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => row[column].length)
  ));
  const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ');
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'));
  for (const row of rows) console.log(line(row));
}

function firstMismatch(label, steps, results) {
  if (results.length < 2) return null;
  const baseline = results[0];
  for (let checkpoint = 0; checkpoint < steps.length; checkpoint++) {
    for (let i = 1; i < results.length; i++) {
      if (baseline.result[label].digests[checkpoint] !==
          results[i].result[label].digests[checkpoint]) {
        return { baseline, other: results[i], checkpoint, label, steps };
      }
    }
  }
  return null;
}

function firstExerciseDifference(results) {
  if (results.length < 2) return null;
  const baseline = results[0];
  const fields = [
    'blocksDestroyed',
    'pigsKilled',
    'explosionsTriggered',
    'tntCratesChained',
    'springLaunches',
    'gelAbsorptions',
    'sandbagsCrumbled',
    'largeStonesSplit',
    'balloonsPopped'
  ];
  for (let i = 1; i < results.length; i++) {
    for (const field of fields) {
      const expected = baseline.result.sim.exercise[field];
      const actual = results[i].result.sim.exercise[field];
      if (expected !== actual) return { baseline, other: results[i], field, expected, actual };
    }
  }
  return null;
}

function firstBodyDifference(aBodies, bBodies, fields) {
  const count = Math.max(aBodies.length, bBodies.length);
  for (let i = 0; i < count; i++) {
    const a = aBodies[i];
    const b = bBodies[i];
    if (!a || !b || a.id !== b.id) return { a, b, field: null };
    if (a.role !== b.role) return { a, b, field: 'role' };
    if (a.dead !== b.dead) return { a, b, field: 'dead' };
    for (let field = 0; field < fields.length; field++) {
      if (a.bits[field] !== b.bits[field]) {
        return { a, b, field: fields[field] };
      }
    }
  }
  return null;
}

function reportMismatch(mismatch) {
  const { baseline, other, checkpoint, label, steps } = mismatch;
  const stepNumber = steps[checkpoint];
  console.error(
    `\nFAIL: ${label} differs between ${baseline.engine} and ${other.engine} at step ${stepNumber} ` +
    `(checkpoint ${checkpoint + 1}).`
  );

  const aSnapshot = baseline.result[label].snapshots[checkpoint];
  const bSnapshot = other.result[label].snapshots[checkpoint];
  const aBodies = label === 'physics' ? aSnapshot : aSnapshot.bodies;
  const bBodies = label === 'physics' ? bSnapshot : bSnapshot.bodies;
  const fields = label === 'physics' ? BODY_FIELDS : SIM_BODY_FIELDS;
  const difference = firstBodyDifference(aBodies, bBodies, fields);
  if (!difference) {
    if (label === 'sim') {
      if (aSnapshot.phase !== bSnapshot.phase) {
        console.error(`Bodies agree bit-for-bit; round phase is ${aSnapshot.phase} vs ${bSnapshot.phase}.`);
        return;
      }
      const scalar = aSnapshot.bits.findIndex((bits, index) => bits !== bSnapshot.bits[index]);
      if (scalar !== -1) {
        const names = [
          'seed', 'shotIndex', 'stepCount', 'time', 'settleTimer', 'score',
          'flyingId', 'pendingExplosions', 'nextBodyId'
        ];
        console.error(`Bodies agree bit-for-bit; first differing round field is ${names[scalar]}: ` +
          `${formatNumber(aSnapshot.values[scalar])} [${aSnapshot.bits[scalar]}] vs ` +
          `${formatNumber(bSnapshot.values[scalar])} [${bSnapshot.bits[scalar]}].`);
        return;
      }
    }
    console.error('Body and round values agree bit-for-bit; the digest implementation itself diverged.');
    return;
  }

  const { a, b, field } = difference;
  if (!a || !b || a.id !== b.id) {
    console.error(
      `First divergent body slot has ${baseline.engine} id ${a?.id ?? 'missing'} and ` +
      `${other.engine} id ${b?.id ?? 'missing'}.`
    );
    return;
  }

  const kind = a.role === 'pig' ? `pig ${a.tag}` : `${a.role ?? 'body'} ${a.tag ?? ''}`.trim();
  console.error(`First divergent ${kind}: id ${a.id}; first differing field: ${field}.`);
  if (field === 'dead' || field === 'role') {
    console.error(`${baseline.engine}: ${String(a[field])}; ${other.engine}: ${String(b[field])}.`);
    return;
  }
  console.error(`field | ${baseline.engine} value [bits] | ${other.engine} value [bits]`);
  console.error(`------+--------------------------+--------------------------`);
  for (let i = 0; i < fields.length; i++) {
    console.error(
      `${fields[i].padEnd(5)} | ${formatNumber(a.values[i])} [${a.bits[i]}] | ` +
      `${formatNumber(b.values[i])} [${b.bits[i]}]`
    );
  }
}

function contentType(pathname) {
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) {
    return 'text/javascript; charset=utf-8';
  }
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function startServer(root, createServer, readFile, resolve, sep) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/__determinism__.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end('<!doctype html><meta charset="utf-8"><title>determinism</title>');
      return;
    }

    let relative;
    try {
      relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    } catch {
      response.writeHead(400);
      response.end('bad path');
      return;
    }
    const filePath = resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }

    readFile(filePath).then((contents) => {
      response.writeHead(200, {
        'content-type': contentType(requestUrl.pathname),
        'cache-control': 'no-store'
      });
      response.end(contents);
    }, () => {
      response.writeHead(404);
      response.end('not found');
    });
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolveListen({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function runBrowsers(root, results, skipped, errors) {
  let playwright;
  try {
    playwright = await import('@playwright/test');
  } catch (error) {
    const reason = `@playwright/test unavailable: ${formatError(error)}`;
    for (const engine of ENGINE_NAMES.slice(1)) skipped.push({ engine, reason });
    return;
  }

  const [{ createServer }, { readFile }, { resolve, sep }] = await Promise.all([
    import('node:http'),
    import('node:fs/promises'),
    import('node:path')
  ]);
  const { server, origin } = await startServer(root, createServer, readFile, resolve, sep);

  try {
    for (const [engine, browserType] of [
      ['Chromium', playwright.chromium],
      ['Firefox', playwright.firefox],
      ['WebKit', playwright.webkit]
    ]) {
      let browser;
      try {
        browser = await browserType.launch({ headless: true });
      } catch (error) {
        skipped.push({ engine, reason: `browser unavailable: ${formatError(error)}` });
        continue;
      }

      try {
        const page = await browser.newPage();
        await page.goto(`${origin}/__determinism__.html`, { waitUntil: 'load' });
        const result = await page.evaluate(async () => {
          const [physics, sim, data, harness] = await Promise.all([
            import('/physics.js?v=20260904-2'),
            import('/sim.js?v=20260904-2'),
            import('/data.js?v=20260904-2'),
            import('/tools/determinism-test.mjs?v=20260904-2')
          ]);
          return harness.runScenarios(physics, sim, data);
        });
        results.push({ engine, result });
      } catch (error) {
        errors.push({ engine, reason: formatError(error) });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await closeServer(server);
  }
}

async function main() {
  const [{ dirname, resolve }, { fileURLToPath }] = await Promise.all([
    import('node:path'),
    import('node:url')
  ]);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [physics, sim, data] = await Promise.all([
    import('../physics.js?v=20260904-2'),
    import('../sim.js?v=20260904-2'),
    import('../data.js?v=20260904-2')
  ]);
  const results = [{ engine: 'Node', result: runScenarios(physics, sim, data) }];
  const skipped = [];
  const errors = [];

  if (process.env.SKIP_BROWSERS === '1') {
    for (const engine of ENGINE_NAMES.slice(1)) {
      skipped.push({ engine, reason: 'SKIP_BROWSERS=1' });
    }
  } else {
    await runBrowsers(root, results, skipped, errors);
  }

  printDigestTable('physics', CHECKPOINT_STEPS, results, skipped, errors);
  printDigestTable('sim', SIM_CHECKPOINT_STEPS, results, skipped, errors);
  const exercise = results[0].result.sim.exercise;
  console.log('\nsim exercise');
  console.log(`blocks destroyed: ${exercise.blocksDestroyed}`);
  console.log(`pigs killed: ${exercise.pigsKilled}`);
  console.log(`explosions triggered: ${exercise.explosionsTriggered}`);
  console.log(`TNT crates chained: ${exercise.tntCratesChained}`);
  console.log(`spring launches: ${exercise.springLaunches}`);
  console.log(`gel absorptions: ${exercise.gelAbsorptions}`);
  console.log(`sandbags crumbled: ${exercise.sandbagsCrumbled}`);
  console.log(`large stones split: ${exercise.largeStonesSplit}`);
  console.log(`balloons popped: ${exercise.balloonsPopped}`);
  for (const { engine, reason } of skipped) console.warn(`SKIPPED ${engine}: ${reason}`);
  for (const { engine, reason } of errors) console.error(`FAILED ${engine}: ${reason}`);

  const mismatch = firstMismatch('physics', CHECKPOINT_STEPS, results) ??
    firstMismatch('sim', SIM_CHECKPOINT_STEPS, results);
  if (mismatch) reportMismatch(mismatch);
  const exerciseDifference = firstExerciseDifference(results);
  if (exerciseDifference) {
    console.error(`\nFAIL: sim exercise count '${exerciseDifference.field}' differs between ` +
      `${exerciseDifference.baseline.engine} (${exerciseDifference.expected}) and ` +
      `${exerciseDifference.other.engine} (${exerciseDifference.actual}).`);
  }

  if (process.env.SKIP_BROWSERS === '1') {
    console.warn('\nWARNING: browser comparison skipped by SKIP_BROWSERS=1; Node-only run passed.');
    return;
  }
  if (mismatch || exerciseDifference || skipped.length || errors.length) process.exitCode = 1;
  else console.log('\nAll four engines agree at all seven checkpoints.');
}

const runningInNode = typeof process !== 'undefined' && process.versions?.node;
if (runningInNode) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main().catch((error) => {
      console.error(`determinism test failed: ${error.stack ?? error}`);
      process.exitCode = 1;
    });
  }
}
