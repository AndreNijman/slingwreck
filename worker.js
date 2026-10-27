// The SLINGWRECK relay.
//
// The two players' worlds never interact: you attack their fortress and they
// attack yours. There is therefore no authoritative 60 Hz dual-world sim. The
// relay is authority for build, then a cheap auditor of each independent siege.
// The relay persists the reconstructible input record, audits it incrementally,
// and never treats the lossy corner preview as authority.
//
//   GET /health   - liveness
//   GET /lobbies  - public lobby directory
//   GET /ping?room=<name>[&shard=<shard>] - where that room runs, { colo, region }
//   GET /ws?room=<name>[&shard=<shard>&ticket=<t>] - websocket, first message
//                   must be create, join or reconnect
//
// At match start a room whose two players are far apart may move to a fairer
// region (netplace.js): its Durable Object hands the room to a fresh one there,
// its "shard" (`<key>~<shard>`), and gives each player a ticket to reconnect
// with. Later connections to the old name are sent on to the shard until it
// empties. Internal routes between objects (/_adopt, /_released) are never
// forwarded.

import { BUDGET, CARDS_BY_ID, PIGS, SCORE, TUNE } from './data.js?v=20260904-2';
import {
  AUDIT_STEP_BUDGET,
  SETTLE_STEPS,
  advanceAudit,
  auditSnapshot,
  auditTarget,
  bagForRound,
  checkScore,
  checkShot,
  checkTap,
  checkRemoteTnt,
  createAudit,
  defaultDraftPick,
  draftTiers,
  finalizeAuditScore,
  matchWinner,
  previewAllowed,
  previewInterval,
  resolveRound,
  rollDraft,
  scoreCeiling,
  startSuddenDeath,
  validationMode
} from './relay-audit.js?v=20260904-2';
import {
  autoCompleteCandidates,
  budgetFor,
  decode,
  earlyLockScrap,
  encode,
  fromBlueprint,
  settleTest,
  spent,
  validate
} from './build.js?v=20260904-2';
import { PIG_FLAGS, PIG_FLAG_DECOY, PIG_ID, digestRound } from './sim.js?v=20260904-2';
import { NetStats, sendNetLog, coloOf } from './netstats.js?v=20260904-2';
import {
  REGIONS, chooseRegion, newShard, playerWhere, regionOfColo, roomStub, shardRegion,
  whereOf, withWhere
} from './netplace.js?v=20260904-2';

const TICK_MS = 250;
const ROOM_TTL = 45 * 60_000;
const REGISTRY_HEARTBEAT = 10_000;
const REGISTRY_STALE = 30_000;
const HANDSHAKE_MS = 12_000;
const MAX_MESSAGE = 8192;
const MAX_PLAYERS = 2;
const PASSWORD_MAX = 128;
const PASSWORD_ATTEMPTS = 5;
const PASSWORD_WINDOW = 60_000;
const ROOM_STATE_KEY = 'room-state';
const MOVED_KEY = 'moved';
const ADOPT_WAIT = 6000; // a moved room starts with whoever reconnected by then
const MOVE_CLOSE = 1000; // the old sockets close this long after `move`
const TICKET = /^[a-z0-9]{16}$/;
const PRODUCTION_ORIGIN = 'https://slingwreck.andrenijman.com';
const encoder = new TextEncoder();

export {
  bagForRound,
  checkScore,
  checkShot,
  checkTap,
  checkRemoteTnt,
  defaultDraftPick,
  draftTiers,
  finalizeAuditScore,
  matchWinner,
  previewAllowed,
  previewInterval,
  resolveRound,
  rollDraft,
  scoreCeiling,
  validationMode
};

export function cleanName(value, fallback = 'Wrecker', max = 16) {
  const limit = Math.max(0, Math.min(64, Math.floor(Number(max) || 0)));
  const name = String(value || '').replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
  return name || fallback;
}

export function roomKey(value) {
  return cleanName(value, '', 24).replace(/[^a-z0-9 _-]/gi, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

export function originAllowed(origin) {
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  try {
    const url = new URL(origin);
    if (url.origin !== origin.replace(/\/$/, '')) return false;
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' || url.hostname === '::1';
    if (local) return url.protocol === 'http:' || url.protocol === 'https:';
    if (url.protocol !== 'https:') return false;
    return url.origin === PRODUCTION_ORIGIN ||
      url.hostname.endsWith('.andrenijman.com') ||
      url.hostname.endsWith('.workers.dev');
  } catch {
    return false;
  }
}

export async function hashPassword(value) {
  const password = String(value ?? '').slice(0, PASSWORD_MAX);
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(password));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Both operands are SHA-256 hex digests, so the loop count never depends on the
// supplied password or on a mismatching prefix.
export function constantTimeEqual(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  let difference = a.length === 64 && b.length === 64 ? 0 : 1;
  for (let index = 0; index < 64; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function lobbyIsStale(lobby, now = Date.now()) {
  return !lobby || !Number.isFinite(lobby.updated) ||
    now - lobby.updated > REGISTRY_STALE;
}

export function partitionLobbies(entries, now = Date.now()) {
  const lobbies = [];
  const staleKeys = [];
  let freshEntries = 0;
  for (const [key, value] of entries) {
    if (lobbyIsStale(value, now)) {
      staleKeys.push(key);
      continue;
    }
    freshEntries++;
    if (value.phase !== 'lobby' || value.players < 1) continue;
    lobbies.push({ ...value, joinable: value.players < value.max });
  }
  lobbies.sort((a, b) => (Number(b.joinable) - Number(a.joinable)) ||
    (b.players - a.players) || (b.updated - a.updated));
  return { lobbies: lobbies.slice(0, 40), staleKeys, freshEntries };
}

// The relay's preview rate limit (relay-audit.js previewAllowed) with a little slack:
// frames leave the sender evenly, but uplink jitter bunches some of them up, and a
// strict per-frame gap threw those away. `lastPreviewAt` advances by the interval for
// each frame taken, so the average rate (Smokescreen's one per 3 s included) is the same.
const PREVIEW_SLACK = 60;
export function previewAccepted(session, now, cards = []) {
  if (!previewAllowed(session.lastPreviewAt, now + PREVIEW_SLACK, cards)) return false;
  session.lastPreviewAt = Number.isFinite(session.lastPreviewAt)
    ? Math.max(now, session.lastPreviewAt + previewInterval(cards)) : now;
  return true;
}

export function disconnectExpired(record, now = Date.now()) {
  return Boolean(record && !record.connected && record.graceDeadline &&
    now >= record.graceDeadline);
}

function wireError(code, message, pieceIds = [], reason) {
  return { code, message, pieceIds, ...(reason ? { reason } : {}) };
}

export function validateBlueprintSubmission(source, options = {}) {
  const decoded = decode(source);
  if (decoded?.ok === false) {
    return {
      ok: false,
      stage: 'decode',
      reason: decoded.reason,
      errors: [wireError(
        'malformed-blueprint',
        `Blueprint could not be decoded: ${decoded.reason}.`,
        [],
        decoded.reason
      )]
    };
  }
  try {
    const legality = validate(decoded, { ...options, mode: 'siege' });
    if (!legality.ok) {
      return { ok: false, stage: 'validate', errors: legality.errors };
    }
    // The settle test is advisory, never a gate: the relay only ever stores the *authored*
    // blueprint (record.blueprint below is always `result.encoded`, this same `source` —
    // never a settled pose), and the siege phase's own SETTLE_STEPS preflight runs the exact
    // same fixed-length simulation on both sides regardless of what settleTest found here. A
    // fortress that fails it is accepted and simply falls into whatever shape it falls into;
    // the findings travel back as `warnings` so the client can say so instead of refusing to
    // continue. Legality above stays a hard gate — those are the game's rules, not a physics
    // outcome the player is being asked to tolerate.
    const settled = settleTest(decoded, options);
    const warnings = [];
    if (!settled.ok) {
      if (settled.movedPieces.length) warnings.push(wireError(
        'unstable', 'One or more pieces may move before the siege begins.',
        settled.movedPieces
      ));
      if (settled.deadPigs.length) {
        // A dead pig is a lesser fortress; a dead King is the round, lost before the first
        // shot. Real (non-Decoy) King only, the same test sim.js's own isKing uses — a Decoy
        // King dying is cosmetic, not a loss condition. This is the one warning worth
        // escalating rather than stating flatly.
        const kingDied = settled.deadPigs.some((id) => {
          const tuple = decoded.pigs[Number(id.split(':')[1])];
          return tuple && PIGS[tuple[PIG_ID]]?.traits.king &&
            !((tuple[PIG_FLAGS] ?? 0) & PIG_FLAG_DECOY);
        });
        warnings.push(wireError(
          'pig-died',
          kingDied
            ? 'Your King may die before the siege begins — that loses the round outright.'
            : 'One or more pigs may die before the siege begins.',
          settled.deadPigs
        ));
      }
      if (!settled.settled && !warnings.length) warnings.push(wireError(
        'not-settled', 'The fortress may not finish settling before the siege begins.', []
      ));
    }
    const cost = spent(fromBlueprint(decoded, options));
    return { ok: true, blueprint: decoded, encoded: source, settled, cost, warnings };
  } catch {
    return {
      ok: false,
      stage: 'validate',
      reason: 'malformed',
      errors: [wireError(
        'malformed-blueprint', 'Blueprint validation failed safely.', [], 'malformed'
      )]
    };
  }
}

// Timer expiry first tries to preserve the authored draft, then its blocks, and
// finally uses the smallest deterministic legal fortress. It never invents a
// settled pose: every candidate is still an authored blueprint and is tested by
// the exact same validation path as an explicit lock-in. The candidate ladder is
// build.js's, shared with the solo client so the two cannot drift.
export function autoCompleteBlueprint(source, options = {}) {
  const decoded = decode(source);
  const candidates = autoCompleteCandidates(decoded?.ok === false ? null : decoded);

  const tried = new Set();
  for (const candidate of candidates) {
    let encoded;
    try { encoded = encode(candidate); } catch { continue; }
    if (tried.has(encoded)) continue;
    tried.add(encoded);
    const result = validateBlueprintSubmission(encoded, options);
    if (result.ok) return { ...result, autoCompleted: true };
  }
  return {
    ok: false,
    stage: 'auto-complete',
    errors: [wireError(
      'auto-complete-failed', 'The relay could not create a legal fallback.', []
    )]
  };
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

function clientIp(request) {
  return cleanName(request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') || 'unknown', 'unknown', 64);
}

function randomSeed() {
  const words = new Uint32Array(1);
  crypto.getRandomValues(words);
  return words[0] | 0;
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// A player's netprobe.js results as sent ({ weur: 38, apac: 290 }), kept to known regions.
export function cleanProbes(ms) {
  if (!ms || typeof ms !== 'object') return null;
  const out = {};
  for (const region of REGIONS) {
    const value = Number(ms[region]);
    if (Number.isFinite(value) && value > 0 && value < 10_000) out[region] = Math.round(value);
  }
  return Object.keys(out).length ? out : null;
}

function median(values) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
}

function newTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_')) return new Response('not found', { status: 404 });
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      } });
    }
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'slingwreck-relay', maxPlayers: MAX_PLAYERS });
    }
    if (url.pathname === '/lobbies') {
      return env.REGISTRY.getByName('global')
        .fetch(new Request('https://registry/list'));
    }
    if (url.pathname !== '/ws' && url.pathname !== '/ping') {
      return new Response('SLINGWRECK relay. Connect over websocket at /ws\n', {
        status: 404
      });
    }
    const key = roomKey(url.searchParams.get('room'));
    const shard = url.searchParams.get('shard') || '';
    const ticket = url.searchParams.get('ticket') || '';
    if (key.length < 3 || shard && !shardRegion(shard) || ticket && !TICKET.test(ticket)) {
      return json({ error: 'lobby names need at least 3 characters' }, 400);
    }
    // A room's ping target, timed by the lobby list and the waiting room. It
    // never creates a room: the object only reports where it runs.
    if (url.pathname === '/ping') {
      return roomStub(env.ROOMS, key, shard).fetch(new Request('https://room/ping'));
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('upgrade required', { status: 426 });
    }
    if (!originAllowed(request.headers.get('Origin'))) {
      return new Response('origin not allowed', { status: 403 });
    }
    const headers = new Headers(request.headers);
    headers.set('X-Slingwreck-IP', clientIp(request));
    // Where the player connects from, for the lag log (request.cf is only
    // reliable here). DEV_TRUST_WHERE (wrangler dev --var) lets tests fake it.
    const where = playerWhere(request, { trustHeaders: env.DEV_TRUST_WHERE === '1' });
    return roomStub(env.ROOMS, key, shard)
      .fetch(withWhere(new Request(request, { headers }), where));
  }
};

