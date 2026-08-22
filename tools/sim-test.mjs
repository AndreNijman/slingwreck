#!/usr/bin/env node

import { AMMO_BY_ID, MATERIALS, TUNE } from '../data.js';
import { addBody } from '../physics.js';
import {
  digestRound,
  launch,
  makeRound,
  stepRound,
  tap
} from '../sim.js';

let failures = 0;

function report(name, passed, measurement) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${measurement}`);
  if (!passed) failures++;
}

function roundWith(blueprint, bag = ['nib'], seed = 1, mode = 'campaign') {
  return makeRound({ blueprint, bag, seed, mode });
}

function speed(body) {
  return Math.sqrt(body.vx * body.vx + body.vy * body.vy);
}

function launchSpeedGate() {
  const blueprint = { v: 1, blocks: [], pigs: [['runt', 60, 0.3]] };
  const fullRound = roundWith(blueprint);
  const halfRound = roundWith(blueprint);
  const full = launch(fullRound, -TUNE.slingRadius, 0);
  const half = launch(halfRound, -TUNE.slingRadius / 2, 0);
  const fullSpeed = speed(full);
  const halfSpeed = speed(half);
  const fullError = Math.abs(fullSpeed - TUNE.launchSpeedMax) / TUNE.launchSpeedMax;
  const halfTarget = TUNE.launchSpeedMax / 2;
  const halfError = Math.abs(halfSpeed - halfTarget) / halfTarget;
  report('launch speed', fullError <= 0.01 && halfError <= 0.01,
    `full ${fullSpeed.toFixed(5)} vs ${TUNE.launchSpeedMax.toFixed(5)} ` +
    `(${(fullError * 100).toFixed(3)}%); half ${halfSpeed.toFixed(5)} vs ` +
    `${halfTarget.toFixed(5)} (${(halfError * 100).toFixed(3)}%)`);
}

function trajectoryGate() {
  // Two halves, because "can the sling reach the fortress" is only half the question
  // and the other half is whether there is any headroom left. A tuning that lands a
  // full-power 45-degree shot exactly on the far edge passes a reach test and is still
  // wrong: the player would have no margin and every long shot would be a max-power
  // shot. So: a partial draw must land inside the plot, and a full draw must overshoot
  // it. This is deliberately stricter than the single landing check it replaces.
  const at = (fraction) => {
    const component = TUNE.slingRadius * fraction / Math.sqrt(2);
    const round = roundWith({ v: 1, blocks: [], pigs: [['runt', 60, 0.3]] });
    const body = launch(round, -component, -component);
    let landingX = Infinity;
    let landingStep = -1;
    let furthestX = -Infinity;
    for (let index = 0; index < 400; index++) {
      stepRound(round, TUNE.step);
      if (body.dead) break;
      furthestX = Math.max(furthestX, body.x);
      const touchedGround = round.world.contacts.some((contact) =>
        contact.a === body && contact.b.role === 'ground' ||
        contact.b === body && contact.a.role === 'ground');
      if (touchedGround) {
        landingX = body.x;
        landingStep = round.stepCount;
        break;
      }
    }
    return { landingX, landingStep, furthestX };
  };

  const partial = at(0.8);
  const full = at(1);
  const lands = partial.landingStep > 0 && partial.landingX >= 0 && partial.landingX <= TUNE.plotW;
  const headroom = full.furthestX > TUNE.plotW;
  report('45-degree reach', lands && headroom,
    `80% draw lands at x ${partial.landingX.toFixed(3)} in [0, ${TUNE.plotW}]; ` +
    `full draw carries to ${full.furthestX.toFixed(3)} > ${TUNE.plotW}`);
}

function damageTrial(projectileSpeed) {
  const round = roundWith({
    v: 1,
    blocks: [['cube', 'glass', 0, 2, 0]],
    pigs: [['runt', 20, 2]]
  });
  round.world.gravity = 0;
  round.world.lastGravity = 0;
  const block = round.blocks[0];
  addBody(round.world, {
    shape: { id: 'damage-probe', kind: 'circle', r: 0.25, area: 1 },
    mat: { id: 'damage-probe', density: 1, hp: 1, friction: 0, restitution: 0 },
    x: -2,
    y: 2,
    vx: projectileSpeed
  });
  let maxImpulse = 0;
  for (let index = 0; index < 180 && !block.dead; index++) {
    stepRound(round, TUNE.step);
    for (const contact of round.world.contacts) {
      if (contact.a === block || contact.b === block) {
        maxImpulse = Math.max(maxImpulse, contact.pn);
      }
    }
  }
  return { block, maxImpulse };
}

function damageThresholdGate() {
  const below = damageTrial(2);
  const above = damageTrial(20);
  const threshold = MATERIALS.glass.thresh;
  const passed = below.maxImpulse < threshold && !below.block.dead &&
    above.maxImpulse > threshold && above.block.dead;
  report('glass damage threshold', passed,
    `below ${below.maxImpulse.toFixed(5)} < ${threshold.toFixed(5)} survived; ` +
    `above ${above.maxImpulse.toFixed(5)} > ${threshold.toFixed(5)} dead ${above.block.dead}`);
}

function restingDamageGate() {
  const blocks = [];
  for (let index = 0; index < 10; index++) {
    blocks.push(['cube', 'wood', 4, index + 0.5, 0]);
  }
  const round = roundWith({ v: 1, blocks, pigs: [['runt', 15, 0.3]] });
  let hitEvents = 0;
  for (let index = 0; index < 300; index++) {
    hitEvents += stepRound(round, TUNE.step).filter((event) => event.kind === 'hit').length;
  }
  let maxHpLost = 0;
  for (const block of round.blocks) {
    maxHpLost = Math.max(maxHpLost, block.maxHp - block.hp);
  }
  const dead = round.blocks.filter((block) => block.dead).length;
  report('resting tower damage', maxHpLost === 0 && dead === 0 && hitEvents === 0,
    `300 steps; max HP lost ${maxHpLost.toFixed(8)}; dead ${dead}; hit events ${hitEvents}`);
}

function tntChainGate() {
  const blocks = [];
  for (let index = 0; index < 5; index++) {
    blocks.push(['cube', 'tnt', 2 + index * 2.5, 0.5, 0]);
  }
  const round = roundWith({ v: 1, blocks, pigs: [['runt', 20, 0.3]] });
  round.blocks[0].hp = 0;
  const deathSteps = [];
  let booms = 0;
  for (let index = 0; index < 12; index++) {
    const events = stepRound(round, TUNE.step);
    for (const event of events) {
      if (event.kind === 'shatter') deathSteps.push(round.stepCount);
      if (event.kind === 'boom') booms++;
    }
  }
  const dead = round.blocks.filter((block) => block.dead).length;
  const distinctDeathSteps = new Set(deathSteps).size;
  report('five-TNT queued chain', dead === 5 && booms === 5 && distinctDeathSteps === 5,
    `dead ${dead}/5; booms ${booms}; death steps ${deathSteps.join(', ')}`);
}

function blastTrial(withWall) {
  const blocks = [['cube', 'tnt', 2, 0.5, 0]];
  if (withWall) blocks.push(['cube', 'stone', 3.2, 0.5, 0]);
  blocks.push(['cube', 'glass', 4.4, 0.5, 0]);
  const round = roundWith({ v: 1, blocks, pigs: [['runt', 20, 0.3]] });
  const target = round.blocks[round.blocks.length - 1];
  round.blocks[0].hp = 0;
  stepRound(round, TUNE.step);
  stepRound(round, TUNE.step);
  return target.maxHp - target.hp;
}

function occlusionGate() {
  const clearDamage = blastTrial(false);
  const shieldedDamage = blastTrial(true);
  report('explosion occlusion', clearDamage > 0 && shieldedDamage < clearDamage,
    `clear damage ${clearDamage.toFixed(5)}; behind stone ${shieldedDamage.toFixed(5)}`);
}

function armourTrial(pigId, direction, withArmour) {
  const round = roundWith({ v: 1, blocks: [], pigs: [[pigId, 0, 5]] });
  round.world.gravity = 0;
  round.world.lastGravity = 0;
  const pig = round.pigs[0];
  if (!withArmour) pig.pig = { ...pig.pig, traits: {} };
  const velocity = 8;
  const fromAbove = direction === 'above';
  const fromSling = direction === 'sling';
  addBody(round.world, {
    shape: { id: 'armour-probe', kind: 'circle', r: 0.25, area: 1 },
    mat: { id: 'armour-probe', density: 1, hp: 1, friction: 0, restitution: 0 },
    x: fromAbove ? 0 : fromSling ? -2 : 2,
    y: fromAbove ? 7 : 5,
    vx: fromAbove ? 0 : fromSling ? velocity : -velocity,
    vy: fromAbove ? -velocity : 0
  });
  for (let index = 0; index < 60 && pig.hp === pig.maxHp; index++) {
    stepRound(round, TUNE.step);
  }
  return pig.maxHp - pig.hp;
}

function helmArmourGate() {
  const armouredWith = armourTrial('helm', 'above', true);
  const armouredWithout = armourTrial('helm', 'above', false);
  const sideWith = armourTrial('helm', 'side', true);
  const sideWithout = armourTrial('helm', 'side', false);
  const passed = armouredWith > 0 && armouredWith < armouredWithout * 0.45 &&
    sideWith > 0 && Math.abs(sideWith - sideWithout) < 1e-12;
  report('helmet armour from both sides', passed,
    `above with ${armouredWith.toFixed(5)} vs without ${armouredWithout.toFixed(5)}; ` +
    `side with ${sideWith.toFixed(5)} vs without ${sideWithout.toFixed(5)}`);
}

function tuskArmourGate() {
  const armouredWith = armourTrial('tusk', 'sling', true);
  const armouredWithout = armourTrial('tusk', 'sling', false);
  const behindWith = armourTrial('tusk', 'behind', true);
  const behindWithout = armourTrial('tusk', 'behind', false);
  const passed = armouredWith > 0 && armouredWith < armouredWithout * 0.45 &&
    behindWith > 0 && Math.abs(behindWith - behindWithout) < 1e-12;
  report('tusker armour from both sides', passed,
    `sling side with ${armouredWith.toFixed(5)} vs without ${armouredWithout.toFixed(5)}; ` +
    `behind with ${behindWith.toFixed(5)} vs without ${behindWithout.toFixed(5)}`);
}

function zeppelinTrial(popBalloon) {
  const round = roundWith({
    v: 1,
    blocks: [],
    pigs: [['zep', 0, 4], ['runt', 20, 0.3]]
  });
  const pig = round.pigs[0];
  if (popBalloon) round.balloons[0].hp = 0;
  let popEvent = false;
  for (let index = 0; index < 75; index++) {
    const events = stepRound(round, TUNE.step);
    popEvent ||= events.some((event) => event.kind === 'balloon-pop');
  }
  return { pig, popEvent, balloonCount: round.balloons.length };
}

function zeppelinGate() {
  const hovering = zeppelinTrial(false);
  const popped = zeppelinTrial(true);
  const passed = hovering.balloonCount === 1 &&
    Math.abs(hovering.pig.x - 1.5) < 1e-10 && Math.abs(hovering.pig.y - 4) < 1e-10 &&
    popped.popEvent && popped.pig.dead && popped.pig.y < hovering.pig.y - 2;
  report('zeppelin balloon hover and fall', passed,
    `live height ${hovering.pig.y.toFixed(5)} vs popped ${popped.pig.y.toFixed(5)}; ` +
    `live drift ${hovering.pig.x.toFixed(5)} vs popped ${popped.pig.x.toFixed(5)}`);
}

function sargeTrial(mode) {
  const round = roundWith({
    v: 1,
    blocks: [
      ['cube', 'wood', 1, 0.5, 0],
      ['cube', 'wood', 3, 0.5, 0]
    ],
    pigs: [['sarge', 2, 0.46]]
  }, ['nib'], 44, mode);
  for (const block of round.blocks) block.hp -= 10;
  let repairEvents = 0;
  for (let index = 0; index < 360; index++) {
    repairEvents += stepRound(round, TUNE.step)
      .filter((event) => event.kind === 'repair').length;
  }
  return {
    firstRestored: round.blocks[0].hp - (round.blocks[0].maxHp - 10),
    secondRestored: round.blocks[1].hp - (round.blocks[1].maxHp - 10),
    repairEvents
  };
}

function occupiedSargeTrial() {
  const round = roundWith({
    v: 1,
    blocks: [
      ['cube', 'wood', 1, 0.5, 0],
      ['cube', 'wood', 3, 0.5, 0]
    ],
    pigs: [['sarge', 2, 0.46]]
  }, ['nib'], 45, 'siege');
  const blocked = round.blocks[0];
  const fallback = round.blocks[1];
  blocked.hp = 0;
  fallback.hp -= 10;
  stepRound(round, TUNE.step);
  const occupant = addBody(round.world, {
    shape: 'cube', mat: 'wood', x: blocked.x, y: blocked.y,
    isStatic: true, filterTag: 'repair-occupant'
  });
  occupant.role = 'debris';
  for (let index = 1; index < 360; index++) stepRound(round, TUNE.step);
  return {
    blockedDead: blocked.dead,
    fallbackRestored: fallback.hp - (fallback.maxHp - 10)
  };
}

function clearSargeResurrectionTrial() {
  const round = roundWith({
    v: 1,
    blocks: [['cube', 'wood', 1, 0.5, 0]],
    pigs: [['sarge', 2, 0.46]]
  }, ['nib'], 46, 'siege');
  const originalId = round.blocks[0].id;
  round.blocks[0].hp = 0;
  for (let index = 0; index < 360; index++) stepRound(round, TUNE.step);
  return {
    alive: !round.blocks[0].dead,
    restored: round.blocks[0].hp,
    newId: round.blocks[0].id !== originalId
  };
}

function sargeRepairGate() {
  const siege = sargeTrial('siege');
  const campaign = sargeTrial('campaign');
  const occupied = occupiedSargeTrial();
  const clear = clearSargeResurrectionTrial();
  const expected = MATERIALS.wood.hp * 0.25;
  const passed = Math.abs(siege.firstRestored - expected) < 1e-10 &&
    siege.secondRestored === 0 && siege.repairEvents === 1 &&
    campaign.firstRestored === 0 && campaign.secondRestored === 0 &&
    campaign.repairEvents === 0 && occupied.blockedDead &&
    Math.abs(occupied.fallbackRestored - expected) < 1e-10 && clear.alive && clear.newId &&
    Math.abs(clear.restored - expected) < 1e-10;
  report('sarge siege-only deterministic repair', passed,
    `siege restored ${siege.firstRestored.toFixed(5)} vs campaign ` +
    `${campaign.firstRestored.toFixed(5)}; tied second block ${siege.secondRestored.toFixed(5)}; ` +
    `occupied dead space ${occupied.blockedDead ? 'skipped' : 'resurrected'}; ` +
    `clear dead space restored ${clear.restored.toFixed(5)}`);
}

function springTrial(withBehaviour) {
  const round = roundWith({ v: 1, blocks: [], pigs: [['runt', 20, 10]] });
  round.world.gravity = 0;
  round.world.lastGravity = 0;
  const spring = addBody(round.world, {
    shape: 'cube',
    mat: 'spring',
    x: 0,
    y: 3,
    isStatic: true,
    filterTag: 'spring'
  });
  spring.role = 'block';
  spring.materialId = 'spring';
  if (!withBehaviour) {
    spring.mat = { ...spring.mat };
    delete spring.mat.ammoRestitution;
  }
  const ammo = addBody(round.world, {
    shape: { id: 'spring-probe', kind: 'circle', r: 0.25, area: 0.19634954084936207 },
    mat: {
      id: 'ammo:probe', density: 5.092958178940651, hp: 1,
      friction: 0, restitution: 0.16
    },
    x: -1.25,
    y: 3,
    vx: 8,
    filterTag: 'ammo:probe'
  });
  ammo.role = 'ammo';
  let event = false;
  let rebound = 0;
  for (let index = 0; index < 30; index++) {
    const events = stepRound(round, TUNE.step);
    event ||= events.some((candidate) => candidate.kind === 'spring-launch');
    if (ammo.vx < 0) {
      rebound = -ammo.vx;
      break;
    }
  }
  return { rebound, event };
}

function springGate() {
  const withBehaviour = springTrial(true);
  const withoutBehaviour = springTrial(false);
  report('spring critter restitution', withBehaviour.rebound > withoutBehaviour.rebound * 3 &&
    withBehaviour.event && !withoutBehaviour.event,
    `with ${withBehaviour.rebound.toFixed(5)} vs without ` +
    `${withoutBehaviour.rebound.toFixed(5)} rebound speed`);
}

function gelTrial(withBehaviour) {
  const round = roundWith({ v: 1, blocks: [], pigs: [['runt', 20, 10]] });
  round.world.gravity = 0;
  round.world.lastGravity = 0;
  const gel = addBody(round.world, {
    shape: 'cube', mat: 'gel', x: 0, y: 3, filterTag: 'gel'
  });
  gel.role = 'block';
  gel.materialId = 'gel';
  if (!withBehaviour) {
    gel.mat = { ...gel.mat };
    delete gel.mat.absorb;
  }
  const target = addBody(round.world, {
    shape: 'cube', mat: 'glass', x: 1, y: 3, isStatic: true, filterTag: 'glass'
  });
  target.role = 'block';
  target.materialId = 'glass';
  addBody(round.world, {
    shape: { id: 'gel-probe', kind: 'circle', r: 0.3, area: 0.2827433388230814 },
    mat: {
      id: 'gel-probe', density: 5.659010251, hp: 1,
      friction: 0, restitution: 0.03
    },
    x: -1.4,
    y: 3,
    vx: 6
  });
  for (let index = 0; index < 30 && target.hp === target.maxHp; index++) {
    stepRound(round, TUNE.step);
  }
  return {
    targetDamage: target.maxHp - target.hp,
    gelDamage: gel.maxHp - gel.hp
  };
}

function gelGate() {
  const withBehaviour = gelTrial(true);
  const withoutBehaviour = gelTrial(false);
  const ratio = withBehaviour.targetDamage / withoutBehaviour.targetDamage;
  const passed = withBehaviour.targetDamage > 0 && withoutBehaviour.targetDamage > 0 &&
    Math.abs(ratio - 0.3) < 1e-10 &&
    Math.abs(withBehaviour.gelDamage - withoutBehaviour.gelDamage) < 1e-10;
  report('gel far-side absorption', passed,
    `far-side damage with ${withBehaviour.targetDamage.toFixed(5)} vs without ` +
    `${withoutBehaviour.targetDamage.toFixed(5)}; gel own damage ` +
    `${withBehaviour.gelDamage.toFixed(5)} vs ${withoutBehaviour.gelDamage.toFixed(5)}`);
}

function sandTrial(withBehaviour) {
  const round = roundWith({
    v: 1,
    blocks: [['cube', 'sand', 2, 2, 0]],
    pigs: [['runt', 20, 10]]
  });
  const original = round.blocks[0];
  const originalMass = 1 / original.im;
  if (!withBehaviour) {
    original.mat = { ...original.mat };
    delete original.mat.chunks;
  }
  original.hp = 0;
  const events = stepRound(round, TUNE.step);
  const pieces = round.debris.filter((body) => body.parentId === original.id);
  const mass = pieces.reduce((sum, body) => sum + 1 / body.im, 0);
  return {
    count: pieces.length,
    mass,
    originalMass,
    event: events.some((candidate) => candidate.kind === 'crumble')
  };
}

function sandGate() {
  const withBehaviour = sandTrial(true);
  const withoutBehaviour = sandTrial(false);
  const passed = withBehaviour.count === MATERIALS.sand.chunks &&
    withoutBehaviour.count === 0 && withBehaviour.event && !withoutBehaviour.event &&
    Math.abs(withBehaviour.mass - withBehaviour.originalMass) < 1e-12;
  report('sand deterministic chunks', passed,
    `with ${withBehaviour.count} bodies/${withBehaviour.mass.toFixed(5)} mass vs without ` +
    `${withoutBehaviour.count}/${withoutBehaviour.mass.toFixed(5)}`);
}

function stoneTrial(withBehaviour) {
  const round = roundWith({
    v: 1,
    blocks: [['plank', 'stone', 3, 3, 0]],
    pigs: [['runt', 20, 10]]
  });
  const original = round.blocks[0];
  const originalMass = 1 / original.im;
  if (!withBehaviour) original.materialId = 'stone-control';
  original.hp = 0;
  stepRound(round, TUNE.step);
  const pieces = round.debris.filter((body) => body.parentId === original.id);
  const mass = pieces.reduce((sum, body) => sum + 1 / body.im, 0);
  return { count: pieces.length, mass, originalMass, pieces };
}

function stoneSplitGate() {
  const withBehaviour = stoneTrial(true);
  const withoutBehaviour = stoneTrial(false);
  const passed = withBehaviour.count === 2 && withoutBehaviour.count === 0 &&
    Math.abs(withBehaviour.mass - withBehaviour.originalMass) < 1e-12 &&
    withBehaviour.pieces[0].shape.w === 2 && withBehaviour.pieces[0].shape.h === 0.5;
  report('large stone long-axis split', passed,
    `with ${withBehaviour.count} halves/${withBehaviour.mass.toFixed(5)} mass vs without ` +
    `${withoutBehaviour.count}/${withoutBehaviour.mass.toFixed(5)}`);
}

const ABILITY_BLUEPRINT = { v: 1, blocks: [], pigs: [['runt', 20, 10]] };

function abilityPair(ammoId, blueprint = ABILITY_BLUEPRINT, dx = -TUNE.slingRadius, dy = 0) {
  const tapped = roundWith(blueprint, [ammoId], 12345);
  const untapped = roundWith(blueprint, [ammoId], 12345);
  tapped.world.gravity = 0;
  tapped.world.lastGravity = 0;
  untapped.world.gravity = 0;
  untapped.world.lastGravity = 0;
  return {
    tapped,
    untapped,
    tappedBody: launch(tapped, dx, dy),
    untappedBody: launch(untapped, dx, dy)
  };
}

function hasAbilityEvent(round, ability) {
  return round.queuedEvents.some((event) =>
    event.kind === 'ability' && event.ability === ability);
}

function splitAbilityGate() {
  const trial = abilityPair('chip');
  const parentSpeed = speed(trial.tappedBody);
  const firstTap = tap(trial.tapped);
  const secondTap = tap(trial.tapped);
  const fragments = trial.tapped.world.bodies.filter((body) => body.role === 'ammo');
  const control = trial.untapped.world.bodies.filter((body) => body.role === 'ammo');
  const expected = AMMO_BY_ID.chip;
  const expectedRadius = expected.radius / Math.sqrt(expected.params.count);
  const speedError = Math.max(...fragments.map((body) => Math.abs(speed(body) - parentSpeed)));
  const massError = Math.max(...fragments.map((body) =>
    Math.abs(1 / body.im - expected.mass / expected.params.count)));
  const radiusError = Math.max(...fragments.map((body) => Math.abs(body.r - expectedRadius)));
  const passed = firstTap && !secondTap && fragments.length === 3 && control.length === 1 &&
    trial.tappedBody.dead && !trial.tapped.world.bodies.includes(trial.tappedBody) &&
    speedError < 1e-12 && massError < 1e-12 && radiusError < 1e-12 &&
    hasAbilityEvent(trial.tapped, 'split');
  report('ability split', passed,
    `tapped ${fragments.length} bodies vs untapped ${control.length}; ` +
    `max speed error ${speedError.toExponential(3)}`);
}

function accelAbilityGate() {
  const trial = abilityPair('wedge');
  const untappedSpeed = speed(trial.untappedBody);
  const firstTap = tap(trial.tapped);
  const secondTap = tap(trial.tapped);
  const tappedSpeed = speed(trial.tappedBody);
  const multiplier = AMMO_BY_ID.wedge.params.speedMultiplier;
  const passed = firstTap && !secondTap &&
    Math.abs(tappedSpeed - untappedSpeed * multiplier) < 1e-12 &&
    hasAbilityEvent(trial.tapped, 'accel');
  report('ability accel', passed,
    `tapped speed ${tappedSpeed.toFixed(5)} vs untapped ${untappedSpeed.toFixed(5)}`);
}

function boomAbilityGate() {
  const blueprint = {
    v: 1,
    blocks: [['cube', 'glass', TUNE.slingX + 3, TUNE.slingY, 0]],
    pigs: [['runt', 20, 10]]
  };
  const trial = abilityPair('lob', blueprint);
  const firstTap = tap(trial.tapped);
  const secondTap = tap(trial.tapped);
  stepRound(trial.tapped, TUNE.step);
  stepRound(trial.untapped, TUNE.step);
  const tappedDamage = trial.tapped.blocks[0].maxHp - trial.tapped.blocks[0].hp;
  const untappedDamage = trial.untapped.blocks[0].maxHp - trial.untapped.blocks[0].hp;
  const boomEvent = trial.tapped.events.some((event) => event.kind === 'boom');
  const abilityEvent = trial.tapped.events.some((event) =>
    event.kind === 'ability' && event.ability === 'boom');
  report('ability boom', firstTap && !secondTap && tappedDamage > untappedDamage &&
    boomEvent && abilityEvent,
    `tapped damage ${tappedDamage.toFixed(5)} vs untapped ${untappedDamage.toFixed(5)}`);
}

function dropAbilityGate() {
  const trial = abilityPair('pebble');
  const initialVy = trial.tappedBody.vy;
  const firstTap = tap(trial.tapped);
  const secondTap = tap(trial.tapped);
  const payload = trial.tapped.world.bodies.find((body) => body.role === 'payload');
  const tappedBodies = [trial.tappedBody, payload];
  const tappedSpread = Math.max(...tappedBodies.map((body) => body.vy)) -
    Math.min(...tappedBodies.map((body) => body.vy));
  const untappedSpread = 0;
  const params = AMMO_BY_ID.pebble.params;
  const passed = firstTap && !secondTap && payload &&
    Math.abs(payload.vy - (initialVy - params.payloadSpeed)) < 1e-12 &&
    Math.abs(trial.tappedBody.vy - (initialVy + params.recoilSpeed)) < 1e-12 &&
    Math.abs(1 / payload.im - params.payloadMass) < 1e-12 &&
    Math.abs(payload.r - params.payloadRadius) < 1e-12 &&
    hasAbilityEvent(trial.tapped, 'drop');
  report('ability drop', passed,
    `tapped vertical spread ${tappedSpread.toFixed(5)} vs untapped ${untappedSpread.toFixed(5)}`);
}

function reverseAbilityGate() {
  const trial = abilityPair('boomer', ABILITY_BLUEPRINT, -TUNE.slingRadius, -0.4);
  const beforeVy = trial.tappedBody.vy;
  const firstTap = tap(trial.tapped);
  const secondTap = tap(trial.tapped);
  const passed = firstTap && !secondTap &&
    trial.tappedBody.vx === -trial.untappedBody.vx && trial.tappedBody.vy === beforeVy &&
    hasAbilityEvent(trial.tapped, 'reverse');
  report('ability reverse', passed,
    `tapped vx ${trial.tappedBody.vx.toFixed(5)} vs untapped ${trial.untappedBody.vx.toFixed(5)}`);
}

function inflateAbilityGate() {
  const blueprint = {
    v: 1,
    blocks: [['cube', 'wood', TUNE.slingX + 0.9, TUNE.slingY, 0]],
    pigs: [['runt', 20, 10]]
  };
  const trial = abilityPair('hulk', blueprint, 0, 0);
  const firstTap = tap(trial.tapped);
  const secondTap = tap(trial.tapped);
  const abilityEvent = hasAbilityEvent(trial.tapped, 'inflate');
  const steps = Math.ceil(AMMO_BY_ID.hulk.params.inflateSeconds / TUNE.step);
  for (let index = 0; index < steps; index++) {
    stepRound(trial.tapped, TUNE.step);
    stepRound(trial.untapped, TUNE.step);
  }
  const tappedRadius = trial.tappedBody.r;
  const untappedRadius = trial.untappedBody.r;
  const pushed = trial.tapped.blocks[0].x - trial.untapped.blocks[0].x;
  const massRatio = (1 / trial.tappedBody.im) / AMMO_BY_ID.hulk.mass;
  const passed = firstTap && !secondTap &&
    Math.abs(tappedRadius - AMMO_BY_ID.hulk.params.inflatedRadius) < 1e-12 &&
    untappedRadius === AMMO_BY_ID.hulk.radius && Math.abs(massRatio - 4) < 1e-12 &&
    pushed > 0 && abilityEvent;
  report('ability inflate', passed,
    `tapped radius ${tappedRadius.toFixed(5)} vs untapped ${untappedRadius.toFixed(5)}; ` +
    `neighbour pushed ${pushed.toFixed(5)}`);
}

function hardenGlassTrial(useTap) {
  const round = roundWith({
    v: 1,
    blocks: [['cube', 'glass', TUNE.slingX + 3, TUNE.slingY, 0]],
    pigs: [['runt', 20, 10]]
  }, ['spike'], 2468);
  round.world.gravity = 0;
  round.world.lastGravity = 0;
  const body = launch(round, -TUNE.slingRadius, 0);
  const firstTap = useTap ? tap(round) : false;
  const secondTap = useTap ? tap(round) : false;
  let abilityEvent = false;
  for (let index = 0; index < 18; index++) {
    const events = stepRound(round, TUNE.step);
    abilityEvent ||= events.some((event) => event.kind === 'ability' && event.ability === 'harden');
  }
  return {
    x: body.x,
    speed: speed(body),
    damage: round.blocks[0].maxHp - round.blocks[0].hp,
    firstTap,
    secondTap,
    abilityEvent
  };
}

function hardenStoneTrial(useTap) {
  const round = roundWith({
    v: 1,
    blocks: [['cube', 'stone', TUNE.slingX + 3, TUNE.slingY, 0]],
    pigs: [['runt', 20, 10]]
  }, ['spike'], 9753);
  round.world.gravity = 0;
  round.world.lastGravity = 0;
  launch(round, -TUNE.slingRadius, 0);
  if (useTap) tap(round);
  const block = round.blocks[0];
  for (let index = 0; index < 20 && block.hp === block.maxHp; index++) {
    stepRound(round, TUNE.step);
  }
  return block.maxHp - block.hp;
}

function hardenAbilityGate() {
  const tappedGlass = hardenGlassTrial(true);
  const untappedGlass = hardenGlassTrial(false);
  const tappedStone = hardenStoneTrial(true);
  const untappedStone = hardenStoneTrial(false);
  const passed = tappedGlass.firstTap && !tappedGlass.secondTap && tappedGlass.abilityEvent &&
    tappedGlass.damage > 0 && tappedGlass.x > untappedGlass.x &&
    tappedGlass.speed > untappedGlass.speed && untappedStone > 0 &&
    tappedStone > untappedStone * 1.7;
  report('ability harden', passed,
    `glass x tapped ${tappedGlass.x.toFixed(5)} vs untapped ${untappedGlass.x.toFixed(5)}; ` +
    `stone damage tapped ${tappedStone.toFixed(5)} vs untapped ${untappedStone.toFixed(5)}`);
}

function blinkAbilityGate() {
  const wallX = TUNE.slingX + 2.5;
  const trial = abilityPair('zip', {
    v: 1,
    blocks: [['cube', 'stone', wallX, TUNE.slingY, 0]],
    pigs: [['runt', 20, 10]]
  });
  const firstTap = tap(trial.tapped);
  const secondTap = tap(trial.tapped);
  const safe = trial.tappedBody.x + trial.tappedBody.r <= wallX - 0.5 + 1e-12;
  const passed = firstTap && !secondTap && trial.tappedBody.x > trial.untappedBody.x && safe &&
    speed(trial.tappedBody) === speed(trial.untappedBody) &&
    hasAbilityEvent(trial.tapped, 'blink');
  report('ability blink', passed,
    `tapped x ${trial.tappedBody.x.toFixed(5)} vs untapped ${trial.untappedBody.x.toFixed(5)}; ` +
    `wall near face ${(wallX - 0.5).toFixed(5)}`);
}

function runToEnd(round, limit = 600) {
  for (let index = 0; index < limit && round.phase !== 'won' && round.phase !== 'lost'; index++) {
    stepRound(round, TUNE.step);
  }
}

function roundEndGate() {
  // A flat full-power shot leaves the pouch at y = TUNE.slingY and reaches the ground
  // about 13 world units downrange, so the reachable pig sits there rather than at the
  // plot's left edge, which the critter now flies clean over since slingX moved to -9.
  const winning = roundWith({ v: 1, blocks: [], pigs: [['runt', TUNE.slingX + 13, 0.3]] });
  launch(winning, -TUNE.slingRadius, 0);
  runToEnd(winning);

  const losing = roundWith({ v: 1, blocks: [], pigs: [['runt', 30, 0.3]] });
  launch(losing, -TUNE.slingRadius, 0);
  runToEnd(losing);

  const passed = winning.phase === 'won' && winning.pigs[0].dead &&
    losing.phase === 'lost' && !losing.pigs[0].dead &&
    losing.shotIndex === losing.bag.length;
  report('round win and loss', passed,
    `reachable ${winning.phase} at step ${winning.stepCount}; unreachable ${losing.phase} ` +
    `at step ${losing.stepCount} (${losing.settleTimer.toFixed(3)} s cap), bag ` +
    `${losing.shotIndex}/${losing.bag.length}`);
}

function replayGate() {
  const spec = {
    blueprint: {
      v: 1,
      blocks: [['cube', 'wood', 5, 0.5, 0]],
      pigs: [['runt', 30, 0.3]]
    },
    bag: ['wedge', 'nib'],
    seed: 8675309,
    mode: 'campaign'
  };
  const original = makeRound(spec);
  const upward = TUNE.slingRadius * 0.2;
  launch(original,
    -Math.sqrt(TUNE.slingRadius * TUNE.slingRadius - upward * upward),
    -upward);
  while (original.phase !== 'aiming' && original.stepCount < 1000) {
    if (original.stepCount === 12) tap(original);
    stepRound(original, TUNE.step);
  }
  launch(original, -TUNE.slingRadius, 0);
  runToEnd(original, 1000);

  const shotLog = original.shots.map((shot) => ({ ...shot }));
  const replay = makeRound(spec);
  while (replay.stepCount < original.stepCount) {
    for (const shot of shotLog) {
      if (shot.step === replay.stepCount) launch(replay, shot.dx, shot.dy);
      if (shot.tapStep === replay.stepCount) tap(replay);
    }
    stepRound(replay, TUNE.step);
  }
  const originalDigest = digestRound(original);
  const replayDigest = digestRound(replay);
  report('shot-log replay digest', originalDigest === replayDigest && shotLog[0].tapStep === 12,
    `${originalDigest} = ${replayDigest}; ${shotLog.length} shots over ` +
    `${original.stepCount} steps from seed ${spec.seed}`);
}

launchSpeedGate();
trajectoryGate();
damageThresholdGate();
restingDamageGate();
tntChainGate();
occlusionGate();
helmArmourGate();
tuskArmourGate();
zeppelinGate();
sargeRepairGate();
springGate();
gelGate();
sandGate();
stoneSplitGate();
splitAbilityGate();
accelAbilityGate();
boomAbilityGate();
dropAbilityGate();
reverseAbilityGate();
inflateAbilityGate();
hardenAbilityGate();
blinkAbilityGate();
roundEndGate();
replayGate();

if (failures) {
  console.error(`\n${failures} simulation assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll twenty-four simulation assertions passed.');
}
