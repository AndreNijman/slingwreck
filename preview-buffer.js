// The corner preview's wire frames, both ends.
//
// previewFrame() is the sender: quantised poses of the blocks that moved since the last
// frame, newly dead blocks and pigs, score and ammo, and `k`, the sender's sim step. The
// relay forwards a frame untouched (worker.js handlePreviewMessage).
//
// PreviewBuffer is the receiver. Drawing each frame the moment it arrives (the old
// applyPreview in siege-online.js, kept here as `legacy`) moves the preview in steps at
// the network's arrival rhythm, about 7.5 Hz with every jitter spike showing. Instead the
// buffer plays frames out by the sender's own clock (`k`) at an adaptive delay, the send
// interval plus the 95th-percentile lateness over a sliding window, and interpolates each
// block between the two frames around the playout time. Frames from an older client
// carry no `k` and play out by arrival time instead, which is still smooth, just less
// even.
//
// No extrapolation past the newest frame, deliberately: a frame only lists blocks that
// moved and none is sent when nothing moved, so a missing frame usually means
// "unchanged". Carrying a block's last velocity forward would push every block that just
// landed into the ground and then snap it back. Holding the newest pose is exact for
// that case and only wrong for the rare frame later than the delay allows.

import { TUNE } from './data.js?v=20260904-2';

// Quantisation for the outgoing preview: the relay closes any socket that sends a message
// over 8192 bytes (worker.js MAX_MESSAGE), so this has a hard ceiling, not just a bandwidth
// preference. Rounding to 0.02 world units collapses float noise into a small alphabet of
// repeated values, which is what actually keeps the JSON small — the array length (bounded
// by PREVIEW_MAX_DELTA) is the real backstop.
const POSE_QUANTUM = 0.02;
const PREVIEW_MAX_DELTA = 48;
const STEP_MS = TUNE.step * 1000;
const WINDOW = 40; // frames of history for the anchor and lateness, about 5 s
const MAX_DELAY = 300; // ms behind the sender at most, past its fastest frame
const MAX_GAP = 400; // ms between frames beyond which a block snaps instead of gliding
const SNAP = 6; // world units; further than any block travels between two frames

function quantise(value) { return Math.round(value / POSE_QUANTUM) * POSE_QUANTUM; }

function poseOf(body) {
  return [quantise(body.x), quantise(body.y), quantise(body.c), quantise(body.s)];
}

function posesDiffer(a, b) {
  return !a || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3];
}

