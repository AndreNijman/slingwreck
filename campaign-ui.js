import { AMMO_BY_ID, MATERIALS, PIGS } from './data.js?v=20260904-2';
import { EPISODES, LEVELS } from './levels.js?v=20260904-2';
import { PALETTE } from './render.js?v=20260904-2';

const STORAGE_KEY = 'slingwreck.campaign.progress.v1';
const PROFILE_URL = '/_guard/profile';
const PROFILE_VERSION = 1;
const LEVELS_PER_EPISODE = 13;
const EPISODE_UNLOCK_COMPLETIONS = 8;
const STAR_WORDS = ['no stars', 'one star', 'two stars', 'three stars'];
const STAR_GOALS = ['one', 'two', 'three'];
const scoreFormat = new Intl.NumberFormat('en-AU');
const levelById = new Map(LEVELS.map((level) => [level.id, level]));

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function starsForScore(level, score) {
  let count = 0;
  for (const threshold of level.stars) if (score >= threshold) count++;
  return count;
}

export function starResultText(level, score, count = starsForScore(level, score)) {
  const rounded = Math.max(0, Math.round(score));
  const scoreText = scoreFormat.format(rounded);
  if (count >= 3) return `${scoreText} · three stars · all thresholds cleared`;
  const next = level.stars[count];
  const distance = scoreFormat.format(Math.max(0, next - rounded));
  return `${scoreText} · ${STAR_WORDS[count]} · ${distance} more for ${STAR_GOALS[count]}`;
}

function normalRecord(value, level) {
  const bestScore = Number.isFinite(value?.bestScore)
    ? Math.max(0, Math.round(value.bestScore))
    : 0;
  const storedStars = Number.isFinite(value?.stars)
    ? clamp(Math.round(value.stars), 0, 3)
    : 0;
  return {
    bestScore,
    stars: Math.max(storedStars, starsForScore(level, bestScore)),
    completed: Boolean(value?.completed)
  };
}

function normalProfile(value) {
  const source = value?.levels && typeof value.levels === 'object' ? value.levels : {};
  const levels = {};
  for (const level of LEVELS) levels[level.id] = normalRecord(source[level.id], level);
  return { version: PROFILE_VERSION, levels };
}

function mergeProfiles(first, second) {
  const a = normalProfile(first);
  const b = normalProfile(second);
  const levels = {};
  for (const level of LEVELS) {
    const left = a.levels[level.id];
    const right = b.levels[level.id];
    const bestScore = Math.max(left.bestScore, right.bestScore);
    levels[level.id] = {
      bestScore,
      stars: Math.max(left.stars, right.stars, starsForScore(level, bestScore)),
      completed: left.completed || right.completed
    };
  }
  return { version: PROFILE_VERSION, levels };
}

function readLocalProfile() {
  try {
    return normalProfile(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return normalProfile(null);
  }
}

function writeLocalProfile(profile) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage can be unavailable in a private or embedded context. The in-memory
    // profile remains playable, and guard sync still gets the same blob if signed in.
  }
}

function contentName(id) {
  return AMMO_BY_ID[id]?.name ?? PIGS[id]?.name ?? MATERIALS[id]?.name ?? id;
}

function prepareIcon(canvas, size) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  return context;
}

