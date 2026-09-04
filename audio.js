import { PIGS } from './data.js?v=20260904-2';
const MAX_VOICES = 16, COALESCE_SECONDS = 0.03, MASTER_LEVEL = 0.68;
const SILENCE = null;
const DEFAULT_ABILITY_NOTES = Object.freeze([350]);
const ABILITY_NOTES = Object.freeze({
  split: [520, 690, 880], accel: [260, 430, 720], boom: [190, 125],
  drop: [540, 230], reverse: [520, 280, 500], inflate: [180, 245, 335],
  harden: [260, 920], blink: [820, 1180], flak: [920, 460, 920]
});
const HIT_CENTRES = Object.freeze({
  wood: 720, stone: 270, iron: 1050, glass: 1500, sand: 240, gel: 360
});
// Recipe steps are fixed at module load so an event burst only allocates WebAudio's
// mandatory one-shot nodes. Oscillators and buffer sources cannot be restarted.
const RECIPES = Object.freeze({
  launch: [0.28, ['n', 0, 0.095, 2600, 620, 0.7], ['t', 0.008, 0.065, 285, 194, 0.42]],
  crumble: [0.18, ['n', 0, 0.27, 520, 170, 0.7, 'lowpass', 0.035]],
  stone: [0.25, ['n', 0, 0.075, 1400, 280, 0.75],
    ['n', 0.018, 0.22, 260, 90, 0.55, 'lowpass', 0.01]],
  boom: [0.54, ['t', 0, 0.3, 64, 38, 0.82, 'sine'],
    ['n', 0, 0.2, 1900, 230, 0.82, 'lowpass'], ['n', 0.01, 0.12, 820, 180, 0.42]],
  balloon: [0.24, ['n', 0, 0.055, 3400, 1700, 0.82],
    ['t', 0, 0.07, 760, 330, 0.28]],
  spring: [0.2, ['t', 0, 0.15, 210, 540, 0.62], ['t', 0, 0.065, 310, 211, 0.25]],
  repair: [0.18, ['t', 0, 0.065, 430, 292, 0.55],
    ['t', 0.075, 0.065, 560, 381, 0.48]],
  won: [0.22, ['t', 0, 0.24, 196, 192, 0.42],
    ['t', 0.12, 0.24, 247, 242, 0.42], ['t', 0.24, 0.24, 294, 288, 0.42]],
  lost: [0.22, ['t', 0, 0.24, 196, 192, 0.42],
    ['t', 0.12, 0.24, 233, 228, 0.42], ['t', 0.24, 0.24, 277, 271, 0.42]]
});
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const emptyVoice = () => ({
  sources: [], nodes: [], output: null, pending: 0, level: 0, kind: '', stopped: true
});
export function makeAudio() {
  return {
    context: null, master: null, noise: null, muted: false, voices: [],
    pool: Array.from({ length: MAX_VOICES }, emptyVoice), recent: new Map()
  };
}
function createBus(a, context) {
  const master = context.createGain();
  const lowpass = context.createBiquadFilter();
  const limiter = context.createDynamicsCompressor();
  master.gain.value = a.muted ? 0 : MASTER_LEVEL;
  lowpass.type = 'lowpass'; lowpass.frequency.value = 6000; lowpass.Q.value = 0.45;
  limiter.threshold.value = -14; limiter.knee.value = 18; limiter.ratio.value = 6;
  limiter.attack.value = 0.004; limiter.release.value = 0.11;
  master.connect(lowpass).connect(limiter).connect(context.destination);
  const length = Math.ceil(context.sampleRate * 0.6);
  a.noise = context.createBuffer(1, length, context.sampleRate);
  const samples = a.noise.getChannelData(0);
  let dust = 0;
  for (let index = 0; index < length; index++) {
    dust = dust * 0.24 + (Math.random() * 2 - 1) * 0.76;
    samples[index] = dust;
  }
  a.master = master;
}
export function unlock(a) {
  if (!a || a.context) {
    if (a?.context?.state === 'suspended') return a.context.resume().catch(() => a.context.state);
    return Promise.resolve(a?.context?.state ?? 'unavailable');
  }
  try {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve('unavailable');
    a.context = new AudioContextClass();
    createBus(a, a.context);
    if (a.context.state === 'suspended') {
      return a.context.resume().then(() => a.context.state).catch(() => a.context.state);
    }
    return Promise.resolve(a.context.state);
  } catch {
    return Promise.resolve('unavailable');
  }
}
function releaseVoice(a, voice) {
  if (voice.stopped) return;
  voice.stopped = true;
  const index = a.voices.indexOf(voice);
  if (index >= 0) a.voices.splice(index, 1);
  for (const node of voice.nodes) node.disconnect();
  voice.sources.length = 0; voice.nodes.length = 0;
  voice.output = null; voice.pending = 0; voice.kind = '';
  a.pool.push(voice);
}
function stopVoice(a, voice) {
  if (voice.stopped) return;
  for (const source of voice.sources) {
    source.onended = null;
    try { source.stop(); } catch {}
    source.disconnect();
  }
  releaseVoice(a, voice);
}
function beginVoice(a, level) {
  if (!a.context || a.context.state !== 'running' || a.muted) return null;
  if (a.voices.length >= MAX_VOICES) {
    let quietest = a.voices[0];
    for (const voice of a.voices) if (voice.level < quietest.level) quietest = voice;
    // The incoming voice participates in the comparison, so a quiet new hit is the
    // one dropped rather than stealing an audible boom already in flight.
    if (level <= quietest.level) return null;
    stopVoice(a, quietest);
  }
  const voice = a.pool.pop() ?? emptyVoice();
  voice.output = a.context.createGain();
  voice.output.gain.value = level; voice.output.connect(a.master);
  voice.nodes.push(voice.output);
  voice.pending = 0; voice.level = level; voice.stopped = false;
  a.voices.push(voice);
  return voice;
}
function track(a, voice, source, ...nodes) {
  voice.sources.push(source);
  voice.nodes.push(...nodes);
  voice.pending++;
  source.onended = () => {
    source.disconnect();
    if (!voice.stopped && --voice.pending === 0) releaseVoice(a, voice);
  };
}
function tone(a, voice, delay, duration, startHz, endHz, gain, type = 'triangle') {
  const context = a.context;
  const when = context.currentTime + 0.004 + delay;
  const source = context.createOscillator();
  const filter = context.createBiquadFilter();
  const envelope = context.createGain();
  source.type = type;
  source.frequency.setValueAtTime(startHz, when);
  source.frequency.exponentialRampToValueAtTime(endHz, when + duration);
  filter.type = 'lowpass'; filter.frequency.value = clamp(startHz * 4, 420, 5200);
  filter.Q.value = 0.8;
  envelope.gain.setValueAtTime(0.0001, when);
  envelope.gain.linearRampToValueAtTime(gain, when + Math.min(0.006, duration / 3));
  envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  source.connect(filter).connect(envelope).connect(voice.output);
  track(a, voice, source, filter, envelope);
  source.start(when);
  source.stop(when + duration + 0.01);
}
function burst(a, voice, delay, duration, startHz, endHz, gain,
  type = 'bandpass', attack = 0.003) {
  const context = a.context;
  const when = context.currentTime + 0.004 + delay;
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const envelope = context.createGain();
  source.buffer = a.noise; filter.type = type;
  filter.frequency.setValueAtTime(startHz, when);
  filter.frequency.exponentialRampToValueAtTime(endHz, when + duration);
  filter.Q.value = type === 'bandpass' ? 1.25 : 0.7;
  envelope.gain.setValueAtTime(0.0001, when);
  envelope.gain.linearRampToValueAtTime(gain, when + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  source.connect(filter).connect(envelope).connect(voice.output);
  track(a, voice, source, filter, envelope);
  source.start(when, Math.random() * Math.max(0.001, 0.58 - duration), duration);
}
function playRecipe(a, recipe) {
  const voice = beginVoice(a, recipe[0]);
  if (!voice) return null;
  for (let index = 1; index < recipe.length; index++) {
    const step = recipe[index];
    if (step[0] === 't') tone(a, voice, step[1], step[2], step[3], step[4], step[5], step[6]);
    else burst(a, voice, step[1], step[2], step[3], step[4], step[5], step[6], step[7]);
  }
  return voice;
}
function hitSound(a, event) {
  const strength = clamp(Math.log1p(event.impulse ?? 0) / 5, 0.12, 1);
  const centre = HIT_CENTRES[event.mat] ?? 580;
  const voice = beginVoice(a, 0.08 + strength * 0.22);
  if (!voice) return null;
  burst(a, voice, 0, 0.075 + strength * 0.04, centre * 1.25, centre * 0.72, 0.7);
  if (event.mat === 'iron') tone(a, voice, 0.006, 0.14, 980, 840, 0.18, 'sine');
  return voice;
}
function shatterSound(a, event) {
  const glass = event.mat === 'glass';
  const voice = beginVoice(a, glass ? 0.21 : 0.14);
  if (!voice) return null;
  if (!glass) {
    burst(a, voice, 0, 0.09, event.mat === 'wood' ? 1150 : 620, 260, 0.62);
  } else {
    for (let index = 0; index < 4; index++) {
      const pitch = 2600 + Math.random() * 1700;
      burst(a, voice, index * 0.013, 0.043, pitch, pitch * 0.72, 0.46);
    }
  }
  return voice;
}
function popSound(a, event) {
  const radius = PIGS[event.pig]?.radius ?? 0.4;
  const pitch = clamp(220 - (radius - 0.3) * 230, 125, 230) * (0.96 + Math.random() * 0.08);
  const voice = beginVoice(a, event.pig === 'king' ? 0.42 : 0.3);
  if (!voice) return null;
  tone(a, voice, 0, 0.12, pitch * 1.2, pitch * 0.62, 0.72, 'sine');
  burst(a, voice, 0.006, 0.105, 780, 260, 0.58, 'bandpass', 0.008);
  return voice;
}
function abilitySound(a, event) {
  const notes = ABILITY_NOTES[event.ability] ?? DEFAULT_ABILITY_NOTES;
  const voice = beginVoice(a, 0.16);
  if (!voice) return null;
  for (let index = 0; index < notes.length; index++) {
    tone(a, voice, index * 0.045, 0.065, notes[index], notes[index] * 0.68,
      index === notes.length - 1 ? 0.5 : 0.38);
  }
  if (event.ability === 'inflate')
    burst(a, voice, 0, 0.16, 420, 900, 0.22, 'bandpass', 0.025);
  else if (event.ability === 'blink') burst(a, voice, 0.035, 0.045, 3600, 2100, 0.28);
  return voice;
}
function gelSound(a, event) {
  const voice = beginVoice(a, clamp((event.amount ?? 0) / 30, 0.06, 0.14));
  if (!voice) return null;
  burst(a, voice, 0, 0.12, 440, 170, 0.52, 'lowpass', 0.018);
  return voice;
}
export const EVENT_SOUNDS = Object.freeze({
  launch: (a) => playRecipe(a, RECIPES.launch), hit: hitSound, shatter: shatterSound,
  crumble: (a) => playRecipe(a, RECIPES.crumble),
  'stone-split': (a) => playRecipe(a, RECIPES.stone), boom: (a) => playRecipe(a, RECIPES.boom),
  pop: popSound, 'balloon-pop': (a) => playRecipe(a, RECIPES.balloon),
  'spring-launch': (a) => playRecipe(a, RECIPES.spring),
  repair: (a) => playRecipe(a, RECIPES.repair), ability: abilitySound, 'gel-absorb': gelSound,
  won: (a) => playRecipe(a, RECIPES.won), lost: (a) => playRecipe(a, RECIPES.lost),
  settled: SILENCE
});
export function pushEvents(a, events) {
  if (!a?.context || a.context.state !== 'running' || a.muted || !Array.isArray(events)) return;
  const now = a.context.currentTime;
  for (const event of events) {
    const handler = event && EVENT_SOUNDS[event.kind];
    if (handler === SILENCE || typeof handler !== 'function') continue;
    const recent = a.recent.get(event.kind);
    if (recent && now - recent.at <= COALESCE_SECONDS && !recent.voice.stopped &&
        recent.voice.kind === event.kind) {
      recent.at = now;
      recent.voice.level = Math.min(0.9, recent.voice.level * 1.14);
      recent.voice.output.gain.setTargetAtTime(recent.voice.level, now, 0.004);
      continue;
    }
    const voice = handler(a, event);
    if (voice) { voice.kind = event.kind; a.recent.set(event.kind, { at: now, voice }); }
  }
}
export function setMuted(a, muted) {
  if (!a) return;
  a.muted = Boolean(muted);
  if (!a.context || !a.master) return;
  const now = a.context.currentTime;
  a.master.gain.cancelScheduledValues(now);
  a.master.gain.setValueAtTime(a.muted ? 0 : MASTER_LEVEL, now);
  if (a.muted) while (a.voices.length) stopVoice(a, a.voices[a.voices.length - 1]);
}
