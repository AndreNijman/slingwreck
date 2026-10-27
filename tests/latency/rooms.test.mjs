#!/usr/bin/env node
// Integration test for room placement against wrangler dev. A mixed pair (one in Europe,
// one in Asia, by their fake probe results) starts and is moved; both reconnect with
// tickets and the match starts on the shard; a later connection to the old name is sent
// on to the shard. A pair where only one ticket comes back waits in the room on the shard,
// where a late joiner lands, and once the shard empties the name is free again. A
// same-region pair is not moved. Also /ping (region, CORS), the internal routes staying
// internal, and the lag records (country, region, moved) as received by a stub NetLog.
//
// By default it starts both servers itself on 8860 (relay) and 8861 (NetLog stub), with
// WRANGLER (default: node_modules/.bin/wrangler, else npx):
//   node tests/latency/rooms.test.mjs
// The two share a private dev registry, so the relay's NETLOG binding can't reach another
// "games-guard" running locally. Or against servers you started:
//   export WRANGLER_REGISTRY_PATH=$(mktemp -d)
//   wrangler dev -c tests/latency/netlog-stub.jsonc --port 8861 --inspector-port 9361 &
//   wrangler dev --port 8860 --inspector-port 9360 --var DEV_TRUST_WHERE:1 --var DEV_COLO:FRA &
//   RELAY=http://127.0.0.1:8860 NETLOG=http://127.0.0.1:8861 node tests/latency/rooms.test.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let BASE = process.env.RELAY || '';
let NETLOG = process.env.NETLOG || '';
let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.log('FAIL:', message); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const servers = [];
let registry = '';
async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await sleep(500);
  }
  return false;
}
async function startServers() {
  const local = path.join(ROOT, 'node_modules/.bin/wrangler');
  const bin = process.env.WRANGLER || (existsSync(local) ? local : 'npx');
  const pre = bin === 'npx' ? ['wrangler'] : [];
  registry = mkdtempSync(path.join(tmpdir(), 'slingwreck-registry-'));
  const run = (args) => {
    servers.push(spawn(bin, [...pre, ...args], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
      env: { ...process.env, WRANGLER_REGISTRY_PATH: registry }
    }));
  };
  run(['dev', '-c', 'tests/latency/netlog-stub.jsonc', '--port', '8861', '--inspector-port', '9361', '--ip', '127.0.0.1']);
  run(['dev', '--port', '8860', '--inspector-port', '9360', '--ip', '127.0.0.1',
    '--var', 'DEV_TRUST_WHERE:1', '--var', 'DEV_COLO:FRA']);
  BASE = 'http://127.0.0.1:8860';
  NETLOG = 'http://127.0.0.1:8861';
  if (!(await up(`${NETLOG}/`)) || !(await up(`${BASE}/health`))) throw new Error('wrangler dev did not come up');
  await sleep(1500); // let the dev registry connect the NETLOG binding
}
function stopServers() {
  for (const child of servers) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch {}
}

// A websocket to the relay, from a player in `country`.
function client(query, country = '') {
  const url = `${BASE.replace(/^http/, 'ws')}/ws?${query}`;
  const headers = { Origin: 'http://localhost' };
  if (country) Object.assign(headers, { 'X-Games-Country': country, 'X-Games-Edge': 'TST' });
  const ws = new WebSocket(url, { headers });
  const c = { ws, msgs: [], waiters: [], closed: null };
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = c.waiters.find((w) => w.type === message.t);
    if (waiter) {
      c.waiters = c.waiters.filter((w) => w !== waiter);
      waiter.resolve(message);
    } else c.msgs.push(message);
  });
  ws.addEventListener('close', (event) => { c.closed = { code: event.code, reason: event.reason }; });
  const opened = new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  c.send = async (message) => { await opened; ws.send(JSON.stringify(message)); };
  c.wait = (type, timeout = 5000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find((m) => m.t === type);
    if (hit) {
      c.msgs = c.msgs.filter((m) => m !== hit);
      resolve(hit);
      return;
    }
    const waiter = { type, resolve };
    c.waiters.push(waiter);
    setTimeout(() => {
      c.waiters = c.waiters.filter((w) => w !== waiter);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeout);
  });
  c.has = (type) => c.msgs.some((m) => m.t === type);
  return c;
}
const roomName = (tag) => `lat ${tag} ${Math.random().toString(36).slice(2, 8)}`;
const query = (room, extra = {}) => new URLSearchParams({ room, ...extra }).toString();

const EUROPE = { weur: 20, eeur: 45, apac: 290, oc: 330, me: 140 };
const ASIA = { weur: 290, eeur: 260, apac: 30, oc: 120, me: 150 };