function drawStar(canvas, filled, size) {
  const context = prepareIcon(canvas, size);
  const centre = size / 2;
  const outer = size * 0.41;
  const inner = size * 0.19;
  context.beginPath();
  for (let point = 0; point < 10; point++) {
    const angle = -Math.PI / 2 + point * Math.PI / 5;
    const radius = point % 2 ? inner : outer;
    const x = centre + Math.cos(angle) * radius;
    const y = centre + Math.sin(angle) * radius;
    if (point === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fillStyle = filled ? PALETTE.crown : PALETTE.cream;
  context.strokeStyle = PALETTE.ink;
  context.lineWidth = Math.max(1.8, size * 0.075);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(size * 0.31, size * 0.39);
  context.lineTo(size * 0.45, size * 0.31);
  context.strokeStyle = filled ? 'rgba(255,255,255,.62)' : 'rgba(185,154,108,.72)';
  context.lineWidth = Math.max(1, size * 0.04);
  context.stroke();
}

function drawLock(canvas, size) {
  const context = prepareIcon(canvas, size);
  context.strokeStyle = PALETTE.ink;
  context.fillStyle = PALETTE.cream;
  context.lineWidth = Math.max(2, size * 0.085);
  context.beginPath();
  context.arc(size * 0.5, size * 0.38, size * 0.23, Math.PI, 0);
  context.lineTo(size * 0.73, size * 0.54);
  context.stroke();
  context.beginPath();
  context.rect(size * 0.18, size * 0.48, size * 0.64, size * 0.42);
  context.fill();
  context.stroke();
  context.fillStyle = PALETTE.ink;
  context.beginPath();
  context.arc(size * 0.5, size * 0.66, size * 0.055, 0, Math.PI * 2);
  context.fill();
  context.fillRect(size * 0.47, size * 0.67, size * 0.06, size * 0.13);
}

function starCanvas(filled, size = 24) {
  const canvas = document.createElement('canvas');
  canvas.className = 'drawn-star';
  canvas.dataset.filled = String(filled);
  canvas.setAttribute('aria-hidden', 'true');
  drawStar(canvas, filled, size);
  return canvas;
}

function lockCanvas(size = 36) {
  const canvas = document.createElement('canvas');
  canvas.className = 'drawn-lock';
  canvas.setAttribute('aria-hidden', 'true');
  drawLock(canvas, size);
  return canvas;
}

export function renderDrawnStars(target, count, size = 24) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 3; index++) fragment.append(starCanvas(index < count, size));
  target.replaceChildren(fragment);
  target.setAttribute('aria-label', `${count} of 3 stars earned`);
}

