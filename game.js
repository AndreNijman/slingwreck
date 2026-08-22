import { AMMO_BY_ID, SCORE, TUNE } from './data.js?v=20260822-1';
import {
  isRoundOver,
  launch,
  makeRound,
  stepRound,
  tap
} from './sim.js?v=20260822-1';
import {
  PALETTE,
  capturePose,
  draw,
  frameRect,
  makeCamera,
  makeRenderer,
  panTo,
  pushEvents,
  screenToWorld
} from './render.js?v=20260822-1';
import {
  makeAudio,
  pushEvents as pushAudioEvents,
  setMuted as setAudioMuted,
  unlock as unlockAudio
} from './audio.js?v=20260822-1';

// P5 moves this authored level, including its star thresholds, into levels.js.
const SLICE_LEVEL = Object.freeze({
  id: 'first-wreck',
  name: 'A Delicate Arrangement',
  seed: 0x51a9,
  bag: ['nib', 'nib', 'nib', 'nib'],
  starScores: [15000, 28000, 40000],
  blueprint: {
    v: 1,
    blocks: [
      ['slab', 'stone', 6, 0.5, 0],
      ['post', 'wood', 5.25, 2, 0],
      ['post', 'wood', 6.75, 2, 0],
      ['beam', 'wood', 6, 3.25, 0],
      ['post', 'glass', 5.25, 4.5, 0],
      ['post', 'glass', 6.75, 4.5, 0],
      ['plank', 'wood', 6, 5.75, 0],
      ['cube', 'tnt', 8.75, 0.5, 0],
      ['slab', 'stone', 11.5, 0.5, 0],
      ['post', 'stone', 10.75, 2, 0],
      ['post', 'wood', 12.25, 2, 0],
      ['beam', 'wood', 11.5, 3.25, 0],
      ['post', 'glass', 10.75, 4.5, 0],
      ['post', 'glass', 12.25, 4.5, 0],
      ['plank', 'wood', 11.5, 5.75, 0]
    ],
    pigs: [
      ['runt', 6, 1.3],
      ['runt', 11.5, 1.3],
      ['runt', 11.5, 3.8]
    ]
  }
});

// Practice links may pin one critter without changing the authored level or normal play.
const requestedAmmo = new URLSearchParams(window.location.search).get('ammo');
const pinnedAmmo = requestedAmmo && AMMO_BY_ID[requestedAmmo] ? requestedAmmo : null;

const GRAB_RADIUS = 2;
const MAX_CAMERA_ZOOM = 4;
const MIN_USER_ZOOM = -0.45;
const MAX_USER_ZOOM = 0.8;
const POINTER_TAP_DISTANCE = 12;
const AIMING_FRAME_HEIGHT = 12;
const FORTRESS_FRAME_HEIGHT = 8;
const FORTRESS_FEEDBACK_SECONDS = 1.25;
const scoreFormat = new Intl.NumberFormat('en-AU');

const canvas = document.querySelector('#game');
const titleScreen = document.querySelector('#title-screen');
const roundHud = document.querySelector('#round-hud');
const roundOver = document.querySelector('#round-over');
const playButton = document.querySelector('#play-button');
const restartButton = document.querySelector('#restart-button');
const muteButton = document.querySelector('#mute-button');
const abilityButton = document.querySelector('#ability-button');
const retryButton = document.querySelector('#retry-button');
const nextButton = document.querySelector('#next-button');
const menuButton = document.querySelector('#menu-button');
const ammoList = document.querySelector('#ammo-list');
const scoreValue = document.querySelector('#score-value');
const roundTitle = document.querySelector('#round-title');
const roundAnnouncement = document.querySelector('#round-announcement');
const finalScore = document.querySelector('#final-score');
const stars = document.querySelector('#stars');
const statusMessage = document.querySelector('#status-message');

const renderer = makeRenderer(canvas);
const audio = makeAudio();
const camera = makeCamera();
const cameraTarget = makeCamera();
const aim = { active: false, dx: 0, dy: 0, startX: 0, startY: 0, scale: 1 };
const pan = { active: false, pointerId: null, startX: 0, cameraX: 0, targetX: 0 };
const pointers = new Map();

