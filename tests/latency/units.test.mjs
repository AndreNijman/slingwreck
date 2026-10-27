#!/usr/bin/env node
// Unit tests for the latency work: the preview playout buffer, the relay's tolerant
// preview limit, probe cleaning, and the room move between two SiegeRooms in one process
// (a fake ROOMS namespace hands /_adopt and /_released from one to the other).
//   node --test tests/latency/units.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { TUNE } from '../../data.js?v=20260904-2';
import { previewAllowed, previewInterval } from '../../relay-audit.js?v=20260904-2';
import { PreviewBuffer } from '../../preview-buffer.js?v=20260904-2';
import { cleanProbes, previewAccepted, SiegeRoom } from '../../worker.js?v=20260904-2';

const STEP_MS = TUNE.step * 1000;

function shadow(ids = [1, 2]) {
  const bodies = new Map(ids.map((id) => [id, { id, x: 0, y: 0, c: 1, s: 0, dead: false }]));
  const pigs = new Map([[9, { id: 9, dead: false }]]);
  return { bodies, pigs };
}
const frame = (k, d, extra = {}) => ({ d, p: [], s: 0, a: 3, k, ...extra });

test('the buffer plays frames out at a delay and glides between them', () => {
  const { bodies, pigs } = shadow();
  const buffer = new PreviewBuffer(bodies, pigs);
  // A steady 8-step (133 ms) stream with 100 ms of transit and no jitter.
  for (let i = 0; i < 6; i++) buffer.push(frame(i * 8, [[1, i, 0, 1, 0, 0]]), i * 8 * STEP_MS + 100);
  const sendGap = 8 * STEP_MS;
  // With no jitter the delay is one send gap, so at wall time t the playout time is
  // t - 100 - gap: here halfway between frames 3 and 4.
  buffer.render(4.5 * sendGap + 100);
  assert.ok(Math.abs(buffer.delay - sendGap) < 1, `delay is one send gap with no jitter (${buffer.delay})`);
  assert.ok(Math.abs(bodies.get(1).x - 3.5) < 0.05, `x glides to 3.5 (${bodies.get(1).x})`);
  assert.equal(bodies.get(2).x, 0, 'a block no frame moved stays where it was built');
});

test('the delay grows with jitter and stays under its ceiling', () => {
  const { bodies, pigs } = shadow();
  const buffer = new PreviewBuffer(bodies, pigs);
  for (let i = 0; i < 40; i++) {
    const late = i % 5 === 0 ? 120 : 0;
    buffer.push(frame(i * 8, [[1, i, 0, 1, 0, 0]]), i * 8 * STEP_MS + 100 + late);
  }
  buffer.render(40 * 8 * STEP_MS + 300);
  assert.ok(buffer.delay > 8 * STEP_MS + 100 && buffer.delay <= 300, `delay covers the late frames (${buffer.delay})`);
  const wild = new PreviewBuffer(...Object.values(shadow()));
  for (let i = 0; i < 40; i++) wild.push(frame(i * 8, [[1, i, 0, 1, 0, 0]]), i * 8 * STEP_MS + (i % 2 ? 900 : 0));
  wild.render(1e6);
  assert.equal(wild.delay, 300, 'delay is clamped at 300 ms');
});

test('rotation glides on the unit circle', () => {
  const { bodies, pigs } = shadow();
  const buffer = new PreviewBuffer(bodies, pigs);
  buffer.push(frame(0, [[1, 0, 0, 1, 0, 0]]), 0);
  buffer.push(frame(8, [[1, 0, 0, 0, 1, 0]]), 8 * STEP_MS);
  buffer.push(frame(16, [[1, 0, 0, 0, 1, 0]]), 16 * STEP_MS);
  buffer.render(4 * STEP_MS + buffer.delay + 8 * STEP_MS); // playout halfway from 0 to 8
  const { c, s } = bodies.get(1);
  assert.ok(Math.abs(Math.hypot(c, s) - 1) < 1e-9, 'c, s stay a unit vector');
  assert.ok(c > 0.1 && s > 0.1, 'and sit between the two angles');
});