// `memory` is { lastSentPose: Map, reportedDeadBlocks: Set, reportedDeadPigs: Set },
// cleared at each round's start. Null when nothing changed since the last frame.
export function previewFrame(round, memory) {
  const d = [];
  for (const block of round.blocks) {
    if (d.length >= PREVIEW_MAX_DELTA) break;
    if (memory.reportedDeadBlocks.has(block.id)) continue;
    if (block.dead) {
      d.push([block.id, 0, 0, 0, 0, 1]);
      memory.reportedDeadBlocks.add(block.id);
      memory.lastSentPose.delete(block.id);
      continue;
    }
    const pose = poseOf(block);
    if (posesDiffer(memory.lastSentPose.get(block.id), pose)) {
      d.push([block.id, ...pose, 0]);
      memory.lastSentPose.set(block.id, pose);
    }
  }
  const p = [];
  for (const pig of round.pigs) {
    if (pig.dead && !memory.reportedDeadPigs.has(pig.id)) {
      p.push([pig.id, 1]);
      memory.reportedDeadPigs.add(pig.id);
    }
  }
  if (!d.length && !p.length) return null;
  return { d, p, s: round.score, a: round.bag.length - round.shotIndex, k: round.stepCount };
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export class PreviewBuffer {
  // `bodies` and `pigs` map wire ids to the shadow round's bodies and pigs, which this
  // reposes in place. `legacy` draws every frame on arrival, as before the buffer.
  constructor(bodies, pigs, { legacy = false } = {}) {
    this.bodies = bodies;
    this.pigs = pigs;
    this.legacy = legacy;
    this.frames = []; // waiting to play, oldest first: { t, frame }
    this.known = new Map(); // id -> pose as of the last frame played
    this.gliding = new Set(); // ids drawn between two poses on the last render
    this.offsets = []; // arrival minus send time, ms
    this.gaps = []; // send-time gaps between consecutive frames, ms
    this.lastT = -Infinity; // send time of the newest frame received
    this.playedT = -Infinity; // send time of the newest frame played
    this.score = 0;
    this.ammo = null;
    this.delay = 0;
  }

  push(frame, arrival) {
    if (!frame) return;
    const t = Number.isFinite(frame.k) ? frame.k * STEP_MS : arrival;
    if (t < this.lastT) return; // a stale frame; the socket is in order, so not expected
    if (Number.isFinite(this.lastT) && t - this.lastT <= MAX_GAP) {
      this.gaps.push(t - this.lastT);
      if (this.gaps.length > WINDOW) this.gaps.shift();
    }
    this.lastT = t;
    this.offsets.push(arrival - t);
    if (this.offsets.length > WINDOW) this.offsets.shift();
    this.frames.push({ t, frame });
    if (this.legacy) this.play(this.frames.length);
  }

  // Play the first `count` waiting frames: their poses become the known ones.
  play(count) {
    for (const { t, frame } of this.frames.splice(0, count)) {
      for (const [id, x, y, c, s, dead] of frame.d ?? []) {
        const body = this.bodies.get(id);
        if (!body) continue;
        if (dead) { body.dead = true; this.known.delete(id); continue; }
        this.known.set(id, [x, y, c, s]);
      }
      for (const [id, dead] of frame.p ?? []) {
        const pig = this.pigs.get(id);
        if (pig && dead) pig.dead = true;
      }
      if (Number.isFinite(frame.s)) this.score = frame.s;
      if (Number.isFinite(frame.a)) this.ammo = frame.a;
      this.playedT = t;
    }
  }

  // Repose the shadow round for wall time `now` (ms, the same clock as push). True when
  // anything on screen changed.
  render(now) {
    let changed = false;
    const put = (id, pose) => {
      const body = this.bodies.get(id);
      if (!body || body.dead) return;
      if (body.x === pose[0] && body.y === pose[1] && body.c === pose[2] && body.s === pose[3]) return;
      body.x = pose[0]; body.y = pose[1]; body.c = pose[2]; body.s = pose[3];
      changed = true;
    };
    if (!this.legacy && this.offsets.length) {
      const anchor = Math.min(...this.offsets);
      const late = percentile(this.offsets.map((offset) => offset - anchor), 0.95);
      const interval = this.gaps.length ? percentile(this.gaps, 0.5) : 1000 / TUNE.previewHz;
      this.delay = Math.min(MAX_DELAY, interval + late);
      const playout = now - anchor - this.delay;
      let due = 0;
      while (due < this.frames.length && this.frames[due].t <= playout) due++;
      const before = this.playedT;
      if (due) this.play(due);
      if (this.playedT !== before) changed = true;
      // Blocks glide toward the next frame's poses from the ones last played.
      // Rotation is (cos, sin): lerped, then put back on the unit circle.
      const next = this.frames[0];
      this.gliding.clear();
      if (next && Number.isFinite(this.playedT) && next.t - this.playedT <= MAX_GAP) {
        const alpha = Math.max(0, Math.min(1, (playout - this.playedT) / (next.t - this.playedT)));
        for (const [id, x, y, c, s, dead] of next.frame.d ?? []) {
          const from = this.known.get(id) ?? this.poseNow(id);
          if (dead || !from) continue;
          if (Math.abs(x - from[0]) > SNAP || Math.abs(y - from[1]) > SNAP) continue;
          const ic = from[2] + (c - from[2]) * alpha;
          const is = from[3] + (s - from[3]) * alpha;
          const length = Math.sqrt(ic * ic + is * is) || 1;
          put(id, [from[0] + (x - from[0]) * alpha, from[1] + (y - from[1]) * alpha,
            ic / length, is / length]);
          this.gliding.add(id);
        }
      }
    }
    for (const [id, pose] of this.known) {
      if (!this.gliding.has(id)) put(id, pose);
    }
    return changed;
  }

  // A block's pose before any frame moved it: the settled one it was built with.
  poseNow(id) {
    const body = this.bodies.get(id);
    if (!body) return null;
    const pose = [body.x, body.y, body.c, body.s];
    this.known.set(id, pose);
    return pose;
  }
}
