// Online Siege: the relay is authority for build validation, the draft roll, round
// resolution and match state; this module is a thin, honest client around it.
//
// The netcode model (ARCHITECTURE.md §5) means each browser only ever simulates ONE live
// world: the attack it is making on the opponent's fortress. The corner preview — "your own
// fortress under attack" — is never simulated locally. It is a lossy 8 Hz stream of
// quantised block poses and alive-pig flags that the opponent's client sends about ITS OWN
// attack (which happens to be aimed at your fortress), forwarded unmodified by the relay.
// This module renders that stream onto a static "shadow round" instantiated once from your
// own locked blueprint — never stepped, only reposed from the network.
//
// Reuse, not reimplementation: build validation, the settle test, the auto-complete ladder,
// bag composition, the preview rate and the score/digest math are all imported from the same
// build.js / sim.js / relay-audit.js the relay itself runs. This module owns no rule the
// relay already owns; it owns wiring, timing and honesty about connection state.

import {
  digestRound, isRoundOver, launch, makeRound, remoteDetonate, stepRound, tap
} from './sim.js?v=20260902-3';
import { drawPreview } from './render.js?v=20260902-3';
import {
  autoCompleteCandidates, decode, encode, settleTest, toBlueprint, validate
} from './build.js?v=20260902-3';
import { SETTLE_STEPS, bagForRound, previewAllowed } from './relay-audit.js?v=20260902-3';
import { CARDS_BY_ID, TUNE } from './data.js?v=20260902-3';
import { createNet, fetchLobbies } from './net.js?v=20260902-3';

// Quantisation for the outgoing preview: the relay closes any socket that sends a message
// over 8192 bytes (worker.js MAX_MESSAGE), so this has a hard ceiling, not just a bandwidth
// preference. Rounding to 0.02 world units collapses float noise into a small alphabet of
// repeated values, which is what actually keeps the JSON small — the array length (bounded
// by PREVIEW_MAX_DELTA) is the real backstop.
const POSE_QUANTUM = 0.02;
const PREVIEW_MAX_DELTA = 48;
const LOBBY_POLL_MS = 3000;

function quantise(value) { return Math.round(value / POSE_QUANTUM) * POSE_QUANTUM; }

function poseOf(body) {
  return [quantise(body.x), quantise(body.y), quantise(body.c), quantise(body.s)];
}

function posesDiffer(a, b) {
  return !a || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3];
}

