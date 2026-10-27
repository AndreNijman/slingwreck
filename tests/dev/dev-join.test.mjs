#!/usr/bin/env node
// Dev join against wrangler dev, with a throwaway Ed25519 key: the relay is started with
// --var DEV_TEST_PUBLIC_KEY:<its public half> and the test signs passes with the private
// half (netdev.js signDevPass). Covers: a dev takes a seat in a locked lobby without the
// password; a dev at a full lobby watches and takes the seat that frees; a dev joining a
// running match watches it (the snapshot has both fortresses and the preview so far, and
// both attacks' frames follow, marked with the attacker); the room reopens for the
// watcher when both players are gone; everyone, the dev included, gets
// {t:'dev-joined', name}; a forged, expired or other-host pass is nobody (wrong-password,
// room-full and match-started exactly as before).
//
// Starts its own servers on 8862 (relay) and 8863 (NetLog stub), inspectors 9362/9363,
// with a private dev registry (WRANGLER, default node_modules/.bin/wrangler):
//   node tests/dev/dev-join.test.mjs

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encode } from '../../build.js?v=20261027-1';
import { signDevPass } from '../../netdev.js?v=20261027-1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOST = 'slingwreck.andrenijman.com';
const BASE = 'http://127.0.0.1:8862';
const FORTRESS = encode({
  v: 1,
  blocks: [['cube', 'wood', 5, 0.5, 0]],
  pigs: [['runt', 2, 0.296875, 0], ['king', 12, 0.6875, 0], ['runt', 22, 0.296875, 0]]
});

let pass = 0;
let fail = 0;
const ok = (condition, message, detail = '') => {
  if (condition) { pass++; console.log('ok  ', message, detail); }
  else { fail++; console.log('FAIL', message, detail); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

const servers = [];
let registry = '';
async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await sleep(500);
  }
  return false;
}
async function startServers(publicKey) {
  const local = path.join(ROOT, 'node_modules/.bin/wrangler');
  const bin = process.env.WRANGLER || (existsSync(local) ? local : 'npx');
  const pre = bin === 'npx' ? ['wrangler'] : [];
  registry = mkdtempSync(path.join(tmpdir(), 'slingwreck-devjoin-'));
  const run = (args) => servers.push(spawn(bin, [...pre, ...args], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
    env: { ...process.env, WRANGLER_REGISTRY_PATH: registry }
  }));
  run(['dev', '-c', 'tests/latency/netlog-stub.jsonc', '--port', '8863', '--inspector-port', '9363', '--ip', '127.0.0.1']);
  run(['dev', '--port', '8862', '--inspector-port', '9362', '--ip', '127.0.0.1',
    '--var', `DEV_TEST_PUBLIC_KEY:${publicKey}`]);
  if (!(await up('http://127.0.0.1:8863/')) || !(await up(`${BASE}/health`))) {
    throw new Error('wrangler dev did not come up');
  }
  await sleep(1500);
}
function stopServers() {
  for (const child of servers) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch {}
}

