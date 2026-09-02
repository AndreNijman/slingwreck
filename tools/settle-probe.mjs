#!/usr/bin/env node

import { PIGS, TUNE } from '../data.js?v=20260902-1';
import { launch, makeRound, stepRound } from '../sim.js?v=20260902-1';

let failures = 0;

function report(name, passed, measurement) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${measurement}`);
  if (!passed) failures++;
}

function makeProbe(blueprint, bag = ['nib', 'nib']) {
  return makeRound({ blueprint, bag, seed: 1, mode: 'campaign' });
}

function runShot(round, dx) {
  launch(round, dx, 0);
  const limit = Math.ceil((TUNE.settleTimeout + 1) / TUNE.step);
  while (round.phase !== 'aiming' && round.phase !== 'won' &&
      round.phase !== 'lost' && round.stepCount < limit) {
    stepRound(round, TUNE.step);
  }
  return round.stepCount * TUNE.step;
}

function missGate() {
  const round = makeProbe({
    v: 1,
    blocks: [],
    pigs: [['runt', TUNE.slingX - 2, PIGS.runt.radius]]
  });
  // Seven units per second is the measured steady-roll failure. A partial flat
  // launch isolates it on empty ground while the pig waits safely behind the sling.
  const draw = -TUNE.slingRadius * 7 / TUNE.launchSpeedMax;
  const seconds = runShot(round, draw);
  report('empty-ground miss', round.phase === 'aiming' && seconds < 2,
    `${seconds.toFixed(3)} s < 2.000 s; phase ${round.phase}`);
}

function towerGate() {
  const round = makeProbe({
    v: 1,
    blocks: [
      ['post', 'wood', 2, 1, 0],
      ['post', 'wood', 4, 1, 0],
      ['plank', 'wood', 3, 2.25, 0]
    ],
    pigs: [['runt', TUNE.slingX - 2, PIGS.runt.radius]]
  });
  const seconds = runShot(round, -TUNE.slingRadius);
  report('small-tower hit', round.phase === 'aiming' && seconds < 2.5,
    `${seconds.toFixed(3)} s < 2.500 s; phase ${round.phase}`);
}

function edgeWinGate() {
  const pigX = TUNE.plotW - 0.4;
  const round = makeProbe({
    v: 1,
    blocks: [],
    pigs: [['runt', pigX, PIGS.runt.radius]]
  }, ['nib']);
  const seconds = runShot(round, -TUNE.slingRadius);
  const pig = round.pigs[0];
  const crossedEdge = pig.x + pig.r > TUNE.plotW;
  report('right-edge pig', round.phase === 'won' && crossedEdge,
    `${round.phase} at ${seconds.toFixed(3)} s; right edge ` +
    `${(pig.x + pig.r).toFixed(3)} > ${TUNE.plotW.toFixed(3)}`);
}

missGate();
towerGate();
edgeWinGate();

if (failures) {
  console.error(`\n${failures} settling probe(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll three settling probes passed.');
}