export class LobbyRegistry {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async prune(now = Date.now()) {
    const entries = await this.ctx.storage.list({ prefix: 'room:' });
    const result = partitionLobbies(entries, now);
    await Promise.all(result.staleKeys.map((key) => this.ctx.storage.delete(key)));
    return result;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/list') {
      const result = await this.prune();
      return json({ lobbies: result.lobbies });
    }
    if (request.method !== 'POST') return new Response('not found', { status: 404 });
    let body;
    try { body = await request.json(); } catch {
      return new Response('invalid registry message', { status: 400 });
    }
    const key = roomKey(body?.key);
    if (!key) return new Response('invalid room key', { status: 400 });
    const storageKey = `room:${key}`;
    if (path === '/upsert') {
      const source = body?.lobby ?? {};
      const lobby = {
        name: cleanName(source.name, key, 24),
        key,
        players: Math.max(0, Math.min(MAX_PLAYERS, Math.floor(source.players) || 0)),
        max: MAX_PLAYERS,
        locked: Boolean(source.locked),
        phase: String(source.phase || 'lobby'),
        round: Math.max(0, Math.floor(source.round) || 0),
        region: REGIONS.includes(source.region) ? source.region : '',
        shard: shardRegion(source.shard) ? source.shard : '',
        updated: Number.isFinite(source.updated) ? source.updated : Date.now()
      };
      await this.ctx.storage.put(storageKey, lobby);
      await this.ctx.storage.setAlarm(Date.now() + REGISTRY_HEARTBEAT);
      return new Response(null, { status: 204 });
    }
    if (path === '/remove') {
      await this.ctx.storage.delete(storageKey);
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    const result = await this.prune();
    if (result.freshEntries) {
      await this.ctx.storage.setAlarm(Date.now() + REGISTRY_HEARTBEAT);
    }
  }
}