export function createOnlineSiege(deps) {
  const {
    openEditor, closeEditor, showTitle, getEditorDraft, renderValidation,
    getRound, setRound, setPlaying, resetCameraState, updateHud
  } = deps;

  const titleScreen = document.querySelector('#title-screen');
  const roundHud = document.querySelector('#round-hud');
  const statusMessage = document.querySelector('#status-message');
  const siegeBanner = document.querySelector('#siege-banner');
  const siegeRoundLabel = document.querySelector('#siege-round');
  const siegeWinsLabel = document.querySelector('#siege-wins');
  const siegeScrapLabel = document.querySelector('#siege-scrap');
  const scrapLeftLabel = document.querySelector('#scrap-left');
  const siegeClock = document.querySelector('#siege-clock');
  const siegeLockButton = document.querySelector('#siege-lock');
  const siegePreview = document.querySelector('#siege-preview');
  const siegePreviewCanvas = document.querySelector('#siege-preview-canvas');
  const siegePreviewKing = document.querySelector('#siege-preview-king');
  const siegeTheirScore = document.querySelector('#siege-their-score');
  const siegeTheirAmmo = document.querySelector('#siege-their-ammo');
  const siegeDraftScreen = document.querySelector('#siege-draft');
  const siegeDraftCards = document.querySelector('#siege-draft-cards');
  const siegeDraftEyebrow = document.querySelector('#siege-draft-eyebrow');
  const siegeResultScreen = document.querySelector('#siege-result');
  const siegeResultTitle = document.querySelector('#siege-result-title');
  // Not natively focusable; game.js's #round-over dialog sets the same tabIndex on
  // #round-title so a screen reader lands on the outcome instead of wherever focus was
  // left on the canvas. #siege-result has no such wiring of its own.
  siegeResultTitle.tabIndex = -1;
  const siegeResultEyebrow = document.querySelector('#siege-result-eyebrow');
  const siegeResultDetail = document.querySelector('#siege-result-detail');
  const siegeStandings = document.querySelector('#siege-standings');
  const siegeContinueButton = document.querySelector('#siege-continue');
  const siegeQuitButton = document.querySelector('#siege-quit');

  const lobbyScreen = document.querySelector('#online-lobby');
  const lobbyStatus = document.querySelector('#online-status');
  const nameInput = document.querySelector('#online-name');
  const roomInput = document.querySelector('#online-room');
  const passwordInput = document.querySelector('#online-password');
  const createButton = document.querySelector('#online-create');
  const joinButton = document.querySelector('#online-join');
  const refreshButton = document.querySelector('#online-refresh');
  const lobbyList = document.querySelector('#online-lobby-list');
  const roomState = document.querySelector('#online-room-state');
  const playersLine = document.querySelector('#online-players');
  const startButton = document.querySelector('#online-start');
  const backButton = document.querySelector('#online-back');
  const connectionBanner = document.querySelector('#online-connection-banner');
  const connectionText = document.querySelector('#online-connection-text');
  const connectionReconnect = document.querySelector('#online-connection-reconnect');

  // Everything that describes the current session. Rebuilt by resetContext() whenever the
  // player leaves the lobby, starts a fresh room search, or the match ends.
  let ctx = null;
  let net = null;
  let lobbyPollTimer = 0;
  let loopHandle = 0;

  function resetContext() {
    ctx = {
      active: false,
      connected: false,
      pid: -1,
      host: false,
      room: '',
      resumeToken: '',
      opponent: null,
      phase: 'lobby',
      round: 0,
      wins: null,
      buildBudget: 0,
      buildCards: [],
      buildDeadline: 0,
      locked: false,
      attackRound: null,
      shadowRound: null,
      shadowBodyById: null,
      shadowPigById: null,
      shadowKing: null,
      theirAmmoFallback: 0,
      shotsReported: 0,
      tapReportedFor: -1,
      boundaryShotIndex: 0,
      terminalReported: false,
      lastSentPose: new Map(),
      reportedDeadBlocks: new Set(),
      reportedDeadPigs: new Set(),
      lastPreviewSentAt: -Infinity,
      previewFramesApplied: 0,
      previewBodiesMovedTotal: 0,
      draftOffer: null,
      lastRoundOver: null,
      matchWinner: null,
      lastError: '',
      recentErrors: []
    };
  }
  resetContext();

  function isActive() { return Boolean(ctx?.active); }

  // ---------------------------------------------------------------- lobby UI

  function setStatus(text) { lobbyStatus.textContent = text; }

  function renderLobbyList(lobbies) {
    lobbyList.replaceChildren(...lobbies.map((lobby) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button online-lobby-row';
      const lock = lobby.locked ? ' 🔒' : '';
      button.textContent = `${lobby.name} — ${lobby.players}/${lobby.max}${lock}`;
      button.disabled = !lobby.joinable;
      button.addEventListener('click', () => { roomInput.value = lobby.name; roomInput.focus(); });
      li.append(button);
      return li;
    }));
    if (!lobbies.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No open rooms right now.';
      lobbyList.replaceChildren(li);
    }
  }

  async function refreshLobbyList() {
    const lobbies = await fetchLobbies();
    if (lobbyScreen.hidden) return;
    renderLobbyList(lobbies);
  }

  function startLobbyPolling() {
    stopLobbyPolling();
    void refreshLobbyList();
    lobbyPollTimer = setInterval(() => { void refreshLobbyList(); }, LOBBY_POLL_MS);
  }

  function stopLobbyPolling() {
    clearInterval(lobbyPollTimer);
    lobbyPollTimer = 0;
  }

  function ensureNet() {
    if (net) return net;
    net = createNet({
      onState: (info) => onConnectionState(info),
      onMessage: (message) => onNetMessage(message),
      onClose: () => { ctx.connected = false; }
    });
    return net;
  }

  function onConnectionState({ state, reason }) {
    if (!ctx) return;
    ctx.connectionState = state;
    if (state === 'connected') { ctx.connected = true; return; }
    ctx.connected = false;
    if (state === 'error') setStatus(`Could not reach the relay: ${reason || 'connection failed'}.`);
    else if (state === 'closed' && ctx.active && ctx.phase !== 'lobby') {
      // net.js deliberately never auto-reconnects (see its header comment) — a dropped
      // socket mid-match is a fact to show, not to silently paper over. Reconnecting is a
      // decision the player makes, via the button below.
      showConnectionBanner('Connection lost.', true);
    } else if (state === 'connecting') setStatus('Connecting to the relay…');
    else if (state === 'handshaking') setStatus('Handshaking…');
  }

  function showConnectionBanner(text, offerReconnect) {
    connectionText.textContent = text;
    connectionReconnect.hidden = !offerReconnect;
    connectionBanner.hidden = false;
  }

  function hideConnectionBanner() { connectionBanner.hidden = true; }

  function open() {
    resetContext();
    ctx.active = true;
    net = null;
    hideConnectionBanner();
    roomState.hidden = true;
    startButton.hidden = true;
    siegeBanner.hidden = true;
    siegePreview.hidden = true;
    siegeDraftScreen.hidden = true;
    siegeResultScreen.hidden = true;
    roundHud.hidden = true;
    titleScreen.hidden = true;
    lobbyScreen.hidden = false;
    setStatus('Not connected.');
    startLobbyPolling();
    nameInput.focus();
    startLoop();
  }

  function quit() {
    stopLobbyPolling();
    stopLoop();
    net?.close('left');
    net = null;
    setPlaying(false);
    lobbyScreen.hidden = true;
    siegeBanner.hidden = true;
    siegePreview.hidden = true;
    siegeDraftScreen.hidden = true;
    siegeResultScreen.hidden = true;
    hideConnectionBanner();
    resetContext();
    showTitle();
  }

  function handleCreate() {
    ensureNet().open('create', roomInput.value.trim(), {
      name: nameInput.value.trim(), password: passwordInput.value
    });
    setStatus('Creating room…');
  }

  function handleJoin() {
    ensureNet().open('join', roomInput.value.trim(), {
      name: nameInput.value.trim(), password: passwordInput.value
    });
    setStatus('Joining room…');
  }

  function handleReconnectClick() {
    if (!ctx.room || ctx.pid < 0 || !ctx.resumeToken) { quit(); return; }
    hideConnectionBanner();
    ensureNet().open('reconnect', ctx.room, { pid: ctx.pid, token: ctx.resumeToken });
    setStatus('Reconnecting…');
  }

  createButton.addEventListener('click', handleCreate);
  joinButton.addEventListener('click', handleJoin);
  refreshButton.addEventListener('click', () => { void refreshLobbyList(); });
  backButton.addEventListener('click', quit);
  startButton.addEventListener('click', () => net?.send({ t: 'start' }));
  connectionReconnect.addEventListener('click', handleReconnectClick);

  // ---------------------------------------------------------------- protocol dispatch

  function onNetMessage(message) {
    ctx.lastError = '';
    switch (message.t) {
      case 'welcome': return onWelcome(message);
      case 'lobby': return onLobby(message);
      case 'build-cancelled':
        setStatus('The opponent left during the build phase. Back to the lobby.');
        return;
      case 'build': return onBuild(message);
      case 'build-clock': return onBuildClock(message);
      case 'locked': return; // banked scrap ack; nothing to show beyond the disabled button
      case 'build-rejected': return onBuildRejected(message);
      case 'build-status': return; // who has locked so far; not shown, both locks race anyway
      case 'siege': return onSiege(message);
      case 'siege-clock': return; // the 3-minute cap; not surfaced, rounds resolve well inside it
      case 'shot-accepted': case 'tap-accepted': case 'audit-ok': return;
      case 'king-unverified': return;
      case 'preview': return applyPreview(message.frame ?? message);
      case 'opponent-disconnected':
        showConnectionBanner(`${message.m ?? 'Opponent disconnected.'}`, false);
        return;
      case 'opponent-reconnected':
        hideConnectionBanner();
        return;
      case 'resume': return onResume(message);
      case 'round-over': return onRoundOver(message);
      case 'match-over': return onMatchOver(message);
      case 'draft-wait': return onDraftWait(message);
      case 'draft-offer': return onDraftOffer(message);
      case 'draft-picked': case 'draft-clock': return;
      case 'sudden-death': setStatus(message.m ?? 'Sudden death.'); return;
      case 'err': return onError(message);
      default: return;
    }
  }

  function onError(message) {
    ctx.lastError = message.code;
    ctx.recentErrors.push({ code: message.code, m: message.m });
    if (ctx.recentErrors.length > 20) ctx.recentErrors.shift();
    if (ctx.phase === 'lobby' || !ctx.connected) setStatus(message.m || message.code);
    else statusMessage.textContent = message.m || message.code;
  }

  function onWelcome(message) {
    ctx.pid = message.you;
    ctx.host = Boolean(message.host);
    ctx.room = message.room;
    ctx.resumeToken = message.resumeToken;
    ctx.connected = true;
    if (message.reconnected) {
      setStatus('Reconnected.');
      hideConnectionBanner();
      // A reconnect that lands during the draft phase gets a draft-offer (or nothing, if
      // this player already won the round the relay does not resend a draft-wait) instead
      // of a resume — see worker.js reconnectHandshake. Fall back to an honest "waiting"
      // state if neither arrives quickly rather than pretending we know what is happening.
      setTimeout(() => {
        if (ctx.phase === 'round-over' || ctx.phase === 'siege') return;
        if (!siegeDraftScreen.hidden || ctx.attackRound) return;
        statusMessage.textContent = 'Reconnected — waiting for the match to continue…';
      }, 1500);
      return;
    }
    ctx.phase = 'lobby';
    stopLobbyPolling();
    lobbyList.replaceChildren();
    setStatus(`Connected as ${nameInput.value.trim() || 'Wrecker'} in "${ctx.room}".`);
  }

  // A `lobby` broadcast is lobby-screen data, not match state — the relay only ever sends
  // one while its own room phase is 'lobby' (worker.js's sendLobby() call sites are all
  // gated that way), but this client does not trust that as an invariant: assigning
  // `ctx.phase` from it unconditionally would let a stray or future lobby broadcast
  // overwrite a live match phase out from under the assault/draft/result UI.
  function onLobby(message) {
    if (ctx.phase !== 'lobby') return;
    ctx.phase = message.phase;
    const you = message.players.find((p) => p.pid === ctx.pid);
    const opponent = message.players.find((p) => p.pid !== ctx.pid);
    ctx.opponent = opponent ? { pid: opponent.pid, name: opponent.name } : null;
    ctx.host = message.host === ctx.pid;
    roomState.hidden = false;
    playersLine.textContent = opponent
      ? `${you?.name ?? 'You'} vs ${opponent.name} — ready.`
      : `${you?.name ?? 'You'} — waiting for an opponent to join "${ctx.room}"…`;
    startButton.hidden = !(ctx.host && opponent && message.players.length === message.max);
    setStatus(`In room "${ctx.room}".`);
  }

  // ---------------------------------------------------------------- build phase

  function onBuild(message) {
    ctx.phase = 'build';
    ctx.round = message.round;
    ctx.buildBudget = message.budget;
    ctx.buildCards = message.cards;
    ctx.locked = false;
    ctx.buildDeadline = performance.now() + message.left * 1000;
    siegeLockButton.disabled = false;
    stopLobbyPolling();
    // Every screen a previous round or the lobby could have left open. openEditor() itself
    // only knows about the campaign/editor screens (titleScreen, roundHud, roundOver) — it
    // has no idea these online-only panels exist, so a round-2+ build phase opened underneath
    // a still-visible result or draft panel (position:absolute; inset:0; z-index:40 — see
    // style.css's .screen-panel), swallowing every click and fill() into the new editor.
    lobbyScreen.hidden = true;
    siegeResultScreen.hidden = true;
    siegeDraftScreen.hidden = true;
    siegePreview.hidden = true;
    openEditor({ budget: message.budget, cards: message.cards, onLock: sendLock });
    updateBuildBanner(message.left);
  }

  function onBuildClock(message) { updateBuildBanner(message.left); }

  function updateBuildBanner(leftSeconds) {
    if (ctx.phase !== 'build') return;
    siegeBanner.hidden = false;
    siegeRoundLabel.textContent = `Round ${ctx.round}`;
    siegeWinsLabel.textContent = ctx.opponent ? '— vs —' : '';
    siegeScrapLabel.textContent = `${(scrapLeftLabel?.textContent ?? '').trim() || '—'} scrap`;
    const left = Number.isFinite(leftSeconds) ? leftSeconds
      : Math.max(0, (ctx.buildDeadline - performance.now()) / 1000);
    siegeClock.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  }

  // Called by both the "Lock in" button and Space (via openEditor's editorSiege.onLock hook —
  // see game.js), exactly the same as solo Siege's lockSiegeFortress. The relay validates and
  // settles authoritatively; this runs the identical validator first so a fortress that would
  // fail server-side already shows its errors locally, per the "one ladder, each side
  // validating with the validator it trusts" rule this task was built under.
  function sendLock(expired) {
    if (ctx.phase !== 'build' || ctx.locked) return;
    const rules = { mode: 'siege', budget: ctx.buildBudget, cards: ctx.buildCards };
    let blueprint = toBlueprint(getEditorDraft());
    let check = validate(blueprint, rules);
    if (!check.ok) {
      if (!expired) { renderValidation(); return; }
      blueprint = autoCompleteCandidates(blueprint).find((c) => validate(c, rules).ok) ?? blueprint;
      check = validate(blueprint, rules);
      if (!check.ok) { renderValidation(); return; }
    }
    const settled = settleTest(blueprint, rules);
    if (!settled.ok && !expired) { renderValidation(); return; }
    ctx.locked = true;
    ctx.myBlueprint = encode(blueprint);
    siegeLockButton.disabled = true;
    net.send({ t: 'lock', blueprint: ctx.myBlueprint });
  }

  function onBuildRejected(message) {
    ctx.locked = false;
    siegeLockButton.disabled = false;
    const detail = (message.errors ?? []).map((e) => e.message).join(' ');
    statusMessage.textContent = `The relay rejected that fortress: ${detail || message.reason || 'invalid'}.`;
  }

  // ---------------------------------------------------------------- siege phase

  // `?siege-seed=` (see game.js) is read once into a module-level constant that this module
  // never imports — the seed used below always comes from `message.seed`, the relay's own
  // field, so there is no code path through which a client-supplied override could reach an
  // online round. The smoke test asserts the round's actual seed equals the relay's, not the
  // pinned query value, which is the measured half of that guarantee.
  function onSiege(message) {
    ctx.phase = 'siege';
    siegeBanner.hidden = true;
    closeEditor();
    ctx.opponent = message.opponent ? { pid: message.opponent.pid, name: message.opponent.name } : ctx.opponent;

    const attackRound = makeRound({
      mode: 'siege',
      blueprint: decode(message.blueprint),
      bag: message.bag,
      seed: message.seed,
      attackerCards: message.attackerCards,
      defenderCards: message.defenderCards
    });
    // The authored blueprint is unsettled; both this client and the relay's audit replay
    // SETTLE_STEPS of plain physics before the first shot is legal (relay-audit.js's
    // checkShot rejects step < SETTLE_STEPS). Doing it in a tight loop up front, rather than
    // over three real seconds of idle waiting, is safe: wallStepLimit's CLOCK_SLOP_STEPS
    // gives room for a locally-computed step count to run ahead of elapsed wall time, and
    // the relay's own auditTarget floors at SETTLE_STEPS regardless of elapsed time too.
    for (let i = 0; i < SETTLE_STEPS; i++) stepRound(attackRound, TUNE.step);
    ctx.attackRound = attackRound;
    ctx.shotsReported = 0;
    ctx.tapReportedFor = -1;
    ctx.boundaryShotIndex = 0;
    ctx.terminalReported = false;
    ctx.lastSentPose.clear();
    ctx.reportedDeadBlocks.clear();
    ctx.reportedDeadPigs.clear();

    // The shadow round renders MY OWN fortress under the opponent's attack. Their attack has
    // attackerCards = their cards, defenderCards = mine — which are exactly my own
    // `defenderCards`/`attackerCards` fields, swapped. Building it from these relay-supplied
    // arrays (not from any locally-tracked card list) is what keeps body ids aligned with
    // the real attacking round on the opponent's machine: instantiate()'s id assignment only
    // depends on the blueprint and the defender's cards, and both sides now agree on both.
    const shadowRound = makeRound({
      mode: 'siege',
      blueprint: decode(ctx.myBlueprint),
      bag: [],
      seed: message.seed,
      attackerCards: message.defenderCards,
      defenderCards: message.attackerCards
    });
    for (let i = 0; i < SETTLE_STEPS; i++) stepRound(shadowRound, TUNE.step);
    ctx.shadowRound = shadowRound;
    ctx.shadowBodyById = new Map(shadowRound.world.bodies.map((b) => [b.id, b]));
    ctx.shadowPigById = new Map(shadowRound.pigs.map((p) => [p.id, p]));
    ctx.shadowKing = shadowRound.pigs.find((p) => p.isKing) ?? null;
    ctx.theirAmmoFallback = bagForRound(message.seed, message.round, message.defenderCards).length;

    setRound(attackRound);
    setPlaying(true);
    resetCameraState('aiming');
    updateHud(true);
    document.body.classList.add('playing');
    roundHud.hidden = false;
    titleScreen.hidden = true;
    siegePreview.hidden = false;
    renderPreviewFrame();
    siegeTheirScore.textContent = '0';
    siegeTheirAmmo.textContent = `${ctx.theirAmmoFallback} left`;
    siegePreviewKing.classList.remove('dead');
  }

  function ammoIndexFor(round) { return round.shotIndex - 1; }

  // Watches the shared, already-stepping `round` for shots, taps and settle boundaries and
  // reports them to the relay. This never decides a round's outcome locally — that stays the
  // relay's job (ARCHITECTURE.md §5) — it only reports what the local sim, which is already
  // authoritative for driving MY OWN attack, observed.
  function monitorSiege() {
    const round = ctx.attackRound;
    if (!round || !net?.connected()) return;
    while (ctx.shotsReported < round.shots.length) {
      const shot = round.shots[ctx.shotsReported];
      net.send({ t: 'shot', step: shot.step, ammoIndex: ctx.shotsReported, dx: shot.dx, dy: shot.dy });
      ctx.shotsReported++;
    }
    const lastIdx = round.shots.length - 1;
    if (lastIdx >= 0 && round.shots[lastIdx].tapStep != null && ctx.tapReportedFor !== lastIdx) {
      net.send({ t: 'tap', step: round.shots[lastIdx].tapStep });
      ctx.tapReportedFor = lastIdx;
    }
    if (round.phase === 'aiming' && round.shotIndex > ctx.boundaryShotIndex) {
      net.send({
        t: 'score', step: round.stepCount, ammoIndex: ammoIndexFor(round),
        score: round.score, digest: digestRound(round), kingPop: false, settled: true
      });
      ctx.boundaryShotIndex = round.shotIndex;
    } else if (isRoundOver(round) && !ctx.terminalReported) {
      net.send({
        t: 'score', step: round.stepCount, ammoIndex: ammoIndexFor(round),
        score: round.score, digest: digestRound(round),
        kingPop: round.phase === 'won', settled: round.phase === 'lost'
      });
      ctx.terminalReported = true;
      // The round-defining moment — a King popped or the bag ran dry — can land inside the
      // 8 Hz preview's own cooldown window, and the relay can confirm round-over well inside
      // that same ~125 ms gap (checkScore's audit runs synchronously in the message handler
      // that receives this very report, not on the next tick). Miss this one and there is no
      // later "allowed" tick to catch it on: onRoundOver stops this loop from running again
      // for this round. The opponent's corner preview would keep showing a live King that is
      // actually already dead. Bypass the throttle here, once, deliberately.
      sendPreviewIfDue(round, true);
      return;
    }
    sendPreviewIfDue(round);
  }

  function sendPreviewIfDue(round, force = false) {
    const now = performance.now();
    if (!force && !previewAllowed(ctx.lastPreviewSentAt, now, round.attackerCards)) return;
    const d = [];
    for (const block of round.blocks) {
      if (d.length >= PREVIEW_MAX_DELTA) break;
      if (ctx.reportedDeadBlocks.has(block.id)) continue;
      if (block.dead) {
        d.push([block.id, 0, 0, 0, 0, 1]);
        ctx.reportedDeadBlocks.add(block.id);
        ctx.lastSentPose.delete(block.id);
        continue;
      }
      const pose = poseOf(block);
      if (posesDiffer(ctx.lastSentPose.get(block.id), pose)) {
        d.push([block.id, ...pose, 0]);
        ctx.lastSentPose.set(block.id, pose);
      }
    }
    const p = [];
    for (const pig of round.pigs) {
      if (pig.dead && !ctx.reportedDeadPigs.has(pig.id)) {
        p.push([pig.id, 1]);
        ctx.reportedDeadPigs.add(pig.id);
      }
    }
    ctx.lastPreviewSentAt = now;
    if (!d.length && !p.length) return; // nothing moved since last frame; save the send
    net.send({
      t: 'preview',
      frame: { d, p, s: round.score, a: round.bag.length - round.shotIndex }
    });
  }

  function applyPreview(frame) {
    if (!ctx.shadowRound || !frame) return;
    let moved = 0;
    for (const [id, x, y, c, s, dead] of frame.d ?? []) {
      const body = ctx.shadowBodyById.get(id);
      if (!body) continue;
      if (dead) { body.dead = true; moved++; continue; }
      body.x = x; body.y = y; body.c = c; body.s = s;
      moved++;
    }
    for (const [id, dead] of frame.p ?? []) {
      const pig = ctx.shadowPigById.get(id);
      if (pig && dead) { pig.dead = true; moved++; }
    }
    if (moved) ctx.previewBodiesMovedTotal += moved;
    if (moved) ctx.previewFramesApplied++;
    renderPreviewFrame();
    siegeTheirScore.textContent = String(Math.round(frame.s ?? 0));
    siegeTheirAmmo.textContent = `${frame.a ?? ctx.theirAmmoFallback} left`;
    siegePreviewKing.classList.toggle('dead', Boolean(ctx.shadowKing?.dead));
  }

  function renderPreviewFrame() {
    if (!ctx.shadowRound) return;
    const previewCtx = siegePreviewCanvas.getContext('2d');
    drawPreview(previewCtx, ctx.shadowRound, siegePreviewCanvas.width, siegePreviewCanvas.height);
  }

  function onResume(message) {
    // Reconnecting mid-round: rebuild the round exactly as tools/mp-smoke.mjs's own
    // replayResume probe does, then fall back into the normal monitor loop. The shadow
    // round (the opponent's attack on MY fortress) has no equivalent log to replay — the
    // preview lost while disconnected is gone, which is an honest, DESIGN-sanctioned
    // degradation ("allowed to be wrong by a frame"; here, wrong by the outage).
    const round = makeRound({
      mode: 'siege', blueprint: decode(message.blueprint), bag: message.bag,
      seed: message.seed, attackerCards: message.attackerCards, defenderCards: message.defenderCards
    });
    let cursor = 0;
    while (true) {
      while (cursor < message.shotLog.length && message.shotLog[cursor].step === round.stepCount) {
        const event = message.shotLog[cursor++];
        if (event.t === 'shot') launch(round, event.dx, event.dy);
        else if (event.t === 'tap') tap(round);
        else if (event.t === 'remote-tnt') remoteDetonate(round);
      }
      if (round.stepCount >= message.step) break;
      stepRound(round, TUNE.step);
    }
    ctx.phase = 'siege';
    ctx.round = message.round;
    ctx.attackRound = round;
    ctx.shotsReported = round.shots.length;
    ctx.tapReportedFor = round.shots.length - 1;
    ctx.boundaryShotIndex = round.shotIndex;
    ctx.terminalReported = isRoundOver(round);
    ctx.myBlueprint = ctx.myBlueprint || null;
    ctx.opponent = message.opponent ?? ctx.opponent;
    setRound(round);
    setPlaying(true);
    resetCameraState('aiming');
    updateHud(true);
    document.body.classList.add('playing');
    roundHud.hidden = false;
    titleScreen.hidden = true;
    if (ctx.shadowRound) siegePreview.hidden = false;
  }

  // ---------------------------------------------------------------- round-over / draft

  function standingLine(standings) {
    const mine = standings.find((s) => s.pid === ctx.pid);
    const theirs = standings.find((s) => s.pid !== ctx.pid);
    return `You ${mine?.wins ?? 0} — ${theirs?.wins ?? 0} ${theirs?.name ?? 'Them'}  ·  first to ${TUNE.winsNeeded}`;
  }

  function reasonDetail(message, iWon) {
    switch (message.reason) {
      case 'king-pop': return iWon ? 'You popped their King.' : 'They popped your King.';
      case 'score': {
        const mine = ctx.attackRound ? Math.round(ctx.attackRound.score) : null;
        return `Decided on points.${mine !== null ? ` Your score: ${mine}.` : ''}`;
      }
      case 'forfeit': case 'disconnect':
        return message.m || (message.loser === ctx.pid ? 'You forfeited the round.' : 'They forfeited the round.');
      default: return `Tiebreak: ${message.reason.replaceAll('-', ' ')}.`;
    }
  }

  function onRoundOver(message) {
    ctx.phase = 'round-over';
    setPlaying(false);
    siegePreview.hidden = true;
    const iWon = message.winner === ctx.pid;
    ctx.lastRoundOver = { round: message.round, winner: message.winner, reason: message.reason };
    siegeResultEyebrow.textContent = `Round ${message.round}`;
    siegeResultTitle.textContent = iWon ? 'You took the round' : 'They took the round';
    siegeResultDetail.textContent = reasonDetail(message, iWon);
    siegeStandings.textContent = standingLine(message.standings);
    siegeContinueButton.textContent = 'Continue';
    siegeResultScreen.hidden = false;
    roundHud.hidden = true;
    siegeResultTitle.focus({ preventScroll: true });
  }

  function onMatchOver(message) {
    ctx.phase = 'match-over';
    ctx.matchWinner = message.winner;
    const iWon = message.winner === ctx.pid;
    siegeResultEyebrow.textContent = 'Match over';
    siegeResultTitle.textContent = iWon ? 'You win the siege' : 'They win the siege';
    siegeResultDetail.textContent = standingLine(message.standings);
    siegeStandings.textContent = '';
    // The relay has no rematch path (starting again from `match-over` is rejected as
    // wrong-phase; only both sockets dropping resets the room — see worker.js's tick()).
    // Offering "play again" here would promise something the relay cannot do.
    siegeContinueButton.textContent = 'Back to title';
    siegeResultScreen.hidden = false;
    siegeResultTitle.focus({ preventScroll: true });
  }

  function onDraftWait(message) {
    ctx.phase = 'draft';
    siegeResultDetail.textContent = `Waiting on the opponent's draft (${message.left}s)…`;
  }

  function onDraftOffer(message) {
    ctx.phase = 'draft';
    ctx.draftOffer = { candidates: message.candidates, deficit: message.deficit };
    siegeDraftEyebrow.textContent = message.deficit >= 2
      ? 'Two rounds down — take something unfair' : 'You lost the round';
    renderDraftCandidates(message.candidates);
    siegeResultScreen.hidden = true;
    siegeDraftScreen.hidden = false;
    siegeDraftCards.querySelector('button')?.focus();
  }

  // Card records (name/tier/text) are display-only here: `candidateIds` already came from
  // the relay's own `rollDraft`, so this never re-derives which cards are legal to offer.
  function renderDraftCandidates(candidateIds) {
    siegeDraftCards.replaceChildren(...candidateIds.map((id) => {
      const card = CARDS_BY_ID[id];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'siege-card';
      const tier = document.createElement('div');
      tier.className = 'tier';
      tier.textContent = card?.tierName ?? id;
      const name = document.createElement('div');
      name.className = 'card-name';
      name.textContent = card?.name ?? id;
      const text = document.createElement('div');
      text.className = 'card-text';
      text.textContent = card?.text ?? '';
      button.append(tier, name, text);
      button.addEventListener('click', () => {
        net.send({ t: 'draft-pick', card: id });
        siegeDraftScreen.hidden = true;
      });
      return button;
    }));
  }

  // ---------------------------------------------------------------- keyboard (a11y)

  // #round-over (game.js) already traps Tab inside itself while open. These four overlays
  // share the same full-screen .screen-panel treatment (index.html now marks all four
  // role="dialog" aria-modal="true", critter-intro included) but never got the same trap, so
  // Tab could walk out to controls hidden underneath. One listener, keyed off whichever is
  // actually visible, covers all of them without a trap function per screen. #critter-intro
  // itself lives in game.js (out of scope) and has exactly one button, so the trap makes Tab
  // there a correct no-op rather than a real cycle — still the right behaviour for aria-modal.
  // Escape backs out of the lobby the same way it already does everywhere else (campaign
  // episode/level screens, the editor), guarded the same way game.js guards its own editor
  // shortcuts: a key typed into a field is text input, not a screen-level command.
  const modalScreens = [lobbyScreen, siegeDraftScreen, siegeResultScreen, document.querySelector('#critter-intro')];
  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLElement &&
      Boolean(event.target.closest('input, textarea, select, [contenteditable="true"]'));
    if (event.key === 'Escape' && isActive() && !lobbyScreen.hidden && !typing) { quit(); return; }
    if (event.key !== 'Tab') return;
    const panel = modalScreens.find((screen) => !screen.hidden);
    if (!panel) return;
    const focusable = [...panel.querySelectorAll('button, input, textarea, a[href]')]
      .filter((el) => !el.disabled && el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  // ---------------------------------------------------------------- listener guards

  siegeQuitButton.addEventListener('click', () => { if (isActive()) quit(); });
  siegeContinueButton.addEventListener('click', () => {
    if (!isActive()) return;
    siegeResultScreen.hidden = true;
    if (ctx.phase === 'match-over') quit();
  });

  // ---------------------------------------------------------------- loop + snapshot

  function tick() {
    loopHandle = requestAnimationFrame(tick);
    if (!ctx?.active) return;
    if (ctx.phase === 'build') {
      updateBuildBanner();
      if (!ctx.locked && performance.now() >= ctx.buildDeadline) sendLock(true);
    } else if (ctx.phase === 'siege') {
      monitorSiege();
    }
  }

  function startLoop() { if (!loopHandle) loopHandle = requestAnimationFrame(tick); }
  function stopLoop() { cancelAnimationFrame(loopHandle); loopHandle = 0; }

  function snapshot() {
    if (!ctx?.active) return null;
    return {
      connection: net?.state() ?? 'idle',
      pid: ctx.pid,
      host: ctx.host,
      room: ctx.room,
      phase: ctx.phase,
      round: ctx.round,
      opponent: ctx.opponent,
      seed: ctx.attackRound?.seed ?? null,
      attackerCards: ctx.attackRound ? [...ctx.attackRound.attackerCards] : null,
      defenderCards: ctx.attackRound ? [...ctx.attackRound.defenderCards] : null,
      shadowAttackerCards: ctx.shadowRound ? [...ctx.shadowRound.attackerCards] : null,
      shadowDefenderCards: ctx.shadowRound ? [...ctx.shadowRound.defenderCards] : null,
      attack: ctx.attackRound ? {
        phase: ctx.attackRound.phase, shot: ctx.attackRound.shotIndex,
        bag: ctx.attackRound.bag.length, step: ctx.attackRound.stepCount, score: ctx.attackRound.score
      } : null,
      previewFramesApplied: ctx.previewFramesApplied,
      previewBodiesMovedTotal: ctx.previewBodiesMovedTotal,
      lastRoundOver: ctx.lastRoundOver,
      matchWinner: ctx.matchWinner,
      draftOffer: ctx.draftOffer,
      lastError: ctx.lastError,
      recentErrors: [...ctx.recentErrors]
    };
  }

  return { open, isActive, snapshot };
}