export function createCampaignUI({ titleScreen, onPlayLevel, onOpenTitle }) {
  const episodeScreen = document.querySelector('#episode-screen');
  const levelScreen = document.querySelector('#level-screen');
  const episodeList = document.querySelector('#episode-list');
  const levelGrid = document.querySelector('#level-grid');
  const episodeBack = document.querySelector('#episode-back-button');
  const levelBack = document.querySelector('#level-back-button');
  const levelEpisodeNumber = document.querySelector('#level-episode-number');
  const levelEpisodeTitle = document.querySelector('#level-episode-title');
  const levelEpisodeCopy = document.querySelector('#level-episode-copy');
  let profile = readLocalProfile();
  let selectedEpisode = 1;
  let view = null;
  let guardSession = false;
  let syncing = false;
  let syncTimer = null;
  let retryTimer = null;
  let retryDelay = 5000;

  writeLocalProfile(profile);

  function recordFor(level) {
    return profile.levels[level.id];
  }

  function episodeLevels(number) {
    return LEVELS.filter((level) => level.episode === number);
  }

  function episodeCompleted(number) {
    return episodeLevels(number).filter((level) => recordFor(level).completed).length;
  }

  function episodeStars(number) {
    return episodeLevels(number).reduce((sum, level) => sum + recordFor(level).stars, 0);
  }

  function episodeUnlocked(number) {
    return number === 1 || episodeCompleted(number - 1) >= EPISODE_UNLOCK_COMPLETIONS;
  }

  function levelUnlocked(level) {
    if (!episodeUnlocked(level.episode)) return false;
    if (level.index === 1) return true;
    const previous = LEVELS.find((candidate) =>
      candidate.episode === level.episode && candidate.index === level.index - 1);
    return Boolean(previous && recordFor(previous).completed);
  }

  function refreshVisible() {
    if (view === 'episodes') renderEpisodes();
    if (view === 'levels') renderLevels(selectedEpisode);
  }

  function episodeButton(episode) {
    const unlocked = episodeUnlocked(episode.number);
    const completed = episodeCompleted(episode.number);
    const earned = episodeStars(episode.number);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'episode-choice';
    button.dataset.episode = String(episode.number);
    button.setAttribute('aria-disabled', String(!unlocked));
    button.setAttribute('aria-label', unlocked
      ? `Episode ${episode.number}, ${episode.name}. ${earned} of 39 stars, ${completed} of ${LEVELS_PER_EPISODE} levels completed.`
      : `Episode ${episode.number}, ${episode.name}, locked. Complete ${EPISODE_UNLOCK_COMPLETIONS} levels in ${EPISODES[episode.number - 2].name}; ${episodeCompleted(episode.number - 1)} completed there.`);

    const number = document.createElement('span');
    number.className = 'episode-number';
    number.textContent = String(episode.number).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'episode-copy';
    const heading = document.createElement('strong');
    heading.textContent = episode.name;
    const theme = document.createElement('span');
    theme.className = 'episode-theme';
    theme.textContent = episode.theme;
    const introduces = document.createElement('span');
    introduces.className = 'episode-introduces';
    introduces.textContent = `Introduces ${episode.introduces.map(contentName).join(' · ')}`;
    copy.append(heading, theme, introduces);

    const progress = document.createElement('span');
    progress.className = 'episode-progress';
    if (unlocked) {
      const stars = document.createElement('span');
      stars.className = 'episode-star-total';
      stars.append(starCanvas(true, 25));
      const total = document.createElement('strong');
      total.textContent = `${earned} / 39`;
      stars.append(total);
      const levels = document.createElement('span');
      levels.textContent = `${completed} / ${LEVELS_PER_EPISODE} cleared`;
      progress.append(stars, levels);
    } else {
      progress.classList.add('locked');
      progress.append(lockCanvas(34));
      const reason = document.createElement('span');
      const previous = EPISODES[episode.number - 2];
      const previousDone = episodeCompleted(episode.number - 1);
      reason.textContent = `${previousDone} / ${EPISODE_UNLOCK_COMPLETIONS} ${previous.name} levels cleared`;
      progress.append(reason);
    }
    button.append(number, copy, progress);
    button.addEventListener('click', () => {
      if (!unlocked) {
        const previous = EPISODES[episode.number - 2];
        document.querySelector('#status-message').textContent =
          `Complete ${EPISODE_UNLOCK_COMPLETIONS} levels in ${previous.name} to open ${episode.name}.`;
        return;
      }
      openLevels(episode.number);
    });
    return button;
  }

  function renderEpisodes() {
    const fragment = document.createDocumentFragment();
    for (const episode of EPISODES) fragment.append(episodeButton(episode));
    episodeList.replaceChildren(fragment);
  }

  function levelButton(level) {
    const record = recordFor(level);
    const unlocked = levelUnlocked(level);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'level-choice';
    button.dataset.levelId = level.id;
    button.setAttribute('aria-disabled', String(!unlocked));
    button.setAttribute('aria-label', unlocked
      ? `Level ${level.index}, ${level.name}. ${record.stars} of 3 stars${record.completed ? `, best score ${scoreFormat.format(record.bestScore)}` : ', not completed'}.`
      : `Level ${level.index}, ${level.name}, locked. Complete the previous level first.`);
    const number = document.createElement('span');
    number.className = 'level-number';
    number.textContent = String(level.index).padStart(2, '0');
    const name = document.createElement('strong');
    name.className = 'level-name';
    name.textContent = level.name;
    const footer = document.createElement('span');
    footer.className = 'level-footer';
    if (unlocked) {
      const starRow = document.createElement('span');
      starRow.className = 'tile-stars';
      starRow.setAttribute('aria-hidden', 'true');
      for (let index = 0; index < 3; index++) starRow.append(starCanvas(index < record.stars, 21));
      const best = document.createElement('span');
      best.className = 'level-best';
      best.textContent = record.completed
        ? `Best ${scoreFormat.format(record.bestScore)}`
        : 'Not yet cleared';
      footer.append(starRow, best);
    } else {
      footer.classList.add('locked');
      footer.append(lockCanvas(34));
      const copy = document.createElement('span');
      copy.textContent = 'Previous level';
      footer.append(copy);
    }
    button.append(number, name, footer);
    button.addEventListener('click', () => {
      if (!unlocked) {
        document.querySelector('#status-message').textContent =
          `${level.name} opens when the previous level is completed.`;
        return;
      }
      hide();
      onPlayLevel(level);
    });
    return button;
  }

  function renderLevels(number) {
    const episode = EPISODES[number - 1];
    levelEpisodeNumber.textContent = `Episode ${episode.number}`;
    levelEpisodeTitle.textContent = episode.name;
    levelEpisodeCopy.textContent = `${episode.theme} · ${episodeStars(number)} of 39 stars`;
    const fragment = document.createDocumentFragment();
    for (const level of episodeLevels(number)) fragment.append(levelButton(level));
    levelGrid.replaceChildren(fragment);
  }

  function hide() {
    episodeScreen.hidden = true;
    levelScreen.hidden = true;
    view = null;
  }

  function openEpisodes() {
    titleScreen.hidden = true;
    levelScreen.hidden = true;
    renderEpisodes();
    episodeScreen.hidden = false;
    view = 'episodes';
    episodeBack.focus({ preventScroll: true });
  }

  function openLevels(number = selectedEpisode) {
    if (!episodeUnlocked(number)) return;
    selectedEpisode = number;
    titleScreen.hidden = true;
    episodeScreen.hidden = true;
    renderLevels(number);
    levelScreen.hidden = false;
    view = 'levels';
    levelBack.focus({ preventScroll: true });
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void loadGuardProfile();
    }, retryDelay);
    retryDelay = Math.min(60000, retryDelay * 2);
  }

  function scheduleSync(delay = 120) {
    if (!guardSession) return;
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => void pushGuardProfile(), delay);
  }

  async function pushGuardProfile() {
    if (!guardSession || syncing) return;
    syncing = true;
    const body = JSON.stringify(profile);
    try {
      let response = await fetch(PROFILE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      });
      // The deployed guard predates the POST contract and currently accepts PUT. Keep
      // the requested POST as the canonical call while remaining compatible in place.
      if (response.status === 405) {
        response = await fetch(PROFILE_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true
        });
      }
      if (response.status === 401 || response.status === 403) {
        guardSession = false;
      } else if (!response.ok) {
        scheduleRetry();
      } else {
        retryDelay = 5000;
      }
    } catch {
      scheduleRetry();
    } finally {
      syncing = false;
    }
  }

  async function loadGuardProfile() {
    try {
      const response = await fetch(PROFILE_URL, { cache: 'no-store' });
      if (response.status === 401 || response.status === 403 || response.status === 404) return;
      if (!response.ok) {
        scheduleRetry();
        return;
      }
      const body = await response.json().catch(() => null);
      guardSession = true;
      retryDelay = 5000;
      const remote = normalProfile(body?.profile);
      const before = JSON.stringify(profile);
      profile = mergeProfiles(profile, remote);
      writeLocalProfile(profile);
      refreshVisible();
      if (before !== JSON.stringify(remote)) scheduleSync(0);
    } catch {
      scheduleRetry();
    }
  }

  function recordResult(level, score, completed) {
    const previous = recordFor(level);
    const bestScore = Math.max(previous.bestScore, Math.max(0, Math.round(score)));
    profile.levels[level.id] = {
      bestScore,
      stars: completed
        ? Math.max(previous.stars, starsForScore(level, bestScore))
        : previous.stars,
      completed: previous.completed || completed
    };
    writeLocalProfile(profile);
    refreshVisible();
    scheduleSync();
    return profile.levels[level.id];
  }

  function nextLevel(level) {
    return LEVELS.find((candidate) => candidate.episode === level.episode &&
      candidate.index === level.index + 1) ?? null;
  }

  function snapshot() {
    return {
      view,
      selectedEpisode,
      storageKey: STORAGE_KEY,
      guardSession,
      profile: normalProfile(profile)
    };
  }

  episodeBack.addEventListener('click', () => onOpenTitle());
  levelBack.addEventListener('click', openEpisodes);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !view) return;
    event.preventDefault();
    if (view === 'levels') openEpisodes();
    else onOpenTitle();
  });
  window.addEventListener('online', () => void loadGuardProfile());
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      profile = mergeProfiles(profile, JSON.parse(event.newValue));
      writeLocalProfile(profile);
      refreshVisible();
    } catch {
      // Ignore malformed values written by another tab.
    }
  });
  queueMicrotask(() => void loadGuardProfile());

  return {
    hide,
    openEpisodes,
    openLevels,
    recordResult,
    nextLevel,
    recordFor,
    renderStars: renderDrawnStars,
    snapshot
  };
}