let round = createRound();
let playing = false;
let muted = false;
let roundOverShown = false;
let accumulator = 0;
let last = performance.now();
let userZoom = 0;
let aimPointerId = null;
let lastPinchDistance = 0;
let shownScore = -1;
let shownShotIndex = -1;
let shownPhase = '';
let cameraMode = 'aiming';
let cameraPhase = round.phase;
let fortressFeedbackTime = 0;

function createRound() {
  return makeRound({
    mode: 'campaign',
    seed: SLICE_LEVEL.seed,
    bag: pinnedAmmo ? SLICE_LEVEL.bag.map(() => pinnedAmmo) : SLICE_LEVEL.bag,
    blueprint: SLICE_LEVEL.blueprint
  });
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function setAimActive(active) {
  aim.active = active;
  document.body.classList.toggle('aiming', active);
}

function cancelAim() {
  setAimActive(false);
  aimPointerId = null;
  aim.dx = 0;
  aim.dy = 0;
}

function cancelPan() {
  pan.active = false;
  pan.pointerId = null;
}

function resetCameraState(mode) {
  cameraMode = mode;
  cameraPhase = round.phase;
  fortressFeedbackTime = 0;
  cancelPan();
}

function enterFortressFeedback() {
  if (cameraMode !== 'settling') fortressFeedbackTime = 0;
  cameraMode = 'settling';
}

function observeCameraEvents(events) {
  if (events.some((event) => event.kind === 'settled' ||
      event.kind === 'won' || event.kind === 'lost')) {
    enterFortressFeedback();
  }
}

function startRound() {
  round = createRound();
  playing = true;
  roundOverShown = false;
  accumulator = 0;
  last = performance.now();
  shownScore = -1;
  shownShotIndex = -1;
  shownPhase = '';
  pointers.clear();
  cancelAim();
  resetCameraState('aiming');
  titleScreen.hidden = true;
  roundOver.hidden = true;
  roundHud.hidden = false;
  document.body.classList.add('playing');
  updateHud(true);
  canvas.focus({ preventScroll: true });
}

function showTitle() {
  playing = false;
  accumulator = 0;
  pointers.clear();
  cancelAim();
  resetCameraState('fortress');
  roundHud.hidden = true;
  roundOver.hidden = true;
  titleScreen.hidden = false;
  abilityButton.hidden = true;
  document.body.classList.remove('playing');
  playButton.focus({ preventScroll: true });
}

function setMuted(nextMuted) {
  muted = nextMuted;
  setAudioMuted(audio, muted);
  muteButton.textContent = muted ? 'Sound off' : 'Sound on';
  muteButton.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} sound (M)`);
  muteButton.title = `${muted ? 'Unmute' : 'Mute'} sound (M)`;
  statusMessage.textContent = muted ? 'Sound muted.' : 'Sound on.';
}

function drawCritterHead(icon) {
  const size = 44;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  icon.width = Math.round(size * dpr);
  icon.height = Math.round(size * dpr);
  const ctx = icon.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2.5;
  ctx.fillStyle = PALETTE.critter;
  ctx.beginPath();
  ctx.moveTo(10, 20);
  ctx.lineTo(4, 12);
  ctx.lineTo(14, 15);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(22, 23, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PALETTE.belly;
  ctx.beginPath();
  ctx.ellipse(18, 29, 8, 6, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PALETTE.ink;
  ctx.beginPath();
  ctx.arc(27, 18, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.crown;
  ctx.beginPath();
  ctx.moveTo(34, 21);
  ctx.lineTo(42, 25);
  ctx.lineTo(34, 29);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function rebuildAmmoList() {
  const fragment = document.createDocumentFragment();
  for (let index = round.shotIndex; index < round.bag.length; index++) {
    const ammo = AMMO_BY_ID[round.bag[index]];
    const icon = document.createElement('canvas');
    icon.className = 'ammo-head';
    icon.setAttribute('role', 'listitem');
    icon.setAttribute('aria-label', `${ammo.name}, shot ${index + 1}`);
    drawCritterHead(icon);
    fragment.append(icon);
  }
  ammoList.replaceChildren(fragment);
  const remaining = round.bag.length - round.shotIndex;
  ammoList.setAttribute('aria-label', `${remaining} critter${remaining === 1 ? '' : 's'} remaining`);
}

function updateHud(force = false) {
  if (force || round.score !== shownScore) {
    const unusedBonus = (round.bag.length - round.shotIndex) * SCORE.campaign.unusedAmmo;
    const liveScore = isRoundOver(round) ? round.score : Math.max(0, round.score - unusedBonus);
    scoreValue.textContent = scoreFormat.format(Math.round(liveScore));
    shownScore = round.score;
  }
  if (force || round.shotIndex !== shownShotIndex) {
    rebuildAmmoList();
    shownShotIndex = round.shotIndex;
  }
  if (force || round.phase !== shownPhase) {
    abilityButton.hidden = round.phase !== 'flying';
    canvas.dataset.phase = round.phase;
    shownPhase = round.phase;
  }
}

function earnedStars(score) {
  let count = 0;
  for (const threshold of SLICE_LEVEL.starScores) if (score >= threshold) count++;
  return count;
}

function showRoundOver() {
  if (roundOverShown) return;
  roundOverShown = true;
  const won = round.phase === 'won';
  const count = won ? earnedStars(round.score) : 0;
  roundHud.hidden = true;
  roundOver.hidden = false;
  abilityButton.hidden = true;
  roundTitle.textContent = won ? 'Fortress wrecked' : 'Out of critters';
  roundAnnouncement.textContent = won
    ? `You brought the fortress down and earned ${count} star${count === 1 ? '' : 's'}.`
    : 'The pigs are still standing. Pull farther back and aim for the crate of bang.';
  finalScore.textContent = scoreFormat.format(Math.round(round.score));
  stars.replaceChildren();
  for (let index = 0; index < 3; index++) {
    const star = document.createElement('span');
    star.textContent = '★';
    if (index >= count) star.className = 'empty';
    star.setAttribute('aria-hidden', 'true');
    stars.append(star);
  }
  stars.setAttribute('aria-label', `${count} of 3 stars earned`);
  roundTitle.tabIndex = -1;
  roundTitle.focus({ preventScroll: true });
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * renderer.width / rect.width,
    y: (event.clientY - rect.top) * renderer.height / rect.height
  };
}

function updateAim(point) {
  let dx = (point.x - aim.startX) / aim.scale;
  let dy = (aim.startY - point.y) / aim.scale;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length > TUNE.slingRadius) {
    const scale = TUNE.slingRadius / length;
    dx *= scale;
    dy *= scale;
  }
  aim.dx = dx;
  aim.dy = dy;
}

function pointerDistance() {
  const values = pointers.values();
  const first = values.next().value;
  const second = values.next().value;
  if (!first || !second) return 0;
  return Math.sqrt((second.x - first.x) ** 2 + (second.y - first.y) ** 2);
}

function beginPinch() {
  for (const pointer of pointers.values()) pointer.pinching = true;
  lastPinchDistance = pointerDistance();
  cancelAim();
  cancelPan();
}

function adjustUserZoom(delta) {
  userZoom = clamp(userZoom + delta, MIN_USER_ZOOM, MAX_USER_ZOOM);
}

function beginPan(pointerId, point) {
  pan.active = true;
  pan.pointerId = pointerId;
  pan.startX = point.x;
  pan.cameraX = camera.x;
  pan.targetX = camera.x;
}

function onPointerDown(event) {
  if (!playing || isRoundOver(round) || event.button > 0) return;
  const point = canvasPoint(event);
  pointers.set(event.pointerId, {
    x: point.x,
    y: point.y,
    startX: point.x,
    startY: point.y,
    moved: false,
    pinching: false,
    mode: 'idle'
  });
  canvas.setPointerCapture(event.pointerId);
  if (pointers.size === 2) {
    beginPinch();
    return;
  }
  if (round.phase === 'aiming') {
    const world = screenToWorld(camera, point.x, point.y);
    const dx = world.x - TUNE.slingX;
    const dy = world.y - TUNE.slingY;
    if (dx * dx + dy * dy <= GRAB_RADIUS * GRAB_RADIUS) {
      pointers.get(event.pointerId).mode = 'aim';
      aimPointerId = event.pointerId;
      aim.startX = point.x;
      aim.startY = point.y;
      aim.scale = camera.scale;
      setAimActive(true);
      updateAim(point);
      return;
    }
  }
  pointers.get(event.pointerId).mode = 'pan';
  beginPan(event.pointerId, point);
}

function onPointerMove(event) {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  const point = canvasPoint(event);
  pointer.x = point.x;
  pointer.y = point.y;
  if (Math.abs(point.x - pointer.startX) + Math.abs(point.y - pointer.startY) > POINTER_TAP_DISTANCE) {
    pointer.moved = true;
  }
  if (pointers.size >= 2) {
    const distance = pointerDistance();
    if (lastPinchDistance > 0 && distance > 0) adjustUserZoom(Math.log(distance / lastPinchDistance));
    lastPinchDistance = distance;
    return;
  }
  if (aim.active && event.pointerId === aimPointerId) {
    updateAim(point);
  } else if (pan.active && event.pointerId === pan.pointerId) {
    pan.targetX = pan.cameraX - (point.x - pan.startX) / camera.scale;
  }
}

function finishPointer(event, cancelled) {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  const wasPinching = pointer.pinching || pointers.size > 1;
  if (aim.active && event.pointerId === aimPointerId) {
    if (!cancelled) launch(round, aim.dx, aim.dy);
    cancelAim();
  } else {
    if (pan.active && event.pointerId === pan.pointerId) cancelPan();
    if (!cancelled && !wasPinching && !pointer.moved && round.phase === 'flying') {
      tap(round);
    }
  }
  pointers.delete(event.pointerId);
  if (pointers.size < 2) lastPinchDistance = 0;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  updateHud();
}

function useAbility() {
  if (playing && round.phase === 'flying') tap(round);
}

function syncCameraTarget() {
  cameraTarget.canvasW = camera.canvasW;
  cameraTarget.canvasH = camera.canvasH;
  cameraTarget.viewportW = camera.viewportW;
  cameraTarget.viewportH = camera.viewportH;
  cameraTarget.viewportX = camera.viewportX;
  cameraTarget.viewportY = camera.viewportY;
  cameraTarget.viewH = camera.viewH;
  cameraTarget.minZoom = camera.minZoom;
}

function frameDefaultView(target, x, y) {
  const baseScale = target.canvasH / target.viewH;
  const halfWidth = target.viewportW / baseScale / 2;
  frameRect(target, x - halfWidth, y - target.viewH / 2,
    x + halfWidth, y + target.viewH / 2, 0);
}

function clampCameraX(x, zoom) {
  const scale = camera.canvasH / camera.viewH * zoom;
  const halfWidth = camera.viewportW / scale / 2;
  const low = TUNE.viewMinX + halfWidth;
  const high = TUNE.viewMaxX - halfWidth;
  return low <= high ? clamp(x, low, high) : (TUNE.viewMinX + TUNE.viewMaxX) / 2;
}

function updateCameraMode(dt) {
  if (round.phase !== cameraPhase) {
    if (round.phase === 'flying') {
      cameraMode = 'flying';
      fortressFeedbackTime = 0;
    } else if (round.phase === 'settling' || isRoundOver(round)) {
      enterFortressFeedback();
    } else if (round.phase === 'aiming' && cameraMode !== 'settling') {
      cameraMode = 'aiming';
    }
    cameraPhase = round.phase;
  }
  if (cameraMode === 'settling') {
    fortressFeedbackTime += Math.max(0, dt);
    if (round.phase === 'aiming' && fortressFeedbackTime >= FORTRESS_FEEDBACK_SECONDS) {
      cameraMode = 'aiming';
    }
  }
  canvas.dataset.cameraMode = playing ? cameraMode : 'fortress';
}

function updateCamera(dt) {
  syncCameraTarget();
  updateCameraMode(dt);
  if (!playing || cameraMode === 'settling') {
    frameRect(cameraTarget, 0, 0, TUNE.plotW, FORTRESS_FRAME_HEIGHT, 0);
  } else if (cameraMode === 'flying' && round.flying) {
    const body = round.flying;
    const leadX = clamp(body.vx * 0.12, -3, 3);
    const leadY = clamp(body.vy * 0.05, -1.2, 1.2);
    const centreX = body.x + leadX;
    const centreY = Math.max(3.8, body.y + leadY);
    frameDefaultView(cameraTarget, centreX, centreY);
  } else {
    frameRect(cameraTarget, TUNE.slingX - 3, 0,
      TUNE.plotW + 2, AIMING_FRAME_HEIGHT, 0);
  }

  const desiredZoom = clamp(
    cameraTarget.zoom * Math.exp(userZoom),
    camera.minZoom,
    MAX_CAMERA_ZOOM
  );
  if (pan.active) cameraTarget.x = clampCameraX(pan.targetX, desiredZoom);
  const zoomBlend = 1 - Math.exp(-6 * Math.max(0, dt));
  camera.zoom += (desiredZoom - camera.zoom) * zoomBlend;
  panTo(camera, cameraTarget.x, cameraTarget.y, dt);
}

function frame(now) {
  const elapsed = Math.min(250, Math.max(0, now - last));
  last = now;
  if (playing && !isRoundOver(round)) {
    accumulator = Math.min(
      accumulator + elapsed / 1000,
      TUNE.step * TUNE.catchUpSteps
    );
    let steps = 0;
    while (accumulator >= TUNE.step && steps < TUNE.catchUpSteps) {
      capturePose(renderer, round);
      const events = stepRound(round, TUNE.step);
      pushEvents(renderer, events);
      pushAudioEvents(audio, events);
      observeCameraEvents(events);
      accumulator -= TUNE.step;
      steps++;
    }
    updateHud();
    if (isRoundOver(round)) showRoundOver();
  } else {
    accumulator = 0;
  }

  updateCamera(elapsed / 1000);
  const alpha = !playing || isRoundOver(round) ? 1 : accumulator / TUNE.step;
  draw(renderer, round, camera, alpha, aim);
  requestAnimationFrame(frame);
}

playButton.addEventListener('click', () => {
  void unlockAudio(audio);
  startRound();
});
restartButton.addEventListener('click', startRound);
retryButton.addEventListener('click', startRound);
menuButton.addEventListener('click', showTitle);
muteButton.addEventListener('click', () => setMuted(!muted));
abilityButton.addEventListener('click', useAbility);
nextButton.addEventListener('click', () => {});

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', (event) => finishPointer(event, false));
canvas.addEventListener('pointercancel', (event) => finishPointer(event, true));
canvas.addEventListener('lostpointercapture', (event) => {
  if (pointers.has(event.pointerId)) finishPointer(event, true);
});
canvas.addEventListener('wheel', (event) => {
  if (!playing) return;
  event.preventDefault();
  adjustUserZoom(-event.deltaY * 0.0015);
}, { passive: false });

document.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.key === 'Escape' && playing) {
    event.preventDefault();
    showTitle();
  } else if (event.key === ' ' && playing && round.phase === 'flying') {
    event.preventDefault();
    useAbility();
  } else if (event.key.toLowerCase() === 'r' && playing) {
    event.preventDefault();
    startRound();
  } else if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    setMuted(!muted);
  }
});

document.documentElement.dataset.gameReady = 'true';
updateHud(true);
requestAnimationFrame(frame);

if (new URLSearchParams(window.location.search).has('smoke-test')) {
  Object.defineProperty(window, '__SLINGWRECK_SMOKE__', {
    configurable: true,
    value: () => ({
      phase: round.phase,
      audioState: audio.context?.state ?? 'locked',
      shotIndex: round.shotIndex,
      bagSize: round.bag.length,
      stepCount: round.stepCount,
      aim: { active: aim.active, dx: aim.dx, dy: aim.dy },
      camera: {
        x: camera.x,
        y: camera.y,
        scale: camera.scale,
        zoom: camera.zoom,
        mode: cameraMode,
        viewportX: camera.viewportX,
        viewportY: camera.viewportY,
        viewportW: camera.viewportW,
        viewportH: camera.viewportH
      },
      cameraTarget: { x: cameraTarget.x, y: cameraTarget.y, zoom: cameraTarget.zoom },
      sling: {
        x: TUNE.slingX,
        y: TUNE.slingY,
        radius: TUNE.slingRadius,
        launchSpeedMax: TUNE.launchSpeedMax,
        gravity: TUNE.gravity,
        viewMinX: TUNE.viewMinX,
        viewMaxX: TUNE.viewMaxX
      },
      pigs: round.pigs.map(({ dead, x, y }) => ({ dead, x, y })),
      blocks: round.blocks.map(({ dead }) => ({ dead }))
    })
  });
}