function client(room) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(room)}`,
    { headers: { Origin: 'http://localhost' } });
  const c = { ws, msgs: [], waiters: [], closed: null };
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = c.waiters.find((w) => w.type === message.t);
    if (waiter) {
      c.waiters = c.waiters.filter((w) => w !== waiter);
      waiter.resolve(message);
    } else c.msgs.push(message);
  });
  ws.addEventListener('close', (event) => { c.closed = { code: event.code }; });
  const opened = new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  c.send = async (message) => { await opened; ws.send(JSON.stringify(message)); };
  c.wait = (type, timeout = 6000) => new Promise((resolve) => {
    const hit = c.msgs.find((m) => m.t === type);
    if (hit) { c.msgs = c.msgs.filter((m) => m !== hit); resolve(hit); return; }
    const waiter = { type, resolve };
    c.waiters.push(waiter);
    setTimeout(() => { c.waiters = c.waiters.filter((w) => w !== waiter); resolve(null); }, timeout);
  });
  c.has = (type) => c.msgs.some((m) => m.t === type);
  c.close = () => { try { ws.close(); } catch {} };
  return c;
}
const roomName = (tag) => `dev ${tag} ${Math.random().toString(36).slice(2, 8)}`;

async function enter(room, kind, name, extra = {}) {
  const c = client(room);
  await c.send({ t: kind, room, name, ...extra });
  const first = await Promise.race([c.wait('welcome'), c.wait('err')]);
  return { c, welcome: first?.t === 'welcome' ? first : null, err: first?.t === 'err' ? first : null };
}

async function main() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = b64url(await crypto.subtle.exportKey('raw', keys.publicKey));
  const privateKey = b64url(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const otherKey = b64url(await crypto.subtle.exportKey('pkcs8', other.privateKey));
  const good = (await signDevPass(privateKey, { name: 'Andre', host: HOST })).pass;
  const bad = {
    forged: (await signDevPass(otherKey, { name: 'Andre', host: HOST })).pass,
    expired: (await signDevPass(privateKey, { name: 'Andre', host: HOST, ttl: -5 })).pass,
    'other host': (await signDevPass(privateKey, { name: 'Andre', host: 'fart.andrenijman.com' })).pass,
    'bare flag': 'true'
  };
  await startServers(publicKey);

  // A locked lobby: a dev sits down without the password; nobody else does.
  {
    const room = roomName('locked');
    const host = await enter(room, 'create', 'Hana', { password: 'sesame' });
    for (const [label, forged] of Object.entries(bad)) {
      const attempt = await enter(room, 'join', 'Mallory', { dev: forged });
      ok(attempt.err?.code === 'wrong-password', `${label} pass at a locked room: wrong-password as before`, attempt.err?.code);
      attempt.c.close();
    }
    const dev = await enter(room, 'join', 'Andre', { dev: good });
    ok(dev.welcome && dev.welcome.you > 0 && !dev.welcome.spectator, 'a dev takes the free seat in a locked lobby', JSON.stringify(dev.welcome?.you));
    const [seen, own] = await Promise.all([host.c.wait('dev-joined'), dev.c.wait('dev-joined')]);
    ok(seen?.name === 'ANDRE' && own?.name === 'ANDRE' && Object.keys(seen).join() === 't,name',
      'host and dev both get {t:"dev-joined", name:"ANDRE"}', JSON.stringify(seen));
    await sleep(200);
    const lobby = [...host.c.msgs].reverse().find((m) => m.t === 'lobby');
    ok(lobby?.players.length === 2, 'the lobby now has two players', JSON.stringify(lobby?.players.map((p) => p.name)));
    host.c.close();
    dev.c.close();
  }

  // A full lobby: a dev watches, and the seat that frees is theirs.
  {
    const room = roomName('full');
    const host = await enter(room, 'create', 'Hana');
    const guest = await enter(room, 'join', 'Gus');
    const forged = await enter(room, 'join', 'Mallory', { dev: bad.forged });
    ok(forged.err?.code === 'room-full', 'a forged pass at a full lobby: room-full as before', forged.err?.code);
    forged.c.close();
    const dev = await enter(room, 'join', 'Andre', { dev: good });
    ok(dev.welcome?.spectator === true && dev.welcome.you === -1, 'a dev at a full lobby watches', JSON.stringify(dev.welcome));
    const watch = await dev.c.wait('watch');
    ok(watch?.phase === 'lobby' && watch.players.length === 2, 'the watch snapshot has the lobby and both players', JSON.stringify(watch?.players));
    const joined = await Promise.all([host, guest, dev].map((p) => p.c.wait('dev-joined')));
    ok(joined.every((m) => m?.name === 'ANDRE'), 'all three get dev-joined');
    await dev.c.send({ t: 'ping', c: 7 });
    ok((await dev.c.wait('pong'))?.c === 7, 'a watcher gets pongs');
    await dev.c.send({ t: 'start' });
    await sleep(300);
    ok(!dev.c.has('err') && !host.c.has('build'), 'a watcher\'s match messages are ignored, not errors');
    guest.c.close();
    const seat = await dev.c.wait('welcome');
    ok(seat && seat.you > 0 && !seat.spectator, 'the guest leaves and the watching dev takes the seat', JSON.stringify(seat?.you));
    await sleep(200);
    const lobby = [...host.c.msgs].reverse().find((m) => m.t === 'lobby');
    ok(lobby?.players.map((p) => p.name).join() === 'Hana,Andre', 'the lobby shows host and dev', JSON.stringify(lobby?.players));
    await host.c.send({ t: 'start' });
    const builds = await Promise.all([host.c.wait('build'), dev.c.wait('build')]);
    ok(builds.every((b) => b?.round === 1), 'the host starts the next match with the dev in the seat');
    host.c.close();
    dev.c.close();
  }

  // A running match: a dev watches both attacks.
  {
    const room = roomName('siege');
    const host = await enter(room, 'create', 'Hana');
    const guest = await enter(room, 'join', 'Gus');
    await host.c.send({ t: 'start' });
    await Promise.all([host.c.wait('build'), guest.c.wait('build')]);
    const buildWatcher = await enter(room, 'join', 'Andre', { dev: good });
    const buildWatch = await buildWatcher.c.wait('watch');
    ok(buildWatcher.welcome?.spectator && buildWatch?.phase === 'build' && buildWatch.round === 1,
      'a dev joining during the build watches it', JSON.stringify({ phase: buildWatch?.phase, left: buildWatch?.left }));
    buildWatcher.c.close();
    await host.c.send({ t: 'lock', blueprint: FORTRESS });
    await guest.c.send({ t: 'lock', blueprint: FORTRESS });
    const sieges = await Promise.all([host.c.wait('siege', 10000), guest.c.wait('siege', 10000)]);
    ok(sieges.every(Boolean), 'the match reaches its siege');
    const hostPid = host.welcome.you;
    const guestPid = guest.welcome.you;
    // The host's attack on the guest's fortress moves block 0.
    const frame1 = { d: [[0, 6.1, 0.52, 1, 0, 0]], p: [], s: 40, a: 4, k: 400 };
    await host.c.send({ t: 'preview', frame: frame1 });
    await sleep(200);
    const late = await enter(room, 'join', 'Mallory', { dev: bad.expired });
    ok(late.err?.code === 'match-started', 'an expired pass mid-match: match-started as before', late.err?.code);
    late.c.close();
    const dev = await enter(room, 'join', 'Andre', { dev: good });
    ok(dev.welcome?.spectator === true, 'a dev joining a running match watches it');
    const watch = await dev.c.wait('watch');
    const attackOf = (pid) => watch?.attacks.find((a) => a.pid === pid);
    ok(watch?.phase === 'siege' && watch.attacks.length === 2, 'the snapshot has both attacks', JSON.stringify(watch?.attacks.map((a) => [a.pid, a.target])));
    ok(attackOf(hostPid)?.target === guestPid && attackOf(guestPid)?.target === hostPid && attackOf(hostPid)?.ammo > 0 &&
      watch.attacks.every((a) => a.blueprint === FORTRESS && Number.isFinite(a.seed)),
      'each attack carries its target, the fortress blueprint and the seed');
    ok(JSON.stringify(attackOf(hostPid)?.frame?.d) === JSON.stringify(frame1.d) && attackOf(hostPid)?.frame.s === 40,
      'the host\'s attack starts from the preview so far', JSON.stringify(attackOf(hostPid)?.frame));
    const joined = await Promise.all([host, guest, dev].map((p) => p.c.wait('dev-joined')));
    ok(joined.every((m) => m?.name === 'ANDRE'), 'both players and the dev get dev-joined mid-match');
    await sleep(150);
    guest.c.msgs = guest.c.msgs.filter((m) => m.t !== 'preview');
    const frame2 = { d: [[0, 6.3, 0.52, 1, 0, 0]], p: [[3, 1]], s: 90, a: 3, k: 460 };
    await host.c.send({ t: 'preview', frame: frame2 });
    const [toDev, toGuest] = await Promise.all([dev.c.wait('preview'), guest.c.wait('preview')]);
    ok(toDev?.by === hostPid && toDev.frame.s === 90, 'the watcher gets the host\'s frame marked with the attacker', JSON.stringify(toDev));
    ok(toGuest && toGuest.by === undefined && JSON.stringify(toGuest.frame) === JSON.stringify(frame2),
      'the defender still gets the frame untouched');
    await sleep(150);
    await guest.c.send({ t: 'preview', frame: { d: [[1, 2, 2, 1, 0, 0]], p: [], s: 10, a: 4, k: 500 } });
    ok((await dev.c.wait('preview'))?.by === guestPid, 'and the guest\'s attack too');
    const shot = await Promise.all([host.c.wait('siege-clock', 3000), dev.c.wait('siege-clock', 3000)]);
    ok(shot.every(Boolean), 'the siege clock reaches the watcher');
    // Both players gone for good: after the grace the room reopens with the dev in it.
    host.c.close();
    guest.c.close();
    const seat = await dev.c.wait('welcome', 35000);
    ok(seat && seat.you > 0 && seat.host === true, 'both players gone: the room reopens as a lobby and the dev hosts it', JSON.stringify(seat));
    const lobby = await dev.c.wait('lobby');
    ok(lobby?.phase === 'lobby' && lobby.players.length === 1 && lobby.players[0].name === 'Andre', 'the reopened lobby has the dev', JSON.stringify(lobby));
    const next = await enter(room, 'join', 'Ivy');
    ok(next.welcome && next.welcome.you > 0, 'and someone else can join it');
    next.c.close();
    dev.c.close();
  }

  // A build that loses a player hands the seat to the watching dev.
  {
    const room = roomName('build');
    const host = await enter(room, 'create', 'Hana');
    const guest = await enter(room, 'join', 'Gus');
    await host.c.send({ t: 'start' });
    await host.c.wait('build');
    const dev = await enter(room, 'join', 'Andre', { dev: good });
    ok(dev.welcome?.spectator === true, 'a dev joining a build watches it');
    guest.c.close();
    const seat = await dev.c.wait('welcome');
    ok(seat && seat.you > 0, 'the guest leaves the build: back to the lobby, and the dev sits down', JSON.stringify(seat?.you));
    host.c.close();
    dev.c.close();
  }

  // A dev who creates a room is an ordinary host who gets the banner too.
  {
    const room = roomName('create');
    const dev = await enter(room, 'create', 'Andre', { dev: good });
    ok(dev.welcome?.host === true && (await dev.c.wait('dev-joined'))?.name === 'ANDRE', 'a dev creating a room hosts it and sees dev-joined');
    const missing = await enter(roomName('none'), 'join', 'Andre', { dev: good });
    ok(missing.err?.code === 'room-missing', 'a dev cannot join a room that does not exist', missing.err?.code);
    missing.c.close();
    dev.c.close();
  }
}

try {
  await main();
} catch (error) {
  fail++;
  console.log('FAIL', error.stack || error);
} finally {
  stopServers();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
