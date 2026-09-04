#!/usr/bin/env node

import {
  addBody,
  digest,
  fromDegrees,
  isSettled,
  makeWorld,
  maxPenetration,
  rng,
  rngInt,
  step
} from '../physics.js?v=20260904-1';
import { SHAPES, TUNE } from '../data.js?v=20260904-1';

let failures = 0;

function report(name, passed, measurement) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${measurement}`);
  if (!passed) failures++;
}

// A scene whose bodies start inside each other is not testing the solver, it is
// testing recovery from a bad initial condition, and it will pass or fail for
// reasons that have nothing to do with the assertion in its name. Every hand-placed
// scene asserts this before it runs.
function assertNoOverlap(world, name) {
  const worst = maxPenetration(world);
  if (worst > TUNE.slop) {
    console.log(`FAIL  ${name}: scene starts with ${worst.toFixed(5)} of interpenetration, > slop ${TUNE.slop}`);
    failures++;
  }
}

function material(id, friction, restitution = 0) {
  return {
    id,
    density: 1,
    hp: 1,
    friction,
    restitution
  };
}

function staticBox(world, id, x, y, w, h, mat = 'wood', rotation = null) {
  return addBody(world, {
    shape: { id, kind: 'box', w, h, area: w * h },
    mat,
    x,
    y,
    c: rotation?.c,
    s: rotation?.s,
    isStatic: true
  });
}

function run(world, steps) {
  for (let i = 0; i < steps; i++) step(world);
}

function stackGate() {
  const world = makeWorld();
  staticBox(world, 'stack-ground', 0, -0.5, 30, 1);
  const cubes = [];
  for (let i = 0; i < 10; i++) {
    cubes.push(addBody(world, { shape: 'cube', mat: 'wood', x: 0, y: i + 0.5 }));
  }
  assertNoOverlap(world, 'stack');
  let sleepStep = -1;
  let maxDrift = 0;
  for (let i = 1; i <= 120; i++) {
    step(world);
    for (const cube of cubes) maxDrift = Math.max(maxDrift, Math.abs(cube.x));
    if (sleepStep < 0 && isSettled(world)) sleepStep = i;
  }
  const sleepSeconds = sleepStep < 0 ? Infinity : sleepStep * TUNE.step;
  report('stack', sleepSeconds <= 2 && maxDrift < 0.02,
    `sleep ${sleepSeconds.toFixed(3)} s <= 2.000 s; drift ${maxDrift.toFixed(6)} < 0.020000`);
}

function pyramidGate() {
  const world = makeWorld();
  staticBox(world, 'pyramid-ground', 0, -0.5, 24, 1);
  const pieces = [];
  const postRows = [5, 4, 3];
  // Post spacing must equal the plank width. At the 3-unit spacing this gate
  // originally used, 4-wide planks in the same row overlapped each other by a full
  // unit, and the whole 30 seconds was the structure climbing out of that
  // interpenetration — 0.54 units of travel that read as a solver too weak to stack
  // and was really a scene that could not be built. With the spans abutting exactly
  // the same structure moves 0.014.
  const SPACING = SHAPES.plank.w;
  for (let row = 0; row < postRows.length; row++) {
    const count = postRows[row];
    const postY = 1 + row * 2.5;
    const left = -(count - 1) * SPACING / 2;
    for (let i = 0; i < count; i++) {
      pieces.push(addBody(world, {
        shape: 'post', mat: 'wood', x: left + i * SPACING, y: postY
      }));
    }
    if (row < postRows.length - 1) {
      for (let i = 0; i < count - 1; i++) {
        pieces.push(addBody(world, {
          shape: 'plank', mat: 'wood', x: left + SPACING / 2 + i * SPACING, y: postY + 1.25
        }));
      }
    }
  }
  assertNoOverlap(world, 'pyramid');
  const starts = pieces.map((body) => ({ x: body.x, y: body.y }));
  run(world, 1800);
  let maxMove = 0;
  let top = -Infinity;
  for (let i = 0; i < pieces.length; i++) {
    const dx = pieces[i].x - starts[i].x;
    const dy = pieces[i].y - starts[i].y;
    maxMove = Math.max(maxMove, Math.sqrt(dx * dx + dy * dy));
    top = Math.max(top, pieces[i].y);
  }
  // 0.05 rather than the 0.75 this gate first shipped with. A threshold loose enough
  // to pass a collapsing structure is not a gate, it is a record of one run.
  const stands = top > 5.9 && maxMove < 0.05;
  report('pyramid', stands && isSettled(world),
    `sleep ${isSettled(world)} at 30.000 s; top ${top.toFixed(3)} > 5.900; max move ${maxMove.toFixed(5)} < 0.05000`);
}

function bounceGate() {
  const restitution = 0.72;
  const bounceMat = material('bounce', 0, restitution);
  const world = makeWorld();
  staticBox(world, 'bounce-ground', 0, -0.5, 20, 1, bounceMat);
  const ball = addBody(world, { shape: 'ball', mat: bounceMat, x: 0, y: 10 });
  const peaks = [];
  let rising = false;
  let peak = 0;
  for (let i = 0; i < 600 && peaks.length < 2; i++) {
    const before = ball.vy;
    step(world);
    if (!rising && before < 0 && ball.vy > 0) {
      rising = true;
      peak = ball.y;
    } else if (rising) {
      peak = Math.max(peak, ball.y);
      if (ball.vy <= 0) {
        peaks.push(peak - ball.r);
        rising = false;
      }
    }
  }
  const measured = peaks.length === 2 ? Math.sqrt(peaks[1] / peaks[0]) : Infinity;
  const error = Math.abs(measured - restitution) / restitution;
  report('restitution', peaks.length === 2 && error <= 0.05,
    `coefficient ${measured.toFixed(5)} vs ${restitution.toFixed(5)}; error ${(error * 100).toFixed(2)}% <= 5.00%`);
}

function rampTrial(friction) {
  const mat = material(`ramp-${friction}`, friction);
  const world = makeWorld();
  const rotation = fromDegrees(20);
  staticBox(world, `ramp-${friction}`, 0, 0, 18, 0.5, mat, rotation);
  const normalX = -rotation.s;
  const normalY = rotation.c;
  const box = addBody(world, {
    shape: 'cube', mat, x: normalX * 0.75, y: normalY * 0.75,
    c: rotation.c, s: rotation.s
  });
  assertNoOverlap(world, `friction mu ${friction}`);
  const startAlong = box.x * rotation.c + box.y * rotation.s;
  run(world, 180);
  const endAlong = box.x * rotation.c + box.y * rotation.s;
  return { distance: Math.abs(endAlong - startAlong), asleep: box.isAsleep };
}

function frictionGate() {
  const high = rampTrial(0.6);
  const low = rampTrial(0.2);
  report('friction', high.distance < 0.05 && high.asleep && low.distance > 1,
    `mu 0.6 slide ${high.distance.toFixed(5)} < 0.05000; mu 0.2 slide ${low.distance.toFixed(5)} > 1.00000`);
}

function massDropGate() {
  const world = makeWorld();
  staticBox(world, 'box-floor', 0, -1, 26, 2, 'stone');
  staticBox(world, 'box-left', -13, 9, 2, 20, 'stone');
  staticBox(world, 'box-right', 13, 9, 2, 20, 'stone');
  const bodies = [];
  for (let row = 0; row < 10; row++) {
    for (let column = 0; column < 20; column++) {
      bodies.push(addBody(world, {
        shape: 'cube', mat: 'wood',
        x: column - 9.5, y: 3 + row * 1.05
      }));
    }
  }
  assertNoOverlap(world, 'mass drop');
  run(world, 360);
  let escaped = 0;
  for (const body of bodies) {
    if (body.x < -13 || body.x > 13 || body.y < -2) escaped++;
  }
  report('mass drop', isSettled(world) && escaped === 0,
    `sleep ${isSettled(world)} by 6.000 s; escaped ${escaped} = 0`);
  return world;
}

function reverseGravityGate(world) {
  world.gravity = -world.gravity;
  run(world, 360);
  let nanFields = 0;
  for (const body of world.bodies) {
    for (const value of Object.values(body)) {
      if (typeof value === 'number' && Number.isNaN(value)) nanFields++;
    }
  }
  report('reverse gravity', nanFields === 0, `NaN body fields ${nanFields} = 0`);
}

function twinWorld() {
  const random = rng(9127);
  const world = makeWorld();
  staticBox(world, 'twin-ground', 0, -0.5, 30, 1, 'stone');
  const shapes = ['cube', 'slab', 'beam', 'post', 'tri', 'ball'];
  const mats = ['glass', 'wood', 'stone', 'iron'];
  for (let i = 0; i < 24; i++) {
    const rotation = fromDegrees(rngInt(random, 24) * 15);
    addBody(world, {
      shape: shapes[rngInt(random, shapes.length)],
      mat: mats[rngInt(random, mats.length)],
      x: -8 + random() * 16,
      y: 2 + random() * 15,
      c: rotation.c,
      s: rotation.s,
      vx: -2 + random() * 4,
      av: -1 + random() * 2
    });
  }
  return world;
}

function determinismGate() {
  const a = twinWorld();
  const b = twinWorld();
  for (let i = 0; i < 3600; i++) {
    step(a);
    step(b);
  }
  const digestA = digest(a);
  const digestB = digest(b);
  report('twin determinism', digestA === digestB,
    `digest ${digestA} = ${digestB} after 3600 steps`);
}

stackGate();
pyramidGate();
bounceGate();
frictionGate();
const massWorld = massDropGate();
reverseGravityGate(massWorld);
determinismGate();

if (failures) {
  console.error(`\n${failures} physics assertion(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll seven physics assertions passed.');
}
