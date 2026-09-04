import {
  AMMO_BY_ID, BUDGET, CARDS, CARDS_BY_ID, MATERIALS, PIGS, SCORE, SHAPES,
  SIEGE_DIFFICULTIES, SIEGE_DIFFICULTY_DEFAULT, TUNE
} from './data.js?v=20260904-2';
import {
  finalizeSiegeScore,
  isRoundOver,
  launch,
  makeRound,
  stepRound,
  tap
} from './sim.js?v=20260904-2';
import {
  PALETTE,
  TRAJECTORY_STEP,
  capturePose,
  draw,
  drawPreview,
  drawThumbnail,
  frameRect,
  makeCamera,
  makeRenderer,
  panTo,
  pushEvents,
  screenToWorld
} from './render.js?v=20260904-2';
import {
  makeAudio,
  pushEvents as pushAudioEvents,
  setMuted as setAudioMuted,
  unlock as unlockAudio
} from './audio.js?v=20260904-2';
import {
  autoCompleteCandidates,
  budgetFor,
  decode,
  encode,
  fromBlueprint,
  makeDraft,
  moveTo,
  place,
  redo,
  removeAt,
  settleTest,
  spent,
  toBlueprint,
  undo,
  validate
} from './build.js?v=20260904-2';
import { LEVELS } from './levels.js?v=20260904-2';
import { fortressForBudget, planShot, shouldTap } from './bots.js?v=20260904-2';
import {
  bagForRound,
  defaultDraftPick,
  matchWinner,
  resolveRound,
  rollDraft
} from './relay-audit.js?v=20260904-2';
import {
  createCampaignUI,
  starResultText,
  starsForScore
} from './campaign-ui.js?v=20260904-2';
import { createOnlineSiege } from './siege-online.js?v=20260904-2';

// Practice links may pin one critter without changing the authored level or normal play.
const requestedAmmo = new URLSearchParams(window.location.search).get('ammo');
const pinnedAmmo = requestedAmmo && AMMO_BY_ID[requestedAmmo] ? requestedAmmo : null;

// `siege.seed` is otherwise `Date.now() ^ 0x5109` — reproducible for the length of one
// match, per DESIGN.md, but different on every page load, which makes a browser-driven
// siege test unable to target a specific bag, draft or bot line-up. tools/siege-match.mjs
// pins this so the match it drives — who loses round 1, which cards are offered — is the
// same test on every run instead of whatever the clock hands it.
const requestedSiegeSeed = new URLSearchParams(window.location.search).get('siege-seed');
const pinnedSiegeSeed = requestedSiegeSeed !== null && Number.isFinite(Number(requestedSiegeSeed))
  ? Number(requestedSiegeSeed) >>> 0
  : null;

const GRAB_RADIUS = 2;
const MAX_CAMERA_ZOOM = 4;
const MIN_USER_ZOOM = -0.45;
const MAX_USER_ZOOM = 0.8;
const POINTER_TAP_DISTANCE = 12;
const AIMING_FRAME_HEIGHT = 12;
const FORTRESS_FRAME_HEIGHT = 8;
const FORTRESS_FEEDBACK_SECONDS = 1.25;
const EDITOR_FRAME_MARGIN = 1;
const EDITOR_GROUND_LINE = 0.78;
const scoreFormat = new Intl.NumberFormat('en-AU');

const canvas = document.querySelector('#game');
const gameCanvasLabel = canvas.getAttribute('aria-label');
const editorCanvasLabel = 'Fortress plot. Click to place, drag to sweep a run, click an existing piece to move it, and right-click to remove it.';
const titleScreen = document.querySelector('#title-screen');
const editorScreen = document.querySelector('#editor-screen');
const roundHud = document.querySelector('#round-hud');
const roundOver = document.querySelector('#round-over');
const playButton = document.querySelector('#play-button');
const editorButton = document.querySelector('#editor-button');
const editorBackButton = document.querySelector('#editor-back-button');
const restartButton = document.querySelector('#restart-button');
const muteButton = document.querySelector('#mute-button');
const abilityButton = document.querySelector('#ability-button');
const abilityHint = document.querySelector('#ability-hint');
const retryButton = document.querySelector('#retry-button');
const nextButton = document.querySelector('#next-button');
const menuButton = document.querySelector('#menu-button');
const ammoList = document.querySelector('#ammo-list');
const pigList = document.querySelector('#pig-list');
// A separate binding, and a separate id. The editor palette already owned `pigList` and
// `#pig-list`; reusing either meant the editor's pig buttons and the HUD's objective row
// were writing over each other, which broke the palette while looking like a CSS problem.
const objectivePigs = document.querySelector('#objective-pigs');
const critterIntro = document.querySelector('#critter-intro');
const critterIntroArt = document.querySelector('#critter-intro-art');
const critterIntroName = document.querySelector('#critter-intro-name');
const critterIntroTip = document.querySelector('#critter-intro-tip');
const critterIntroButton = document.querySelector('#critter-intro-button');
const scoreValue = document.querySelector('#score-value');
const roundTitle = document.querySelector('#round-title');
const roundAnnouncement = document.querySelector('#round-announcement');
const finalScore = document.querySelector('#final-score');
const stars = document.querySelector('#stars');
const resultStarCopy = document.querySelector('#result-star-copy');
const statusMessage = document.querySelector('#status-message');
const scrapLeft = document.querySelector('#scrap-left');
const hoverCost = document.querySelector('#hover-cost');
const budgetMeter = document.querySelector('#budget-meter');
const undoButton = document.querySelector('#undo-button');
const redoButton = document.querySelector('#redo-button');
const gridButton = document.querySelector('#grid-button');
const settleButton = document.querySelector('#settle-button');
const materialsTab = document.querySelector('#materials-tab');
const pigsTab = document.querySelector('#pigs-tab');
const materialsPalette = document.querySelector('#materials-palette');
const pigsPalette = document.querySelector('#pigs-palette');
const materialList = document.querySelector('#material-list');
const shapeList = document.querySelector('#shape-list');
const rotationStatus = document.querySelector('#rotation-status');
const validationCount = document.querySelector('#validation-count');
const validationList = document.querySelector('#validation-list');
const settleResult = document.querySelector('#settle-result');
const blueprintInput = document.querySelector('#blueprint-input');
const copyBlueprintButton = document.querySelector('#copy-blueprint-button');
const pasteBlueprintButton = document.querySelector('#paste-blueprint-button');
const loadBlueprintButton = document.querySelector('#load-blueprint-button');

const renderer = makeRenderer(canvas);
const audio = makeAudio();
const camera = makeCamera();
const cameraTarget = makeCamera();
const editorCamera = makeCamera();
const aim = { active: false, dx: 0, dy: 0, startX: 0, startY: 0, scale: 1 };
const pan = { active: false, pointerId: null, startX: 0, cameraX: 0, targetX: 0 };
const pointers = new Map();
const editorPointers = new Map();
const editorPan = {
  active: false, pointerId: null, startX: 0, startY: 0, cameraX: 0, cameraY: 0
};

let currentLevel = LEVELS[0];
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
let shownPigsAlive = -1;
let shownPhase = '';
let cameraMode = 'aiming';
let cameraPhase = round.phase;
let fortressFeedbackTime = 0;
let editing = false;
let editorDraft = makeDraft();
let editorSiege = null;
// The round/deficit/banked purse, deliberately without the card bonus. `editorOptions`
// hands this to `makeDraft`/`fromBlueprint`, which each run it through `budgetFor` and add
// the bonus themselves — so if this instead tracked `editorDraft.budget` (already bonused
// once), reloading a blueprint while holding a `budget`-effect card would compose the
// bonus a second time, and the editor would show more scrap than `lockSiegeFortress`'s
// validator, composing it once from `siegeBudget`, will accept.
let editorBudgetBase;
let editorRound = null;
let editorBodyPieceIds = new Map();
let editorGroup = 'materials';
let editorMaterial = 'glass';
let editorShape = 'cube';
let editorPig = 'runt';
let editorRotation = 0;
let editorGrid = false;
let editorGhost = null;
let editorHoverWorld = null;
let editorDrag = null;
let editorHighlightCode = null;
let editorHighlightIds = new Set();
let settleAnimation = null;
let settleDisplayRound = null;
let settleMarkers = [];
let editorCameraWidth = 0;
let editorCameraHeight = 0;
let editorPinch = null;
let editorSpacePan = false;

function createRound() {
  return makeRound({
    mode: 'campaign',
    seed: currentLevel.seed ?? 0x51a9,
    bag: pinnedAmmo ? currentLevel.bag.map(() => pinnedAmmo) : currentLevel.bag,
    blueprint: currentLevel.blueprint,
    cards: currentLevel.cards ?? []
  });
}

const placementErrors = new Set([
  'out-of-bounds', 'overlap', 'too-many-blocks', 'over-budget',
  'locked-material', 'locked-piece', 'piece-limit'
]);

// Defaults to the pre-bonus base, not `editorDraft.budget`: that field already has
// `rulesFor(cards).budgetBonus` folded in once (by the `makeDraft` call that built it), and
// `makeDraft`/`fromBlueprint` below fold the same bonus in again from `cards`. Feeding the
// already-bonused number back in as the new base would double it — invisible with no cards,
// live the moment a `budget`-effect card (Deep Pockets) is held, and it would show more
// scrap in the editor than `lockSiegeFortress`'s validator, composing it once from
// `siegeBudget`, would accept.
function editorOptions(budget = editorBudgetBase) {
  return { budget, cards: editorDraft.cards };
}

function editorRoundFor(blueprint = toBlueprint(editorDraft), seed = 0x51a9) {
  return makeRound({ mode: 'campaign', seed, bag: [], blueprint });
}

function mapEditorBodies(round) {
  const map = new Map();
  const blocks = editorDraft.pieces.filter((piece) => piece.kind === 'block');
  const pigs = editorDraft.pieces.filter((piece) => piece.kind === 'pig');
  for (const body of round.blocks ?? []) map.set(body.id, blocks[body.blueprintIndex]?.id);
  for (const body of round.pigs ?? []) map.set(body.id, pigs[body.blueprintIndex]?.id);
  for (const body of round.balloons ?? []) map.set(body.id, pigs[body.pigBody?.blueprintIndex]?.id);
  return map;
}

function rebuildEditorRound() {
  editorRound = editorRoundFor();
  editorBodyPieceIds = mapEditorBodies(editorRound);
}

function cloneEditorDraft(budget = editorBudgetBase, excludedId = null) {
  const clone = fromBlueprint(toBlueprint(editorDraft), editorOptions(budget));
  if (excludedId !== null) {
    const index = editorDraft.pieces.findIndex((piece) => piece.id === excludedId);
    const piece = clone.pieces[index];
    if (piece) removeAt(clone, piece.x, piece.y);
  }
  return clone;
}

function selectedSource(x, y) {
  if (editorGroup === 'pigs') return { kind: 'pig', pig: editorPig, x, y };
  return {
    kind: 'block', material: editorMaterial, shape: editorShape,
    rotation: editorRotation, x, y
  };
}

function ghostBodyFor(piece) {
  if (!piece) return null;
  const round = editorRoundFor(toBlueprint({ pieces: [piece] }));
  return piece.kind === 'block' ? round.blocks[0] : round.pigs[0];
}

function probePlacement(x, y, excludedId = null) {
  const source = selectedSource(x, y);
  const real = cloneEditorDraft(editorBudgetBase, excludedId);
  const placed = place(real, source);
  let candidate = placed.piece ?? null;
  let reason = placed.reason;
  let legal = placed.ok;
  if (placed.ok) {
    const issue = validate(real).errors.find((entry) =>
      placementErrors.has(entry.code) && entry.pieceIds.includes(placed.piece.id));
    if (issue) {
      legal = false;
      reason = issue.code;
    }
  }
  const roomy = cloneEditorDraft(1_000_000_000, excludedId);
  const before = spent(roomy);
  const costPlacement = place(roomy, source);
  if (!candidate) candidate = costPlacement.piece ?? null;
  const cost = excludedId !== null ? 0 : costPlacement.ok ? spent(roomy) - before : null;
  return { legal, reason, cost, piece: candidate, body: ghostBodyFor(candidate) };
}

