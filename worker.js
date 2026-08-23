// The SLINGWRECK relay.
//
// The two players' worlds never interact: you attack their fortress and they
// attack yours. There is therefore no authoritative 60 Hz dual-world sim. The
// relay is authority for build, then a cheap auditor of each independent siege.
// This phase implements that authoritative build only.
//
//   GET /health   - liveness
//   GET /lobbies  - public lobby directory
//   GET /ws?room= - websocket, first message must be create or join

import { PIGS, TUNE } from './data.js';
import { PIG_FLAG_DECOY } from './sim.js';
import {
  budgetFor,
  decode,
  earlyLockScrap,
  encode,
  settleTest,
  validate
} from './build.js';

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
const PRODUCTION_ORIGIN = 'https://slingwreck.andrenijman.com';
const encoder = new TextEncoder();

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
    const settled = settleTest(decoded, options);
    if (!settled.ok) {
      const errors = [];
      if (settled.movedPieces.length) errors.push(wireError(
        'unstable', 'One or more pieces moved too far during the settle test.',
        settled.movedPieces
      ));
      if (settled.deadPigs.length) errors.push(wireError(
        'pig-died', 'One or more pigs died during the settle test.',
        settled.deadPigs
      ));
      if (!settled.settled && !errors.length) errors.push(wireError(
        'not-settled', 'The fortress did not settle within three seconds.', []
      ));
      return { ok: false, stage: 'settle', errors, settled };
    }
    return { ok: true, blueprint: decoded, encoded: source, settled };
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

const AUTO_LAYOUTS = [
  [['runt', 2, 0.296875, 0], ['king', 12, 0.6875, 0], ['runt', 22, 0.296875, 0]],
  [['runt', 4, 0.296875, 0], ['king', 12, 0.6875, 0], ['runt', 20, 0.296875, 0]],
  [['runt', 2, 0.296875, 0], ['king', 6, 0.6875, 0], ['runt', 10, 0.296875, 0]],
  [['runt', 14, 0.296875, 0], ['king', 18, 0.6875, 0], ['runt', 22, 0.296875, 0]]
];

function realKing(tuple) {
  return Boolean(PIGS[tuple[0]]?.traits.king) &&
    ((tuple[3] ?? 0) & PIG_FLAG_DECOY) === 0;
}

function completePigs(pigs, layout) {
  const completed = pigs.map((tuple) => tuple.slice());
  let kings = completed.filter(realKing).length;
  let others = completed.length - kings;
  for (const tuple of layout) {
    if (realKing(tuple)) {
      if (kings) continue;
      kings++;
    } else {
      if (others >= TUNE.minOtherPigs) continue;
      others++;
    }
    completed.push(tuple.slice());
  }
  return completed;
}