// Host and guest in `room`, each reporting probes and five pings.
async function lobby(room, players) {
  const out = [];
  for (const [i, p] of players.entries()) {
    const c = client(query(room), p.country);
    await c.send({ t: i === 0 ? 'create' : 'join', room, name: p.name });
    const welcome = await c.wait('welcome');
    await c.send({ t: 'regions', ms: p.probes });
    for (let k = 0; k < 5; k++) await c.send({ t: 'ping', c: k, rtt: p.rtt, fps: 60, frameMax: 20 });
    out.push({ ...p, c, pid: welcome.you, welcome });
  }
  await sleep(200);
  return out;
}
// Keep the lag stats moving while a match runs.
function chatter(players) {
  return setInterval(() => {
    for (const p of players) {
      if (p.c.ws.readyState === 1) void p.c.send({ t: 'ping', c: 1, rtt: p.rtt, fps: 60, frameMax: 20 });
    }
  }, 500);
}
const close = (...clients) => { for (const c of clients) try { c.ws.close(); } catch {} };

async function main() {
  if (!BASE) await startServers();
  const http = BASE;

  // /ping: where a room runs, with CORS; bad names and internal routes are refused.
  {
    const res = await fetch(`${http}/ping?room=${encodeURIComponent(roomName('ping'))}`);
    const body = await res.json();
    ok(res.ok && body.region === 'weur' && body.colo === 'FRA', `room /ping answers its region (${JSON.stringify(body)})`);
    ok(res.headers.get('access-control-allow-origin') === '*' && res.headers.get('cache-control') === 'no-store',
      '/ping has CORS and no-store');
    ok((await fetch(`${http}/ping?room=ab`)).status === 400, '/ping refuses a malformed room name');
    ok((await fetch(`${http}/ping?room=acorn&shard=xx-1`)).status === 400, '/ping refuses a malformed shard');
    ok((await fetch(`${http}/_adopt`, { method: 'POST', body: '{}' })).status === 404, '/_adopt is not reachable from outside');
    ok((await fetch(`${http}/_released?room=acorn`, { method: 'POST', body: '{}' })).status === 404,
      '/_released is not reachable from outside');
    ok((await fetch(`${http}/_adopt`)).status === 404, 'GET /_adopt is not reachable either');
  }

  // A same-region pair starts where it is.
  const stayRoom = roomName('stay');
  const stay = await lobby(stayRoom, [
    { name: 'Erin', probes: EUROPE, rtt: 25, country: 'FR' },
    { name: 'Finn', probes: EUROPE, rtt: 30, country: 'BE' }
  ]);
  ok(stay[0].welcome.region === 'weur', 'welcome carries the room region');
  await stay[0].c.send({ t: 'start' });
  const stayBuild = await stay[0].c.wait('build').catch(() => null);
  await sleep(300);
  ok(stayBuild && !stay[0].c.has('move') && !stay[1].c.has('move'), 'a same-region pair does not move');
  const stayTalk = chatter(stay);

  // A mixed pair moves to the fairest region.
  const room = roomName('move');
  const pair = await lobby(room, [
    { name: 'Alice', probes: EUROPE, rtt: 300, country: 'DE' },
    { name: 'Chin', probes: ASIA, rtt: 20, country: 'SG' }
  ]);
  await pair[0].c.send({ t: 'start' });
  const moves = await Promise.all(pair.map((p) => p.c.wait('move').catch(() => null)));
  ok(moves.every((m) => m && m.shard === moves[0].shard && m.region === 'me' && /^[a-z0-9]{16}$/.test(m.ticket)),
    `both get move to the same shard with a ticket (${JSON.stringify(moves[0])})`);
  ok(!pair.some((p) => p.c.has('build')), 'the old room does not start the match');
  const shard = moves[0]?.shard;
  await sleep(1300);
  ok(pair.every((p) => p.c.closed?.code === 4000 && p.c.closed?.reason === 'moved'), 'old sockets close with 4000 moved');

  const moved = pair.map((p, i) => ({ ...p, c: client(query(room, { shard, ticket: moves[i].ticket }), p.country) }));
  for (const p of moved) await p.c.send({ t: 'join', room, name: 'ignored' });
  const welcomes = await Promise.all(moved.map((p) => p.c.wait('welcome').catch(() => null)));
  ok(welcomes.every((w, i) => w?.you === pair[i].pid && w.region === 'me' && w.moved), 'each seat comes back under its pid on the shard');
  ok(welcomes[0]?.host === true && welcomes[1]?.host === false, 'the host keeps hosting');
  const builds = await Promise.all(moved.map((p) => p.c.wait('build', 8000).catch(() => null)));
  ok(builds.every((b) => b?.round === 1), 'the match starts on the shard once both tickets are back');
  const builtAt = Date.now();
  const talk = chatter(moved);
  const shardPing = await fetch(`${http}/ping?room=${encodeURIComponent(room)}&shard=${shard}`);
  ok(shardPing.ok && (await shardPing.json()).region === 'me', '/ping with the shard answers the shard region');

  // A later connection to the old name is sent on to the shard.
  const late = client(query(room), 'AU');
  await late.send({ t: 'join', room, name: 'Dana' });
  const lateMove = await late.wait('move').catch(() => null);
  ok(lateMove?.shard === shard && !lateMove.ticket, 'a late joiner to the old name gets move without a ticket');
  const late2 = client(query(room, { shard }), 'AU');
  await late2.send({ t: 'join', room, name: 'Dana' });
  const lateErr = await late2.wait('err').catch(() => null);
  ok(lateErr?.code === 'match-started', 'and lands on the shard (refused there: the match is on)');
  close(late, late2);

  // A pair where only one ticket comes back: the shard waits ADOPT_WAIT, then that player
  // waits in the room for an opponent, where a late joiner lands.
  const lonely = roomName('lonely');
  const half = await lobby(lonely, [
    { name: 'Gus', probes: EUROPE, rtt: 310, country: 'IE' },
    { name: 'Hana', probes: ASIA, rtt: 15, country: 'JP' }
  ]);
  await half[0].c.send({ t: 'start' });
  const halfMoves = await Promise.all(half.map((p) => p.c.wait('move').catch(() => null)));
  const lonelyShard = halfMoves[0]?.shard;
  close(...half.map((p) => p.c));
  const back = client(query(lonely, { shard: lonelyShard, ticket: halfMoves[0]?.ticket }), 'IE');
  await back.send({ t: 'join', room: lonely, name: 'Gus' });
  ok((await back.wait('welcome').catch(() => null))?.moved, 'one ticket comes back');
  await sleep(6500);
  ok(!back.has('build'), 'the shard does not start a match with one player');
  let listed = null;
  for (let i = 0; i < 10 && !listed; i++) {
    const { lobbies } = await (await fetch(`${http}/lobbies`)).json();
    listed = lobbies.find((l) => l.name === lonely && l.shard === lonelyShard) ?? null;
    if (!listed) await sleep(300);
  }
  ok(listed?.region === 'me' && listed.joinable, `the lobby lists the waiting shard room (${JSON.stringify(listed)})`);
  const joiner = client(query(lonely), 'NZ');
  await joiner.send({ t: 'join', room: lonely, name: 'Ivy' });
  const joinerMove = await joiner.wait('move').catch(() => null);
  const joiner2 = client(query(lonely, { shard: joinerMove?.shard ?? '' }), 'NZ');
  await joiner2.send({ t: 'join', room: lonely, name: 'Ivy' });
  await joiner2.wait('welcome').catch(() => null);
  const joinedLobby = await joiner2.wait('lobby').catch(() => null);
  ok(joinedLobby?.players?.map((p) => p.name).join() === 'Gus,Ivy', 'the late joiner lands in the moved room');
  close(joiner, joiner2, back);
  let againWelcome = null;
  let again = null;
  for (let i = 0; i < 10 && !againWelcome; i++) {
    await sleep(500);
    again = client(query(lonely), 'NZ');
    await again.send({ t: 'create', room: lonely, name: 'Jo' });
    againWelcome = await Promise.race([again.wait('welcome').catch(() => null), again.wait('move').then(() => null, () => null)]);
    if (!againWelcome) close(again);
  }
  ok(againWelcome, 'once the shard empties, the old name hosts a room again');
  close(again);

  // Ten seconds of match, then one player leaves each: both records are sent.
  await sleep(Math.max(0, 10_500 - (Date.now() - builtAt)));
  clearInterval(talk);
  clearInterval(stayTalk);
  close(moved[1].c, stay[1].c);
  let records = [];
  for (let i = 0; i < 30; i++) {
    records = (await (await fetch(`${NETLOG}/records`)).json()).map((r) => r.record);
    if (records.some((r) => r.code === room) && records.some((r) => r.code === stayRoom)) break;
    await sleep(300);
  }
  const movedRecord = records.find((r) => r.code === room);
  const stayRecord = records.find((r) => r.code === stayRoom);
  ok(movedRecord?.region === 'me' && movedRecord.moved?.from === 'FRA' && movedRecord.moved?.to === 'me',
    `moved record: region and moved (${JSON.stringify(movedRecord && { region: movedRecord.region, moved: movedRecord.moved })})`);
  ok(movedRecord?.seats.map((s) => s.country).join() === 'DE,SG' && movedRecord.seats.every((s) => s.edge === 'TST'),
    'moved record: each player\'s country and edge');
  ok(stayRecord?.region === 'weur' && stayRecord.moved === null && stayRecord.seats.map((s) => s.country).join() === 'FR,BE',
    'unmoved record: region, moved null, countries');
  close(moved[0].c, stay[0].c);
  console.log(`${pass} passed, ${fail} failed`);
}

// Never leave wrangler running: on a signal, or if the test hangs.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopServers(); process.exit(1); });
setTimeout(() => { console.log('ERROR: test timed out'); stopServers(); process.exit(1); }, 150_000).unref();

main()
  .catch((error) => { console.log('ERROR:', error.stack || error.message); fail++; })
  .finally(() => { stopServers(); process.exit(fail ? 1 : 0); });