function pieceAt(x, y) {
  const clone = cloneEditorDraft();
  const ids = clone.pieces.map((piece) => piece.id);
  const removed = removeAt(clone, x, y);
  if (!removed.ok) return null;
  const index = ids.indexOf(removed.piece.id);
  return editorDraft.pieces[index] ?? null;
}

function unlockCardFor(material) {
  return CARDS.find((card) => card.effect.material === material &&
    (card.effect.kind === 'unlock' ||
      card.effect.kind === 'materialCost' && Object.hasOwn(card.effect, 'limit')));
}

function materialAvailability(material) {
  const probe = makeDraft({ budget: 1_000_000_000, cards: editorDraft.cards });
  const result = place(probe, {
    kind: 'block', material, shape: 'cube', x: 12, y: 8, rotation: 0
  });
  return { unlocked: result.reason !== 'locked-material', card: unlockCardFor(material) };
}

function catalogueCost(source, unlockCard = null) {
  const cards = [...editorDraft.cards];
  if (unlockCard && !cards.includes(unlockCard.id)) cards.push(unlockCard.id);
  const probe = makeDraft({ budget: 1_000_000_000, cards });
  const result = place(probe, { ...source, x: 12, y: 8 });
  return result.ok ? spent(probe) : null;
}

function formatScrap(value) {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function drawPaletteThumbnail(canvas, source) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = 60;
  const height = 48;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const piece = source.kind === 'block'
    ? { ...source, id: 1, x: 4, y: 4 }
    : { ...source, id: 1, x: 4, y: 4 };
  drawThumbnail(ctx, editorRoundFor(toBlueprint({ pieces: [piece] })), width, height);
}

function makePieceButton(source, name, cost, index, selected) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'piece-choice';
  button.dataset.paletteIndex = String(index + 1);
  button.setAttribute('aria-pressed', String(selected));
  button.setAttribute('aria-label', `${index + 1}. ${name}, ${formatScrap(cost)} scrap`);
  const icon = document.createElement('canvas');
  icon.setAttribute('aria-hidden', 'true');
  const meta = document.createElement('span');
  meta.className = 'piece-meta';
  const label = document.createElement('span');
  label.className = 'piece-name';
  label.textContent = name;
  const price = document.createElement('span');
  price.className = 'piece-cost';
  price.textContent = cost === null ? 'locked' : `${formatScrap(cost)} scrap`;
  meta.append(label, price);
  button.append(icon, meta);
  drawPaletteThumbnail(icon, source);
  return button;
}

function renderMaterialList() {
  const fragment = document.createDocumentFragment();
  for (const material of Object.values(MATERIALS)) {
    const availability = materialAvailability(material.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'material-choice';
    button.dataset.material = material.id;
    button.setAttribute('aria-pressed', String(editorMaterial === material.id));
    button.classList.toggle('locked', !availability.unlocked);
    button.setAttribute('aria-label', availability.unlocked
      ? material.name
      : `${material.name}, locked; inspect shapes. Unlocks with ${availability.card?.name ?? 'a draft card'}.`);
    button.textContent = material.name;
    if (!availability.unlocked) {
      const lock = document.createElement('small');
      lock.textContent = `Locked · ${availability.card?.name ?? 'draft card'}`;
      button.append(lock);
    }
    button.addEventListener('click', () => {
      editorMaterial = material.id;
      renderPalette();
      updateEditorGhost();
      if (!availability.unlocked) {
        statusMessage.textContent = `${material.name} unlocks with ${availability.card?.name ?? 'a draft card'}.`;
      }
    });
    fragment.append(button);
  }
  materialList.replaceChildren(fragment);
}

function renderShapeList() {
  const fragment = document.createDocumentFragment();
  const unlock = unlockCardFor(editorMaterial);
  const availability = materialAvailability(editorMaterial);
  Object.values(SHAPES).forEach((shape, index) => {
    const source = {
      kind: 'block', material: editorMaterial, shape: shape.id,
      rotation: editorRotation
    };
    const button = makePieceButton(source, shape.id,
      catalogueCost(source, unlock), index, editorShape === shape.id);
    button.id = `palette-block-${shape.id}`;
    button.setAttribute('aria-disabled', String(!availability.unlocked));
    button.addEventListener('click', () => {
      if (!availability.unlocked) {
        statusMessage.textContent = `${MATERIALS[editorMaterial].name} unlocks with ` +
          `${availability.card?.name ?? 'a draft card'}.`;
        return;
      }
      editorShape = shape.id;
      renderPalette();
      updateEditorGhost();
    });
    fragment.append(button);
  });
  shapeList.replaceChildren(fragment);
  rotationStatus.textContent = `Rotation ${editorRotation * TUNE.rotSnapDeg}°`;
}

function renderPigList() {
  const fragment = document.createDocumentFragment();
  Object.values(PIGS).forEach((pig, index) => {
    const source = { kind: 'pig', pig: pig.id };
    const button = makePieceButton(source, pig.name,
      catalogueCost(source), index, editorPig === pig.id);
    button.id = `palette-pig-${pig.id}`;
    button.addEventListener('click', () => {
      editorPig = pig.id;
      renderPalette();
      updateEditorGhost();
    });
    fragment.append(button);
  });
  pigList.replaceChildren(fragment);
}

function renderPalette() {
  renderMaterialList();
  renderShapeList();
  renderPigList();
}

function setEditorGroup(group, focusSelection = false) {
  editorGroup = group === 'pigs' ? 'pigs' : 'materials';
  const materials = editorGroup === 'materials';
  materialsTab.setAttribute('aria-selected', String(materials));
  pigsTab.setAttribute('aria-selected', String(!materials));
  materialsPalette.hidden = !materials;
  pigsPalette.hidden = materials;
  updateEditorGhost();
  if (focusSelection) {
    const id = materials ? `#palette-block-${editorShape}` : `#palette-pig-${editorPig}`;
    document.querySelector(id)?.focus({ preventScroll: true });
  }
}

function guidanceFor(error) {
  const kings = editorDraft.pieces.filter((piece) =>
    piece.kind === 'pig' && PIGS[piece.pig].traits.king && !piece.decoy).length;
  const messages = {
    'king-count': kings === 0
      ? 'Place one real King Hog so the fortress has someone to defend.'
      : 'Keep one real King Hog and remove the extra crown.',
    'too-few-pigs': 'Add at least two pigs besides your King to guard the place.',
    'buried-king': `Your King is too deeply buried — there must be a way in within ${TUNE.maxBurialDepth} blocks.`,
    overlap: 'These pieces overlap. Let them touch without passing through each other.',
    'out-of-bounds': 'Bring the marked pieces fully back inside the 24 × 16 plot.',
    'too-many-blocks': `Trim the fortress to ${TUNE.maxBlocks} blocks or fewer.`,
    'over-budget': 'This fortress spends more scrap than you have left.',
    'locked-material': 'A marked block needs its named draft card before it can be used.',
    'locked-piece': 'A marked pig ability needs its draft card first.',
    'piece-limit': 'Only one pig can carry each drafted special flag.'
  };
  return messages[error.code] ?? error.message;
}

function renderValidation() {
  const result = validate(editorDraft);
  const fragment = document.createDocumentFragment();
  if (editorHighlightCode && !result.errors.some((error) => error.code === editorHighlightCode)) {
    editorHighlightCode = null;
    editorHighlightIds = new Set();
  }
  if (result.ok) {
    const item = document.createElement('li');
    item.className = 'valid-message';
    item.textContent = 'All build rules are satisfied. Now make sure it stands.';
    fragment.append(item);
  } else {
    for (const error of result.errors) {
      const item = document.createElement('li');
      item.className = 'validation-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'validation-problem';
      button.dataset.validationCode = error.code;
      button.setAttribute('aria-pressed', String(editorHighlightCode === error.code));
      button.textContent = guidanceFor(error);
      button.addEventListener('click', () => {
        editorHighlightCode = error.code;
        editorHighlightIds = new Set(error.pieceIds);
        renderValidation();
        statusMessage.textContent = error.pieceIds.length
          ? `${error.pieceIds.length} offending piece${error.pieceIds.length === 1 ? '' : 's'} highlighted.`
          : guidanceFor(error);
      });
      item.append(button);
      fragment.append(item);
    }
  }
  validationList.replaceChildren(fragment);
  validationCount.textContent = result.ok
    ? 'Ready'
    : `${result.errors.length} to fix`;
  validationCount.classList.toggle('valid', result.ok);
  return result;
}

function updateBudgetMeter() {
  const left = editorDraft.budget - spent(editorDraft);
  scrapLeft.textContent = formatScrap(left);
  const unaffordable = editorGhost?.reason === 'over-budget' ||
    Number.isFinite(editorGhost?.cost) && editorGhost.cost > left;
  budgetMeter.classList.toggle('unaffordable', unaffordable);
  if (!editorGhost) {
    hoverCost.textContent = 'Hover the plot to price a placement';
  } else if (editorGhost.cost === null) {
    hoverCost.textContent = 'This piece is not available';
  } else {
    const outcome = left - editorGhost.cost;
    const reason = {
      overlap: ' · overlaps',
      'out-of-bounds': ' · leaves the plot',
      'over-budget': ' · not enough scrap',
      'too-many-blocks': ' · block limit reached'
    }[editorGhost.reason] ?? '';
    hoverCost.textContent = `This costs ${formatScrap(editorGhost.cost)} · ` +
      `${formatScrap(outcome)} left${reason}`;
  }
  undoButton.disabled = !editorDraft.history.length || Boolean(settleAnimation);
  redoButton.disabled = !editorDraft.future.length || Boolean(settleAnimation);
}

function updateEditorGhost(world = editorHoverWorld) {
  editorHoverWorld = world;
  if (!editing || !world || settleAnimation) {
    editorGhost = null;
  } else {
    const excluded = editorDrag?.mode === 'move' ? editorDrag.id : null;
    editorGhost = probePlacement(world.x, world.y, excluded);
  }
  updateBudgetMeter();
}

function clearSettleDisplay(message = 'Draft changed — test it again when the tower is ready.') {
  settleDisplayRound = null;
  settleMarkers = [];
  settleResult.classList.remove('testing');
  settleResult.textContent = message;
}

function refreshEditor(changed = false) {
  if (changed) clearSettleDisplay();
  rebuildEditorRound();
  renderValidation();
  updateEditorGhost();
}

function selectExistingPiece(piece) {
  if (piece.kind === 'block') {
    editorGroup = 'materials';
    editorMaterial = piece.material;
    editorShape = piece.shape;
    editorRotation = piece.rotation;
  } else {
    editorGroup = 'pigs';
    editorPig = piece.pig;
  }
  renderPalette();
  setEditorGroup(editorGroup);
}

function placeEditorPiece(world) {
  const probe = probePlacement(world.x, world.y);
  editorGhost = probe;
  if (!probe.legal) {
    updateBudgetMeter();
    return false;
  }
  const result = place(editorDraft, selectedSource(world.x, world.y));
  if (!result.ok) return false;
  refreshEditor(true);
  return true;
}

function removeEditorPiece(world = editorHoverWorld) {
  if (!world || settleAnimation) return false;
  const result = removeAt(editorDraft, world.x, world.y);
  if (!result.ok) return false;
  editorHighlightIds.delete(result.piece.id);
  refreshEditor(true);
  statusMessage.textContent = 'Piece removed.';
  return true;
}

function editorWorldPoint(event) {
  const point = canvasPoint(event);
  return screenToWorld(editorCamera, point.x, point.y);
}

function clampEditorCamera() {
  const halfW = editorCamera.viewportW / editorCamera.scale / 2;
  const halfH = editorCamera.viewportH / editorCamera.scale / 2;
  const lowX = TUNE.viewMinX + halfW;
  const highX = TUNE.viewMaxX - halfW;
  editorCamera.x = lowX <= highX
    ? clamp(editorCamera.x, lowX, highX)
    : (TUNE.viewMinX + TUNE.viewMaxX) / 2;
  const lowY = halfH * (EDITOR_GROUND_LINE - 0.5) * 2;
  const highY = Math.max(lowY, TUNE.plotH + halfH - 0.5);
  editorCamera.y = clamp(editorCamera.y, lowY, highY);
}

function setEditorZoomAt(point, zoom, anchor = screenToWorld(editorCamera, point.x, point.y)) {
  editorCamera.zoom = clamp(zoom, editorCamera.minZoom, MAX_CAMERA_ZOOM);
  editorCamera.scale = renderer.height / editorCamera.viewH * editorCamera.zoom;
  editorCamera.x = anchor.x -
    (point.x - editorCamera.viewportX - editorCamera.viewportW / 2) / editorCamera.scale;
  editorCamera.y = anchor.y +
    (point.y - editorCamera.viewportY - editorCamera.viewportH / 2) / editorCamera.scale;
  clampEditorCamera();
}

function beginEditorPan(event, point) {
  editorPan.active = true;
  editorPan.pointerId = event.pointerId;
  editorPan.startX = point.x;
  editorPan.startY = point.y;
  editorPan.cameraX = editorCamera.x;
  editorPan.cameraY = editorCamera.y;
  canvas.setPointerCapture(event.pointerId);
  updateEditorGhost(null);
}

function editorPointerDistance() {
  const values = editorPointers.values();
  const first = values.next().value;
  const second = values.next().value;
  if (!first || !second) return 0;
  return Math.sqrt((second.x - first.x) ** 2 + (second.y - first.y) ** 2);
}

function editorPointerCentre() {
  const values = [...editorPointers.values()];
  return {
    x: (values[0].x + values[1].x) / 2,
    y: (values[0].y + values[1].y) / 2
  };
}

function beginEditorPinch() {
  const centre = editorPointerCentre();
  editorPinch = {
    distance: editorPointerDistance(),
    zoom: editorCamera.zoom,
    anchor: screenToWorld(editorCamera, centre.x, centre.y)
  };
  editorDrag = null;
  updateEditorGhost(null);
}

function editorPointerDown(event) {
  if (!editing || settleAnimation || event.button > 1) return;
  const point = canvasPoint(event);
  if (event.button === 1 || editorSpacePan) {
    event.preventDefault();
    beginEditorPan(event, point);
    return;
  }
  if (event.pointerType === 'touch') {
    editorPointers.set(event.pointerId, {
      x: point.x, y: point.y, startX: point.x, startY: point.y
    });
    canvas.setPointerCapture(event.pointerId);
    if (editorPointers.size === 2) {
      beginEditorPinch();
      return;
    }
    const world = screenToWorld(editorCamera, point.x, point.y);
    editorHoverWorld = world;
    editorDrag = { mode: 'touch-pending', pointerId: event.pointerId, world };
    updateEditorGhost(world);
    return;
  }
  const world = editorWorldPoint(event);
  editorHoverWorld = world;
  const existing = pieceAt(world.x, world.y);
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  if (existing) {
    selectExistingPiece(existing);
    editorDrag = { mode: 'move', id: existing.id, startX: existing.x, startY: existing.y };
    updateEditorGhost(world);
  } else {
    editorDrag = { mode: 'sweep', pointerX: world.x, pointerY: world.y };
    placeEditorPiece(world);
  }
}

function editorPointerMove(event) {
  if (!editing) return;
  const point = canvasPoint(event);
  if (editorPan.active && editorPan.pointerId === event.pointerId) {
    editorCamera.x = editorPan.cameraX - (point.x - editorPan.startX) / editorCamera.scale;
    editorCamera.y = editorPan.cameraY + (point.y - editorPan.startY) / editorCamera.scale;
    clampEditorCamera();
    return;
  }
  const touch = editorPointers.get(event.pointerId);
  if (touch) {
    touch.x = point.x;
    touch.y = point.y;
    if (editorPinch && editorPointers.size >= 2) {
      const centre = editorPointerCentre();
      const distance = editorPointerDistance();
      if (editorPinch.distance > 0 && distance > 0) {
        setEditorZoomAt(centre, editorPinch.zoom * distance / editorPinch.distance,
          editorPinch.anchor);
      }
      return;
    }
    if (editorDrag?.mode === 'touch-pending') {
      const moved = Math.abs(point.x - touch.startX) + Math.abs(point.y - touch.startY);
      if (moved <= POINTER_TAP_DISTANCE) {
        updateEditorGhost(screenToWorld(editorCamera, point.x, point.y));
        return;
      }
      const startWorld = editorDrag.world;
      editorDrag = {
        mode: 'sweep', pointerX: startWorld.x, pointerY: startWorld.y
      };
      placeEditorPiece(startWorld);
    } else if (editorDrag?.mode === 'touch-pinch') {
      return;
    }
  }
  const world = editorWorldPoint(event);
  editorHoverWorld = world;
  if (!editorDrag || settleAnimation) {
    updateEditorGhost(world);
    return;
  }
  if (editorDrag.mode === 'move') {
    updateEditorGhost(world);
    return;
  }
  const dx = world.x - editorDrag.pointerX;
  const dy = world.y - editorDrag.pointerY;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / TUNE.gridSnap));
  for (let index = 1; index <= steps; index++) {
    placeEditorPiece({
      x: editorDrag.pointerX + dx * index / steps,
      y: editorDrag.pointerY + dy * index / steps
    });
  }
  editorDrag.pointerX = world.x;
  editorDrag.pointerY = world.y;
  updateEditorGhost(world);
}

