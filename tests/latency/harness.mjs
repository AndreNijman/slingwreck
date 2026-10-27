// Item-1 harness: the corner preview, before (each frame drawn on arrival, the relay's
// strict per-frame limit) and after (preview-buffer.js's PreviewBuffer, plus any relay
// change), on a deterministic network.
//
// The sender is a real attack through sim.js: a campaign fortress, a bot aiming each
// shot (bots.js), 60 sim steps a second, a preview frame every 8 frames when something
// moved (previewFrame, the same encoder siege-online.js sends). Each frame crosses two
// in-order legs, attacker to relay and relay to defender, each 100 ms +-20 ms (so both
// players sit at 200 ms RTT +-40 ms), and the relay applies its preview rate limit on
// what it receives. The defender renders at 60 fps. Measured over moving blocks:
//
//   error    mean distance (world units) between the drawn block and where it really is
//   shape    the same after the best constant delay is taken out: how far the drawn
//            motion is from the real motion, i.e. steps and wobble rather than lag
//   lag      that best constant delay, ms
//   stutter  share of display frames where a moving block froze or jumped (more than
//            three times its real motion that frame)
//   dropped  share of frames the relay threw away
//
//   node tests/latency/harness.mjs   (5 fortresses; 200 ms RTT +-40 ms, then a clean line)
import { LEVELS } from '../../levels.js?v=20261027-2';
import { TUNE } from '../../data.js?v=20261027-2';
import { planShot, shouldTap } from '../../bots.js?v=20261027-2';
import { launch, makeRound, stepRound, tap, isRoundOver } from '../../sim.js?v=20261027-2';
import { SETTLE_STEPS, previewAllowed } from '../../relay-audit.js?v=20261027-2';
import { previewFrame, PreviewBuffer } from '../../preview-buffer.js?v=20261027-2';
import { previewAccepted } from '../../worker.js?v=20261027-2';

const STEP_MS = TUNE.step * 1000;
const SECONDS = 40;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundFor(level) {
  const round = makeRound({ mode: 'campaign', seed: level.seed ?? 0x51a9, bag: level.bag, blueprint: level.blueprint });
  for (let i = 0; i < SETTLE_STEPS; i++) stepRound(round, TUNE.step);
  return round;
}

// The attack and its frames: truth[step] is every block's position at that step.
function attack(level) {
  const round = roundFor(level);
  const truth = [];
  const frames = [];
  const memory = { lastSentPose: new Map(), reportedDeadBlocks: new Set(), reportedDeadPigs: new Set() };
  let lastSent = -Infinity;
  let nextShot = 30;
  let plan = null;
  for (let i = 0; i < SECONDS * 60 && !isRoundOver(round); i++) {
    if (round.phase === 'aiming' && i >= nextShot && round.shotIndex < round.bag.length) {
      plan = planShot(round, 1, round.rng);
      if (plan?.aim) launch(round, plan.aim.dx, plan.aim.dy);
      else launch(round, -TUNE.slingRadius * 0.8, -TUNE.slingRadius * 0.4);
      nextShot = i + 150;
    }
    if (plan && round.phase === 'flying' && shouldTap(round, plan)) { tap(round); plan = null; }
    stepRound(round, TUNE.step);
    const at = (round.stepCount - SETTLE_STEPS) * STEP_MS;
    truth.push(new Map(round.blocks.filter((b) => !b.dead).map((b) => [b.id, [b.x, b.y]])));
    if (previewAllowed(lastSent, at, round.attackerCards)) {
      lastSent = at;
      const frame = previewFrame(round, memory);
      if (frame) frames.push({ at, frame: { ...frame, k: frame.k } });
    }
  }
  return { truth, frames };
}

// Two in-order legs and the relay's limit between them.
function deliver(frames, random, relayLimit, net) {
  const leg = () => net.rtt / 2 + (random() * 2 - 1) * net.jitter / 2;
  const out = [];
  let relayAt = -Infinity;
  let clientAt = -Infinity;
  const relay = { lastPreviewAt: -Infinity };
  let dropped = 0;
  for (const { at, frame } of frames) {
    relayAt = Math.max(relayAt, at + leg());
    if (!relayLimit(relay, relayAt)) { dropped++; continue; }
    clientAt = Math.max(clientAt, relayAt + leg());
    out.push({ arrival: clientAt, frame });
  }
  return { arrivals: out, dropped: dropped / frames.length };
}

function strictLimit(state, now) {
  if (!previewAllowed(state.lastPreviewAt, now, [])) return false;
  state.lastPreviewAt = now;
  return true;
}

function tolerantLimit(state, now) {
  return previewAccepted(state, now, []);
}