test('a block that jumps far, or across a long gap, snaps instead of gliding', () => {
  const { bodies, pigs } = shadow();
  const buffer = new PreviewBuffer(bodies, pigs);
  buffer.push(frame(0, [[1, 0, 0, 1, 0, 0]]), 0);
  buffer.push(frame(8, [[1, 20, 0, 1, 0, 0]]), 8 * STEP_MS);
  buffer.render(8 * STEP_MS + 4 * STEP_MS); // between the two frames
  assert.equal(bodies.get(1).x, 0, 'a 20-unit jump is not drawn halfway');
  buffer.render(1e5);
  assert.equal(bodies.get(1).x, 20, 'and lands once its frame plays');

  const slow = shadow();
  const smoke = new PreviewBuffer(slow.bodies, slow.pigs);
  smoke.push(frame(0, [[1, 0, 0, 1, 0, 0]]), 0);
  smoke.push(frame(180, [[1, 2, 0, 1, 0, 0]]), 3000); // Smokescreen: one frame per 3 s
  smoke.render(1500 + smoke.delay);
  assert.equal(slow.bodies.get(1).x, 0, 'no glide across a 3 s gap');
});

test('dead blocks and pigs, score and ammo apply when their frame plays', () => {
  const { bodies, pigs } = shadow();
  const buffer = new PreviewBuffer(bodies, pigs);
  buffer.push(frame(0, [[1, 1, 0, 1, 0, 0]]), 0);
  buffer.push(frame(8, [[1, 0, 0, 0, 0, 1]], { p: [[9, 1]], s: 450, a: 1 }), 8 * STEP_MS);
  buffer.render(0);
  assert.equal(bodies.get(1).dead, false, 'not dead before its frame plays');
  buffer.render(1e5);
  assert.equal(bodies.get(1).dead, true);
  assert.equal(pigs.get(9).dead, true);
  assert.equal(buffer.score, 450);
  assert.equal(buffer.ammo, 1);
  assert.equal(buffer.render(1e5 + 16), false, 'nothing changes once everything played');
});

test('legacy mode draws each frame on arrival', () => {
  const { bodies, pigs } = shadow();
  const buffer = new PreviewBuffer(bodies, pigs, { legacy: true });
  buffer.push(frame(0, [[1, 3, 4, 1, 0, 0]]), 50);
  assert.equal(buffer.render(50), true);
  assert.deepEqual([bodies.get(1).x, bodies.get(1).y], [3, 4]);
});

test('frames without k (an older sender) play out by arrival time', () => {
  const { bodies, pigs } = shadow();
  const buffer = new PreviewBuffer(bodies, pigs);
  for (let i = 0; i < 5; i++) buffer.push({ d: [[1, i, 0, 1, 0, 0]], p: [], s: 0, a: 3 }, 1000 + i * 133);
  buffer.render(1000 + 4 * 133 + buffer.delay + 400);
  assert.equal(bodies.get(1).x, 4);
  buffer.push(null, 0);
  buffer.push(frame(0, [[1, 99, 0, 1, 0, 0]]), 0); // stale: older than the newest frame
  buffer.render(1e6);
  assert.equal(bodies.get(1).x, 4, 'a stale frame is ignored');
});

test('the tolerant relay limit keeps the average rate and lets a bunched frame through', () => {
  const session = { lastPreviewAt: -Infinity };
  const gap = previewInterval([]);
  assert.equal(previewAccepted(session, 0, []), true);
  // The next frame was held up 50 ms upstream, so the one after arrives 50 ms early.
  assert.equal(previewAccepted(session, gap + 50, []), true);
  assert.equal(previewAllowed(gap + 50, 2 * gap, []), false, 'the strict limit drops it');
  assert.equal(previewAccepted(session, 2 * gap, []), true, 'the tolerant one does not');
  // A flood is still held to the average rate.
  let accepted = 0;
  const flood = { lastPreviewAt: -Infinity };
  for (let now = 0; now < 10_000; now += 10) if (previewAccepted(flood, now, [])) accepted++;
  assert.ok(accepted <= Math.ceil(10_000 / gap) + 1, `flood held to the rate (${accepted})`);
  // Smokescreen keeps its slow rate.
  const smoke = { lastPreviewAt: -Infinity };
  const cards = ['smokescreen'];
  const slow = previewInterval(cards);
  assert.equal(slow, 3000);
  assert.equal(previewAccepted(smoke, 0, cards), true);
  assert.equal(previewAccepted(smoke, slow / 2, cards), false);
  assert.equal(previewAccepted(smoke, slow - 30, cards), true, 'with the same small slack');
});

test('cleanProbes keeps known regions with sane numbers', () => {
  assert.deepEqual(cleanProbes({ weur: 20.4, apac: '290', mars: 5, oc: -1, me: 1e9, eeur: NaN }), { weur: 20, apac: 290 });
  assert.equal(cleanProbes(null), null);
  assert.equal(cleanProbes({ mars: 3 }), null);
  assert.equal(cleanProbes('weur'), null);
});