function editorPointerUp(event) {
  if (editorPan.active && editorPan.pointerId === event.pointerId) {
    editorPan.active = false;
    editorPan.pointerId = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    updateEditorGhost(editorWorldPoint(event));
    return;
  }
  if (editorPointers.has(event.pointerId)) {
    const wasPinching = Boolean(editorPinch);
    const pending = editorDrag?.mode === 'touch-pending' &&
      editorDrag.pointerId === event.pointerId ? editorDrag : null;
    editorPointers.delete(event.pointerId);
    if (wasPinching) {
      editorPinch = null;
      editorDrag = editorPointers.size
        ? { mode: 'touch-pinch', pointerId: editorPointers.keys().next().value }
        : null;
    } else if (pending) {
      editorDrag = null;
      placeEditorPiece(editorWorldPoint(event));
    } else if (editorDrag?.mode === 'touch-pinch') {
      editorDrag = null;
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    updateEditorGhost(editorPointers.size ? null : editorWorldPoint(event));
    if (wasPinching || pending || !editorDrag) return;
  }
  if (!editorDrag) return;
  const drag = editorDrag;
  const world = editorWorldPoint(event);
  editorDrag = null;
  if (drag.mode === 'move') {
    const probe = probePlacement(world.x, world.y, drag.id);
    if (probe.legal && probe.piece &&
        (probe.piece.x !== drag.startX || probe.piece.y !== drag.startY)) {
      moveTo(editorDraft, drag.id, world.x, world.y);
      refreshEditor(true);
      statusMessage.textContent = 'Piece moved.';
    }
  }
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  updateEditorGhost(world);
}

function cancelEditorPointer(event) {
  editorPointers.delete(event.pointerId);
  if (editorPointers.size < 2) editorPinch = null;
  if (editorPan.pointerId === event.pointerId) {
    editorPan.active = false;
    editorPan.pointerId = null;
  }
  if (editorDrag?.pointerId === event.pointerId || editorDrag) editorDrag = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

function runSettleTest() {
  if (settleAnimation) return;
  const result = settleTest(editorDraft);
  const round = editorRoundFor(toBlueprint(editorDraft), 1);
  settleAnimation = { result, round, steps: 0, accumulator: 0 };
  editorBodyPieceIds = mapEditorBodies(round);
  settleDisplayRound = null;
  settleMarkers = [];
  editorGhost = null;
  settleButton.disabled = true;
  settleButton.textContent = 'Watching… 3.0 s';
  settleResult.classList.add('testing');
  settleResult.textContent = 'Gravity is on. Watch what shifts during the next three seconds.';
  updateBudgetMeter();
}

// Shared with lockSiegeFortress's ready-up warning below, so a player who reads one sees
// the same language in the other rather than a second, differently-worded report.
function braceMessage(result) {
  const moved = result.movedPieces.length;
  const dead = result.deadPigs.length;
  return `It needs bracing: ${moved} piece${moved === 1 ? '' : 's'} moved` +
    `${dead ? ` and ${dead} pig${dead === 1 ? '' : 's'} died` : ''}`;
}

function finishSettleTest() {
  const animation = settleAnimation;
  settleAnimation = null;
  settleDisplayRound = animation.round;
  editorBodyPieceIds = mapEditorBodies(animation.round);
  editorHighlightIds = new Set([
    ...animation.result.movedPieces,
    ...animation.result.deadPigs
  ]);
  editorHighlightCode = null;
  const pigs = editorDraft.pieces.filter((piece) => piece.kind === 'pig');
  settleMarkers = animation.result.deadPigs.map((id) => {
    const index = pigs.findIndex((piece) => piece.id === id);
    const body = animation.round.pigs[index];
    return body ? { x: body.x, y: body.y } : null;
  }).filter(Boolean);
  settleButton.disabled = false;
  settleButton.textContent = 'Test tower';
  settleResult.classList.remove('testing');
  settleResult.textContent = animation.result.ok
    ? 'It stands: nothing shifted and every pig survived the full three seconds.'
    : `${braceMessage(animation.result)}. The draft is unchanged.`;
  statusMessage.textContent = settleResult.textContent;
  editorGhost = null;
  updateBudgetMeter();
}

async function copyBlueprint() {
  const encoded = encode(toBlueprint(editorDraft));
  blueprintInput.value = encoded;
  try {
    await navigator.clipboard.writeText(encoded);
    statusMessage.textContent = 'Blueprint copied to the clipboard.';
  } catch (unused) {
    blueprintInput.focus();
    blueprintInput.select();
    document.execCommand('copy');
    statusMessage.textContent = 'Blueprint selected and copied.';
  }
}

function loadBlueprint(source = blueprintInput.value) {
  const decoded = decode(source.trim());
  if (decoded?.ok === false) {
    statusMessage.textContent = `That blueprint could not be loaded: ${decoded.reason.replaceAll('-', ' ')}.`;
    blueprintInput.setAttribute('aria-invalid', 'true');
    return false;
  }
  editorDraft = fromBlueprint(decoded, editorOptions());
  blueprintInput.value = encode(toBlueprint(editorDraft));
  blueprintInput.removeAttribute('aria-invalid');
  editorHighlightCode = null;
  editorHighlightIds = new Set();
  refreshEditor(true);
  statusMessage.textContent = `Blueprint loaded with ${editorDraft.pieces.length} pieces.`;
  return true;
}

async function pasteBlueprint() {
  try {
    blueprintInput.value = await navigator.clipboard.readText();
    loadBlueprint();
  } catch (unused) {
    blueprintInput.focus();
    statusMessage.textContent = 'Paste the blueprint string into the field, then choose Load typed string.';
  }
}

// `siegeCtx` turns the workshop into Siege's build phase: same editor, same validation,
// but with a scrap budget, the player's drafted cards, and a lock-in that hands the
// blueprint back rather than just saving it. Reusing the editor rather than writing a
// second one is the whole reason it was built before the campaign.
function openEditor(siegeCtx = null) {
  editorSiege = siegeCtx && typeof siegeCtx.onLock === 'function' ? siegeCtx : null;
  // The one and only place `editorDraft` is built for this session. It used to be built
  // here for Siege and then unconditionally rebuilt plain twenty-five lines down, which
  // threw away the budget and cards this function was passed — Siege's build phase never
  // saw its own scrap economy or drafted cards, however correctly `siegeBudget` computed
  // them upstream.
  editorBudgetBase = editorSiege ? editorSiege.budget : undefined;
  editorDraft = editorSiege
    ? makeDraft({ budget: editorSiege.budget, cards: editorSiege.cards })
    : makeDraft();
  editorHighlightCode = null;
  editorHighlightIds = new Set();
  playing = false;
  editing = true;
  accumulator = 0;
  pointers.clear();
  editorPointers.clear();
  editorPinch = null;
  editorPan.active = false;
  editorSpacePan = false;
  cancelAim();
  cancelPan();
  campaignUI.hide();
  titleScreen.hidden = true;
  roundHud.hidden = true;
  roundOver.hidden = true;
  editorScreen.hidden = false;
  document.body.classList.remove('playing');
  document.body.classList.add('editing');
  editorCameraWidth = 0;
  editorCameraHeight = 0;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', editorCanvasLabel);
  canvas.setAttribute('aria-describedby', 'editor-controls-hint');
  clearSettleDisplay('Test the tower to watch three seconds of settling.');
  renderPalette();
  setEditorGroup('materials');
  refreshEditor();
  editorBackButton.focus({ preventScroll: true });
}

function closeEditor() {
  editing = false;
  editorPointers.clear();
  editorPinch = null;
  editorPan.active = false;
  editorSpacePan = false;
  editorDrag = null;
  editorGhost = null;
  editorHoverWorld = null;
  settleAnimation = null;
  settleDisplayRound = null;
  editorScreen.hidden = true;
  document.body.classList.remove('editing');
  canvas.tabIndex = -1;
  canvas.setAttribute('aria-label', gameCanvasLabel);
  canvas.setAttribute('aria-describedby', 'controls-hint');
  showTitle(editorButton);
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

const SEEN_CRITTERS_KEY = 'slingwreck.critters.seen.v1';

function seenCritters() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_CRITTERS_KEY) ?? '[]')); }
  catch { return new Set(); }
}

