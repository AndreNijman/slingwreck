#!/usr/bin/env node

import { MATERIALS, TUNE } from '../data.js';
import { addBody } from '../physics.js';
import {
  digestRound,
  launch,
  makeRound,
  stepRound
} from '../sim.js';

let failures = 0;

function report(name, passed, measurement) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${measurement}`);
  if (!passed) failures++;
}

function roundWith(blueprint, bag = ['nib'], seed = 1) {
  return makeRound({ blueprint, bag, seed, mode: 'campaign' });
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
      pigs: [['runt', 0, 0.3]]
    },
    bag: ['nib', 'nib'],
    seed: 8675309,
    mode: 'campaign'
  };
  const original = makeRound(spec);
  const upward = TUNE.slingRadius * 0.2;
  launch(original,
    -Math.sqrt(TUNE.slingRadius * TUNE.slingRadius - upward * upward),
    -upward);
  while (original.phase !== 'aiming' && original.stepCount < 1000) {
    stepRound(original, TUNE.step);
  }
  launch(original, -TUNE.slingRadius, 0);
  runToEnd(original, 1000);

  const shotLog = original.shots.map((shot) => ({ ...shot }));
  const replay = makeRound(spec);
  while (replay.stepCount < original.stepCount) {
    for (const shot of shotLog) {
      if (shot.step === replay.stepCount) launch(replay, shot.dx, shot.dy);
    }
    stepRound(replay, TUNE.step);
  }
  const originalDigest = digestRound(original);
  const replayDigest = digestRound(replay);
  report('shot-log replay digest', originalDigest === replayDigest,
    `${originalDigest} = ${replayDigest}; ${shotLog.length} shots over ` +
    `${original.stepCount} steps from seed ${spec.seed}`);
}

launchSpeedGate();
trajectoryGate();
damageThresholdGate();
restingDamageGate();
tntChainGate();
occlusionGate();
roundEndGate();
replayGate();

if (failures) {
  console.error(`\n${failures} simulation assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll eight simulation assertions passed.');
}