// The defender's view, frame by frame: drawn[i] is every block's drawn position.
function view(level, arrivals, legacy, phase) {
  const shadow = roundFor(level);
  const bodies = new Map(shadow.world.bodies.map((b) => [b.id, b]));
  const pigs = new Map(shadow.pigs.map((p) => [p.id, p]));
  const buffer = new PreviewBuffer(bodies, pigs, { legacy });
  const drawn = [];
  let next = 0;
  const end = SECONDS * 1000 + 600;
  for (let now = phase; now < end; now += 1000 / 60) {
    while (next < arrivals.length && arrivals[next].arrival <= now) {
      buffer.push(arrivals[next].frame, arrivals[next].arrival);
      next++;
    }
    buffer.render(now);
    drawn.push({ now, at: new Map(shadow.blocks.filter((b) => !b.dead).map((b) => [b.id, [b.x, b.y]])) });
  }
  return drawn;
}

function truthAt(truth, ms) {
  return truth[Math.max(0, Math.min(truth.length - 1, Math.floor(ms / STEP_MS)))];
}

function score(truth, drawn) {
  const errorAt = (lag) => {
    let sum = 0;
    let n = 0;
    for (const { now, at } of drawn) {
      if (now - lag < 0 || now - lag >= truth.length * STEP_MS) continue;
      const real = truthAt(truth, now - lag);
      const before = truthAt(truth, now - lag - 1000 / 60);
      for (const [id, [x, y]] of real) {
        const was = before.get(id);
        if (!was || Math.hypot(x - was[0], y - was[1]) < 0.002) continue; // still
        const shown = at.get(id);
        if (!shown) continue;
        sum += Math.hypot(shown[0] - x, shown[1] - y);
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  // The best constant delay: coarse, then fine around the coarse best.
  let best = { lag: 0, shape: Infinity };
  const tryLag = (lag) => {
    const e = errorAt(lag);
    if (e < best.shape) best = { lag, shape: e };
  };
  for (let lag = 0; lag <= 600; lag += 25) tryLag(lag);
  const coarse = best.lag;
  for (let lag = Math.max(0, coarse - 24); lag <= coarse + 24; lag += 4) tryLag(lag);
  let moving = 0;
  let bad = 0;
  for (let i = 1; i < drawn.length; i++) {
    const t = drawn[i].now - best.lag;
    if (t < 0 || t >= truth.length * STEP_MS) continue;
    const real = truthAt(truth, t);
    const before = truthAt(truth, t - 1000 / 60);
    for (const [id, [x, y]] of real) {
      const was = before.get(id);
      if (!was) continue;
      const step = Math.hypot(x - was[0], y - was[1]);
      if (step < 0.01) continue;
      const a = drawn[i - 1].at.get(id);
      const b = drawn[i].at.get(id);
      if (!a || !b) continue;
      moving++;
      const shownStep = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (shownStep < 0.001 || shownStep > 3 * step) bad++;
    }
  }
  return { error: errorAt(0), shape: best.shape, lag: best.lag, stutter: moving ? bad / moving : 0 };
}

const attacks = [51, 25, 12, 38, 18].map((index) => ({ level: LEVELS[index], ...attack(LEVELS[index]) }));

function run(label, legacy, relayLimit, net) {
  const rows = [];
  for (const [n, { level, truth, frames }] of attacks.entries()) {
    const random = rng(1000 + n);
    const { arrivals, dropped } = deliver(frames, random, relayLimit, net);
    const drawn = view(level, arrivals, legacy, random() * 16);
    rows.push({ ...score(truth, drawn), dropped });
  }
  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  console.log(`${label.padEnd(44)} error ${mean('error').toFixed(3)}  shape ${mean('shape').toFixed(3)}  ` +
    `lag ${mean('lag').toFixed(0)} ms  stutter ${(mean('stutter') * 100).toFixed(1)} %  ` +
    `dropped ${(mean('dropped') * 100).toFixed(1)} %`);
  return rows;
}

const JITTERY = { rtt: 200, jitter: 40 };
const CLEAN = { rtt: 40, jitter: 0 };
console.log('corner preview, 5 fortresses x 40 s of bot attack');
console.log('both players at 200 ms RTT +-40 ms:');
run('  before: draw on arrival, strict relay limit', true, strictLimit, JITTERY);
run('  before + tolerant relay limit only', true, tolerantLimit, JITTERY);
run('  buffer only, strict relay limit', false, strictLimit, JITTERY);
run('  after: buffer + tolerant relay limit', false, tolerantLimit, JITTERY);
console.log('both players at 40 ms RTT, no jitter:');
run('  before', true, strictLimit, CLEAN);
run('  after', false, tolerantLimit, CLEAN);