// -- the room move, in process ------------------------------------------------

function storage() {
  const data = new Map();
  return {
    get: async (key) => data.get(key),
    put: async (key, value) => { data.set(key, value); },
    delete: async (key) => { data.delete(key); },
    setAlarm: async () => {},
    deleteAlarm: async () => {}
  };
}

const made = [];
const registry = { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) };

// Two objects behind a fake namespace: the room's own and whatever shard it moves to.
function world({ adoptFails = false } = {}) {
  const objects = new Map();
  const env = { DEV_COLO: 'FRA', REGISTRY: registry };
  const make = () => {
    const room = new SiegeRoom({ blockConcurrencyWhile: (fn) => fn(), waitUntil() {}, storage: storage() }, env);
    made.push(room);
    return room;
  };
  env.ROOMS = {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async (input, init) => {
        if (adoptFails) return new Response('no', { status: 500 });
        if (!objects.has(name)) objects.set(name, make());
        return objects.get(name).fetch(new Request(input, init));
      }
    })
  };
  const root = make();
  objects.set('acorn', root);
  return { root, objects, make };
}

function socket(sent) {
  return { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)), close() { this.closed = true; } };
}

function player(pid, name, regions, rtt) {
  return {
    record: {
      pid, name, wins: 0, cards: [], bankedScrap: 0, roundCarry: 0, budget: 0, draft: '',
      draftOffer: null, blueprint: '', fortressCost: 0, locked: false, autoCompleted: false,
      connected: true, disconnectedAt: 0, graceDeadline: 0, resumeTokenHash: '', siege: null,
      where: { country: name === 'Alice' ? 'DE' : 'SG', edge: 'TST' }
    },
    sent: [],
    regions,
    rtt
  };
}

function seat(room, players) {
  room.room = 'Acorn';
  room.key = 'acorn';
  room.host = 1;
  room.nextPid = 3;
  room.colo = 'FRA';
  for (const p of players) {
    room.players.set(p.record.pid, p.record);
    room.sessions.set(p.record.pid, {
      pid: p.record.pid, ready: true, socket: socket(p.sent), regions: p.regions, rtts: [p.rtt, p.rtt, p.rtt]
    });
  }
}

// Room clocks would keep the process alive.
test.after(() => {
  for (const room of made) {
    if (room.timer) clearInterval(room.timer);
    if (room.adoption) clearTimeout(room.adoption.timer);
    room.timer = null;
  }
});

const FAR = { weur: 20, apac: 290, oc: 330, me: 140 };
const NEAR = { weur: 290, apac: 30, oc: 120, me: 150 };

test('a mixed pair moves at match start; the shard starts once both tickets are back', async () => {
  const { root, objects } = world();
  const alice = player(1, 'Alice', FAR, 300);
  const chin = player(2, 'Chin', NEAR, 20);
  seat(root, [alice, chin]);
  await root.startBuild({ pid: 1 });
  const moves = [alice, chin].map((p) => p.sent.find((m) => m.t === 'move'));
  assert.ok(moves.every((m) => m?.region === 'me' && m.shard === moves[0].shard && /^[a-z0-9]{16}$/.test(m.ticket)));
  assert.notEqual(moves[0].ticket, moves[1].ticket);
  assert.equal(root.phase, 'lobby', 'the old object does not start the match');
  assert.equal(root.key, '');
  assert.deepEqual(root.moved, { shard: moves[0].shard, region: 'me' });
  const shard = objects.get(`acorn~${moves[0].shard}`);
  assert.ok(shard?.adoption, 'the shard waits for its tickets');
  assert.equal(shard.movedFrom, 'FRA');
  assert.equal(shard.host, 1);

  const back = [alice, chin].map((p, i) => {
    const sent = [];
    const session = { pid: -1, ready: false, socket: socket(sent), ticket: moves[i].ticket, routeKey: 'acorn' };
    return { session, sent };
  });
  // A wrong ticket is refused and does not use a seat.
  const wrongSent = [];
  await shard.onMessage({ pid: -1, ready: false, socket: socket(wrongSent), ticket: 'x'.repeat(16), routeKey: 'acorn' },
    JSON.stringify({ t: 'join', room: 'Acorn', name: 'Mallory' }));
  assert.equal(wrongSent.find((m) => m.t === 'err')?.code, 'seat-gone');
  await shard.onMessage(back[0].session, JSON.stringify({ t: 'join', room: 'Acorn', name: 'ignored' }));
  assert.equal(shard.phase, 'lobby', 'one ticket back: still waiting');
  await shard.onMessage(back[1].session, JSON.stringify({ t: 'join', room: 'Acorn', name: 'ignored' }));
  const welcomes = back.map(({ sent }) => sent.find((m) => m.t === 'welcome'));
  assert.deepEqual(welcomes.map((w) => [w.you, w.host, w.moved, w.region]), [[1, true, true, 'me'], [2, false, true, 'me']]);
  assert.deepEqual([...shard.players.values()].map((r) => [r.name, r.where.country]), [['Alice', 'DE'], ['Chin', 'SG']]);
  assert.equal(shard.phase, 'build', 'both back: the match starts on the shard');
  assert.equal(shard.adoption, null);
  assert.ok(shard.net, 'and its lag log runs there');
});