// The first critter in this level's bag the player has never been given. Returned one at a
// time rather than all at once: a level that introduces two new birds should teach them in
// sequence, not stack two cards before the player has touched either.
function nextUnseenCritter(level) {
  const seen = seenCritters();
  const id = level.bag.find((ammoId) => !seen.has(ammoId));
  return id ? AMMO_BY_ID[id] : null;
}

function markCritterSeen(id) {
  const seen = seenCritters();
  seen.add(id);
  try { localStorage.setItem(SEEN_CRITTERS_KEY, JSON.stringify([...seen])); } catch { /* private mode */ }
}

// Solo Siege's bot difficulty, persisted the same way campaign-ui.js persists progress:
// one localStorage key, read once at load, written on every change, tolerant of a
// private-mode browser that throws. See data.js's SIEGE_DIFFICULTIES for what a tier id
// actually changes and how the three were measured apart.
const SIEGE_DIFFICULTY_KEY = 'slingwreck.siege.difficulty.v1';

function loadSiegeDifficulty() {
  try {
    const stored = localStorage.getItem(SIEGE_DIFFICULTY_KEY);
    return SIEGE_DIFFICULTIES[stored] ? stored : SIEGE_DIFFICULTY_DEFAULT;
  } catch { return SIEGE_DIFFICULTY_DEFAULT; }
}

function saveSiegeDifficulty(id) {
  try { localStorage.setItem(SIEGE_DIFFICULTY_KEY, id); } catch { /* private mode */ }
}

function showCritterIntro(ammo, onDone) {
  critterIntroName.textContent = ammo.name;
  critterIntroTip.textContent = ammo.tutorial ?? '';
  drawCritterHead(critterIntroArt, ammo);
  critterIntro.hidden = false;
  critterIntroButton.focus();
  const dismiss = () => {
    critterIntroButton.removeEventListener('click', dismiss);
    critterIntro.hidden = true;
    markCritterSeen(ammo.id);
    onDone();
  };
  critterIntroButton.addEventListener('click', dismiss);
}

function startRound(level = currentLevel) {
  // Teach before playing. Any critter in this bag the player has not met gets a card
  // first, then the level starts — recursively, so a bag with two new birds shows two.
  const unseen = nextUnseenCritter(level);
  if (unseen) {
    showCritterIntro(unseen, () => startRound(level));
    return;
  }
  currentLevel = level;
  round = createRound();
  playing = true;
  editing = false;
  roundOverShown = false;
  accumulator = 0;
  last = performance.now();
  shownScore = -1;
  shownShotIndex = -1;
  shownPhase = '';
  pointers.clear();
  cancelAim();
  resetCameraState('aiming');
  campaignUI.hide();
  titleScreen.hidden = true;
  editorScreen.hidden = true;
  roundOver.hidden = true;
  roundHud.hidden = false;
  document.body.classList.add('playing');
  document.body.classList.remove('editing');
  canvas.tabIndex = -1;
  canvas.setAttribute('aria-label', gameCanvasLabel);
  canvas.setAttribute('aria-describedby', 'controls-hint');
  updateHud(true);
  canvas.focus({ preventScroll: true });
}

function showTitle(focusTarget = playButton) {
  playing = false;
  editing = false;
  accumulator = 0;
  pointers.clear();
  cancelAim();
  resetCameraState('fortress');
  campaignUI.hide();
  roundHud.hidden = true;
  roundOver.hidden = true;
  editorScreen.hidden = true;
  titleScreen.hidden = false;
  abilityButton.hidden = true;
  document.body.classList.remove('playing');
  document.body.classList.remove('editing');
  canvas.tabIndex = -1;
  canvas.setAttribute('aria-label', gameCanvasLabel);
  canvas.setAttribute('aria-describedby', 'controls-hint');
  focusTarget.focus({ preventScroll: true });
}

