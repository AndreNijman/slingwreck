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
//   GET /ws?room= - websocket, first message must be create or join

import { BUDGET, CARDS_BY_ID, SCORE, TUNE } from './data.js?v=20260902-1';
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
} from './relay-audit.js?v=20260902-1';
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
} from './build.js?v=20260902-1';

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
    const cost = spent(fromBlueprint(decoded, options));
    return { ok: true, blueprint: decoded, encoded: source, settled, cost };
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
    this.audits = new Map();
    this.result = null;
    this.draftPid = -1;
    this.validateMode = validationMode(env);
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
      players: [...this.players.values()]
    };
  }

  async persist() {
    if (!this.key) return;
    await this.ctx.storage.put(ROOM_STATE_KEY, this.roomState());
  }

  async restore() {
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
    this.result = null;
    this.draftPid = -1;
    this.audits.clear();
    this.passwordAttempts.clear();
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
    this.seed = randomSeed();
    this.result = null;
    this.draftPid = -1;
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
      totalBankedScrap: record.bankedScrap
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
    if (!sender || !previewAllowed(session.lastPreviewAt, now, sender.cards)) return;
    session.lastPreviewAt = now;
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
    if (!this.sessions.size && this.phase !== 'siege' && this.phase !== 'draft') {
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