test('the shard waits for missing tickets, then sits in the lobby; emptying it frees the name', async () => {
  const { root, objects } = world();
  const alice = player(1, 'Alice', FAR, 300);
  const chin = player(2, 'Chin', NEAR, 20);
  seat(root, [alice, chin]);
  await root.startBuild({ pid: 1 });
  const move = alice.sent.find((m) => m.t === 'move');
  const shard = objects.get(`acorn~${move.shard}`);
  const sent = [];
  const session = { pid: -1, ready: false, socket: socket(sent), ticket: move.ticket, routeKey: 'acorn' };
  shard.sessions.set('a', session);
  await shard.onMessage(session, JSON.stringify({ t: 'join', room: 'Acorn', name: 'Alice' }));
  await shard.adopted(); // what the ADOPT_WAIT timer does
  assert.equal(shard.phase, 'lobby');
  assert.deepEqual([...shard.players.keys()], [1]);
  assert.equal(shard.host, 1);
  await shard.reset(); // the last socket went
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(root.moved, null, 'the old object forgets the move');
});

test('a room created on a shard after a lost release still releases the name', async () => {
  const { root, make } = world();
  root.moved = { shard: 'me-abc123', region: 'me' };
  const shard = make();
  const sent = [];
  const session = { pid: -1, ready: false, socket: socket(sent), routeKey: 'acorn', routeShard: 'me-abc123', ip: 'x' };
  shard.sessions.set('s', session);
  await shard.onMessage(session, JSON.stringify({ t: 'create', room: 'Acorn', name: 'Jo', password: '' }));
  assert.ok(sent.some((m) => m.t === 'welcome'));
  assert.equal(shard.shard, 'me-abc123', 'the object knows which shard it is');
  assert.equal(shard.mayMove(), false, 'and does not move again');
  await shard.reset();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(root.moved, null, 'its release frees the old name');
});

test('a same-region pair, or a failed move, starts where it is', async () => {
  const same = world();
  seat(same.root, [player(1, 'Alice', FAR, 30), player(2, 'Chin', FAR, 25)]);
  await same.root.startBuild({ pid: 1 });
  assert.equal(same.root.phase, 'build');
  assert.equal(same.objects.size, 1, 'no shard made');

  const failing = world({ adoptFails: true });
  const alice = player(1, 'Alice', FAR, 300);
  seat(failing.root, [alice, player(2, 'Chin', NEAR, 20)]);
  const error = console.error;
  console.error = () => {};
  try { await failing.root.startBuild({ pid: 1 }); } finally { console.error = error; }
  assert.equal(failing.root.phase, 'build', 'the match starts here when the shard will not adopt');
  assert.equal(failing.root.moved, null);
  assert.ok(!alice.sent.some((m) => m.t === 'move'));

  const unknown = world();
  seat(unknown.root, [player(1, 'Alice', null, 300), player(2, 'Chin', NEAR, 20)]);
  await unknown.root.startBuild({ pid: 1 });
  assert.equal(unknown.root.phase, 'build', 'a player without probes: no move');
});

test('a shard refuses a second adoption or a malformed one', async () => {
  const room = new SiegeRoom({ blockConcurrencyWhile: (fn) => fn(), waitUntil() {}, storage: storage() }, { REGISTRY: registry });
  made.push(room);
  const body = { code: 'acorn', shard: 'me-abc123', from: 'FRA', state: { room: 'Acorn', host: 1, players: [{ pid: 1, name: 'A' }] }, tickets: {} };
  assert.equal(room.adopt({ ...body, shard: 'xx' }).status, 409);
  assert.equal(room.adopt({ ...body, code: 'Acorn!' }).status, 409);
  assert.equal(room.adopt(body).status, 204);
  assert.equal(room.adopt(body).status, 409, 'busy');
});