function setMuted(nextMuted) {
  muted = nextMuted;
  setAudioMuted(audio, muted);
  muteButton.textContent = muted ? 'Sound off' : 'Sound on';
  muteButton.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} sound (M)`);
  muteButton.title = `${muted ? 'Unmute' : 'Mute'} sound (M)`;
  statusMessage.textContent = muted ? 'Sound muted.' : 'Sound on.';
}

// Deliberately the same construction as drawCritterHead so the two read as a matched
// pair — the thing you fire, and the thing you fire at — while the palette keeps them
// unmistakably apart. A popped pig stays in the row, greyed and crossed, so progress is
// legible rather than a shrinking count.
function drawPigHead(icon, pig) {
  const size = 44;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  icon.width = Math.round(size * dpr);
  icon.height = Math.round(size * dpr);
  const ctx = icon.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = pig.dead ? 0.32 : 1;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2.5;
  const king = Boolean(pig.king);
  ctx.fillStyle = king ? PALETTE.king : PALETTE.pig;
  ctx.beginPath();
  ctx.arc(22, 23, king ? 16 : 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PALETTE.pigDark;
  ctx.beginPath();
  ctx.ellipse(22, 28, 7, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PALETTE.ink;
  for (const dx of [-2.5, 2.5]) {
    ctx.beginPath();
    ctx.arc(22 + dx, 28, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  for (const dx of [-6, 6]) {
    ctx.beginPath();
    ctx.arc(22 + dx, 18, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = PALETTE.ink;
  for (const dx of [-6, 6]) {
    ctx.beginPath();
    ctx.arc(22 + dx, 18.5, 1.7, 0, Math.PI * 2);
    ctx.fill();
  }
  if (king) {
    ctx.fillStyle = PALETTE.crown;
    ctx.beginPath();
    ctx.moveTo(14, 8); ctx.lineTo(17, 3); ctx.lineTo(22, 7);
    ctx.lineTo(27, 3); ctx.lineTo(30, 8); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  if (pig.dead) {
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(11, 12); ctx.lineTo(33, 34);
    ctx.moveTo(33, 12); ctx.lineTo(11, 34);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Takes the ammo so each critter wears its own colour and silhouette cue. It used to
// ignore the type entirely, so the bag preview showed the same bird nine times and the
// abilities behind them were invisible.
function drawCritterHead(icon, ammo) {
  const look = ammo?.look ?? { fill: PALETTE.critter, tone: PALETTE.tntDark, feature: 'plain' };
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
  // Behind-the-body cues first.
  if (look.feature === 'trio') {
    ctx.fillStyle = look.tone;
    for (const dy of [-7, 0, 7]) {
      ctx.beginPath();
      ctx.moveTo(12, 23); ctx.lineTo(-2, 23 + dy); ctx.lineTo(4, 27 + dy);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  } else if (look.feature === 'hook') {
    ctx.strokeStyle = look.tone; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(10, 23);
    ctx.quadraticCurveTo(-4, 16, 2, 38); ctx.stroke();
    ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 2.5;
  } else if (look.feature === 'streak') {
    ctx.strokeStyle = look.tone; ctx.lineWidth = 2.2;
    for (const dy of [-6, 0, 6]) {
      ctx.beginPath(); ctx.moveTo(8, 23 + dy); ctx.lineTo(-1, 23 + dy); ctx.stroke();
    }
    ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 2.5;
  }
  ctx.fillStyle = look.fill;
  ctx.beginPath();
  ctx.moveTo(10, 20);
  ctx.lineTo(4, 12);
  ctx.lineTo(14, 15);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(22, 23, look.feature === 'bulk' ? 17 : look.feature === 'streak' ? 12 : 15, 0, Math.PI * 2);
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
  // Front-of-body cues.
  if (look.feature === 'dart') {
    ctx.fillStyle = look.tone;
    ctx.beginPath(); ctx.moveTo(41, 23); ctx.lineTo(30, 18); ctx.lineTo(30, 28);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (look.feature === 'fuse') {
    ctx.beginPath(); ctx.moveTo(22, 8);
    ctx.quadraticCurveTo(29, 2, 26, -1); ctx.stroke();
    ctx.fillStyle = PALETTE.spring;
    ctx.beginPath(); ctx.arc(26, -1, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else if (look.feature === 'crest') {
    ctx.fillStyle = look.tone;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const bx = 14 + k * 7;
      ctx.moveTo(bx, 10); ctx.lineTo(bx + 3.5, 1); ctx.lineTo(bx + 7, 10);
    }
    ctx.fill(); ctx.stroke();
  } else if (look.feature === 'egg') {
    ctx.fillStyle = PALETTE.cream;
    ctx.beginPath(); ctx.ellipse(22, 38, 6, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else if (look.feature === 'bulk') {
    ctx.fillStyle = look.tone;
    for (const dx of [-13, 13]) {
      ctx.beginPath(); ctx.arc(22 + dx, 27, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}

function rebuildAmmoList() {
  const fragment = document.createDocumentFragment();
  for (let index = round.shotIndex; index < round.bag.length; index++) {
    const ammo = AMMO_BY_ID[round.bag[index]];
    const loaded = index === round.shotIndex;
    const icon = document.createElement('canvas');
    // The loaded critter is drawn large and named. At the sling it renders about 20 pixels
    // across with the bands over it, so its colour is marginal and its silhouette cue is
    // invisible — art that separates on a reference sheet and collapses in play. Naming
    // the one you are about to fire is what actually tells the player which bird they hold.
    icon.className = loaded ? 'ammo-head loaded' : 'ammo-head';
    icon.setAttribute('role', 'listitem');
    icon.setAttribute('aria-label', `${ammo.name}, shot ${index + 1}`);
    drawCritterHead(icon, ammo);
    if (loaded) {
      const cell = document.createElement('span');
      cell.className = 'ammo-loaded';
      const name = document.createElement('span');
      name.className = 'ammo-loaded-name';
      name.textContent = ammo.name;
      cell.append(icon, name);
      fragment.append(cell);
    } else {
      fragment.append(icon);
    }
  }
  ammoList.replaceChildren(fragment);
  const remaining = round.bag.length - round.shotIndex;
  ammoList.setAttribute('aria-label', `${remaining} critter${remaining === 1 ? '' : 's'} remaining`);
}

// Pig heads that empty as they pop. This is the level's win condition made continuously
// visible: a playtester asked outright whether it had to hit the pigs or topple the
// structure, and nothing on screen answered.
function rebuildPigList() {
  if (!objectivePigs) return;
  const fragment = document.createDocumentFragment();
  for (const pig of round.pigs) {
    const icon = document.createElement('canvas');
    icon.className = pig.dead ? 'objective-pig popped' : 'objective-pig';
    icon.setAttribute('role', 'listitem');
    icon.setAttribute('aria-label', pig.dead ? 'popped' : 'still standing');
    drawPigHead(icon, pig);
    fragment.append(icon);
  }
  objectivePigs.replaceChildren(fragment);
  const left = round.pigs.filter((pig) => !pig.dead).length;
  objectivePigs.setAttribute('aria-label', `${left} pig${left === 1 ? '' : 's'} left to pop`);
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
  // Keyed on the live pig count rather than a step counter, so the row updates the moment
  // one pops without redrawing every frame.
  const pigsAlive = round.pigs.reduce((n, pig) => n + (pig.dead ? 0 : 1), 0);
  if (force || pigsAlive !== shownPigsAlive) {
    rebuildPigList();
    shownPigsAlive = pigsAlive;
  }
  if (force || round.phase !== shownPhase) {
    abilityButton.hidden = round.phase !== 'flying';
    // The hint used to be hardcoded in index.html as "Nib has no trick" and never changed,
    // so a Lob in mid-air told the player it had no trick — the opposite of true, at the
    // one moment the tap matters. Take it from the critter actually in flight.
    if (round.phase === 'flying') {
      const flying = AMMO_BY_ID[round.flying?.ammoId ?? round.bag[round.shotIndex - 1]];
      abilityHint.textContent = flying
        ? (flying.ability ? `${flying.name} — ${flying.tutorial}` : `${flying.name} has no trick`)
        : '';
    }
    canvas.dataset.phase = round.phase;
    shownPhase = round.phase;
  }
}

function showRoundOver() {
  if (roundOverShown) return;
  roundOverShown = true;
  const won = round.phase === 'won';
  const count = won ? starsForScore(currentLevel, round.score) : 0;
  campaignUI.recordResult(currentLevel, round.score, won);
  roundHud.hidden = true;
  roundOver.hidden = false;
  abilityButton.hidden = true;
  roundTitle.textContent = won ? 'Fortress wrecked' : 'Out of critters';
  roundAnnouncement.textContent = won
    ? `You brought the fortress down and earned ${count} star${count === 1 ? '' : 's'}.`
    : 'The pigs are still standing. Try another angle or save a specialist for the weak seam.';
  finalScore.textContent = scoreFormat.format(Math.round(round.score));
  campaignUI.renderStars(stars, count, 48);
  resultStarCopy.textContent = starResultText(currentLevel, round.score, count);
  const next = campaignUI.nextLevel(currentLevel);
  nextButton.disabled = !won;
  nextButton.textContent = next ? `Next — ${next.index}. ${next.name}` : 'Finish episode';
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

function updateEditorCamera() {
  if (editorCameraWidth === renderer.width && editorCameraHeight === renderer.height) return;
  editorCameraWidth = renderer.width;
  editorCameraHeight = renderer.height;
  editorCamera.canvasW = renderer.width;
  editorCamera.canvasH = renderer.height;
  editorCamera.viewportX = 0;
  editorCamera.viewportY = 0;
  editorCamera.viewportW = renderer.width;
  editorCamera.viewportH = renderer.height;
  frameRect(editorCamera, -EDITOR_FRAME_MARGIN, 0,
    TUNE.plotW + EDITOR_FRAME_MARGIN, TUNE.plotH, 0);
  const viewH = editorCamera.viewportH / editorCamera.scale;
  editorCamera.y = Math.max(
    viewH * (EDITOR_GROUND_LINE - 0.5),
    TUNE.plotH - viewH / 2 + 0.5
  );
  clampEditorCamera();
}

function frame(now) {
  const elapsed = Math.min(250, Math.max(0, now - last));
  last = now;
  // Before the editor's early return, not after it. The build phase *is* editor mode, so
  // the banner update used to sit on an unreachable line: the clock stayed at 1:30 for the
  // whole ninety seconds, the scrap readout kept showing the full purse, and the expiry
  // auto-lock inside it never ran once.
  if (siege.active && siege.phase === 'build') updateSiegeBanner();
  if (editing) {
    updateEditorCamera();
    let displayRound = settleDisplayRound ?? editorRound;
    let alpha = 1;
    if (settleAnimation) {
      settleAnimation.accumulator += elapsed / 1000;
      const total = Math.ceil(TUNE.blueprintSettleSeconds / TUNE.step);
      while (settleAnimation.accumulator >= TUNE.step && settleAnimation.steps < total) {
        capturePose(renderer, settleAnimation.round);
        stepRound(settleAnimation.round, TUNE.step);
        settleAnimation.accumulator -= TUNE.step;
        settleAnimation.steps++;
      }
      const remaining = Math.max(0, (total - settleAnimation.steps) * TUNE.step);
      settleButton.textContent = `Watching… ${remaining.toFixed(1)} s`;
      displayRound = settleAnimation.round;
      alpha = settleAnimation.accumulator / TUNE.step;
      if (settleAnimation.steps >= total) {
        finishSettleTest();
        displayRound = settleDisplayRound;
        alpha = 1;
      }
    }
    draw(renderer, displayRound, editorCamera, alpha, null, {
      grid: editorGrid,
      ghostBody: editorGhost?.body,
      ghostLegal: Boolean(editorGhost?.legal),
      highlightIds: editorHighlightIds,
      bodyPieceIds: editorBodyPieceIds,
      focusHighlights: Boolean(editorHighlightCode),
      markers: settleMarkers
    });
    requestAnimationFrame(frame);
    return;
  }
  if (siege.active && siege.phase === 'assault') {
    stepSiegeOpponent(elapsed, now);
    drawSiegePreview(now);
    if (siegeRoundFinished()) endSiegeRound();
  }
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
    // Siege resolves its own rounds in `endSiegeRound`. `round` is the player's siege world
    // during an assault, so without this guard the campaign's result dialog opened over the
    // siege panel, recorded a campaign star for a fortress that is not a level, and took
    // the clicks meant for "Next round".
    if (isRoundOver(round) && !siege.active && !onlineSiege.isActive()) showRoundOver();
  } else {
    accumulator = 0;
  }

  updateCamera(elapsed / 1000);
  const alpha = !playing || isRoundOver(round) ? 1 : accumulator / TUNE.step;
  draw(renderer, round, camera, alpha, aim);
  requestAnimationFrame(frame);
}

const campaignUI = createCampaignUI({
  titleScreen,
  onPlayLevel: (level) => {
    void unlockAudio(audio);
    startRound(level);
  },
  onOpenTitle: () => showTitle(playButton)
});

playButton.addEventListener('click', campaignUI.openEpisodes);
editorButton.addEventListener('click', openEditor);
editorBackButton.addEventListener('click', closeEditor);
restartButton.addEventListener('click', () => startRound());
retryButton.addEventListener('click', () => startRound());
menuButton.addEventListener('click', () => {
  playing = false;
  roundOver.hidden = true;
  campaignUI.openLevels(currentLevel.episode);
});
muteButton.addEventListener('click', () => setMuted(!muted));
abilityButton.addEventListener('click', useAbility);
nextButton.addEventListener('click', () => {
  const next = campaignUI.nextLevel(currentLevel);
  if (next) startRound(next);
  else {
    playing = false;
    roundOver.hidden = true;
    campaignUI.openEpisodes();
  }
});
materialsTab.addEventListener('click', () => setEditorGroup('materials'));
pigsTab.addEventListener('click', () => setEditorGroup('pigs'));
undoButton.addEventListener('click', () => {
  if (undo(editorDraft).ok) refreshEditor(true);
});
redoButton.addEventListener('click', () => {
  if (redo(editorDraft).ok) refreshEditor(true);
});
gridButton.addEventListener('click', () => {
  editorGrid = !editorGrid;
  gridButton.setAttribute('aria-pressed', String(editorGrid));
  statusMessage.textContent = `Grid ${editorGrid ? 'shown' : 'hidden'}.`;
});
settleButton.addEventListener('click', runSettleTest);
copyBlueprintButton.addEventListener('click', () => void copyBlueprint());
pasteBlueprintButton.addEventListener('click', () => void pasteBlueprint());
loadBlueprintButton.addEventListener('click', () => loadBlueprint());

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointerdown', editorPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointermove', editorPointerMove);
canvas.addEventListener('pointerup', (event) => {
  finishPointer(event, false);
  editorPointerUp(event);
});
canvas.addEventListener('pointercancel', (event) => finishPointer(event, true));
canvas.addEventListener('pointercancel', cancelEditorPointer);
canvas.addEventListener('lostpointercapture', (event) => {
  if (pointers.has(event.pointerId)) finishPointer(event, true);
  if (editorPointers.has(event.pointerId) || editorPan.pointerId === event.pointerId) {
    cancelEditorPointer(event);
  }
});
canvas.addEventListener('pointerleave', () => {
  if (editing && !editorDrag) updateEditorGhost(null);
});
canvas.addEventListener('contextmenu', (event) => {
  if (!editing) return;
  event.preventDefault();
  removeEditorPiece(editorWorldPoint(event));
});
canvas.addEventListener('wheel', (event) => {
  if (editing) {
    event.preventDefault();
    const point = canvasPoint(event);
    setEditorZoomAt(point, editorCamera.zoom * Math.exp(-event.deltaY * 0.0015));
    updateEditorGhost(screenToWorld(editorCamera, point.x, point.y));
    return;
  }
  if (!playing) return;
  event.preventDefault();
  adjustUserZoom(-event.deltaY * 0.0015);
}, { passive: false });

document.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (editing) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEditor();
      return;
    }
    const typing = event.target instanceof HTMLElement &&
      Boolean(event.target.closest('input, textarea, select, [contenteditable="true"]'));
    if (typing) return;
    if (event.code === 'Space') {
      event.preventDefault();
      // DESIGN.md 6.2: in Siege's build phase Space locks in early and banks the unspent
      // time as scrap. `editorSiege.onLock` has carried this callback since Siege's build
      // phase was wired up, but nothing ever called it — the ordinary workshop editor's own
      // use of Space, for panning, is only correct outside Siege.
      if (editorSiege) { editorSiege.onLock(false); return; }
      editorSpacePan = true;
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      const result = event.shiftKey ? redo(editorDraft) : undo(editorDraft);
      if (result.ok) refreshEditor(true);
    } else if (event.key === 'Tab' && !event.shiftKey && document.activeElement === canvas) {
      // Tab on the canvas is the documented palette-group shortcut, but it used to fire
      // for Shift+Tab too, so a keyboard user standing on the canvas could not navigate
      // backwards at all — Shift+Tab switched the group forwards instead. Plain Tab keeps
      // the shortcut and still lands focus in the newly revealed palette; Shift+Tab now
      // falls through to the browser's own backward navigation, which is the only way out
      // of the canvas towards the controls above it.
      event.preventDefault();
      setEditorGroup(editorGroup === 'materials' ? 'pigs' : 'materials', true);
    } else if (/^[1-9]$/.test(event.key)) {
      const entries = editorGroup === 'materials' ? Object.keys(SHAPES) : Object.keys(PIGS);
      const id = entries[Number(event.key) - 1];
      if (!id) return;
      event.preventDefault();
      if (editorGroup === 'materials') editorShape = id;
      else editorPig = id;
      renderPalette();
      updateEditorGhost();
      statusMessage.textContent = `${editorGroup === 'materials' ? id : PIGS[id].name} selected.`;
    } else if (key === 'r') {
      event.preventDefault();
      if (editorGroup === 'materials') {
        editorRotation = (editorRotation + 1) % 24;
        renderShapeList();
        updateEditorGhost();
        statusMessage.textContent = `Rotation ${editorRotation * TUNE.rotSnapDeg} degrees.`;
      }
    } else if (key === 'g') {
      event.preventDefault();
      gridButton.click();
    } else if (key === 'x') {
      event.preventDefault();
      removeEditorPiece();
    } else if (key === 't') {
      event.preventDefault();
      runSettleTest();
    }
    return;
  }
  if (event.key === 'Escape' && playing) {
    event.preventDefault();
    playing = false;
    roundOver.hidden = true;
    campaignUI.openLevels(currentLevel.episode);
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

roundOver.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || roundOver.hidden) return;
  const controls = [...roundOver.querySelectorAll('button:not(:disabled)')];
  if (!controls.length) return;
  const first = controls[0];
  const lastControl = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === roundTitle)) {
    event.preventDefault();
    lastControl.focus();
  } else if (!event.shiftKey && document.activeElement === lastControl) {
    event.preventDefault();
    first.focus();
  }
});

document.addEventListener('keyup', (event) => {
  if (event.code === 'Space') editorSpacePan = false;
});
window.addEventListener('blur', () => { editorSpacePan = false; });

document.documentElement.dataset.gameReady = 'true';
updateHud(true);
requestAnimationFrame(frame);

if (new URLSearchParams(window.location.search).has('smoke-test')) {
  // Lets tools/critter-sheet render the nine heads side by side for review.
  window.__drawHead = drawCritterHead;
  Object.defineProperty(window, '__SLINGWRECK_SMOKE__', {
    configurable: true,
    value: () => ({
      phase: round.phase,
      score: round.score,
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
        viewMaxX: TUNE.viewMaxX,
        // Read from the renderer rather than restated, so the smoke probe samples exactly
        // the points that get drawn. It used to hardcode its own step and stopped matching
        // silently the first time the preview changed.
        trajectoryStep: TRAJECTORY_STEP
      },
      pigs: round.pigs.map(({ dead, x, y }) => ({ dead, x, y })),
      blocks: round.blocks.map(({ dead }) => ({ dead })),
      level: {
        id: currentLevel.id,
        episode: currentLevel.episode,
        index: currentLevel.index,
        name: currentLevel.name,
        stars: [...currentLevel.stars]
      },
      campaign: campaignUI.snapshot(),
      siege: siege.active ? {
        phase: siege.phase, round: siege.round, wins: [...siege.wins],
        cards: siege.cards.map((c) => [...c]),
        banked: [...siege.banked],
        // The pre-bonus purse exactly as `lockSiegeFortress` composes it into `rules.budget`
        // at the moment it validates (game.js `lockSiegeFortress`). Exposed so a test can
        // check `editor.budget` against this independently of the DOM, rather than checking
        // the banner against the meter it is itself sourced from.
        rulesBudget: siegeBudget(0),
        // The tier id chosen on the title screen and the numeric profile it actually
        // resolves to — the same object `buildBotFortress` and `stepSiegeOpponent` read
        // from, not a restatement, so a test reading this cannot drift from what the bot
        // does. `botSpent` lets a test see `budgetFraction` land on the actual fortress.
        difficulty: siege.difficulty,
        difficultyProfile: siegeDifficultyProfile(),
        botSpent: siege.botSpent,
        player: siege.playerRound ? { phase: siege.playerRound.phase,
          shot: siege.playerRound.shotIndex, bag: siege.playerRound.bag.length,
          over: isRoundOver(siege.playerRound) } : null,
        bot: siege.botRound ? { phase: siege.botRound.phase,
          shot: siege.botRound.shotIndex, bag: siege.botRound.bag.length,
          over: isRoundOver(siege.botRound) } : null,
        finished: siege.playerRound && siege.botRound ? siegeRoundFinished() : null
      } : null,
      online: onlineSiege.snapshot(),
      editor: editing ? {
        group: editorGroup,
        material: editorMaterial,
        shape: editorShape,
        pig: editorPig,
        rotation: editorRotation,
        grid: editorGrid,
        pieceCount: editorDraft.pieces.length,
        spent: spent(editorDraft),
        budget: editorDraft.budget,
        blueprint: toBlueprint(editorDraft),
        encoded: encode(toBlueprint(editorDraft)),
        validation: validate(editorDraft).errors.map((error) => error.code),
        ghost: editorGhost ? {
          legal: editorGhost.legal,
          reason: editorGhost.reason,
          cost: editorGhost.cost,
          x: editorGhost.piece?.x,
          y: editorGhost.piece?.y
        } : null,
        settling: Boolean(settleAnimation),
        settleResult: settleDisplayRound ? settleResult.textContent : null,
        camera: {
          x: editorCamera.x, y: editorCamera.y, scale: editorCamera.scale,
          viewportX: editorCamera.viewportX, viewportY: editorCamera.viewportY,
          viewportW: editorCamera.viewportW, viewportH: editorCamera.viewportH
        }
      } : null
    })
  });
}

// ---------------------------------------------------------------- Siege
//
// Solo Siege against a bot. Both sides build a fortress, then attack each other's at the
// same time: the player fires at the bot's, and the bot's attack on the player's runs
// alongside in the same frame loop, feeding the corner preview. That simultaneity is the
// whole point of the mode — the pressure comes from watching your own walls fall while you
// are still working on theirs.
//
// The rules all exist already: budgets and validation in build.js, bag composition, draft
// tiers, round resolution and match victory in relay-audit.js, scoring in sim.js, and the
// bot's aim in bots.js. This is wiring, not new rules.

let siegeAccumulatorUnused = 0;
const siege = {
  active: false, phase: 'idle', round: 1, seed: 0,
  wins: [0, 0], cards: [[], []], banked: [0, 0],
  playerRound: null, botRound: null, botFortress: null, playerFortress: null,
  playerSpent: 0, botSpent: 0, botPlan: null, lastWinner: 1,
  botNextShot: 0, deadline: 0, lastPreview: 0,
  // Chosen on the title screen, before startSiegeMatch(), and left alone for the rest of
  // the match — the draft can hand either side a scrap bonus mid-match, but the bot's own
  // aim and how much of its purse it bothers spending stay at whatever the player picked.
  difficulty: loadSiegeDifficulty()
};

function siegeDifficultyProfile() {
  return SIEGE_DIFFICULTIES[siege.difficulty] ?? SIEGE_DIFFICULTIES[SIEGE_DIFFICULTY_DEFAULT];
}

const siegeDifficultyButtons = [...document.querySelectorAll('.difficulty-choice')];

function setSiegeDifficulty(id) {
  if (!SIEGE_DIFFICULTIES[id]) return;
  siege.difficulty = id;
  saveSiegeDifficulty(id);
  for (const button of siegeDifficultyButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.difficulty === id));
  }
}

for (const button of siegeDifficultyButtons) {
  button.addEventListener('click', () => setSiegeDifficulty(button.dataset.difficulty));
}
setSiegeDifficulty(siege.difficulty);

const siegeBanner = document.querySelector('#siege-banner');
const siegeRoundLabel = document.querySelector('#siege-round');
const siegeWinsLabel = document.querySelector('#siege-wins');
const siegeScrapLabel = document.querySelector('#siege-scrap');
const scrapLeftLabel = document.querySelector('#scrap-left');
const siegeClock = document.querySelector('#siege-clock');
const siegeLock = document.querySelector('#siege-lock');
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
const siegeResultEyebrow = document.querySelector('#siege-result-eyebrow');
const siegeResultDetail = document.querySelector('#siege-result-detail');
const siegeStandings = document.querySelector('#siege-standings');
const siegeContinue = document.querySelector('#siege-continue');
const siegeQuit = document.querySelector('#siege-quit');
const siegeButton = document.querySelector('#siege-button');

// The base purse, deliberately without the card bonus: `makeDraft`, `validate` and
// `contextFor` all run this through `budgetFor` again with the cards, so adding it here
// would pay `deep-pockets` twice.
function siegeBudget(pid) {
  const behind = Math.max(0, siege.wins[1 - pid] - siege.wins[pid]);
  return budgetFor({ round: siege.round, roundsBehind: behind }) + siege.banked[pid];
}

// Card-aware bot fortress. `bots.js`'s `fortressForBudget` only ever walks a fixed
// template pricing blocks at raw `MATERIALS[material].cost`, so a drafted card only
// used to matter to the bot when its effect kind was `budget` (folded in by the old
// caller's `budgetFor` wrapper). Every other kind — `unlock`, `materialCost`,
// `decoyKing`, `pigAbility` (Flak Hog) — was inert. This runs the same declarative
// pipeline the editor and the relay use instead, following `tools/balance.mjs`'s
// `buildFortress` rather than a second, divergent build path: seed from
// `fortressForBudget`, replay through `fromBlueprint` (which folds `rulesFor(cards)`
// into cost and legality via its own `budgetFor` call), place whatever a card
// obligates (a decoy King, a flak-flagged pig, reserved unlocked-material blocks),
// spend the rest with a discount-aware fill loop, then `validate` before use.
//
// `autoPig` (Conscription) is the one kind that still cannot change what this
// returns: it spawns extra pigs from `cards` inside `sim.js`'s `instantiate` at round
// start, never as blueprint pieces, so there is nothing for a draft to place here —
// `validate`'s own `too-few-pigs` check already credits it without any piece existing
// (see `automaticOtherPigs` in build.js). Solo Siege does not thread `defenderCards`
// into `makeRound` for either side yet (a separate, pre-existing gap — neither
// `siege.playerRound` nor `siege.botRound` below passes `cards`/`defenderCards`), so
// Conscription's spawn and Flak Hog's actual ability still would not fire in an
// assault even after this fix; that gap is out of scope here since it is not the
// blueprint-building defect this function addresses.
//
// `kingBalloon` (Airlift) now opens the same flight lane `tools/balance.mjs`'s
// `buildFortress` does, at the same geometry: clear blocks at x in (10, 14) — the
// stock templates flank the King with posts there — and keep the fill loop from
// refilling x in [9.5, 14.5]. Without this, a card-aware build holding Airlift failed
// `settleTest` 10/10 across the template/budget sweep: the balloon-carried King rose
// through the un-laned gap and jostled the neighbouring posts enough to exceed the
// movement tolerance, and the build silently fell back to the plain ~60-scrap
// template every time — Airlift permanently crippling the one fortress it should be
// making more interesting to attack.
//
// One deliberate divergence from the harness: `buildFortress` has a
// `--no-lane-respend` flag that keeps the lane open but withholds the scrap it freed,
// because *spending* that scrap was inflating Airlift's measured parity win rate by
// 4.3 points — a measurement-fairness fix, not a gameplay one. There is no equivalent
// here: the fill loop below respends the freed scrap into the rest of the fortress
// exactly as it would for any other reason a column was unavailable. A human player
// forced to leave a lane would spend that scrap elsewhere; modelling the bot as
// declining to spend budget it has would repeat the exact discontinuity this function
// already removed once (see the no-cards note below). Do not add `--no-lane-respend`
// symmetry here to make this match the harness — they are answering different
// questions on purpose.
//
// No-cards is not special-cased either, on purpose, even though it changes the bot's
// strength materially. It used to return `fortressForBudget`'s output directly, which
// stops adding blocks once the fixed template list is exhausted — about 60 scrap
// spent regardless of a purse that reaches into the hundreds. That produced a spend
// discontinuity: 60 scrap with no cards, a full purse the instant the bot held even
// one card with no fortress effect at all (e.g. Bedrock), so the bot's strength
// depended on whether it happened to lose a round rather than on the budget it was
// given. `fortressForBudget` is now always just the seed; the fill loop below always
// runs, with or without cards, so the budget is always the constraint. This is a
// deliberate, material difficulty increase to solo Siege — a full-purse bot fortress
// every round, not just after a draft. P8 tunes it with `budgetFraction`: the fill loop
// below stops at that fraction of `draft.budget` rather than always at the full purse,
// so `straw`'s bot deliberately leaves scrap on the table the way the old ~60-scrap
// template used to, `bricks` spends every scrap exactly as this function always has, and
// `sticks` sits between them. `draft.budget` itself — the real legality ceiling `validate`
// checks against — is untouched; only the fill loop's own stopping point moves.
function buildBotFortress(baseBudget, templateIndex, cards, budgetFraction = 1) {
  const initial = fortressForBudget(baseBudget, templateIndex);
  const effects = cards.map((id) => CARDS_BY_ID[id]?.effect).filter(Boolean);
  // `baseBudget` must be the pre-bonus purse — exactly what was passed to
  // `fortressForBudget` above, never wrapped in another `budgetFor` call. `fromBlueprint`
  // -> `makeDraft` -> `budgetFor` folds `rulesFor(cards).budgetBonus` in from `cards`
  // itself, once. Feeding an already-bonused number back in here would compose it a
  // second time — the same trap the `editorBudgetBase` comment near the top of this
  // file documents for the editor's own reload path.
  const draft = fromBlueprint(initial.blueprint, { round: templateIndex, budget: baseBudget, cards });
  // The fill loop's own stopping point, not the legality ceiling `validate` uses below —
  // see the function comment. Not clamped against `spent(draft)`: at a low enough
  // `budgetFraction` this can sit below what the seed template already costs, and that is
  // fine — `placeLegal` below just adds nothing, `straw`'s bot fields the bare template.
  const targetSpend = draft.budget * budgetFraction;

  // Airlift's flight lane, cleared before anything else is placed — same order as
  // `tools/balance.mjs`'s `buildFortress`, and the same geometry (x in (10, 14) for
  // both stock templates; not template-dependent, since both flank the King with
  // posts at the same x offsets from centre).
  const airlift = effects.some((effect) => effect.kind === 'kingBalloon');
  if (airlift) {
    draft.pieces = draft.pieces.filter((piece) => piece.kind !== 'block' || piece.x < 10 || piece.x > 14);
  }

  // Card-obligated pieces are placed best-effort: a reserve that doesn't fit costs the
  // bot that one piece, not the whole card-aware build. `validate`/`settleTest` below,
  // not this, decide whether the result is legal enough to use.
  if (effects.some((effect) => effect.kind === 'decoyKing')) {
    place(draft, { pig: 'king', decoy: true, x: initial.template === 'low-keep' ? 6 : 9, y: TUNE.plotH });
  }
  if (effects.some((effect) => effect.kind === 'pigAbility' && effect.ability === 'flak')) {
    place(draft, { pig: 'runt', flak: true, x: initial.template === 'low-keep' ? 18 : 15, y: TUNE.plotH });
  }

  const blockCost = (material, shape) =>
    (effects.find((effect) => effect.kind === 'materialCost' && effect.material === material)?.cost ??
      MATERIALS[material].cost) * SHAPES[shape].area;
  const groundSources = (shape) => {
    const sources = [];
    const add = (source) => {
      if (!airlift || source.x < 9.5 || source.x > 14.5) sources.push(source);
    };
    if (shape === 'pillar') {
      for (const y of [2, 6]) {
        for (let index = 0; index < TUNE.plotW * 2; index++) add({ shape, x: 0.25 + index * 0.5, y });
      }
    } else {
      for (let index = 0; index < TUNE.plotW; index++) add({ shape, x: 0.5 + index, y: 0.5 });
    }
    return sources;
  };
  const placeLegal = (material, shape = 'pillar') => {
    if (spent(draft) + blockCost(material, shape) > targetSpend) return false;
    for (const source of groundSources(shape)) {
      if (!place(draft, { ...source, material }).ok) continue;
      if (validate(draft, { mode: 'siege' }).ok) return true;
      undo(draft);
    }
    return false;
  };

  // Best-effort too: `perRound` reserves that do not all fit still leave whichever did
  // in place, same reasoning as the obligations above.
  for (const effect of effects) {
    if (effect.kind !== 'unlock') continue;
    for (let index = 0; index < effect.perRound; index++) {
      if (!placeLegal(effect.material)) break;
    }
  }

  // Prefer whichever material a `materialCost` card just discounted, same as the
  // harness: otherwise a held Quarryman or Heavy Industry never shows up in the fill
  // loop's output even though the discount is real.
  const preferred = effects.some((effect) => effect.kind === 'materialCost' && effect.material === 'iron')
    ? 'iron'
    : effects.some((effect) => effect.kind === 'materialCost' && effect.material === 'stone') ? 'stone' : null;
  for (let guard = 0; spent(draft) < targetSpend && guard < 500; guard++) {
    const materials = preferred ? [preferred, 'stone', 'wood', 'glass'] : ['stone', 'wood', 'glass'];
    const candidates = [...materials.map((material) => [material, 'pillar']), ['glass', 'cube']];
    if (!candidates.some(([material, shape]) => placeLegal(material, shape))) break;
  }

  // `validate` alone does not catch a piece with nothing under it — that only shows up
  // once physics runs, which is exactly what `settleTest` (used identically by the
  // editor's own settle button, and by `tools/balance.mjs`'s harness) is for. Both
  // gates have to pass, or the bot would be defending a fortress that could collapse
  // on its own before the assault even starts.
  const legality = validate(draft, { mode: 'siege' });
  const settled = legality.ok ? settleTest(draft) : null;
  if (!legality.ok || !settled.ok) {
    console.warn('Siege: bot could not fill its fortress legally; falling back to the plain template.',
      { cards, errors: legality.errors, settled });
    return initial;
  }
  return { blueprint: toBlueprint(draft), template: initial.template, spent: spent(draft) };
}

function startSiegeMatch() {
  siege.active = true;
  siege.round = 1;
  siege.wins = [0, 0];
  siege.cards = [[], []];
  siege.banked = [0, 0];
  siege.lastWinner = 1;
  siege.playerSpent = 0;
  siege.botSpent = 0;
  siege.botPlan = null;
  siege.playerUnsettled = null;
  // One seed for the whole match: bag composition and the draft are both derived from it,
  // so a match is reproducible and — when this is wired to the relay — auditable.
  siege.seed = pinnedSiegeSeed ?? (Date.now() ^ 0x5109) >>> 0;
  beginSiegeBuild();
}

function beginSiegeBuild() {
  siege.phase = 'build';
  siegePreview.hidden = true;
  siegeDraftScreen.hidden = true;
  siegeResultScreen.hidden = true;
  siege.deadline = performance.now() + TUNE.buildSeconds * 1000;
  openEditor({
    budget: siegeBudget(0),
    cards: siege.cards[0],
    onLock: lockSiegeFortress
  });
  updateSiegeBanner();
}

function updateSiegeBanner() {
  if (!siege.active || siege.phase !== 'build') { siegeBanner.hidden = true; return; }
  siegeBanner.hidden = false;
  siegeRoundLabel.textContent = `Round ${siege.round}`;
  siegeWinsLabel.textContent = `${siege.wins[0]} – ${siege.wins[1]}`;
  // Read the editor's own meter rather than recomputing the remainder here. Two
  // independent calculations of one number is exactly how the banner ended up showing a
  // full purse over a fortress that had already spent 60 — the same duplicated-maths
  // fault that broke the smoke probe's dot sampling and the editor's pouch position.
  siegeScrapLabel.textContent = `${(scrapLeftLabel?.textContent ?? '').trim() || '—'} scrap`;
  const remaining = Math.max(0, (siege.deadline - performance.now()) / 1000);
  siegeClock.textContent = `${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, '0')}`;
  if (remaining <= 0) lockSiegeFortress(true);
}

function lockSiegeFortress(expired = false) {
  if (siege.phase !== 'build') return;
  const rules = { mode: 'siege', budget: siegeBudget(0), cards: siege.cards[0] };
  let blueprint = toBlueprint(editorDraft);
  let check = validate(blueprint, rules);
  if (!check.ok) {
    // Same rules the relay enforces. Surfacing them here rather than silently repairing
    // the draft keeps the solo mode honest about what online will accept.
    if (!expired) { renderValidation(); return; }
    // Unless the timer ran out, in which case DESIGN.md 6.2 says complete it and lock.
    // Same candidate ladder the relay walks, so an expired solo build and an expired
    // online build produce the same fortress from the same draft.
    blueprint = autoCompleteCandidates(blueprint)
      .find((candidate) => validate(candidate, rules).ok) ?? blueprint;
    check = validate(blueprint, rules);
    if (!check.ok) { renderValidation(); quitSiege(); return; }
    // The draft has to follow the blueprint, or `spent` below prices the fortress the
    // player abandoned rather than the one they are about to defend.
    editorDraft = fromBlueprint(blueprint, editorOptions());
  }
  // Bank the unspent time, per DESIGN.md: locking in early is the only reason to stop
  // fiddling with a fortress.
  const remaining = Math.max(0, (siege.deadline - performance.now()) / 1000);
  siege.banked[0] += Math.floor(remaining / 10) * BUDGET.earlyLockPer10s;
  siege.playerSpent = spent(editorDraft);
  siege.playerFortress = blueprint;
  // Settle is advisory, not a gate: online Siege no longer blocks ready-up on it either
  // (worker.js's validateBlueprintSubmission), so this never held solo back — it just never
  // said anything. Stash the finding for endSiegeRound to surface once this round resolves,
  // so a player learns the same thing in both modes instead of one warning and one silence.
  const settled = settleTest(blueprint, rules);
  siege.playerUnsettled = settled.ok ? null : settled;
  // `fortressForBudget` returns { blueprint, template, spent } — passing the wrapper
  // straight to makeRound built an empty world, so the player won every round instantly
  // against nothing and `fortressCost` read undefined.
  // `buildBotFortress` (above) runs the bot's draft through the same declarative
  // pipeline the editor and the relay use, so a drafted card actually reaches its
  // fortress instead of only mattering when its kind is `budget`. `siegeBudget(1)` is
  // passed through untouched — the pre-bonus purse — because `buildBotFortress` folds
  // `rulesFor(cards).budgetBonus` in exactly once, from inside `fromBlueprint`'s own
  // `budgetFor` call; wrapping it in another `budgetFor` here first, as the old code
  // did to price a plain-number budget for `fortressForBudget`, would compose the
  // bonus twice.
  const built = buildBotFortress(siegeBudget(1), siege.round + siege.wins[0], siege.cards[1],
    siegeDifficultyProfile().budgetFraction);
  siege.botFortress = built.blueprint;
  siege.botSpent = built.spent;
  beginSiegeAssault();
}

function beginSiegeAssault() {
  siege.phase = 'assault';
  siegeBanner.hidden = true;
  closeEditor();
  const bag = bagForRound(siege.seed, siege.round, siege.cards[0]);
  const botBag = bagForRound(siege.seed, siege.round, siege.cards[1]);
  // Two independent worlds that never interact: you attack theirs, they attack yours.
  // Each world's attacker is whoever is firing into it; its defender is whoever built
  // the fortress standing in it. Get this backwards and every defender-side effect
  // (Conscription's spawn, Flak Hog's ability, Airlift's balloon, pigHp, plotTilt...)
  // would apply to the wrong side while still "running" without error — this was
  // previously not wired at all, so none of them fired for either side in solo Siege.
  siege.botPlan = null;
  siege.playerRound = makeRound({
    blueprint: siege.botFortress, bag, seed: siege.seed, mode: 'siege',
    attackerCards: siege.cards[0], defenderCards: siege.cards[1]
  });
  siege.botRound = makeRound({
    blueprint: siege.playerFortress, bag: botBag, seed: siege.seed ^ 0x9e37, mode: 'siege',
    attackerCards: siege.cards[1], defenderCards: siege.cards[0]
  });
  round = siege.playerRound;
  playing = true;
  editing = false;
  siege.botNextShot = performance.now() + 2200;
  siegePreview.hidden = false;
  roundHud.hidden = false;
  titleScreen.hidden = true;
  document.body.classList.add('playing');
  resetCameraState('aiming');
  updateHud(true);
}

// The bot's attack, stepped in the same frame as the player's. It plans a shot with
// bots.js, waits for its own world to settle, then plans the next — the same rhythm a
// person plays at, so the corner preview reads as an opponent rather than a metronome.
function stepSiegeOpponent(elapsed, now) {
  const bot = siege.botRound;
  if (!bot || isRoundOver(bot)) return;
  let acc = (siege.botAccumulator ?? 0) + elapsed / 1000;
  let steps = 0;
  while (acc >= TUNE.step && steps < TUNE.catchUpSteps) {
    stepRound(bot, TUNE.step);
    acc -= TUNE.step;
    steps++;
  }
  siege.botAccumulator = acc;
  if (bot.phase === 'aiming' && now >= siege.botNextShot && bot.shotIndex < bot.bag.length) {
    const plan = planShot(bot, siegeDifficultyProfile().accuracy, bot.rng);
    if (plan?.aim) {
      // The draw vector is on `plan.aim`, not on the plan itself. Reading `plan.dx`
      // passed undefined to launch, so the bot stood there for the whole round and its
      // shot counter never moved off zero.
      launch(bot, plan.aim.dx, plan.aim.dy);
      siege.botPlan = plan;
    } else {
      launch(bot, -TUNE.slingRadius * 0.8, -TUNE.slingRadius * 0.4);
    }
    siege.botNextShot = now + 4200;
  }
  // Ability timing is bots.js's call, checked each step while the shot is in the air.
  if (siege.botPlan && bot.phase === 'flying' && shouldTap(bot, siege.botPlan)) {
    tap(bot);
    siege.botPlan = null;
  }
}

function drawSiegePreview(now) {
  if (siege.phase !== 'assault' || now - siege.lastPreview < 1000 / TUNE.previewHz) return;
  siege.lastPreview = now;
  const ctx = siegePreviewCanvas.getContext('2d');
  drawPreview(ctx, siege.botRound, siegePreviewCanvas.width, siegePreviewCanvas.height);
  const king = siege.botRound.pigs.find((pig) => pig.isKing);
  siegePreviewKing.classList.toggle('dead', Boolean(king?.dead));
  siegeTheirScore.textContent = scoreFormat.format(Math.round(finalizeSiegeScore(siege.botRound)));
  siegeTheirAmmo.textContent = `${siege.botRound.bag.length - siege.botRound.shotIndex} left`;
}

function siegePlayerState(pid) {
  const r = pid === 0 ? siege.playerRound : siege.botRound;
  const fortress = pid === 0 ? siege.playerFortress : siege.botFortress;
  const king = r.pigs.find((pig) => pig.isKing);
  return {
    pid,
    score: finalizeSiegeScore(r),
    kingPopped: Boolean(king?.dead),
    wins: siege.wins[pid],
    // Scrap spent, not block count: DESIGN.md's last tie-break rewards the cheaper
    // fortress, and two fortresses can share a block count at very different prices.
    fortressCost: pid === 0 ? (siege.playerSpent ?? 0) : (siege.botSpent ?? 0),
    suddenDeathDamage: undefined
  };
}

function siegeRoundFinished() {
  const both = [siege.playerRound, siege.botRound];
  // `isKing` is the flag sim.js sets, and it already excludes a Decoy King. The earlier
  // version read `pig.king` and looked `pig.id` up in PIGS — but `pig.id` is a numeric
  // body id, so it was always undefined and no King pop was ever detected.
  const kingDown = both.some((r) => r.pigs.some((pig) => pig.isKing && pig.dead));
  if (kingDown) return true;
  // Otherwise the round ends when neither side has anything left to throw and both worlds
  // have come to rest. `isRoundOver` covers a side that has already won or lost outright;
  // an empty bag sitting in `aiming` is the ordinary case.
  // sim.js already knows the siege win condition — `makeRound({ mode: 'siege' })` ends a
  // round on the King, not on all pigs — so `isRoundOver` is authoritative here.
  const done = (r) => isRoundOver(r) ||
    (r.shotIndex >= r.bag.length && r.phase === 'aiming');
  return both.every(done);
}


function endSiegeRound() {
  siege.phase = 'roundover';
  playing = false;
  siegePreview.hidden = true;
  const players = [siegePlayerState(0), siegePlayerState(1)];
  const outcome = resolveRound(players);
  // An unresolved round would mean a genuine tie all the way down to fortress cost. Rather
  // than stall the match, award it to the defender who spent least — the same tie-break
  // DESIGN.md uses, applied one step earlier.
  const winner = outcome.resolved ? outcome.winner
    : (players[0].fortressCost <= players[1].fortressCost ? 0 : 1);
  siege.wins[winner]++;
  siege.lastWinner = winner;
  const iWon = winner === 0;
  siegeResultEyebrow.textContent = `Round ${siege.round}`;
  siegeResultTitle.textContent = iWon ? 'You took the round' : 'They took the round';
  siegeResultDetail.textContent = outcome.reason === 'king-pop'
    ? (iWon ? 'You popped their King.' : 'They popped your King.')
    : `On points — ${scoreFormat.format(Math.round(players[0].score))} against ` +
      `${scoreFormat.format(Math.round(players[1].score))}.`;
  // Advisory settle warning, surfaced here rather than at ready-up: readying up is
  // instant against a bot (no opponent to wait on), so a banner shown then would close
  // with the editor before anyone could read it. Same wording runSettleTest uses.
  if (siege.playerUnsettled) {
    siegeResultDetail.textContent += ` Heads up: ${braceMessage(siege.playerUnsettled)} in your fortress.`;
    siege.playerUnsettled = null;
  }
  siegeStandings.textContent = `You ${siege.wins[0]} — ${siege.wins[1]} Bot` +
    `  ·  first to ${TUNE.winsNeeded}`;
  siege.banked[winner] += BUDGET.winnerBonus;
  const champion = matchWinner([
    { pid: 0, wins: siege.wins[0] }, { pid: 1, wins: siege.wins[1] }
  ]);
  if (champion !== null) {
    siegeResultEyebrow.textContent = 'Match over';
    siegeResultTitle.textContent = champion === 0 ? 'You win the siege' : 'The bot wins the siege';
    siegeContinue.textContent = 'Play again';
    siege.phase = 'matchover';
  } else {
    siegeContinue.textContent = iWon ? 'Next round' : 'Draft a card';
  }
  siegeResultScreen.hidden = false;
  roundHud.hidden = true;
}

function offerSiegeDraft() {
  // DESIGN.md 6.4: the loser *of the round* drafts. Deriving the loser from the running
  // win totals instead handed the player a draft at one-all — after a round they had just
  // won — and never gave the bot a card at all.
  const loser = 1 - siege.lastWinner;
  const deficit = siege.wins[1 - loser] - siege.wins[loser];
  const ids = rollDraft(siege.seed, siege.round, deficit, siege.cards[loser], loser);
  if (loser !== 0) {
    // The bot drafts too, or the deficit tiers only ever work in the player's favour and
    // no card is ever seen from the receiving end. It takes the relay's default pick.
    const pick = defaultDraftPick(ids);
    if (pick) siege.cards[1].push(pick);
    siege.round++;
    beginSiegeBuild();
    return;
  }
  // `rollDraft` returns card *ids*. Rendering them as if they were card records is why the
  // draft screen showed three blank buttons and `siege.cards[0]` collected `undefined`.
  const choices = ids.map((id) => CARDS_BY_ID[id]).filter(Boolean);
  if (!choices.length) { siege.round++; beginSiegeBuild(); return; }
  siege.phase = 'draft';
  siegeDraftEyebrow.textContent = deficit >= 2 ? 'Two rounds down — take something unfair'
    : 'You lost the round';
  siegeDraftCards.replaceChildren(...choices.map((card) => {
    const button = document.createElement('button');
    button.className = 'siege-card';
    button.type = 'button';
    button.innerHTML = '';
    const tier = document.createElement('div');
    tier.className = 'tier';
    tier.textContent = card.tierName;
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = card.name;
    const text = document.createElement('div');
    text.className = 'card-text';
    text.textContent = card.text;
    button.append(tier, name, text);
    button.addEventListener('click', () => {
      siege.cards[0].push(card.id);
      siegeDraftScreen.hidden = true;
      siege.round++;
      beginSiegeBuild();
    });
    return button;
  }));
  siegeResultScreen.hidden = true;
  siegeDraftScreen.hidden = false;
  siegeDraftCards.querySelector('button')?.focus();
}

function quitSiege() {
  siege.active = false;
  siege.phase = 'idle';
  playing = false;
  editing = false;
  siegeBanner.hidden = true;
  siegePreview.hidden = true;
  siegeDraftScreen.hidden = true;
  siegeResultScreen.hidden = true;
  roundHud.hidden = true;
  document.body.classList.remove('playing', 'editing');
  editorScreen.hidden = true;
  titleScreen.hidden = false;
}

// Online Siege reuses the editor's build phase and the solo result/draft/preview DOM the
// same way `siege` above reuses them against a bot — see siege-online.js's header comment.
// It is constructed with accessors rather than the raw `round`/`playing` bindings because
// those are `let`s in this module's scope, not values a factory called once could close
// over and see change later.
const onlineSiege = createOnlineSiege({
  openEditor,
  closeEditor,
  showTitle,
  getEditorDraft: () => editorDraft,
  renderValidation,
  guidanceFor, // ready-up rejections reuse the same plain-language reasons as the side panel
  getRound: () => round,
  setRound: (value) => { round = value; },
  setPlaying: (value) => { playing = value; },
  resetCameraState,
  updateHud
});
document.querySelector('#siege-online-button').addEventListener('click', () => {
  void unlockAudio(audio);
  onlineSiege.open();
});

siegeButton.addEventListener('click', startSiegeMatch);
// Not a bare reference: the click event would arrive as the `expired` argument and every
// manual lock-in would silently auto-complete an illegal fortress instead of saying so.
// Goes through `editorSiege.onLock` (set by whichever caller passed a siegeCtx to
// openEditor) rather than calling `lockSiegeFortress` directly — that direct call was a
// latent bug: it always ran solo's own lock function regardless of which mode's build
// phase was open, so the online build phase's lock-in button was inert (Space already used
// the correct `editorSiege.onLock` hook a few lines below, which is how this was found).
siegeLock.addEventListener('click', () => editorSiege?.onLock(false));
siegeQuit.addEventListener('click', () => { if (!onlineSiege.isActive()) quitSiege(); });
siegeContinue.addEventListener('click', () => {
  if (onlineSiege.isActive()) return;
  siegeResultScreen.hidden = true;
  if (siege.phase === 'matchover') { startSiegeMatch(); return; }
  offerSiegeDraft();
});