export class SiegeRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.players = new Map();
    this.room = '';
    this.key = '';
    this.host = -1;
    this.passwordHash = '';
    this.locked = false;
    this.phase = 'lobby';
    this.round = 0;
    this.seed = 0;
    this.nextPid = 1;
    this.deadline = 0;
    this.timer = null;
    this.touched = Date.now();
    this.lastRegistrySync = 0;
    this.lastClockSecond = -1;
    this.registryQueue = Promise.resolve();
    this.passwordAttempts = new Map();
    this.audits = new Map();
    this.result = null;
    this.draftPid = -1;
    this.validateMode = validationMode(env);
    this.net = null; // lag stats for the match in progress
    this.colo = '';
    // Room placement (netplace.js). In a room's own object: `moved` once its
    // room moved to a shard ({ shard, region }, also in storage). In a shard:
    // its name, the colo the room came from, and until the match starts the
    // seats waiting for their tickets.
    this.moved = null;
    this.moving = false;
    this.moveTried = false;
    this.shard = '';
    this.movedFrom = '';
    this.adoption = null;
    this.ctx.blockConcurrencyWhile(async () => {
      await this.restore();
      if (this.key) this.ensureTimer();
    });
  }

  roomState() {
    return {
      room: this.room,
      key: this.key,
      host: this.host,
      passwordHash: this.passwordHash,
      locked: this.locked,
      phase: this.phase,
      round: this.round,
      seed: this.seed,
      nextPid: this.nextPid,
      deadline: this.deadline,
      touched: this.touched,
      result: this.result,
      draftPid: this.draftPid,
      shard: this.shard,
      movedFrom: this.movedFrom,
      players: [...this.players.values()]
    };
  }

  async persist() {
    if (!this.key) return;
    await this.ctx.storage.put(ROOM_STATE_KEY, this.roomState());
  }

  async restore() {
    this.moved = (await this.ctx.storage.get(MOVED_KEY)) ?? null;
    const saved = await this.ctx.storage.get(ROOM_STATE_KEY);
    if (!saved?.key || !Array.isArray(saved.players)) return;
    this.room = saved.room;
    this.key = saved.key;
    this.host = saved.host;
    this.passwordHash = saved.passwordHash;
    this.locked = saved.locked;
    this.phase = saved.phase;
    this.round = saved.round;
    this.seed = saved.seed;
    this.nextPid = saved.nextPid;
    this.deadline = saved.deadline;
    this.touched = saved.touched;
    this.result = saved.result ?? null;
    this.draftPid = saved.draftPid ?? -1;
    this.shard = saved.shard ?? '';
    this.movedFrom = saved.movedFrom ?? '';
    const now = Date.now();
    for (const record of saved.players) {
      record.connected = false;
      if (this.phase === 'siege') {
        record.disconnectedAt = now;
        record.graceDeadline = now + TUNE.disconnectGraceSeconds * 1000;
      }
      this.players.set(record.pid, record);
    }
  }

  auditFor(record) {
    if (this.validateMode === 'lenient' || !record.siege) return null;
    let audit = this.audits.get(record.pid);
    if (audit) return audit;
    const blueprint = decode(record.siege.blueprint);
    if (blueprint?.ok === false) return null;
    audit = createAudit({
      blueprint,
      seed: record.siege.seed,
      bag: record.siege.bag,
      attackerCards: record.siege.attackerCards,
      defenderCards: record.siege.defenderCards
    });
    this.audits.set(record.pid, audit);
    return audit;
  }

  // -- plumbing ----------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/_adopt') {
      return this.adopt(await request.json().catch(() => null));
    }
    if (request.method === 'POST' && url.pathname === '/_released') {
      await this.released((await request.json().catch(() => null))?.shard);
      return new Response(null, { status: 204 });
    }
    await this.locate();
    // Before the upgrade check, and without touching the room clock: a ping
    // keeps nothing alive and creates nothing.
    if (url.pathname === '/ping') return json({ colo: this.colo, region: this.region() });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('upgrade required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const ticket = url.searchParams.get('ticket') || '';
    // The room moved: send the player on to its shard, where they connect as usual.
    if (this.moved && !ticket) {
      this.send(server, { t: 'move', shard: this.moved.shard, region: this.moved.region });
      setTimeout(() => { try { server.close(4000, 'moved'); } catch {} }, MOVE_CLOSE);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const session = {
      socket: server,
      pid: -1,
      ready: false,
      dropped: false,
      ip: cleanName(request.headers.get('X-Slingwreck-IP'), 'unknown', 64),
      routeKey: roomKey(url.searchParams.get('room')),
      where: whereOf(request),
      routeShard: shardRegion(url.searchParams.get('shard')) ? url.searchParams.get('shard') : '',
      ticket,
      regions: null, // this player's netprobe.js results
      rtts: [], // their last five reported pings
      queue: Promise.resolve(),
      handshakeTimer: 0,
      lastPreviewAt: -Infinity
    };
    this.sessions.set(server, session);
    this.touched = Date.now();
    session.handshakeTimer = setTimeout(() => {
      if (!session.ready) server.close(1008, 'handshake timeout');
    }, HANDSHAKE_MS);
    server.addEventListener('message', (event) => {
      session.queue = session.queue.then(() => this.onMessage(session, event.data))
        .catch((error) => {
          console.error(JSON.stringify({
            message: 'room message failed',
            error: error instanceof Error ? error.message : String(error)
          }));
          this.sendError(session, 'relay-error', 'relay error');
        });
    });
    server.addEventListener('close', () => { void this.drop(session); });
    server.addEventListener('error', () => { void this.drop(session); });
    this.ensureTimer();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  sendError(session, code, message, extra = {}) {
    this.send(session.socket, { t: 'err', code, m: message, ...extra });
  }

  broadcast(message) {
    const encoded = JSON.stringify(message);
    for (const session of this.sessions.values()) {
      if (session.ready && session.socket.readyState === 1) session.socket.send(encoded);
    }
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error(JSON.stringify({
        message: 'room tick failed',
        error: error instanceof Error ? error.message : String(error)
      })));
    }, TICK_MS);
  }

  registryRequest(path, body) {
    const request = new Request(`https://registry/${path}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    this.registryQueue = this.registryQueue.then(async () => {
      const response = await this.env.REGISTRY.getByName('global').fetch(request);
      if (!response.ok) throw new Error(`registry ${path} returned ${response.status}`);
    }).catch((error) => {
      console.error(JSON.stringify({
        message: 'registry sync failed',
        error: error instanceof Error ? error.message : String(error)
      }));
    });
    this.ctx.waitUntil(this.registryQueue);
    return this.registryQueue;
  }

  syncRegistry() {
    if (!this.key) return Promise.resolve();
    const lobby = {
      name: this.room,
      key: this.key,
      players: this.players.size,
      max: MAX_PLAYERS,
      locked: this.locked,
      phase: this.phase,
      round: this.round,
      region: this.region(),
      shard: this.shard,
      updated: Date.now()
    };
    this.lastRegistrySync = lobby.updated;
    return this.registryRequest('upsert', { key: this.key, lobby });
  }

  removeRegistry() {
    if (!this.key) return Promise.resolve();
    this.lastRegistrySync = 0;
    return this.registryRequest('remove', { key: this.key });
  }

  async reset() {
    this.endNetLog('closed');
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.shard) this.release();
    if (this.adoption) clearTimeout(this.adoption.timer);
    this.adoption = null;
    this.moveTried = false;
    const registryWork = this.removeRegistry();
    this.players.clear();
    this.room = '';
    this.key = '';
    this.host = -1;
    this.passwordHash = '';
    this.locked = false;
    this.phase = 'lobby';
    this.round = 0;
    this.seed = 0;
    this.deadline = 0;
    this.result = null;
    this.draftPid = -1;
    this.audits.clear();
    this.passwordAttempts.clear();
    this.shard = '';
    this.movedFrom = '';
    await Promise.all([registryWork, this.ctx.storage.delete(ROOM_STATE_KEY)]);
  }

  // -- membership --------------------------------------------------------

  async onMessage(session, raw) {
    if (typeof raw !== 'string') {
      this.sendError(session, 'binary-message', 'binary messages are not accepted');
      session.socket.close(1003, 'text messages only');
      return;
    }
    if (raw.length > MAX_MESSAGE || encoder.encode(raw).byteLength > MAX_MESSAGE) {
      this.sendError(session, 'message-too-large', `messages are capped at ${MAX_MESSAGE} bytes`);
      session.socket.close(1009, 'message too large');
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch {
      this.sendError(session, 'invalid-json', 'message must be valid JSON');
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') {
      this.sendError(session, 'invalid-message', 'message needs a string type');
      return;
    }
    this.touched = Date.now();
    if (!session.ready) {
      await this.handshake(session, message);
      return;
    }
    const record = this.players.get(session.pid);
    if (!record) {
      this.sendError(session, 'not-in-room', 'player is no longer in this room');
      return;
    }

    if (message.t === 'ping') {
      // The last five reported pings, for placement at match start.
      if (typeof message.rtt === 'number' && message.rtt > 0 && message.rtt < 60_000) {
        const rtts = session.rtts ??= [];
        rtts.push(message.rtt);
        if (rtts.length > 5) rtts.shift();
      }
      this.net?.ping(session.pid, message.rtt, message.fps, message.frameMax);
      this.send(session.socket, { t: 'pong', c: message.c });
      return;
    }
    if (message.t === 'regions') {
      session.regions = cleanProbes(message.ms);
      return;
    }
    if (message.t === 'name') {
      if (this.phase !== 'lobby') {
        this.sendError(session, 'wrong-phase', 'names can only change in the lobby');
        return;
      }
      record.name = cleanName(message.name, record.name);
      this.sendLobby();
      await this.syncRegistry();
      return;
    }
    if (message.t === 'start') {
      await this.startBuild(session);
      return;
    }
    if (message.t === 'draft') {
      await this.saveDraft(session, record, message);
      return;
    }
    if (message.t === 'draft-pick') {
      await this.pickDraft(session, record, message.card);
      return;
    }
    if (message.t === 'lock') {
      await this.lockBlueprint(session, record, message);
      return;
    }
    if (['shot', 'tap', 'remote-tnt', 'shot-end', 'score', 'round-over'].includes(message.t)) {
      await this.handleSiegePhaseMessage(session, message);
      return;
    }
    if (message.t === 'preview') {
      this.handlePreviewMessage(session, message);
      return;
    }
    if (['audit', 'digest'].includes(message.t)) {
      await this.handleAuditMessage(session, message);
      return;
    }
    if (['reconnect', 'resume'].includes(message.t)) {
      await this.handleReconnectMessage(session, message);
      return;
    }
    this.sendError(session, 'unknown-message', `unknown message type: ${message.t}`);
  }

  takePasswordAttempt(ip, now) {
    const attempts = (this.passwordAttempts.get(ip) ?? [])
      .filter((at) => now - at < PASSWORD_WINDOW);
    if (attempts.length >= PASSWORD_ATTEMPTS) {
      this.passwordAttempts.set(ip, attempts);
      return false;
    }
    attempts.push(now);
    this.passwordAttempts.set(ip, attempts);
    return true;
  }

  async handshake(session, message) {
    if (session.ticket) {
      await this.ticketHandshake(session, message);
      return;
    }
    if (message.t === 'reconnect') {
      await this.reconnectHandshake(session, message);
      return;
    }
    if (message.t !== 'create' && message.t !== 'join') {
      this.sendError(session, 'handshake-required', 'send create, join, or reconnect first');
      session.socket.close(1008, 'handshake required');
      return;
    }
    const requested = cleanName(message.room, '', 24);
    const key = roomKey(requested);
    if (key.length < 3 || key !== session.routeKey) {
      this.reject(session, 'invalid-room', 'lobby names need at least 3 characters');
      return;
    }

    if (message.t === 'create') {
      if (this.players.size || this.key) {
        this.reject(session, 'room-exists', 'a lobby with that name already exists');
        return;
      }
      const password = String(message.password ?? '').slice(0, PASSWORD_MAX);
      const passwordHash = await hashPassword(password);
      if (this.players.size || this.key) {
        this.reject(session, 'room-exists', 'a lobby with that name already exists');
        return;
      }
      this.room = requested;
      this.key = key;
      this.passwordHash = passwordHash;
      this.locked = password.length > 0;
      // A create can land on a shard object when its release never reached the
      // room's own object (which still sends everyone here). Knowing its shard
      // name, it lists itself correctly and releases the name when it empties.
      if (session.routeShard) this.shard = session.routeShard;
    } else {
      if (!this.players.size || this.key !== key) {
        this.reject(session, 'room-missing', 'no lobby has that name');
        return;
      }
      if (this.phase !== 'lobby' || this.adoption) {
        this.reject(session, 'match-started', 'that match has already started');
        return;
      }
      if (this.players.size >= MAX_PLAYERS) {
        this.reject(session, 'room-full', 'that lobby is full');
        return;
      }
      if (this.locked) {
        const now = Date.now();
        if (!this.takePasswordAttempt(session.ip, now)) {
          this.reject(session, 'password-rate-limit', 'too many password attempts; try again later');
          return;
        }
        const suppliedHash = await hashPassword(message.password ?? '');
        if (!this.players.size || this.key !== key || this.phase !== 'lobby') {
          this.reject(session, 'room-changed', 'that lobby is no longer available');
          return;
        }
        if (this.players.size >= MAX_PLAYERS) {
          this.reject(session, 'room-full', 'that lobby is full');
          return;
        }
        if (!constantTimeEqual(this.passwordHash, suppliedHash)) {
          this.reject(session, 'wrong-password', 'wrong lobby password');
          return;
        }
        this.passwordAttempts.delete(session.ip);
      }
    }

    const resumeToken = randomToken();
    const resumeTokenHash = await hashPassword(resumeToken);
    if (message.t === 'join' && this.players.size >= MAX_PLAYERS) {
      this.reject(session, 'room-full', 'that lobby is full');
      return;
    }
    const pid = this.nextPid++;
    const record = {
      pid,
      name: cleanName(message.name),
      wins: 0,
      cards: [],
      bankedScrap: 0,
      roundCarry: 0,
      budget: 0,
      draft: '',
      draftOffer: null,
      blueprint: '',
      fortressCost: 0,
      locked: false,
      autoCompleted: false,
      connected: true,
      disconnectedAt: 0,
      graceDeadline: 0,
      resumeTokenHash,
      where: session.where ?? null,
      siege: null
    };
    this.players.set(pid, record);
    session.pid = pid;
    session.ready = true;
    clearTimeout(session.handshakeTimer);
    if (this.host < 0) this.host = pid;
    this.send(session.socket, {
      t: 'welcome',
      you: pid,
      room: this.room,
      host: this.host === pid,
      max: MAX_PLAYERS,
      resumeToken,
      region: this.region(),
      tune: {
        buildSeconds: TUNE.buildSeconds,
        winsNeeded: TUNE.winsNeeded,
        maxRounds: TUNE.maxRounds
      }
    });
    this.sendLobby();
    await this.persist();
    await this.syncRegistry();
  }

  async reconnectHandshake(session, message) {
    const key = roomKey(message.room);
    const pid = Number(message.pid);
    const record = this.players.get(pid);
    if (key !== this.key || key !== session.routeKey || !record ||
        this.phase !== 'siege' && this.phase !== 'round-over' && this.phase !== 'draft') {
      this.reject(session, 'resume-missing', 'that resumable round no longer exists');
      return;
    }
    const resumeToken = randomToken();
    const [supplied, resumeTokenHash] = await Promise.all([
      hashPassword(message.token ?? ''),
      hashPassword(resumeToken)
    ]);
    if (!constantTimeEqual(record.resumeTokenHash, supplied)) {
      this.reject(session, 'resume-denied', 'resume identity could not be verified');
      return;
    }
    if (record.connected) {
      this.reject(session, 'already-connected', 'that player is already connected');
      return;
    }
    record.resumeTokenHash = resumeTokenHash;
    record.connected = true;
    record.disconnectedAt = 0;
    record.graceDeadline = 0;
    this.net?.reconnect(pid);
    session.pid = pid;
    session.ready = true;
    clearTimeout(session.handshakeTimer);
    this.send(session.socket, {
      t: 'welcome',
      you: pid,
      room: this.room,
      host: this.host === pid,
      max: MAX_PLAYERS,
      reconnected: true,
      resumeToken
    });
    if (this.phase === 'draft') this.sendDraftOffer(record);
    else await this.sendResume(session, record);
    this.broadcast({
      t: 'opponent-reconnected',
      pid,
      m: `${record.name} reconnected.`
    });
    await this.persist();
  }

  reject(session, code, reason) {
    this.sendError(session, code, reason);
    setTimeout(() => session.socket.close(1008, reason.slice(0, 123)), 25);
  }

  async drop(session) {
    if (session.dropped) return;
    session.dropped = true;
    clearTimeout(session.handshakeTimer);
    this.sessions.delete(session.socket);
    if (session.pid < 0) return;
    const record = this.players.get(session.pid);
    if (!record) return;
    if (this.phase === 'siege' || this.phase === 'round-over' || this.phase === 'draft') {
      const now = Date.now();
      record.connected = false;
      record.disconnectedAt = now;
      record.graceDeadline = this.phase === 'draft'
        ? this.deadline : now + TUNE.disconnectGraceSeconds * 1000;
      this.broadcast({
        t: 'opponent-disconnected',
        pid: record.pid,
        grace: TUNE.disconnectGraceSeconds,
        m: `${record.name} disconnected; ${TUNE.disconnectGraceSeconds} seconds to reconnect.`
      });
      await this.persist();
      if (!this.sessions.size) {
        await this.ctx.storage.setAlarm(record.graceDeadline);
      }
      return;
    }
    const wasHost = session.pid === this.host;
    this.players.delete(session.pid);
    if (!this.players.size) {
      if (this.adoption) return; // a moved room waits for the rest of its seats
      if (!this.sessions.size) {
        await this.reset();
      } else {
        await this.removeRegistry();
        this.room = '';
        this.key = '';
        this.host = -1;
        this.passwordHash = '';
        this.locked = false;
        this.phase = 'lobby';
        this.round = 0;
        this.seed = 0;
        this.deadline = 0;
        this.passwordAttempts.clear();
        await this.ctx.storage.delete(ROOM_STATE_KEY);
      }
      return;
    }
    if (wasHost) this.host = this.players.keys().next().value;
    if (this.phase === 'build') {
      this.endNetLog('abandoned');
      this.phase = 'lobby';
      this.round = 0;
      this.deadline = 0;
      for (const player of this.players.values()) {
        player.draft = '';
        player.blueprint = '';
        player.locked = false;
      }
      this.broadcast({ t: 'build-cancelled', m: 'opponent left during build' });
    }
    this.sendLobby();
    await this.persist();
    await this.syncRegistry();
  }

  sendLobby() {
    this.broadcast({
      t: 'lobby',
      room: this.room,
      host: this.host,
      phase: this.phase,
      region: this.region(),
      max: MAX_PLAYERS,
      players: [...this.players.values()].map((player) => ({
        pid: player.pid,
        name: player.name,
        wins: player.wins
      }))
    });
  }

  // -- authoritative build ----------------------------------------------

  async startBuild(session) {
    if (session.pid !== this.host) {
      this.sendError(session, 'host-only', 'only the host can start the match');
      return;
    }
    if (this.phase !== 'lobby') {
      this.sendError(session, 'wrong-phase', 'the room is not in the lobby phase');
      return;
    }
    if (this.players.size !== MAX_PLAYERS) {
      this.sendError(session, 'need-two-players', 'exactly two players are required');
      return;
    }
    if (this.moving) return;
    // A new match may first move somewhere fairer for both players.
    const choice = this.mayMove()
      ? chooseRegion([...this.players.keys()].map((pid) => this.placeOf(pid))) : null;
    if (choice && await this.moveRoom(choice)) return;
    if (this.phase !== 'lobby' || this.players.size !== MAX_PLAYERS) return;
    await this.beginMatch();
  }

  async beginMatch() {
    this.seed = randomSeed();
    this.result = null;
    this.draftPid = -1;
    this.startNetLog();
    await this.beginBuild(1);
  }

  async beginBuild(round) {
    this.phase = 'build';
    this.round = round;
    this.audits.clear();
    this.deadline = Date.now() + TUNE.buildSeconds * 1000;
    this.lastClockSecond = TUNE.buildSeconds;
    const leadingWins = Math.max(...[...this.players.values()].map((player) => player.wins));
    for (const player of this.players.values()) {
      const roundsBehind = leadingWins - player.wins;
      player.roundCarry = player.bankedScrap;
      player.bankedScrap = 0;
      player.budget = budgetFor({
        round: this.round,
        roundsBehind,
        bankedScrap: player.roundCarry,
        cards: player.cards
      });
      player.draft = '';
      player.draftOffer = null;
      player.blueprint = '';
      player.fortressCost = 0;
      player.locked = false;
      player.autoCompleted = false;
      player.siege = null;
      const target = [...this.sessions.values()].find((entry) => entry.pid === player.pid);
      if (target) this.send(target.socket, {
        t: 'build',
        round: this.round,
        budget: player.budget,
        cards: player.cards,
        left: TUNE.buildSeconds
      });
    }
    await this.persist();
    await this.syncRegistry();
  }

  buildOptions(record) {
    const leadingWins = Math.max(...[...this.players.values()].map((player) => player.wins));
    return {
      mode: 'siege',
      round: this.round,
      roundsBehind: leadingWins - record.wins,
      bankedScrap: record.roundCarry,
      cards: record.cards,
      seed: this.seed ^ record.pid ^ this.round
    };
  }

  async saveDraft(session, record, message) {
    if (this.phase !== 'build') {
      this.sendError(session, 'wrong-phase', 'drafts are accepted only during build');
      return;
    }
    if (record.locked) {
      this.sendError(session, 'already-locked', 'the blueprint is already locked');
      return;
    }
    const decoded = decode(message.blueprint);
    if (decoded?.ok === false) {
      this.send(session.socket, {
        t: 'draft-rejected',
        reason: decoded.reason,
        errors: [wireError(
          'malformed-blueprint',
          `Blueprint could not be decoded: ${decoded.reason}.`,
          [],
          decoded.reason
        )]
      });
      return;
    }
    record.draft = message.blueprint;
    this.send(session.socket, { t: 'draft-saved' });
    await this.persist();
  }

  async lockBlueprint(session, record, message) {
    if (this.phase !== 'build') {
      this.sendError(session, 'wrong-phase', 'lock-in is accepted only during build');
      return;
    }
    if (record.locked) {
      this.sendError(session, 'already-locked', 'the blueprint is already locked');
      return;
    }
    const result = validateBlueprintSubmission(
      message.blueprint,
      this.buildOptions(record)
    );
    if (!result.ok) {
      this.send(session.socket, {
        t: 'build-rejected',
        stage: result.stage,
        reason: result.reason ?? null,
        errors: result.errors
      });
      return;
    }
    record.draft = result.encoded;
    record.blueprint = result.encoded;
    record.fortressCost = result.cost;
    record.locked = true;
    const secondsRemaining = Math.max(0, (this.deadline - Date.now()) / 1000);
    const banked = earlyLockScrap(secondsRemaining);
    record.bankedScrap += banked;
    this.send(session.socket, {
      t: 'locked',
      bankedScrap: banked,
      totalBankedScrap: record.bankedScrap,
      warnings: result.warnings
    });
    this.broadcast({
      t: 'build-status',
      locked: [...this.players.values()].filter((player) => player.locked)
        .map((player) => player.pid)
    });
    if ([...this.players.values()].every((player) => player.locked)) {
      await this.finishBuild();
    } else {
      await this.persist();
    }
  }

  async finishBuild() {
    if (this.phase !== 'build') return;
    for (const record of this.players.values()) {
      if (record.locked) continue;
      const result = autoCompleteBlueprint(record.draft, this.buildOptions(record));
      if (!result.ok) {
        this.broadcast({
          t: 'err',
          code: 'auto-complete-failed',
          m: 'build auto-complete failed',
          errors: result.errors
        });
        return;
      }
      record.blueprint = result.encoded;
      record.fortressCost = result.cost;
      record.locked = true;
      record.autoCompleted = true;
    }
    this.phase = 'siege';
    const startedAt = Date.now();
    this.deadline = startedAt + TUNE.roundSeconds * 1000;
    this.lastClockSecond = TUNE.roundSeconds;
    const roster = [...this.players.values()];
    for (const player of roster) {
      const opponent = roster.find((record) => record.pid !== player.pid);
      const blueprint = decode(opponent.blueprint);
      const bag = bagForRound(this.seed, this.round, player.cards);
      player.siege = {
        startedAt,
        seed: this.seed,
        blueprint: opponent.blueprint,
        bag,
        attackerCards: [...player.cards],
        defenderCards: [...opponent.cards],
        log: [],
        boundaries: [],
        shotCount: 0,
        tappedShot: -1,
        lastShotStep: null,
        lastShotAt: startedAt,
        scoreCeiling: scoreCeiling(blueprint, bag.length, opponent.cards),
        verifiedScore: 0,
        verifiedDamage: 0,
        verifiedStep: SETTLE_STEPS,
        verifiedDigest: null,
        spent: false,
        settled: false,
        suddenDeath: false,
        remoteTntTriggered: false,
        forfeited: false
      };
    }
    for (const session of this.sessions.values()) {
      if (!session.ready) continue;
      const player = this.players.get(session.pid);
      const opponent = roster.find((record) => record.pid !== session.pid);
      if (!player || !opponent) continue;
      this.send(session.socket, {
        t: 'siege',
        round: this.round,
        seed: this.seed,
        bag: player.siege.bag,
        attackerCards: player.siege.attackerCards,
        defenderCards: player.siege.defenderCards,
        left: TUNE.roundSeconds,
        validate: this.validateMode,
        opponent: { pid: opponent.pid, name: opponent.name },
        blueprint: opponent.blueprint,
        autoCompleted: opponent.autoCompleted,
        yourAutoCompleted: player.autoCompleted
      });
    }
    // The settle test above is now advisory, so a King can legitimately already be dead by
    // the time Siege starts -- sim.js's stepRound() ends the round the instant it notices,
    // with zero shots fired. There is no way for a client to report that honestly over the
    // wire: ammoIndexFor(round) is round.shotIndex - 1, so a zero-shot win is ammoIndex -1,
    // and checkScore's ordering check (relay-audit.js) requires the first boundary to be
    // ammoIndex 0 -- it was built for "shots arrive in order", never "no shots arrived at
    // all". Trusting a client's own claim of an instant win would also be a new forgeable
    // claim on the one surface where that is a security bug. Neither problem exists if the
    // relay decides this itself: it already knows both blueprints here, so it replays the
    // exact SETTLE_STEPS preflight both clients are about to run for each pairing, using the
    // same createAudit/advanceAudit machinery a real king-pop mid-siege already goes through
    // (and caching the result into `this.audits`, so a reconnect or later audit call picks
    // up from here instead of re-deriving step 0). If a King is already dead, that leg never
    // needed a shot to resolve and never reaches checkScore at all -- finishRound() below
    // flips the room to 'round-over' before either client's own preflight-triggered report
    // can arrive, and handleAuditMessage's existing `phase !== 'siege'` guard absorbs it
    // harmlessly if it does.
    const preflightWinners = [];
    for (const player of roster) {
      const blueprint = decode(player.siege.blueprint);
      if (blueprint?.ok === false) continue;
      const audit = createAudit({
        blueprint,
        seed: player.siege.seed,
        bag: player.siege.bag,
        attackerCards: player.siege.attackerCards,
        defenderCards: player.siege.defenderCards
      });
      advanceAudit(audit, player.siege, SETTLE_STEPS, SETTLE_STEPS);
      this.audits.set(player.pid, audit);
      if (audit.round.phase === 'won') {
        player.siege.verifiedScore = audit.round.score;
        player.siege.verifiedDamage = audit.round.scoreBreakdown?.damage ?? 0;
        player.siege.verifiedStep = audit.round.stepCount;
        player.siege.verifiedDigest = digestRound(audit.round);
        player.siege.settled = false;
        player.siege.spent = true;
        preflightWinners.push({
          pid: player.pid, score: audit.round.score, fortressCost: player.fortressCost
        });
      }
    }
    if (preflightWinners.length === 1) {
      await this.finishRound(preflightWinners[0].pid, 'king-pop', { preflightCollapse: true });
      return;
    }
    if (preflightWinners.length === 2) {
      // Both players' fortresses collapsed onto their own King before either fired a shot.
      // Neither side has a kingPop claim to arbitrate against the other, so this falls to
      // exactly the score/fortress-cost/seeded ladder an ordinary exhausted-bag tie already
      // uses -- not a new tiebreak, the same one.
      const result = resolveRound(preflightWinners.map((entry) => ({
        pid: entry.pid, score: entry.score, kingPopped: false,
        suddenDeathDamage: undefined, fortressCost: entry.fortressCost
      })));
      const winner = result.resolved ? result.winner : roster[(this.seed ^ this.round) & 1].pid;
      await this.finishRound(winner, result.resolved ? result.reason : 'seeded-final-tie',
        { preflightCollapse: true });
      return;
    }
    await this.persist();
    await this.syncRegistry();
  }

  // -- simultaneous Siege and incremental audit -------------------------

  playerSession(pid) {
    return [...this.sessions.values()].find((entry) =>
      entry.ready && entry.pid === pid && entry.socket.readyState === 1);
  }

  async handleSiegePhaseMessage(session, message) {
    if (this.phase !== 'siege') {
      this.sendError(session, 'wrong-phase', 'Siege inputs are accepted only during Siege');
      return;
    }
    const record = this.players.get(session.pid);
    const siege = record?.siege;
    if (!record || !siege || siege.forfeited) return;
    if (message.t === 'remote-tnt') {
      const granted = record.cards.some((id) =>
        CARDS_BY_ID[id]?.effect.kind === 'remoteTnt');
      const target = [...this.players.values()].find((candidate) =>
        candidate.pid !== record.pid);
      if (!granted || !target?.siege || target.siege.remoteTntTriggered) {
        this.sendError(session, 'card-required',
          'remote TNT may be triggered once only by its drafted holder');
        return;
      }
      const timing = checkRemoteTnt(target.siege, message, Date.now());
      if (!timing.ok) {
        this.sendError(session, timing.code, timing.message);
        return;
      }
      target.siege.log.push({ t: 'remote-tnt', step: message.step });
      target.siege.remoteTntTriggered = true;
      this.send(session.socket, { t: 'remote-tnt-accepted', step: message.step });
      await this.persist();
      if (this.validateMode === 'strict') await this.runAudits(AUDIT_STEP_BUDGET);
      return;
    }
    if (message.t === 'score' || message.t === 'shot-end' ||
        message.t === 'round-over') {
      await this.handleAuditMessage(session, message);
      return;
    }
    const now = Date.now();
    const check = message.t === 'shot'
      ? checkShot(siege, message, now)
      : checkTap(siege, message, now);
    if (!check.ok) {
      await this.forfeit(record, check.code, check.message);
      return;
    }
    if (message.t === 'shot') {
      siege.log.push({
        t: 'shot',
        step: message.step,
        ammoIndex: message.ammoIndex,
        dx: message.dx,
        dy: message.dy
      });
      siege.shotCount++;
      siege.lastShotStep = message.step;
      siege.lastShotAt = now;
      this.send(session.socket, {
        t: 'shot-accepted', step: message.step, ammoIndex: message.ammoIndex
      });
    } else {
      siege.log.push({ t: 'tap', step: message.step });
      siege.tappedShot = siege.shotCount - 1;
      this.send(session.socket, { t: 'tap-accepted', step: message.step });
    }
    await this.persist();
    if (this.validateMode === 'strict') await this.runAudits(AUDIT_STEP_BUDGET);
  }

  handlePreviewMessage(session, message) {
    if (this.phase !== 'siege') return;
    const now = Date.now();
    const sender = this.players.get(session.pid);
    if (!sender || !previewAccepted(session, now, sender.cards)) return;
    const opponent = [...this.players.values()].find((record) =>
      record.pid !== session.pid);
    const target = opponent && this.playerSession(opponent.pid);
    if (target) this.send(target.socket, message);
  }

  async handleAuditMessage(session, message) {
    if (this.phase !== 'siege') {
      this.sendError(session, 'wrong-phase', 'audit reports are accepted only during Siege');
      return;
    }
    const record = this.players.get(session.pid);
    const siege = record?.siege;
    if (!record || !siege || siege.forfeited) return;
    const boundary = {
      step: message.step,
      ammoIndex: message.ammoIndex,
      score: message.score,
      digest: String(message.digest ?? ''),
      kingPop: Boolean(message.kingPop || message.kingPopped),
      settled: Boolean(message.settled || message.phase === 'aiming' ||
        message.phase === 'lost')
    };
    const check = checkScore(siege, boundary, Date.now(),
      this.validateMode === 'strict');
    if (!check.ok) {
      await this.forfeit(record, check.code, check.message);
      return;
    }
    siege.boundaries.push(boundary);
    await this.persist();
    if (this.validateMode === 'strict') {
      await this.runAudits(AUDIT_STEP_BUDGET);
      return;
    }
    siege.verifiedScore = boundary.score;
    siege.verifiedDamage = boundary.score;
    siege.verifiedStep = boundary.step;
    siege.settled = boundary.settled;
    siege.spent = siege.shotCount >= siege.bag.length && boundary.settled;
    this.send(session.socket, {
      t: 'audit-ok', validate: 'lenient', step: boundary.step,
      ammoIndex: boundary.ammoIndex, score: boundary.score
    });
    if (boundary.kingPop) this.send(session.socket, {
      t: 'king-unverified',
      m: 'Lenient validation cannot award an instant King claim; the round continues on score.'
    });
    await this.persist();
    await this.finishIfSpent();
  }

  async handleReconnectMessage(session) {
    const record = this.players.get(session.pid);
    if (!record || this.phase !== 'siege' && this.phase !== 'round-over') {
      this.sendError(session, 'resume-missing', 'there is no resumable round');
      return;
    }
    await this.sendResume(session, record);
  }

  async sendResume(session, record) {
    const siege = record.siege;
    if (!siege) return;
    const audit = this.auditFor(record);
    const snapshot = audit ? auditSnapshot(audit) : {
      step: siege.verifiedStep,
      digest: siege.verifiedDigest,
      score: siege.verifiedScore
    };
    const opponent = [...this.players.values()].find((candidate) =>
      candidate.pid !== record.pid);
    this.send(session.socket, {
      t: 'resume',
      round: this.round,
      phase: this.phase,
      blueprint: siege.blueprint,
      seed: siege.seed,
      bag: siege.bag,
      attackerCards: siege.attackerCards,
      defenderCards: siege.defenderCards,
      suddenDeath: siege.suddenDeath,
      shotLog: siege.log,
      step: snapshot.step,
      digest: snapshot.digest,
      score: snapshot.score,
      left: Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)),
      opponent: opponent ? { pid: opponent.pid, name: opponent.name } : null,
      result: this.result
    });
  }

  async runAudits(budget) {
    if (this.phase !== 'siege' || this.validateMode !== 'strict') return;
    const records = [...this.players.values()].filter((record) => record.siege);
    let remaining = budget;
    let verifiedAny = false;
    for (let index = 0; index < records.length && remaining > 0; index++) {
      const record = records[index];
      const audit = this.auditFor(record);
      if (!audit) {
        await this.forfeit(record, 'audit-blueprint', 'the audit blueprint could not be rebuilt');
        return;
      }
      const slice = Math.ceil(remaining / (records.length - index));
      const result = advanceAudit(audit, record.siege, slice,
        auditTarget(audit, record.siege, Date.now()));
      remaining -= result.steps;
      if (!result.ok) {
        await this.forfeit(record, result.code, result.message);
        return;
      }
      for (const verified of result.checks) {
        verifiedAny = true;
        const siege = record.siege;
        siege.verifiedScore = verified.score;
        siege.verifiedDamage = verified.damage;
        siege.verifiedStep = verified.step;
        siege.verifiedDigest = verified.digest;
        siege.settled = verified.settled;
        siege.spent = verified.spent;
        const target = this.playerSession(record.pid);
        if (target) this.send(target.socket, {
          t: 'audit-ok',
          validate: 'strict',
          step: verified.step,
          ammoIndex: verified.boundary.ammoIndex,
          score: verified.score,
          digest: verified.digest
        });
        if (verified.kingPopped) {
          await this.finishRound(record.pid, 'king-pop');
          return;
        }
      }
    }
    if (verifiedAny) await this.persist();
    await this.finishIfSpent();
  }

  async finishIfSpent() {
    if (this.phase !== 'siege') return;
    const records = [...this.players.values()];
    if (!records.length || !records.every((record) =>
      record.siege?.spent && record.siege?.settled)) return;
    await this.resolveCurrentRound('spent');
  }

  async beginSuddenDeath() {
    const records = [...this.players.values()];
    for (const record of records) {
      const siege = record.siege;
      const audit = this.auditFor(record);
      if (audit) startSuddenDeath(audit, siege);
      else {
        siege.suddenDeath = true;
        siege.regulationScore = siege.verifiedScore;
        siege.regulationDamage = siege.verifiedDamage;
        siege.bag.push('lob');
        siege.spent = false;
        siege.settled = false;
      }
      siege.scoreCeiling += SCORE.siege.unusedAmmo;
    }
    this.deadline = Date.now() + TUNE.draftSeconds * 1000;
    this.lastClockSecond = TUNE.draftSeconds;
    this.broadcast({
      t: 'sudden-death',
      round: this.round,
      ammo: 'lob',
      left: TUNE.draftSeconds,
      m: 'Exact tie: one Lob each. Higher damage wins.'
    });
    await this.persist();
  }

  async resolveCurrentRound(trigger) {
    const records = [...this.players.values()];
    const sudden = records.every((record) => record.siege?.suddenDeath);
    const result = resolveRound(records.map((record) => ({
      pid: record.pid,
      score: sudden ? record.siege.regulationScore : record.siege.verifiedScore,
      kingPopped: false,
      suddenDeathDamage: sudden
        ? record.siege.verifiedDamage - record.siege.regulationDamage : undefined,
      fortressCost: record.fortressCost
    })));
    if (!result.resolved && result.reason === 'sudden-death') {
      await this.beginSuddenDeath();
      return;
    }
    if (!result.resolved) {
      // Identical damage and identical scrap are possible. The match seed supplies a
      // final auditable ordering so even that degenerate case cannot stall a room.
      const winner = records[(this.seed ^ this.round) & 1].pid;
      await this.finishRound(winner, 'seeded-final-tie', { trigger });
      return;
    }
    await this.finishRound(result.winner, result.reason, { trigger });
  }

  finalizeClockScores() {
    if (this.validateMode !== 'strict') return;
    for (const record of this.players.values()) {
      const audit = this.auditFor(record);
      if (!audit) continue;
      const final = finalizeAuditScore(audit);
      record.siege.verifiedScore = final.score;
      record.siege.verifiedDamage = final.damage;
      record.siege.verifiedDigest = final.digest;
      record.siege.verifiedStep = final.step;
    }
  }

  async forfeit(record, code, message) {
    if (this.phase !== 'siege' || record.siege?.forfeited) return;
    record.siege.forfeited = true;
    const opponent = [...this.players.values()].find((candidate) =>
      candidate.pid !== record.pid);
    console.error(JSON.stringify({
      message: 'Siege audit forfeit', room: this.key, pid: record.pid, code, detail: message
    }));
    await this.finishRound(opponent?.pid ?? null, 'forfeit', {
      loser: record.pid,
      code,
      m: `${record.name} forfeited: ${message}`
    });
  }

  async finishRound(winner, reason, extra = {}) {
    if (this.phase !== 'siege') return;
    this.phase = 'round-over';
    this.deadline = 0;
    const winningRecord = this.players.get(winner);
    if (!winningRecord) return;
    winningRecord.wins++;
    winningRecord.bankedScrap += BUDGET.winnerBonus;
    this.result = { winner, reason, round: this.round, at: Date.now(), ...extra };
    this.broadcast({
      t: 'round-over',
      ...this.result,
      standings: [...this.players.values()].map((record) => ({
        pid: record.pid, name: record.name, wins: record.wins
      }))
    });
    const match = matchWinner([...this.players.values()]);
    if (match !== null || this.round >= TUNE.maxRounds) {
      this.phase = 'match-over';
      this.deadline = 0;
      this.broadcast({
        t: 'match-over',
        winner: match ?? winner,
        round: this.round,
        standings: [...this.players.values()].map((record) => ({
          pid: record.pid, name: record.name, wins: record.wins
        }))
      });
      this.endNetLog('finished');
    } else {
      this.beginDraft(winner);
    }
    await this.persist();
    await this.syncRegistry();
  }

  beginDraft(winner) {
    const loser = [...this.players.values()].find((record) => record.pid !== winner);
    const winningRecord = this.players.get(winner);
    if (!loser || !winningRecord) return;
    const deficit = winningRecord.wins - loser.wins;
    const candidates = rollDraft(this.seed, this.round, deficit, loser.cards, loser.pid);
    this.phase = 'draft';
    this.draftPid = loser.pid;
    this.deadline = Date.now() + TUNE.draftSeconds * 1000;
    this.lastClockSecond = TUNE.draftSeconds;
    loser.draftOffer = { candidates, deficit, round: this.round };
    this.sendDraftOffer(loser);
    const winnerSession = this.playerSession(winner);
    if (winnerSession) this.send(winnerSession.socket, {
      t: 'draft-wait',
      picker: loser.pid,
      left: TUNE.draftSeconds,
      winnerBonus: BUDGET.winnerBonus
    });
  }

  sendDraftOffer(record) {
    const target = this.playerSession(record.pid);
    if (!target || !record.draftOffer) return;
    this.send(target.socket, {
      t: 'draft-offer',
      round: this.round,
      deficit: record.draftOffer.deficit,
      tiers: draftTiers(record.draftOffer.deficit, this.round),
      candidates: record.draftOffer.candidates,
      left: Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000))
    });
  }

  async pickDraft(session, record, requested, timedOut = false) {
    if (this.phase !== 'draft' || record.pid !== this.draftPid || !record.draftOffer) {
      if (session) this.sendError(session, 'wrong-phase', 'only the round loser may draft');
      return false;
    }
    const candidate = timedOut
      ? defaultDraftPick(record.draftOffer.candidates) : String(requested ?? '');
    if (!record.draftOffer.candidates.includes(candidate) || record.cards.includes(candidate) ||
        !CARDS_BY_ID[candidate]) {
      if (session) this.sendError(session, 'invalid-draft-pick',
        'the selected card was not in this draft offer');
      return false;
    }
    record.cards.push(candidate);
    record.draftOffer = null;
    const loser = record.pid;
    this.draftPid = -1;
    this.broadcast({
      t: 'draft-picked',
      picker: loser,
      card: candidate,
      timedOut
    });
    await this.beginBuild(this.round + 1);
    return true;
  }

  // -- room placement ----------------------------------------------------

  // Where this object runs, for /ping, the lobby list and the lag log
  // (DEV_COLO fakes it under wrangler dev). A shard's region is the one it was
  // made for.
  async locate() {
    if (!this.colo) this.colo = this.env?.DEV_COLO || await coloOf();
  }

  region() {
    return shardRegion(this.shard) || regionOfColo(this.colo);
  }

  // Once per room session, never from a shard, never twice.
  mayMove() {
    return Boolean(this.env?.ROOMS && this.key && !this.shard && !this.moved &&
      !this.moveTried && this.players.size >= 2);
  }

  placeOf(pid) {
    const session = this.playerSession(pid);
    return { probes: session?.regions ?? null, rtt: median(session?.rtts ?? []) };
  }

  // At match start netplace.js's chooseRegion found a clearly fairer region:
  // hand the room to a shard there (/_adopt), give each player a ticket for
  // their seat, and remember the move so later connections follow it. The
  // shard starts the match once both tickets are back (or after ADOPT_WAIT)
  // and tells this object when it empties (/_released). False if the shard
  // could not take the room; the match then starts here as before.
  async moveRoom(choice) {
    this.moving = true;
    this.moveTried = true;
    const shard = newShard(choice.region);
    const tickets = {};
    const ticketOf = new Map();
    for (const record of this.players.values()) {
      const ticket = newTicket();
      tickets[ticket] = { pid: record.pid };
      ticketOf.set(record.pid, ticket);
    }
    const state = {
      room: this.room, host: this.host, passwordHash: this.passwordHash, locked: this.locked,
      nextPid: this.nextPid,
      players: [...this.players.values()].map(({ pid, name, where }) => ({ pid, name, where }))
    };
    try {
      const response = await roomStub(this.env.ROOMS, this.key, shard).fetch('https://room/_adopt', {
        method: 'POST',
        body: JSON.stringify({ code: this.key, shard, from: this.colo, state, tickets })
      });
      if (!response.ok) throw new Error(`adopt answered ${response.status}`);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'room move failed, starting here',
        error: error instanceof Error ? error.message : String(error)
      }));
      this.moving = false;
      return false;
    }
    this.moving = false;
    this.moved = { shard, region: choice.region };
    await this.ctx.storage.put(MOVED_KEY, this.moved);
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      const ticket = ticketOf.get(session.pid);
      this.send(session.socket, { t: 'move', shard, region: choice.region, ...(ticket ? { ticket } : {}) });
      session.pid = -1; // nothing left here for drop() to clean up
    }
    // The shard lists the room from now on, under the same key, so this
    // forgets it without removing the listing.
    this.players.clear();
    this.room = '';
    this.key = '';
    this.host = -1;
    this.passwordHash = '';
    this.locked = false;
    this.phase = 'lobby';
    await this.ctx.storage.delete(ROOM_STATE_KEY);
    setTimeout(() => {
      for (const session of sessions) {
        try { session.socket.close(4000, 'moved'); } catch {}
      }
    }, MOVE_CLOSE);
    return true;
  }

  // In the shard: take the room over, its seats waiting for their tickets.
  adopt(body) {
    const { code, shard, from, state, tickets } = body ?? {};
    const key = roomKey(code);
    if (key.length < 3 || key !== code || !shardRegion(shard) || !state ||
        !Array.isArray(state.players) || !tickets || typeof tickets !== 'object' ||
        this.key || this.players.size || this.adoption) {
      return new Response('cannot adopt', { status: 409 });
    }
    this.shard = shard;
    this.movedFrom = cleanName(from, '', 8);
    this.room = cleanName(state.room, key, 24);
    this.key = key;
    this.passwordHash = String(state.passwordHash || '');
    this.locked = Boolean(state.locked);
    this.phase = 'lobby';
    this.round = 0;
    this.touched = Date.now();
    const seats = new Map(state.players.map((seat) => [Number(seat.pid), seat]));
    this.host = seats.has(Number(state.host)) ? Number(state.host) : -1;
    this.nextPid = Math.max(Number(state.nextPid) || 1, ...[...seats.keys()].map((pid) => pid + 1));
    this.adoption = {
      tickets: new Map(Object.entries(tickets).filter(([ticket, value]) =>
        TICKET.test(ticket) && seats.has(Number(value?.pid))).map(([ticket, value]) =>
        [ticket, Number(value.pid)])),
      seats,
      timer: setTimeout(() => {
        void this.adopted().catch((error) => console.error(JSON.stringify({
          message: 'room adoption failed',
          error: error instanceof Error ? error.message : String(error)
        })));
      }, ADOPT_WAIT)
    };
    return new Response(null, { status: 204 });
  }

  // A player back from the room's old object with their ticket takes their seat.
  async ticketHandshake(session, message) {
    const adoption = this.adoption;
    const pid = adoption?.tickets.get(session.ticket);
    if (pid === undefined || roomKey(message.room) !== this.key || session.routeKey !== this.key) {
      this.reject(session, 'seat-gone', 'the room moved and your seat is gone');
      return;
    }
    adoption.tickets.delete(session.ticket);
    const seat = adoption.seats.get(pid);
    const resumeToken = randomToken();
    const record = {
      pid,
      name: cleanName(seat?.name),
      wins: 0,
      cards: [],
      bankedScrap: 0,
      roundCarry: 0,
      budget: 0,
      draft: '',
      draftOffer: null,
      blueprint: '',
      fortressCost: 0,
      locked: false,
      autoCompleted: false,
      connected: true,
      disconnectedAt: 0,
      graceDeadline: 0,
      resumeTokenHash: await hashPassword(resumeToken),
      where: session.where?.country ? session.where : seat?.where ?? null,
      siege: null
    };
    this.players.set(pid, record);
    session.pid = pid;
    session.ready = true;
    clearTimeout(session.handshakeTimer);
    this.send(session.socket, {
      t: 'welcome',
      you: pid,
      room: this.room,
      host: this.host === pid,
      max: MAX_PLAYERS,
      resumeToken,
      region: this.region(),
      moved: true,
      tune: {
        buildSeconds: TUNE.buildSeconds,
        winsNeeded: TUNE.winsNeeded,
        maxRounds: TUNE.maxRounds
      }
    });
    this.sendLobby();
    if (!adoption.tickets.size) await this.adopted();
    else {
      await this.persist();
      await this.syncRegistry();
    }
  }

  // Both tickets are back, or time is up: start with whoever is here. One
  // player alone waits in the room for an opponent, as before a start.
  async adopted() {
    const adoption = this.adoption;
    if (!adoption) return;
    clearTimeout(adoption.timer);
    this.adoption = null;
    if (!this.players.size) {
      await this.reset();
      return;
    }
    if (!this.players.has(this.host)) this.host = this.players.keys().next().value;
    if (this.players.size === MAX_PLAYERS && this.phase === 'lobby') {
      await this.beginMatch();
      return;
    }
    this.sendLobby();
    await this.persist();
    await this.syncRegistry();
  }

  // In the shard, once empty: the room's own name is free again.
  release() {
    if (!this.env?.ROOMS || !this.key) return;
    const sent = roomStub(this.env.ROOMS, this.key).fetch('https://room/_released', {
      method: 'POST',
      body: JSON.stringify({ shard: this.shard })
    }).catch((error) => console.error(JSON.stringify({
      message: 'room release failed',
      error: error instanceof Error ? error.message : String(error)
    })));
    this.ctx.waitUntil?.(sent);
  }

  async released(shard) {
    if (!this.moved || this.moved.shard !== shard) return;
    this.moved = null;
    await this.ctx.storage.delete(MOVED_KEY);
  }

  // -- lag log -----------------------------------------------------------

  // One record per match, from the first build to the match result (or until it
  // is abandoned or the room closes), sent to games-guard's NetLog. The 250 ms
  // room clock is not a simulation loop and previews are not a steady stream,
  // so neither feeds the stats.
  startNetLog() {
    this.endNetLog('abandoned');
    this.net = new NetStats();
    for (const record of this.players.values()) {
      this.net.seat(record.pid, record.name, record.where);
    }
    void this.locate();
  }

  endNetLog(outcome) {
    const net = this.net;
    this.net = null;
    if (!net) return;
    const record = net.record({
      code: this.room, mode: `1v1 siege · first to ${TUNE.winsNeeded}`, outcome, colo: this.colo,
      region: this.region(),
      moved: this.shard ? { from: this.movedFrom, to: shardRegion(this.shard) } : null
    });
    if (record.runTime < 10) return;
    sendNetLog(this.env, this.ctx, 'slingwreck', record);
  }

  // -- the cheap room clock ----------------------------------------------

  prunePasswordAttempts(now) {
    for (const [ip, attempts] of this.passwordAttempts) {
      const fresh = attempts.filter((at) => now - at < PASSWORD_WINDOW);
      if (fresh.length) this.passwordAttempts.set(ip, fresh);
      else this.passwordAttempts.delete(ip);
    }
  }

  async tick() {
    const now = Date.now();
    this.prunePasswordAttempts(now);
    if (now - this.touched > ROOM_TTL) {
      for (const session of this.sessions.values()) {
        session.dropped = true;
        session.socket.close(1000, 'lobby idle');
      }
      this.sessions.clear();
      await this.reset();
      return;
    }
    if (!this.sessions.size && !this.adoption && this.phase !== 'siege' &&
        this.phase !== 'draft') {
      await this.reset();
      return;
    }
    if (this.key && now - this.lastRegistrySync >= REGISTRY_HEARTBEAT) {
      await this.syncRegistry();
    }
    if (this.phase === 'siege') {
      const records = [...this.players.values()];
      const expired = records.filter((record) => disconnectExpired(record, now));
      const connected = records.filter((record) => record.connected);
      if (expired.length && connected.length === 1) {
        await this.finishRound(connected[0].pid, 'disconnect', {
          loser: expired[0].pid,
          m: `${expired[0].name} did not reconnect within ${TUNE.disconnectGraceSeconds} seconds.`
        });
        return;
      }
      if (expired.length && !connected.length) {
        await this.reset();
        return;
      }
      await this.runAudits(AUDIT_STEP_BUDGET);
      if (this.phase !== 'siege') return;
      if (now >= this.deadline) {
        this.finalizeClockScores();
        await this.resolveCurrentRound('clock');
        return;
      }
      const left = Math.max(0, Math.ceil((this.deadline - now) / 1000));
      if (left !== this.lastClockSecond) {
        this.lastClockSecond = left;
        this.broadcast({ t: 'siege-clock', left });
      }
      return;
    }
    if (this.phase === 'draft') {
      const picker = this.players.get(this.draftPid);
      if (now >= this.deadline) {
        if (picker) await this.pickDraft(null, picker, null, true);
        return;
      }
      const left = Math.max(0, Math.ceil((this.deadline - now) / 1000));
      if (left !== this.lastClockSecond) {
        this.lastClockSecond = left;
        this.broadcast({ t: 'draft-clock', left, picker: this.draftPid });
      }
      return;
    }
    if (this.phase !== 'build') return;
    if (now >= this.deadline) {
      await this.finishBuild();
      return;
    }
    const left = Math.max(0, Math.ceil((this.deadline - now) / 1000));
    if (left !== this.lastClockSecond) {
      this.lastClockSecond = left;
      this.broadcast({ t: 'build-clock', left });
    }
  }

  async alarm() {
    await this.tick();
    if ((this.phase === 'siege' || this.phase === 'draft') && !this.sessions.size) {
      const next = [...this.players.values()]
        .filter((record) => !record.connected && record.graceDeadline > Date.now())
        .reduce((soonest, record) => Math.min(soonest, record.graceDeadline), Infinity);
      const alarmAt = this.phase === 'draft' ? this.deadline : next;
      if (Number.isFinite(alarmAt)) await this.ctx.storage.setAlarm(alarmAt);
    }
  }
}