// Timer expiry first tries to preserve the authored draft, then its blocks, and
// finally uses the smallest deterministic legal fortress. It never invents a
// settled pose: every candidate is still an authored blueprint and is tested by
// the exact same validation path as an explicit lock-in.
export function autoCompleteBlueprint(source, options = {}) {
  const decoded = decode(source);
  const candidates = [];
  if (decoded?.ok !== false) {
    candidates.push(decoded);
    for (const layout of AUTO_LAYOUTS) candidates.push({
      v: decoded.v,
      blocks: decoded.blocks.map((tuple) => tuple.slice()),
      pigs: completePigs(decoded.pigs, layout)
    });
    for (const layout of AUTO_LAYOUTS) candidates.push({
      v: decoded.v,
      blocks: decoded.blocks.map((tuple) => tuple.slice()),
      pigs: layout.map((tuple) => tuple.slice())
    });
  }
  for (const layout of AUTO_LAYOUTS) candidates.push({
    v: 1,
    blocks: [],
    pigs: layout.map((tuple) => tuple.slice())
  });

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

export function p61NotImplemented(feature) {
  return {
    t: 'err',
    code: 'not-implemented',
    m: `${feature} not implemented in P6.1`
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
    if (url.pathname !== '/ws') {
      return new Response('SLINGWRECK relay. Connect over websocket at /ws\n', {
        status: 404
      });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('upgrade required', { status: 426 });
    }
    if (!originAllowed(request.headers.get('Origin'))) {
      return new Response('origin not allowed', { status: 403 });
    }
    const key = roomKey(url.searchParams.get('room'));
    if (key.length < 3) {
      return new Response('lobby names need at least 3 characters', { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.set('X-Slingwreck-IP', clientIp(request));
    return env.ROOMS.getByName(key).fetch(new Request(request, { headers }));
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
  }

  // -- plumbing ----------------------------------------------------------

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('upgrade required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const session = {
      socket: server,
      pid: -1,
      ready: false,
      dropped: false,
      ip: cleanName(request.headers.get('X-Slingwreck-IP'), 'unknown', 64),
      routeKey: roomKey(new URL(request.url).searchParams.get('room')),
      queue: Promise.resolve(),
      handshakeTimer: 0
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
    server.addEventListener('close', () => this.drop(session));
    server.addEventListener('error', () => this.drop(session));
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

  reset() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    this.passwordAttempts.clear();
    return registryWork;
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
      this.send(session.socket, { t: 'pong', c: message.c });
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
      this.saveDraft(session, record, message);
      return;
    }
    if (message.t === 'lock') {
      await this.lockBlueprint(session, record, message);
      return;
    }
    if (['shot', 'shot-end', 'score', 'round-over'].includes(message.t)) {
      this.handleSiegePhaseMessage(session, message);
      return;
    }
    if (message.t === 'preview') {
      this.handlePreviewMessage(session, message);
      return;
    }
    if (['audit', 'digest'].includes(message.t)) {
      this.handleAuditMessage(session, message);
      return;
    }
    if (['reconnect', 'resume'].includes(message.t)) {
      this.handleReconnectMessage(session, message);
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
    if (message.t !== 'create' && message.t !== 'join') {
      this.sendError(session, 'handshake-required', 'send create or join first');
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
    } else {
      if (!this.players.size || this.key !== key) {
        this.reject(session, 'room-missing', 'no lobby has that name');
        return;
      }
      if (this.phase !== 'lobby') {
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

    const pid = this.nextPid++;
    const record = {
      pid,
      name: cleanName(message.name),
      wins: 0,
      cards: [],
      bankedScrap: 0,
      budget: 0,
      draft: '',
      blueprint: '',
      locked: false,
      autoCompleted: false
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
      tune: {
        buildSeconds: TUNE.buildSeconds,
        winsNeeded: TUNE.winsNeeded,
        maxRounds: TUNE.maxRounds
      }
    });
    this.sendLobby();
    await this.syncRegistry();
  }

  reject(session, code, reason) {
    this.sendError(session, code, reason);
    setTimeout(() => session.socket.close(1008, reason.slice(0, 123)), 25);
  }

  drop(session) {
    if (session.dropped) return;
    session.dropped = true;
    clearTimeout(session.handshakeTimer);
    this.sessions.delete(session.socket);
    if (session.pid < 0) return;
    const wasHost = session.pid === this.host;
    this.players.delete(session.pid);
    if (!this.players.size) {
      if (!this.sessions.size) {
        void this.reset();
      } else {
        void this.removeRegistry();
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
      }
      return;
    }
    if (wasHost) this.host = this.players.keys().next().value;
    if (this.phase === 'build') {
      this.phase = 'lobby';
      this.round = 0;
      this.deadline = 0;
      for (const player of this.players.values()) {
        player.draft = '';
        player.blueprint = '';
        player.locked = false;
      }
      this.broadcast({ t: 'build-cancelled', m: 'opponent left during build' });
    } else if (this.phase === 'siege') {
      this.broadcast(p61NotImplemented('siege disconnect and reconnect'));
      this.phase = 'lobby';
      this.round = 0;
    }
    this.sendLobby();
    void this.syncRegistry();
  }

  sendLobby() {
    this.broadcast({
      t: 'lobby',
      room: this.room,
      host: this.host,
      phase: this.phase,
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
    this.phase = 'build';
    this.round = 1;
    this.seed = randomSeed();
    this.deadline = Date.now() + TUNE.buildSeconds * 1000;
    this.lastClockSecond = TUNE.buildSeconds;
    for (const player of this.players.values()) {
      player.budget = budgetFor({
        round: this.round,
        roundsBehind: 0,
        bankedScrap: player.bankedScrap,
        cards: player.cards
      });
      player.draft = '';
      player.blueprint = '';
      player.locked = false;
      player.autoCompleted = false;
      const target = [...this.sessions.values()].find((entry) => entry.pid === player.pid);
      if (target) this.send(target.socket, {
        t: 'build',
        round: this.round,
        budget: player.budget,
        cards: player.cards,
        left: TUNE.buildSeconds
      });
    }
    await this.syncRegistry();
  }

  buildOptions(record) {
    return {
      mode: 'siege',
      round: this.round,
      roundsBehind: 0,
      bankedScrap: record.bankedScrap,
      cards: record.cards,
      seed: this.seed ^ record.pid ^ this.round
    };
  }

  saveDraft(session, record, message) {
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
    record.locked = true;
    const secondsRemaining = Math.max(0, (this.deadline - Date.now()) / 1000);
    const banked = earlyLockScrap(secondsRemaining);
    record.bankedScrap += banked;
    this.send(session.socket, {
      t: 'locked',
      bankedScrap: banked,
      totalBankedScrap: record.bankedScrap
    });
    this.broadcast({
      t: 'build-status',
      locked: [...this.players.values()].filter((player) => player.locked)
        .map((player) => player.pid)
    });
    if ([...this.players.values()].every((player) => player.locked)) {
      await this.finishBuild();
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
      record.locked = true;
      record.autoCompleted = true;
    }
    this.phase = 'siege';
    this.deadline = 0;
    const roster = [...this.players.values()];
    for (const session of this.sessions.values()) {
      if (!session.ready) continue;
      const player = this.players.get(session.pid);
      const opponent = roster.find((record) => record.pid !== session.pid);
      if (!player || !opponent) continue;
      this.send(session.socket, {
        t: 'siege',
        round: this.round,
        seed: this.seed,
        opponent: { pid: opponent.pid, name: opponent.name },
        blueprint: opponent.blueprint,
        autoCompleted: opponent.autoCompleted,
        yourAutoCompleted: player.autoCompleted
      });
    }
    await this.syncRegistry();
  }

  // -- P6.2 flow, deliberately empty and loud ----------------------------

  handleSiegePhaseMessage(session, unusedMessage) {
    this.send(session.socket, p61NotImplemented('siege phase'));
  }

  handlePreviewMessage(session, unusedMessage) {
    this.send(session.socket, p61NotImplemented('preview relay'));
  }

  handleAuditMessage(session, unusedMessage) {
    this.send(session.socket, p61NotImplemented('siege audit'));
  }

  handleReconnectMessage(session, unusedMessage) {
    this.send(session.socket, p61NotImplemented('reconnect'));
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
    if (!this.sessions.size) {
      await this.reset();
      return;
    }
    if (this.key && now - this.lastRegistrySync >= REGISTRY_HEARTBEAT) {
      await this.syncRegistry();
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
}
