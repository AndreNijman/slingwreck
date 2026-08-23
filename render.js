import { AMMO_BY_ID, TUNE } from './data.js';
export const PALETTE = Object.freeze({
  ink: '#2B211C', skyTop: '#E8D5B0', skyLow: '#F2C79A',
  hillFar: '#A8B89A', hillNear: '#8FA383',
  groundTop: '#9C8763', groundDeep: '#6B5A42',
  glass: '#A8CFD4', glassDark: '#6E9BA3',
  wood: '#C2874A', woodDark: '#8A5A2B',
  stone: '#9A9691', stoneDark: '#78746F',
  iron: '#89827A', ironDark: '#625C56',
  tnt: '#C4453A', tntDark: '#8E2F27', cream: '#EDD9B6',
  spring: '#D4A32C', springDark: '#9E7818',
  gel: '#7FB89E', gelDark: '#588273',
  sand: '#C9B183', sandDark: '#9A8560',
  // Pigs were dusty rose and critters are warm red: a naive playtester could not tell the
  // ammo from the target, and said so on the title screen before play even started. Now
  // cool and desaturated against the critter's warm saturated red — still deliberately not
  // the genre-standard green.
  pig: '#9E90A8', pigDark: '#7C6F88',
  king: '#5F5470', crown: '#D9A441',
  critter: '#D9563F', belly: '#F3E2C7'
});
const VIEW_W = TUNE.viewMaxX - TUNE.viewMinX;
const DEFAULT_VIEW_H = 13.5;
const DEFAULT_X = TUNE.plotW / 2;
const GROUND_LINE = 0.78;
const DEFAULT_Y = DEFAULT_VIEW_H * (GROUND_LINE - 0.5);
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const GRADIENT_W = 12;
const GRADIENT_H = 96;
const TAU = Math.PI * 2;
const STYLES = Object.freeze({
  glass: { fill: PALETTE.glass, tone: PALETTE.glassDark, alpha: 0.62 },
  wood: { fill: PALETTE.wood, tone: PALETTE.woodDark, alpha: 1 },
  stone: { fill: PALETTE.stone, tone: PALETTE.stoneDark, alpha: 1 },
  iron: { fill: PALETTE.iron, tone: PALETTE.ironDark, alpha: 1 },
  tnt: { fill: PALETTE.tnt, tone: PALETTE.tntDark, alpha: 1 },
  spring: { fill: PALETTE.spring, tone: PALETTE.springDark, alpha: 1 },
  gel: { fill: PALETTE.gel, tone: PALETTE.gelDark, alpha: 0.72 },
  sand: { fill: PALETTE.sand, tone: PALETTE.sandDark, alpha: 1 },
  pig: { fill: PALETTE.pig, tone: PALETTE.pigDark, alpha: 1 },
  king: { fill: PALETTE.king, tone: PALETTE.pigDark, alpha: 1 },
  critter: { fill: PALETTE.critter, tone: PALETTE.tntDark, alpha: 1 }
});
const EFFECT_LIFE = Object.freeze({ shatter: 0.82, pop: 0.58, boom: 0.42, hit: 0.20 });
function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}
function shade(hex, amount) {
  const source = rgb(hex);
  const target = amount > 0 ? 255 : 0;
  const mix = Math.abs(amount);
  return `rgb(${Math.round(source[0] + (target - source[0]) * mix)}, ` +
    `${Math.round(source[1] + (target - source[1]) * mix)}, ` +
    `${Math.round(source[2] + (target - source[2]) * mix)})`;
}
function hashWord(a, b) {
  let value = (a >>> 0) ^ Math.imul((b + 1) >>> 0, 0x9e3779b1);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}
function stable01(a, b) {
  return hashWord(a, b) / 4294967295;
}
function stableSigned(a, b) {
  return stable01(a, b) * 2 - 1;
}
function nowMs(r) {
  return r.now();
}
function setBaseTransform(r) {
  r.ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
}
function layoutCamera(camera, width, height) {
  camera.viewportW = width; camera.viewportH = height;
  camera.viewportX = 0; camera.viewportY = 0;
  const baseScale = height / camera.viewH;
  // Keep a real zoom-out range while preventing the camera from exposing more than
  // the authored playfield unless an unusually narrow viewport needs it.
  camera.minZoom = Math.max(MIN_ZOOM, width / (baseScale * VIEW_W));
  camera.zoom = clamp(camera.zoom ?? 1, camera.minZoom, MAX_ZOOM);
  camera.scale = baseScale * camera.zoom;
  camera.canvasW = width; camera.canvasH = height;
  clampCamera(camera);
  return camera;
}
export function makeCamera() {
  return {
    x: DEFAULT_X, y: DEFAULT_Y, viewH: DEFAULT_VIEW_H, zoom: 1, scale: 1,
    viewportX: 0, viewportY: 0, minZoom: MIN_ZOOM,
    viewportW: 24, viewportH: DEFAULT_VIEW_H,
    canvasW: 24, canvasH: DEFAULT_VIEW_H
  };
}
function clampCamera(camera) {
  const halfW = camera.viewportW / camera.scale / 2;
  const viewH = camera.viewportH / camera.scale;
  const lowX = TUNE.viewMinX + halfW; const highX = TUNE.viewMaxX - halfW;
  camera.x = lowX <= highX ? clamp(camera.x, lowX, highX) :
    (TUNE.viewMinX + TUNE.viewMaxX) / 2;
  // The lowest pan keeps earth shallow; following upward may move the ground out.
  camera.y = Math.max(camera.y, viewH * (GROUND_LINE - 0.5));
  return camera;
}
export function frameRect(camera, x0, y0, x1, y1, pad = 0) {
  const padding = Math.max(0, Number.isFinite(pad) ? pad : 0);
  const width = Math.max(1e-6, Math.abs(x1 - x0) + padding * 2);
  const height = Math.max(1e-6, Math.abs(y1 - y0) + padding * 2);
  const baseScale = camera.canvasH / camera.viewH;
  const fit = Math.min(camera.viewportW / width, camera.viewportH / height);
  camera.x = (x0 + x1) / 2; camera.y = (y0 + y1) / 2;
  camera.zoom = clamp(fit / baseScale, camera.minZoom ?? MIN_ZOOM, MAX_ZOOM);
  return layoutCamera(camera, camera.canvasW, camera.canvasH);
}
export function panTo(camera, x, y, t) {
  const blend = 1 - Math.exp(-8 * Math.max(0, Number.isFinite(t) ? t : 0));
  camera.x += (x - camera.x) * blend;
  camera.y += (y - camera.y) * blend;
  return clampCamera(camera);
}
export function worldToScreen(camera, x, y) {
  return {
    x: camera.viewportX + camera.viewportW / 2 + (x - camera.x) * camera.scale,
    y: camera.viewportY + camera.viewportH / 2 - (y - camera.y) * camera.scale
  };
}
export function screenToWorld(camera, sx, sy) {
  return {
    x: camera.x + (sx - camera.viewportX - camera.viewportW / 2) / camera.scale,
    y: camera.y - (sy - camera.viewportY - camera.viewportH / 2) / camera.scale
  };
}
export function makeRenderer(canvas) {
  if (!canvas?.getContext) throw new TypeError('makeRenderer requires a canvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  const view = canvas.ownerDocument?.defaultView ?? globalThis;
  const Path = view.Path2D ?? globalThis.Path2D;
  if (!Path) throw new Error('Path2D is unavailable');
  const r = {
    canvas,
    ctx,
    view,
    Path,
    dpr: 1,
    width: canvas.width || 1,
    height: canvas.height || 1,
    camera: null,
    world: null,
    poses: new Map(),
    effects: [],
    trail: [],
    flightId: null,
    releaseAt: -Infinity,
    patterns: new Map(),
    scenerySeed: null,
    scenery: null,
    now: () => view.performance?.now?.() ?? Date.now(),
    resizeObserver: null,
    onWindowResize: null,
    destroy: null
  };
  resize(r);
  if (typeof view.ResizeObserver === 'function') {
    r.resizeObserver = new view.ResizeObserver(() => resize(r));
    r.resizeObserver.observe(canvas);
  }
  if (typeof view.addEventListener === 'function') {
    r.onWindowResize = () => resize(r);
    view.addEventListener('resize', r.onWindowResize, { passive: true });
  }
  r.destroy = () => {
    r.resizeObserver?.disconnect();
    if (r.onWindowResize) view.removeEventListener('resize', r.onWindowResize);
  };
  return r;
}
export function resize(r) {
  // These are intentionally the only layout reads. Reading client dimensions from
  // draw made every animation frame eligible for a forced style/layout flush.
  const clientWidth = r.canvas.clientWidth;
  const clientHeight = r.canvas.clientHeight;
  const width = Math.max(1, clientWidth || r.width || 1);
  const height = Math.max(1, clientHeight || r.height || 1);
  const dpr = Math.max(1, r.view.devicePixelRatio || 1);
  const pixelW = Math.max(1, Math.round(width * dpr));
  const pixelH = Math.max(1, Math.round(height * dpr));
  if (r.canvas.width !== pixelW) r.canvas.width = pixelW;
  if (r.canvas.height !== pixelH) r.canvas.height = pixelH;
  r.width = width;
  r.height = height;
  r.dpr = dpr;
  setBaseTransform(r);
  r.ctx.lineJoin = 'round';
  r.ctx.lineCap = 'round';
  r.ctx.imageSmoothingEnabled = true;
  if (r.camera) layoutCamera(r.camera, width, height);
  return r;
}
function makeGradientPattern(r, styleKey) {
  if (r.patterns.has(styleKey)) return r.patterns.get(styleKey);
  const style = STYLES[styleKey];
  const document = r.canvas.ownerDocument;
  if (!style || !document?.createElement || !r.ctx.createPattern) return null;
  const source = document.createElement('canvas');
  source.width = GRADIENT_W;
  source.height = GRADIENT_H;
  const sourceCtx = source.getContext('2d');
  const gradient = sourceCtx.createLinearGradient(0, 0, 0, GRADIENT_H);
  gradient.addColorStop(0, shade(style.fill, 0.08));
  gradient.addColorStop(0.52, style.fill);
  gradient.addColorStop(1, shade(style.fill, -0.10));
  sourceCtx.fillStyle = gradient;
  sourceCtx.fillRect(0, 0, GRADIENT_W, GRADIENT_H);
  const pattern = r.ctx.createPattern(source, 'no-repeat');
  r.patterns.set(styleKey, pattern);
  return pattern;
}
function effectColour(material, dark = false) {
  const style = STYLES[material] ?? STYLES.wood;
  return dark ? style.tone : style.fill;
}
export function pushEvents(r, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const born = nowMs(r);
  for (const event of events) {
    if (!event || !EFFECT_LIFE[event.kind]) continue;
    if (event.kind === 'shatter') {
      const shards = [];
      for (let index = 0; index < 12; index++) {
        const angle = Math.random() * TAU;
        const speed = 1.8 + Math.random() * 4.2;
        shards.push({
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed + 2.2,
          size: 0.07 + Math.random() * 0.13,
          rotation: Math.random() * TAU,
          spin: (Math.random() * 2 - 1) * 9,
          dark: index % 3 === 0
        });
      }
      r.effects.push({
        kind: 'shatter', born, life: EFFECT_LIFE.shatter,
        x: event.x, y: event.y, material: event.mat, shards
      });
    } else if (event.kind === 'pop') {
      const rings = [];
      for (let index = 0; index < 5; index++) {
        rings.push({
          dx: (Math.random() * 2 - 1) * 0.32,
          dy: (Math.random() * 2 - 1) * 0.22,
          delay: index * 0.045,
          scale: 0.7 + Math.random() * 0.45
        });
      }
      r.effects.push({
        kind: 'pop', born, life: EFFECT_LIFE.pop,
        x: event.x, y: event.y, rings
      });
    } else if (event.kind === 'boom') {
      r.effects.push({
        kind: 'boom', born, life: EFFECT_LIFE.boom,
        x: event.x, y: event.y, radius: event.r ?? 2.5,
        phase: Math.random() * TAU
      });
    } else if (event.kind === 'hit') {
      r.effects.push({
        kind: 'hit', born, life: EFFECT_LIFE.hit,
        x: event.x, y: event.y,
        size: clamp(0.10 + (event.impulse ?? 0) * 0.018, 0.12, 0.52),
        rotation: Math.random() * TAU
      });
    }
  }
}
function makeHill(seed, band) {
  const points = [];
  const spacing = band === 0 ? 5.8 : 4.6;
  const base = band === 0 ? 6.6 : 3.7;
  const amplitude = band === 0 ? 2.7 : 2.0;
  let index = 0;
  for (let x = TUNE.viewMinX - 70; x <= TUNE.viewMaxX + 70; x += spacing) {
    const broad = stableSigned(seed ^ (band * 0x51f15e), index) * amplitude;
    const small = stableSigned(seed ^ 0xa53c9e1d, index + band * 91) * 0.45;
    points.push({ x, y: base + broad + small });
    index++;
  }
  return points;
}
function sceneryFor(r, seed) {
  const cleanSeed = seed >>> 0;
  if (r.scenerySeed !== cleanSeed) {
    r.scenerySeed = cleanSeed;
    r.scenery = {
      far: makeHill(cleanSeed ^ 0x31e729ad, 0),
      near: makeHill(cleanSeed ^ 0x7f4a7c15, 1)
    };
  }
  return r.scenery;
}
function drawHill(ctx, camera, points, factor, colour) {
  const cameraDx = camera.x - DEFAULT_X;
  const first = points[0];
  const firstPoint = worldToScreen(camera,
    first.x + cameraDx * (1 - factor), first.y);
  ctx.beginPath();
  ctx.moveTo(firstPoint.x, camera.viewportY + camera.viewportH + 2);
  ctx.lineTo(firstPoint.x, firstPoint.y);
  let previous = firstPoint;
  for (let index = 1; index < points.length; index++) {
    const source = points[index];
    const point = worldToScreen(camera,
      source.x + cameraDx * (1 - factor), source.y);
    const midX = (previous.x + point.x) / 2;
    const midY = (previous.y + point.y) / 2;
    ctx.quadraticCurveTo(previous.x, previous.y, midX, midY);
    previous = point;
  }
  ctx.lineTo(previous.x, camera.viewportY + camera.viewportH + 2);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}
function drawGroundDetails(ctx, camera) {
  const left = Math.max(TUNE.viewMinX, screenToWorld(camera, camera.viewportX, 0).x - 1);
  const right = Math.min(TUNE.viewMaxX, screenToWorld(camera,
    camera.viewportX + camera.viewportW, 0).x + 1);
  ctx.lineWidth = Math.max(1, camera.scale * 0.035);
  for (let slot = Math.floor(left); slot <= Math.ceil(right); slot++) {
    const x = slot + stableSigned(0x736c696e, slot) * 0.31;
    const kind = stable01(0x67726f75, slot); const base = worldToScreen(camera, x, 0);
    if (kind < 0.25) {
      const height = camera.scale * (0.13 + stable01(0x74756674, slot) * 0.18);
      ctx.strokeStyle = PALETTE.groundDeep; ctx.beginPath(); ctx.moveTo(base.x, base.y + 1);
      ctx.lineTo(base.x - height * 0.25, base.y - height);
      ctx.moveTo(base.x, base.y + 1); ctx.lineTo(base.x + height * 0.30, base.y - height * 0.72); ctx.stroke();
    } else if (kind < 0.50) {
      const size = camera.scale * (0.055 + stable01(0x73746f6e, slot) * 0.055);
      ctx.fillStyle = PALETTE.stoneDark; ctx.strokeStyle = PALETTE.ink; ctx.beginPath();
      ctx.ellipse(base.x, base.y + size * 0.35, size * 1.35, size, 0, Math.PI, TAU);
      ctx.fill(); ctx.stroke();
    } else {
      ctx.strokeStyle = PALETTE.groundDeep; ctx.beginPath();
      ctx.moveTo(base.x - camera.scale * 0.10, base.y + camera.scale * 0.28);
      ctx.lineTo(base.x + camera.scale * 0.11, base.y + camera.scale * 0.25); ctx.stroke();
    }
  }
}
function drawBackground(r, round, camera) {
  const ctx = r.ctx;
  const top = camera.viewportY;
  const bottom = top + camera.viewportH;
  const sky = ctx.createLinearGradient(0, top, 0, bottom);
  sky.addColorStop(0, PALETTE.skyTop);
  sky.addColorStop(1, PALETTE.skyLow);
  ctx.fillStyle = sky;
  ctx.fillRect(camera.viewportX, top, camera.viewportW, camera.viewportH);
  const scenery = sceneryFor(r, round?.seed ?? 0);
  drawHill(ctx, camera, scenery.far, 0.25, PALETTE.hillFar);
  drawHill(ctx, camera, scenery.near, 0.45, PALETTE.hillNear);
  const ground = worldToScreen(camera, 0, 0).y;
  const earth = ctx.createLinearGradient(0, ground, 0, bottom);
  earth.addColorStop(0, PALETTE.groundTop);
  earth.addColorStop(1, PALETTE.groundDeep);
  ctx.fillStyle = earth;
  ctx.fillRect(camera.viewportX, ground, camera.viewportW, bottom - ground + 2);
  const lip = Math.max(3, camera.scale * 0.18);
  ctx.fillStyle = PALETTE.groundDeep;
  ctx.fillRect(camera.viewportX, ground, camera.viewportW, lip);
  drawGroundDetails(ctx, camera);
}
function drawEditorGrid(ctx, camera, showGrid) {
  ctx.save();
  if (showGrid) {
    const path = new Path2D();
    for (let x = 0; x <= TUNE.plotW; x += TUNE.gridSnap) {
      const bottom = worldToScreen(camera, x, 0);
      const top = worldToScreen(camera, x, TUNE.plotH);
      path.moveTo(bottom.x, bottom.y);
      path.lineTo(top.x, top.y);
    }
    for (let y = 0; y <= TUNE.plotH; y += TUNE.gridSnap) {
      const left = worldToScreen(camera, 0, y);
      const right = worldToScreen(camera, TUNE.plotW, y);
      path.moveTo(left.x, left.y);
      path.lineTo(right.x, right.y);
    }
    ctx.globalAlpha = 0.11;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = Math.max(0.6, camera.scale * 0.018);
    ctx.stroke(path);
  }
  ctx.globalAlpha = 0.52;
  ctx.strokeRect(
    worldToScreen(camera, 0, TUNE.plotH).x,
    worldToScreen(camera, 0, TUNE.plotH).y,
    TUNE.plotW * camera.scale,
    TUNE.plotH * camera.scale
  );
  ctx.restore();
}
function styleKey(body) {
  if (body.role === 'pig') return body.pig?.traits?.king ? 'king' : 'pig';
  if (body.role === 'ammo') return 'critter';
  const material = body.materialId ?? body.mat?.id;
  return STYLES[material] ? material : 'wood';
}
function bodyBounds(body) {
  if (body.kind === 'circle') {
    return { minX: -body.r, maxX: body.r, minY: -body.r, maxY: body.r };
  }
  if (body.kind === 'tri') {
    return {
      minX: -body.shape.w / 3, maxX: body.shape.w * 2 / 3,
      minY: -body.shape.h / 3, maxY: body.shape.h * 2 / 3
    };
  }
  return { minX: -body.hw, maxX: body.hw, minY: -body.hh, maxY: body.hh };
}
function interpolatedPose(r, body, alpha) {
  const pose = r.poses.get(body.id);
  if (!pose) return body;
  const x = pose.x + (body.x - pose.x) * alpha;
  const y = pose.y + (body.y - pose.y) * alpha;
  let c = pose.c + (body.c - pose.c) * alpha;
  let s = pose.s + (body.s - pose.s) * alpha;
  const length = Math.sqrt(c * c + s * s);
  if (length > 1e-8) {
    c /= length;
    s /= length;
  } else {
    c = body.c;
    s = body.s;
  }
  return { x, y, c, s };
}

export function capturePose(r, round) {
  if (!r?.poses) throw new TypeError('capturePose requires a renderer');
  if (r.world !== round?.world) {
    r.world = round?.world ?? null;
    r.poses.clear();
    r.trail = [];
    r.flightId = null;
  }
  for (const body of round?.world?.bodies ?? []) {
    let pose = r.poses.get(body.id);
    if (!pose) {
      pose = { x: body.x, y: body.y, c: body.c, s: body.s };
      r.poses.set(body.id, pose);
    } else {
      pose.x = body.x;
      pose.y = body.y;
      pose.c = body.c;
      pose.s = body.s;
    }
  }
}
function pointOnItem(item, lx, ly) {
  return {
    x: item.sx + (item.c * lx - item.s * ly) * item.scale,
    y: item.sy - (item.s * lx + item.c * ly) * item.scale
  };
}
function appendEllipse(path, item, lx, ly, rx, ry, count = 14) {
  for (let index = 0; index < count; index++) {
    const angle = index / count * TAU;
    const point = pointOnItem(item,
      lx + Math.cos(angle) * rx, ly + Math.sin(angle) * ry);
    if (index === 0) path.moveTo(point.x, point.y);
    else path.lineTo(point.x, point.y);
  }
  path.closePath();
}
function appendLocalPolygon(path, item, points) {
  for (let index = 0; index < points.length; index++) {
    const point = pointOnItem(item, points[index][0], points[index][1]);
    if (index === 0) path.moveTo(point.x, point.y);
    else path.lineTo(point.x, point.y);
  }
  path.closePath();
}
function polygonCorners(body, wobble) {
  const result = [];
  const width = body.shape.w;
  const height = body.shape.h;
  for (let index = 0; index < body.verts.length; index += 2) {
    const corner = index / 2;
    result.push([
      body.verts[index] + (wobble ? stableSigned(body.id, corner * 2) * width * 0.015 : 0),
      body.verts[index + 1] +
        (wobble ? stableSigned(body.id, corner * 2 + 1) * height * 0.015 : 0)
    ]);
  }
  return result;
}
function appendRoundedPolygon(path, item, corners, radius) {
  const entries = [];
  const exits = [];
  for (let index = 0; index < corners.length; index++) {
    const previous = corners[(index + corners.length - 1) % corners.length];
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    const prevLength = Math.sqrt(
      (previous[0] - current[0]) ** 2 + (previous[1] - current[1]) ** 2);
    const nextLength = Math.sqrt(
      (next[0] - current[0]) ** 2 + (next[1] - current[1]) ** 2);
    const prevScale = Math.min(0.45, radius / prevLength);
    const nextScale = Math.min(0.45, radius / nextLength);
    entries.push([
      current[0] + (previous[0] - current[0]) * prevScale,
      current[1] + (previous[1] - current[1]) * prevScale
    ]);
    exits.push([
      current[0] + (next[0] - current[0]) * nextScale,
      current[1] + (next[1] - current[1]) * nextScale
    ]);
  }
  let point = pointOnItem(item, entries[0][0], entries[0][1]);
  path.moveTo(point.x, point.y);
  for (let index = 0; index < corners.length; index++) {
    const corner = pointOnItem(item, corners[index][0], corners[index][1]);
    const exit = pointOnItem(item, exits[index][0], exits[index][1]);
    path.quadraticCurveTo(corner.x, corner.y, exit.x, exit.y);
    const next = entries[(index + 1) % corners.length];
    point = pointOnItem(item, next[0], next[1]);
    path.lineTo(point.x, point.y);
  }
  path.closePath();
}
function bodyPath(Path, body, item, wobble = true) {
  const path = new Path();
  if (body.kind === 'circle') {
    const count = 18;
    for (let index = 0; index < count; index++) {
      const angle = index / count * TAU;
      const radius = body.r *
        (1 + (wobble ? stableSigned(body.id, 200 + index) * 0.015 : 0));
      const point = pointOnItem(item, Math.cos(angle) * radius, Math.sin(angle) * radius);
      if (index === 0) path.moveTo(point.x, point.y);
      else path.lineTo(point.x, point.y);
    }
    path.closePath();
    return path;
  }
  const corners = polygonCorners(body, wobble);
  if ((body.materialId ?? body.mat?.id) === 'gel' && body.kind === 'box') {
    appendRoundedPolygon(path, item, corners,
      Math.min(body.shape.w, body.shape.h) * 0.18);
  } else {
    appendLocalPolygon(path, item, corners);
  }
  return path;
}
function itemFromPose(Path, body, camera, pose, wobble) {
  const centre = worldToScreen(camera, pose.x, pose.y);
  const bounds = bodyBounds(body);
  const item = {
    body,
    style: styleKey(body),
    x: pose.x,
    y: pose.y,
    c: pose.c,
    s: pose.s,
    sx: centre.x,
    sy: centre.y,
    scale: camera.scale,
    bounds,
    // A critter in flight carries its own colour and silhouette cue, same as the one in
    // the pouch. Without this the shot that leaves the sling is a different creature from
    // the one the player just aimed.
    look: body.role === 'ammo' ? AMMO_BY_ID[body.ammoId]?.look ?? null : null,
    path: null
  };
  item.path = bodyPath(Path, body, item, wobble);
  return item;
}
function makeItem(r, body, camera, alpha) {
  return itemFromPose(r.Path, body, camera,
    interpolatedPose(r, body, alpha), true);
}
function makeStaticItem(Path, body, camera) {
  return itemFromPose(Path, body, camera, body, false);
}
function setPatternFrame(pattern, item) {
  const bounds = item.bounds;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const padX = width * 0.025;
  const padY = height * 0.025;
  const localX = bounds.minX - padX;
  const localY = bounds.maxY + padY;
  const xScale = (width + padX * 2) * item.scale / GRADIENT_W;
  const yScale = (height + padY * 2) * item.scale / GRADIENT_H;
  const origin = pointOnItem(item, localX, localY);
  pattern.setTransform({
    a: item.c * xScale,
    b: -item.s * xScale,
    c: item.s * yScale,
    d: item.c * yScale,
    e: origin.x,
    f: origin.y
  });
}
function bodyGradient(ctx, item, fill) {
  const top = pointOnItem(item, 0, item.bounds.maxY);
  const bottom = pointOnItem(item, 0, item.bounds.minY);
  const gradient = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y);
  gradient.addColorStop(0, shade(fill, 0.08));
  gradient.addColorStop(0.52, fill);
  gradient.addColorStop(1, shade(fill, -0.10));
  return gradient;
}
function drawBodyFills(r, groups) {
  const ctx = r.ctx;
  for (const [key, items] of groups) {
    const style = STYLES[key];
    // A critter carries its own colour. Every ammo type used to share one fill, which is
    // why nine distinct abilities were invisible. Per-item looks bypass the shared
    // gradient pattern because the pattern is cached per material key, not per body.
    if (key === 'critter' && items.some((item) => item.look)) {
      ctx.globalAlpha = 1;
      for (const item of items) {
        ctx.fillStyle = bodyGradient(ctx, item, item.look?.fill ?? style.fill);
        ctx.fill(item.path);
      }
      continue;
    }
    const pattern = makeGradientPattern(r, key);
    ctx.globalAlpha = style.alpha;
    if (pattern?.setTransform) {
      ctx.fillStyle = pattern;
      for (const item of items) {
        setPatternFrame(pattern, item);
        ctx.fill(item.path);
      }
    } else {
      // CanvasPattern.setTransform is absent only on older engines. A per-body
      // gradient is the quality-preserving fallback; a screen-space gradient made
      // rotated blocks flash from light to dark as they turn.
      for (const item of items) {
        ctx.fillStyle = bodyGradient(ctx, item, style.fill);
        ctx.fill(item.path);
      }
    }
  }
  ctx.globalAlpha = 1;
}
function appendLine(path, item, points) {
  for (let index = 0; index < points.length; index++) {
    const point = pointOnItem(item, points[index][0], points[index][1]);
    if (index === 0) path.moveTo(point.x, point.y);
    else path.lineTo(point.x, point.y);
  }
}
function appendBand(path, item, horizontal, along, width) {
  const b = item.bounds;
  if (horizontal) {
    appendLocalPolygon(path, item, [
      [b.minX + (b.maxX - b.minX) * 0.08, along - width],
      [b.maxX - (b.maxX - b.minX) * 0.08, along - width],
      [b.maxX - (b.maxX - b.minX) * 0.08, along + width],
      [b.minX + (b.maxX - b.minX) * 0.08, along + width]
    ]);
  } else {
    appendLocalPolygon(path, item, [
      [along - width, b.minY + (b.maxY - b.minY) * 0.08],
      [along + width, b.minY + (b.maxY - b.minY) * 0.08],
      [along + width, b.maxY - (b.maxY - b.minY) * 0.08],
      [along - width, b.maxY - (b.maxY - b.minY) * 0.08]
    ]);
  }
}
function stonePoint(item, index) {
  const b = item.bounds;
  if (item.body.kind === 'tri') {
    let u = stable01(item.body.id, 410 + index * 2);
    let v = stable01(item.body.id, 411 + index * 2);
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const verts = item.body.verts;
    return {
      x: verts[0] + (verts[2] - verts[0]) * u + (verts[4] - verts[0]) * v,
      y: verts[1] + (verts[3] - verts[1]) * u + (verts[5] - verts[1]) * v
    };
  }
  return {
    x: b.minX + (b.maxX - b.minX) * (0.18 + stable01(item.body.id, 410 + index * 2) * 0.64),
    y: b.minY + (b.maxY - b.minY) *
      (0.18 + stable01(item.body.id, 411 + index * 2) * 0.64)
  };
}
function appendSandSeams(path, item) {
  const b = item.bounds;
  const insetX = (b.maxX - b.minX) * 0.08;
  const insetY = (b.maxY - b.minY) * 0.10;
  const edges = [
    [[b.minX + insetX, b.minY + insetY], [b.maxX - insetX, b.minY + insetY]],
    [[b.maxX - insetX, b.minY + insetY], [b.maxX - insetX, b.maxY - insetY]],
    [[b.maxX - insetX, b.maxY - insetY], [b.minX + insetX, b.maxY - insetY]],
    [[b.minX + insetX, b.maxY - insetY], [b.minX + insetX, b.minY + insetY]]
  ];
  for (const edge of edges) {
    for (let dash = 0; dash < 6; dash += 2) {
      const t0 = dash / 6;
      const t1 = (dash + 0.8) / 6;
      appendLine(path, item, [[
        edge[0][0] + (edge[1][0] - edge[0][0]) * t0,
        edge[0][1] + (edge[1][1] - edge[0][1]) * t0
      ], [
        edge[0][0] + (edge[1][0] - edge[0][0]) * t1,
        edge[0][1] + (edge[1][1] - edge[0][1]) * t1
      ]]);
    }
  }
}
function drawMotifs(r, groups, outline) {
  const ctx = r.ctx;
  for (const [key, items] of groups) {
    if (key === 'pig' || key === 'king' || key === 'critter' || key === 'gel') continue;
    const dark = new r.Path();
    const light = new r.Path();
    const cream = new r.Path();
    for (const item of items) {
      const b = item.bounds;
      const width = b.maxX - b.minX;
      const height = b.maxY - b.minY;
      const horizontal = width >= height;
      if (key === 'glass') {
        appendLine(light, item, [
          [b.minX + width * 0.22, b.minY + height * 0.23],
          [b.maxX - width * 0.22, b.maxY - height * 0.23]
        ]);
      } else if (key === 'wood') {
        const lines = Math.min(width, height) < 0.7 ? 2 : 3;
        for (let line = 0; line < lines; line++) {
          const lane = (line + 1) / (lines + 1);
          if (horizontal) {
            const y = b.minY + height * lane;
            appendLine(dark, item, [
              [b.minX + width * 0.13, y],
              [b.minX + width * 0.47, y + stableSigned(item.body.id, 300 + line) * height * 0.06],
              [b.maxX - width * 0.13, y]
            ]);
          } else {
            const x = b.minX + width * lane;
            appendLine(dark, item, [
              [x, b.minY + height * 0.13],
              [x + stableSigned(item.body.id, 300 + line) * width * 0.06,
                b.minY + height * 0.48],
              [x, b.maxY - height * 0.13]
            ]);
          }
        }
      } else if (key === 'stone') {
        for (let dot = 0; dot < 5; dot++) {
          const point = stonePoint(item, dot);
          const radius = Math.min(width, height) * (0.025 + stable01(item.body.id, 460 + dot) * 0.018);
          appendEllipse(dark, item, point.x, point.y, radius, radius, 7);
        }
      } else if (key === 'iron') {
        appendBand(light, item, horizontal,
          horizontal ? b.minY + height * 0.30 : b.minX + width * 0.30,
          Math.min(width, height) * 0.075);
      } else if (key === 'tnt') {
        const bandWidth = Math.min(width, height) * 0.075;
        const centre = horizontal ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2;
        const spread = (horizontal ? width : height) * 0.22;
        appendBand(cream, item, !horizontal, centre - spread, bandWidth);
        appendBand(cream, item, !horizontal, centre + spread, bandWidth);
      } else if (key === 'spring') {
        const points = [];
        for (let turn = 0; turn <= 10; turn++) {
          const t = turn / 10;
          if (horizontal) {
            points.push([
              b.minX + width * (0.12 + t * 0.76),
              (b.minY + b.maxY) / 2 + (turn % 2 ? 1 : -1) * height * 0.23
            ]);
          } else {
            points.push([
              (b.minX + b.maxX) / 2 + (turn % 2 ? 1 : -1) * width * 0.23,
              b.minY + height * (0.12 + t * 0.76)
            ]);
          }
        }
        appendLine(dark, item, points);
      } else if (key === 'sand') {
        appendSandSeams(dark, item);
      }
    }
    ctx.lineWidth = Math.max(0.85, outline * 0.42);
    ctx.strokeStyle = STYLES[key].tone;
    ctx.fillStyle = STYLES[key].tone;
    if (key === 'stone') ctx.fill(dark);
    else ctx.stroke(dark);
    if (key === 'glass') {
      ctx.globalAlpha = 0.58;
      ctx.strokeStyle = PALETTE.belly;
      ctx.lineWidth = Math.max(1, outline * 0.55);
      ctx.stroke(light);
      ctx.globalAlpha = 1;
    } else if (key === 'iron') {
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = shade(PALETTE.iron, 0.34);
      ctx.fill(light);
      ctx.globalAlpha = 1;
    } else if (key === 'tnt') {
      ctx.fillStyle = PALETTE.cream;
      ctx.fill(cream);
    }
  }
}
function drawBackDetails(r, items, outline) {
  const ctx = r.ctx;
  const ears = new r.Path(); const crowns = new r.Path(); const balloons = new r.Path();
  const tethers = new r.Path(); const tufts = new r.Path(); const detailOutline = new r.Path();
  for (const item of items) {
    const body = item.body;
    if (body.role === 'pig') {
      const radius = body.r;
      appendEllipse(ears, item, -radius * 0.43, radius * 0.62, radius * 0.18, radius * 0.28, 10);
      appendEllipse(ears, item, radius * 0.43, radius * 0.62, radius * 0.18, radius * 0.28, 10);
      appendEllipse(detailOutline, item, -radius * 0.43, radius * 0.62, radius * 0.18, radius * 0.28, 10);
      appendEllipse(detailOutline, item, radius * 0.43, radius * 0.62, radius * 0.18, radius * 0.28, 10);
      if (body.pig?.traits?.king) {
        const crown = [
          [-radius * 0.54, radius * 1.10], [-radius * 0.49, radius * 1.59],
          [-radius * 0.16, radius * 1.33], [0, radius * 1.70],
          [radius * 0.18, radius * 1.33], [radius * 0.50, radius * 1.59],
          [radius * 0.55, radius * 1.10]
        ];
        appendLocalPolygon(crowns, item, crown); appendLocalPolygon(detailOutline, item, crown);
      }
      if (body.pigId === 'zep') {
        appendLine(tethers, item, [[0, radius * 0.92], [0, radius * 1.70]]);
        appendEllipse(balloons, item, 0, radius * 2.52, radius * 0.64, radius * 0.82, 18);
        appendEllipse(detailOutline, item, 0, radius * 2.52, radius * 0.64, radius * 0.82, 18);
      }
    } else if (body.role === 'ammo') {
      const radius = body.r;
      const tuft = [[-radius * 0.62, radius * 0.27], [-radius * 0.98, radius * 0.52], [-radius * 0.67, radius * 0.03]];
      appendLocalPolygon(tufts, item, tuft); appendLocalPolygon(detailOutline, item, tuft);
    }
  }
  ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = Math.max(1, outline * 0.55);
  ctx.stroke(tethers);
  ctx.fillStyle = PALETTE.tnt; ctx.fill(balloons);
  ctx.fillStyle = PALETTE.pigDark; ctx.fill(ears);
  ctx.fillStyle = PALETTE.crown; ctx.fill(crowns);
  ctx.fillStyle = PALETTE.critter; ctx.fill(tufts);
  ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = outline;
  ctx.stroke(detailOutline);
}
function drawPigVariants(r, items, outline) {
  const ctx = r.ctx;
  const metal = new r.Path(); const metalDark = new r.Path(); const cheek = new r.Path();
  const tusks = new r.Path(); const cap = new r.Path(); const capDark = new r.Path();
  const jowls = new r.Path(); const edges = new r.Path();
  for (const item of items) {
    if (item.body.role !== 'pig') continue;
    const radius = item.body.r;
    if (item.body.pigId === 'helm') {
      const dome = [[-.80, .42], [-.68, .77], [-.28, 1.01], [.28, 1.01], [.68, .77], [.80, .42]].map(([x, y]) => [x * radius, y * radius]);
      appendLocalPolygon(metal, item, dome); appendLocalPolygon(edges, item, dome);
      appendLocalPolygon(metalDark, item, [[-.84, .35], [.84, .35], [.80, .54], [-.80, .54]].map(([x, y]) => [x * radius, y * radius]));
    } else if (item.body.pigId === 'tusk') {
      appendEllipse(cheek, item, -radius * .40, -radius * .02, radius * .34, radius * .44, 12);
      appendEllipse(edges, item, -radius * .40, -radius * .02, radius * .34, radius * .44, 12);
      for (const side of [-1, 1]) {
        const tooth = [[side * .30, -.18], [side * .73, -.31], [side * .43, .02]].map(([x, y]) => [x * radius, y * radius]);
        appendLocalPolygon(tusks, item, tooth); appendLocalPolygon(edges, item, tooth);
      }
    } else if (item.body.pigId === 'sarge') {
      const crown = [[-.70, .61], [-.50, .94], [.10, 1.02], [.56, .82], [.62, .61]].map(([x, y]) => [x * radius, y * radius]);
      appendLocalPolygon(cap, item, crown); appendLocalPolygon(edges, item, crown);
      appendLocalPolygon(capDark, item, [[-.78, .57], [.82, .57], [.65, .70], [-.64, .70]].map(([x, y]) => [x * radius, y * radius]));
    } else if (item.body.pigId === 'hogg') {
      appendEllipse(jowls, item, -radius * .38, -radius * .24, radius * .35, radius * .31, 12);
      appendEllipse(jowls, item, radius * .38, -radius * .24, radius * .35, radius * .31, 12);
    }
  }
  ctx.fillStyle = PALETTE.iron; ctx.fill(metal);
  ctx.fillStyle = PALETTE.ironDark; ctx.fill(metalDark); ctx.fill(cheek);
  ctx.fillStyle = PALETTE.cream; ctx.fill(tusks);
  ctx.fillStyle = PALETTE.hillNear; ctx.fill(cap);
  ctx.fillStyle = PALETTE.groundDeep; ctx.fill(capDark);
  ctx.fillStyle = PALETTE.pigDark; ctx.fill(jowls);
  ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = Math.max(1, outline * .72); ctx.stroke(edges);
}
function drawFaces(r, items, outline) {
  const ctx = r.ctx;
  const snouts = new r.Path(); const belly = new r.Path(); const whites = new r.Path();
  const ink = new r.Path(); const highlights = new r.Path();
  const featureOutline = new r.Path(); const beaks = new r.Path();
  for (const item of items) {
    const body = item.body;
    if (body.role === 'pig') {
      const radius = body.r;
      appendEllipse(snouts, item, 0, -radius * 0.12,
        radius * 0.48, radius * 0.31, 14);
      appendEllipse(featureOutline, item, 0, -radius * 0.12,
        radius * 0.48, radius * 0.31, 14);
      for (const side of [-1, 1]) {
        appendEllipse(whites, item, side * radius * 0.23, radius * 0.25,
          radius * 0.15, radius * 0.18, 10);
        appendEllipse(featureOutline, item, side * radius * 0.23, radius * 0.25,
          radius * 0.15, radius * 0.18, 10);
        appendEllipse(ink, item, side * radius * 0.23, radius * 0.23,
          radius * 0.072, radius * 0.09, 8);
        appendEllipse(highlights, item, side * radius * 0.20, radius * 0.28,
          radius * 0.026, radius * 0.032, 7);
      }
      appendEllipse(ink, item, -radius * 0.16, -radius * 0.14,
        radius * 0.045, radius * 0.065, 8);
      appendEllipse(ink, item, radius * 0.16, -radius * 0.14,
        radius * 0.045, radius * 0.065, 8);
    } else if (body.role === 'ammo') {
      const radius = body.r;
      appendEllipse(belly, item, -radius * 0.10, -radius * 0.27,
        radius * 0.57, radius * 0.50, 14);
      appendEllipse(featureOutline, item, -radius * 0.10, -radius * 0.27,
        radius * 0.57, radius * 0.50, 14);
      appendEllipse(ink, item, radius * 0.22, radius * 0.22,
        radius * 0.105, radius * 0.12, 8);
      const beak = [
        [radius * 0.72, radius * 0.10],
        [radius * 1.10, -radius * 0.03],
        [radius * 0.70, -radius * 0.20]
      ];
      appendLocalPolygon(beaks, item, beak);
      appendLocalPolygon(featureOutline, item, beak);
    }
  }
  ctx.fillStyle = PALETTE.pigDark;
  ctx.fill(snouts);
  ctx.fillStyle = PALETTE.belly;
  ctx.fill(belly);
  ctx.fill(whites);
  ctx.fillStyle = PALETTE.crown;
  ctx.fill(beaks);
  ctx.fillStyle = PALETTE.ink;
  ctx.fill(ink);
  ctx.fillStyle = PALETTE.belly;
  ctx.fill(highlights);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = Math.max(1, outline * 0.62);
  ctx.stroke(featureOutline);
}
function drawEditorHighlights(r, items, camera, editor, outline) {
  const ids = editor?.highlightIds; const bodyIds = editor?.bodyPieceIds; if ((!ids || ids.size === 0) && !editor?.markers?.length) return;
  const highlighted = items.filter((item) => ids?.has(bodyIds?.get(item.body.id))); const path = new r.Path();
  for (const item of highlighted) path.addPath(item.path); const ctx = r.ctx; ctx.save(); ctx.globalAlpha = 0.28; ctx.fillStyle = PALETTE.tnt;
  ctx.fill(path); ctx.globalAlpha = 1;
  for (const item of highlighted) {
    ctx.strokeStyle = PALETTE.cream; ctx.lineWidth = Math.max(7, outline * 3.1); ctx.stroke(item.path);
    ctx.strokeStyle = PALETTE.tntDark; ctx.lineWidth = Math.max(3.5, outline * 1.65); ctx.setLineDash([8, 5]); ctx.stroke(item.path);
  } ctx.setLineDash([]);
  if (editor?.focusHighlights && highlighted.length) {
    const centreX = highlighted.reduce((sum, item) => sum + item.sx, 0) / highlighted.length; const leaderY = clamp(Math.min(...highlighted.map((item) => item.sy)) - 44, camera.viewportY + 20, camera.viewportY + camera.viewportH - 20);
    highlighted.forEach((item, index) => {
      const badgeX = clamp(centreX + (index - (highlighted.length - 1) / 2) * 36, camera.viewportX + 18, camera.viewportX + camera.viewportW - 18);
      ctx.strokeStyle = PALETTE.tntDark; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(item.sx, item.sy); ctx.lineTo(badgeX, leaderY); ctx.stroke();
      ctx.fillStyle = PALETTE.cream; ctx.beginPath(); ctx.arc(badgeX, leaderY, 12, 0, TAU); ctx.fill();
      ctx.strokeStyle = PALETTE.tntDark; ctx.lineWidth = 3; ctx.stroke(); ctx.fillStyle = PALETTE.tntDark;
      ctx.font = '700 11px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), badgeX, leaderY + 0.5);
    });
  }
  for (const marker of editor?.markers ?? []) {
    const point = worldToScreen(camera, marker.x, marker.y); const radius = Math.max(12, camera.scale * 0.48);
    ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(point.x - radius * 0.48, point.y - radius * 0.48);
    ctx.lineTo(point.x + radius * 0.48, point.y + radius * 0.48); ctx.moveTo(point.x + radius * 0.48, point.y - radius * 0.48);
    ctx.lineTo(point.x - radius * 0.48, point.y + radius * 0.48); ctx.stroke();
  }
  ctx.restore();
}
function drawEditorSlingMarker(ctx, camera) { const slingLeft = worldToScreen(camera, TUNE.slingX - 0.7, 2.6); const slingRight = worldToScreen(camera, TUNE.slingX + 0.7, 0);
  if (slingLeft.x >= camera.viewportX + 8 && slingRight.x <= camera.viewportX + camera.viewportW - 8) return;
  const x = camera.viewportX + 10; const ground = worldToScreen(camera, 0, 0).y; const y = clamp(ground - 54, camera.viewportY + 10, camera.viewportY + camera.viewportH - 50);
  ctx.save(); ctx.fillStyle = 'rgba(237, 217, 182, 0.94)'; ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(x, y, 92, 40, 5); ctx.fill(); ctx.stroke(); ctx.strokeStyle = PALETTE.woodDark; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(x + 15, y + 32); ctx.lineTo(x + 15, y + 20); ctx.lineTo(x + 9, y + 11);
  ctx.moveTo(x + 15, y + 20); ctx.lineTo(x + 21, y + 11); ctx.stroke();
  ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 29, y + 20); ctx.lineTo(x + 45, y + 20); ctx.stroke();
  ctx.fillStyle = PALETTE.ink; ctx.beginPath(); ctx.moveTo(x + 45, y + 20); ctx.lineTo(x + 39, y + 16); ctx.lineTo(x + 39, y + 24); ctx.closePath(); ctx.fill();
  const distance = Math.abs(TUNE.slingX).toLocaleString('en-AU', { maximumFractionDigits: 1 });
  ctx.font = '700 10px ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(`${distance} units`, x + 51, y + 20.5); ctx.restore(); }
function drawEditorGhost(r, camera, editor, outline) {
  const body = editor?.ghostBody;
  if (!body) return;
  const item = makeStaticItem(r.Path, body, camera);
  const items = [item];
  const groups = new Map([[item.style, items]]);
  const ctx = r.ctx;
  ctx.save();
  ctx.globalAlpha = 0.52;
  drawBackDetails(r, items, outline);
  ctx.globalAlpha = 0.52;
  ctx.fillStyle = STYLES[item.style].fill;
  ctx.fill(item.path);
  ctx.globalAlpha = 0.52;
  drawMotifs(r, groups, outline);
  ctx.globalAlpha = 0.58;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = outline;
  ctx.stroke(item.path);
  ctx.globalAlpha = 0.52;
  drawPigVariants(r, items, outline);
  ctx.globalAlpha = 0.52;
  drawFaces(r, items, outline);
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = editor.ghostLegal ? PALETTE.hillNear : PALETTE.tnt;
  ctx.fill(item.path);
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = editor.ghostLegal ? '#536F48' : PALETTE.tntDark;
  ctx.lineWidth = Math.max(2.5, outline * 1.25);
  ctx.setLineDash([7, 4]);
  ctx.stroke(item.path);
  ctx.restore();
}
function drawDamage(r, items, outline) {
  const ctx = r.ctx;
  const cracks = new r.Path();
  const stipple = new r.Path();
  for (const item of items) {
    const body = item.body;
    if (body.role !== 'block' || !(body.maxHp > 0)) continue;
    const damage = clamp(1 - body.hp / body.maxHp, 0, 1);
    const count = Math.floor(damage * 5);
    const b = item.bounds;
    const width = b.maxX - b.minX;
    const height = b.maxY - b.minY;
    for (let crack = 0; crack < count; crack++) {
      let dx = stableSigned(body.id, 600 + crack * 7);
      let dy = stableSigned(body.id, 601 + crack * 7);
      const length = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= length;
      dy /= length;
      const extent = Math.min(width, height) * (0.22 + stable01(body.id, 602 + crack * 7) * 0.15);
      const centreX = (b.minX + b.maxX) / 2 + stableSigned(body.id, 603 + crack * 7) * width * 0.22;
      const centreY = (b.minY + b.maxY) / 2 + stableSigned(body.id, 604 + crack * 7) * height * 0.22;
      const normalX = -dy;
      const normalY = dx;
      appendLine(cracks, item, [
        [centreX - dx * extent, centreY - dy * extent],
        [centreX - dx * extent * 0.28 + normalX * extent * stableSigned(body.id, 605 + crack * 7) * 0.25,
          centreY - dy * extent * 0.28 + normalY * extent * stableSigned(body.id, 605 + crack * 7) * 0.25],
        [centreX + dx * extent * 0.25 - normalX * extent * stableSigned(body.id, 606 + crack * 7) * 0.20,
          centreY + dy * extent * 0.25 - normalY * extent * stableSigned(body.id, 606 + crack * 7) * 0.20],
        [centreX + dx * extent, centreY + dy * extent]
      ]);
    }
    if (body.hp / body.maxHp < 0.25) {
      for (let dot = 0; dot < 11; dot++) {
        const point = stonePoint(item, 700 + dot);
        const radius = Math.min(width, height) * 0.018;
        appendEllipse(stipple, item, point.x, point.y, radius, radius, 6);
      }
    }
  }
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = Math.max(0.9, outline * 0.48);
  ctx.stroke(cracks);
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = PALETTE.ink;
  ctx.fill(stipple);
  ctx.globalAlpha = 1;
}
function effectProgress(effect, now) {
  return (now - effect.born) / 1000 / effect.life;
}
function shakeFor(r, now) {
  let strength = 0;
  let phase = 0;
  for (const effect of r.effects) {
    if (effect.kind !== 'boom') continue;
    const progress = effectProgress(effect, now);
    if (progress < 0 || progress >= 1) continue;
    const candidate = (1 - progress) * (1 - progress) * 8;
    if (candidate > strength) {
      strength = candidate;
      phase = effect.phase;
    }
  }
  return {
    x: Math.sin(now * 0.075 + phase) * strength,
    y: Math.cos(now * 0.091 + phase * 1.7) * strength * 0.65
  };
}
function appendShard(path, camera, effect, shard, age) {
  const x = effect.x + shard.vx * age;
  const y = effect.y + shard.vy * age - 8.5 * age * age;
  const centre = worldToScreen(camera, x, y);
  const size = shard.size * camera.scale;
  const angle = shard.rotation + shard.spin * age;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const points = [[-0.75, -0.42], [0.72, -0.28], [0.38, 0.68], [-0.48, 0.52]];
  for (let index = 0; index < points.length; index++) {
    const px = points[index][0] * size;
    const py = points[index][1] * size;
    const sx = centre.x + c * px - s * py;
    const sy = centre.y + s * px + c * py;
    if (index === 0) path.moveTo(sx, sy);
    else path.lineTo(sx, sy);
  }
  path.closePath();
}
function appendStar(path, camera, effect, scale) {
  const centre = worldToScreen(camera, effect.x, effect.y);
  const outer = effect.size * camera.scale * scale;
  const inner = outer * 0.42;
  for (let point = 0; point < 10; point++) {
    const angle = effect.rotation + point / 10 * TAU;
    const radius = point % 2 ? inner : outer;
    const x = centre.x + Math.cos(angle) * radius;
    const y = centre.y + Math.sin(angle) * radius;
    if (point === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
}
function drawEffects(r, camera, now, outline) {
  const ctx = r.ctx;
  const shardGroups = new Map();
  const shardOutline = new r.Path();
  const stars = new r.Path();
  for (const effect of r.effects) {
    const progress = effectProgress(effect, now);
    if (progress < 0 || progress >= 1) continue;
    const age = (now - effect.born) / 1000;
    if (effect.kind === 'shatter') {
      for (const shard of effect.shards) {
        const colour = effectColour(effect.material, shard.dark);
        if (!shardGroups.has(colour)) shardGroups.set(colour, new r.Path());
        appendShard(shardGroups.get(colour), camera, effect, shard, age);
        appendShard(shardOutline, camera, effect, shard, age);
      }
    } else if (effect.kind === 'pop') {
      for (const ring of effect.rings) {
        const local = Math.max(0, age - ring.delay);
        if (local <= 0) continue;
        const centre = worldToScreen(camera,
          effect.x + ring.dx, effect.y + ring.dy + local * 0.55);
        const radius = (0.12 + local * 0.95) * ring.scale * camera.scale;
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, radius, 0, TAU);
        ctx.globalAlpha = (1 - progress) * 0.58;
        ctx.strokeStyle = PALETTE.groundTop;
        ctx.lineWidth = Math.max(1, outline * 0.62);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (effect.kind === 'boom') {
      const centre = worldToScreen(camera, effect.x, effect.y);
      const radius = effect.radius * camera.scale * (0.10 + progress * 0.90);
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius, 0, TAU);
      ctx.globalAlpha = (1 - progress) * 0.78;
      ctx.strokeStyle = PALETTE.tnt;
      ctx.lineWidth = Math.max(2, outline * (1.7 - progress * 0.8));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius * 0.72, 0, TAU);
      ctx.strokeStyle = PALETTE.ink;
      ctx.lineWidth = Math.max(1, outline * 0.72);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (effect.kind === 'hit') {
      appendStar(stars, camera, effect, 0.72 + progress * 0.42);
    }
  }
  for (const [colour, path] of shardGroups) {
    ctx.fillStyle = colour;
    ctx.fill(path);
  }
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = Math.max(1, outline * 0.55);
  ctx.stroke(shardOutline);
  ctx.fillStyle = PALETTE.belly;
  ctx.fill(stars);
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke(stars);
  ctx.globalAlpha = 1;
}
function aimVector(aim) {
  if (!aim) return null;
  let dx = aim.dx; let dy = aim.dy;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y)) return null;
    dx = aim.x - TUNE.slingX; dy = aim.y - TUNE.slingY;
  }
  const length = Math.sqrt(dx * dx + dy * dy); const scale = length > TUNE.slingRadius ? TUNE.slingRadius / length : 1;
  return { dx: dx * scale, dy: dy * scale };
}
function taperedBand(ctx, from, to, sag, width, colour) {
  const dx = to.x - from.x; const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1; const nx = -dy / length; const ny = dx / length;
  const cx = (from.x + to.x) / 2; const cy = (from.y + to.y) / 2 + sag;
  ctx.beginPath();
  ctx.moveTo(from.x + nx * width * .55, from.y + ny * width * .55);
  ctx.quadraticCurveTo(cx + nx * width, cy + ny * width, to.x + nx * width, to.y + ny * width);
  ctx.lineTo(to.x - nx * width, to.y - ny * width);
  ctx.quadraticCurveTo(cx - nx * width, cy - ny * width,
    from.x - nx * width * .55, from.y - ny * width * .55);
  ctx.closePath(); ctx.fillStyle = colour; ctx.fill();
}
// A naive playtester complained six times in fourteen turns that it could not tell how
// far it was pulling or where the shot would go, and never once mentioned seeing this
// preview at all. The old version faded to alpha 0.10 by its last dot, drew flat ink with
// nothing to separate it from the sage hills behind it, and stopped after 0.85 seconds of
// flight — well short of the fortress. Aiming is the only verb in this game, so its one
// feedback channel has to survive any background and reach the target.
// Exported so `tools/smoke.mjs` samples the same points the renderer draws. The probe
// previously hardcoded its own step and silently stopped matching the moment this changed.
export const TRAJECTORY_STEP = .06;

function drawTrajectory(ctx, camera, vector) {
  const length = Math.sqrt(vector.dx * vector.dx + vector.dy * vector.dy);
  if (length < .08) return;
  const launchScale = TUNE.launchSpeedMax / TUNE.slingRadius;
  const vx = -vector.dx * launchScale; const vy = -vector.dy * launchScale;
  const step = TRAJECTORY_STEP;
  const core = Math.max(2.2, camera.scale * .062);
  let landing = null;

  ctx.save();
  // Walk the whole arc to the ground rather than a fixed dot count, so a hard pull shows
  // a shot that reaches the fortress and a soft one visibly falls short.
  for (let index = 1; index <= 90; index++) {
    const time = index * step;
    const x = TUNE.slingX + vx * time;
    const y = TUNE.slingY + vy * time - TUNE.gravity * time * time / 2;
    if (y <= 0) { landing = { x, y: 0 }; break; }
    if (x > TUNE.viewMaxX + 2) break;
    if (x < TUNE.viewMinX) continue;
    const point = worldToScreen(camera, x, y);
    // Cream halo under an ink core: the pair reads against both the sage hills and the
    // parchment sky, so legibility never depends on what happens to be behind it.
    ctx.globalAlpha = Math.max(.45, .92 - index * .012);
    ctx.fillStyle = PALETTE.cream;
    ctx.beginPath(); ctx.arc(point.x, point.y, core * 1.75, 0, TAU); ctx.fill();
    ctx.fillStyle = PALETTE.ink;
    ctx.beginPath(); ctx.arc(point.x, point.y, core, 0, TAU); ctx.fill();
  }

  // Where it lands, stated outright. This is the question the player is actually asking.
  if (landing) {
    const mark = worldToScreen(camera, landing.x, 0);
    const ring = Math.max(5, camera.scale * .3);
    ctx.globalAlpha = .95;
    ctx.strokeStyle = PALETTE.cream; ctx.lineWidth = Math.max(3, camera.scale * .1);
    ctx.beginPath(); ctx.ellipse(mark.x, mark.y, ring, ring * .42, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = PALETTE.critter; ctx.lineWidth = Math.max(1.5, camera.scale * .055);
    ctx.beginPath(); ctx.ellipse(mark.x, mark.y, ring, ring * .42, 0, 0, TAU); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.restore();
}

// Release needs an unmistakable acknowledgement. A playtester reported three times that it
// could not tell whether a drag had fired or been ignored — the critter left the pouch and
// the camera followed it, but no single frame said "that happened".
function drawReleasePuff(ctx, camera, r, now) {
  const age = (now - r.releaseAt) / 1000;
  if (age < 0 || age > .45) return;
  const t = age / .45;
  const at = worldToScreen(camera, TUNE.slingX, TUNE.slingY);
  const radius = camera.scale * (.28 + t * .95);
  ctx.save();
  ctx.globalAlpha = (1 - t) * .8;
  ctx.strokeStyle = PALETTE.cream;
  ctx.lineWidth = Math.max(2, camera.scale * .11 * (1 - t));
  ctx.beginPath(); ctx.arc(at.x, at.y, radius, 0, TAU); ctx.stroke();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = Math.max(1, camera.scale * .05 * (1 - t));
  ctx.beginPath(); ctx.arc(at.x, at.y, radius, 0, TAU); ctx.stroke();
  ctx.restore();
}

// How hard am I pulling — a question the screen previously did not answer at all. A band
// that fills along the fork and turns from cream through to critter red at full stretch,
// with the percentage spelled out, because "some fraction of maximum" is exactly the thing
// the playtester was guessing at.
function drawPowerGauge(ctx, camera, vector) {
  const draw = Math.min(1, Math.sqrt(vector.dx * vector.dx + vector.dy * vector.dy) / TUNE.slingRadius);
  if (draw < .04) return;
  const anchor = worldToScreen(camera, TUNE.slingX, 3.5);
  const width = Math.max(46, camera.scale * 2.1);
  const height = Math.max(9, camera.scale * .34);
  const x = anchor.x - width / 2;
  const y = anchor.y;

  ctx.save();
  ctx.fillStyle = PALETTE.cream; ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = Math.max(1.5, camera.scale * .05);
  ctx.beginPath(); ctx.roundRect(x, y, width, height, height / 2); ctx.fill(); ctx.stroke();
  // Cream to red across the draw, so full power is unmistakable at a glance.
  ctx.fillStyle = draw > .88 ? PALETTE.critter : draw > .55 ? PALETTE.spring : PALETTE.gel;
  ctx.beginPath();
  ctx.roundRect(x + ctx.lineWidth, y + ctx.lineWidth,
    Math.max(0, (width - ctx.lineWidth * 2) * draw), height - ctx.lineWidth * 2,
    (height - ctx.lineWidth * 2) / 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `600 ${Math.max(10, Math.round(height * .95))}px ui-monospace, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(draw * 100)}% power`, anchor.x, y - height * .35);
  ctx.restore();
}
function updateTrail(r, round, now) {
  const body = round?.phase === 'flying' ? round.flying : null;
  if (body && r.flightId !== body.id) { r.flightId = body.id; r.releaseAt = now; r.trail = []; }
  if (body) {
    const last = r.trail[r.trail.length - 1];
    if (!last || now - last.at > 28 || Math.abs(last.x - body.x) + Math.abs(last.y - body.y) > .12) {
      r.trail.push({ x: body.x, y: body.y, at: now, r: body.r });
      if (r.trail.length > 18) r.trail.shift();
    }
  }
  r.trail = r.trail.filter((point) => now - point.at < 520); if (round?.phase === 'aiming') { r.flightId = null; r.trail = []; }
}
function drawTrail(r, camera, now) {
  const ctx = r.ctx;
  for (const sample of r.trail) {
    const life = 1 - (now - sample.at) / 520;
    const point = worldToScreen(camera, sample.x, sample.y);
    ctx.globalAlpha = Math.max(0, life) * .34; ctx.fillStyle = PALETTE.critter;
    ctx.beginPath(); ctx.arc(point.x, point.y,
      Math.max(1.5, sample.r * camera.scale * (.22 + life * .18)), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawHeldCritter(r, camera, round, x, y, outline) {
  const ammo = AMMO_BY_ID[round.bag?.[round.shotIndex]];
  if (!ammo) return;
  // Rendered larger than its physics radius. The simulation is untouched — this is the
  // one moment the player is choosing a critter, and at true scale a Zip is 0.22 world
  // units, roughly twenty pixels, with the sling bands across it.
  const HELD_ZOOM = 1.6;
  const body = { id: -1000 - round.shotIndex, role: 'ammo', kind: 'circle',
    r: ammo.radius * HELD_ZOOM, x, y, c: 1, s: 0 };
  const item = makeStaticItem(r.Path, body, camera);
  item.look = ammo.look;
  drawCritterFeature(r, item, ammo, outline);
  drawBackDetails(r, [item], outline); drawBodyFills(r, new Map([['critter', [item]]]));
  r.ctx.strokeStyle = PALETTE.ink; r.ctx.lineWidth = outline; r.ctx.stroke(item.path);
  drawFaces(r, [item], outline);
  drawCritterFeature(r, item, ammo, outline, true);
}

// The silhouette half of a critter's identity. Colour alone fails at speed, in a
// thumbnail, and for anyone who cannot separate the hues — so each ammo also has a shape
// cue. Called twice: once behind the body for anything that should sit under it, once in
// front for anything on top.
function drawCritterFeature(r, item, ammo, outline, front = false) {
  const feature = ammo.look?.feature;
  if (!feature || feature === 'plain') return;
  const ctx = r.ctx;
  const { x, y } = item;
  const size = item.radius ?? (item.r ?? 0);
  if (!size) return;
  const tone = ammo.look.tone;
  ctx.save();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = outline;
  ctx.fillStyle = tone;
  ctx.lineJoin = 'round';

  if (!front && feature === 'trio') {
    // Three tail feathers for the three it becomes.
    for (const angle of [-0.42, 0, 0.42]) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - size * 2.1 * Math.cos(angle), y - size * 2.1 * Math.sin(angle));
      ctx.lineTo(x - size * 1.5 * Math.cos(angle), y - size * 1.5 * Math.sin(angle) + size * .5);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  } else if (!front && feature === 'hook') {
    // A long curved tail: the shape of its return.
    ctx.beginPath();
    ctx.moveTo(x - size * .4, y);
    ctx.quadraticCurveTo(x - size * 2.4, y - size * .3, x - size * 1.7, y + size * 1.5);
    ctx.lineWidth = outline * 1.6; ctx.strokeStyle = tone; ctx.stroke();
  } else if (!front && feature === 'streak') {
    // Speed streaks behind the smallest critter in the bag.
    ctx.strokeStyle = tone; ctx.lineWidth = outline * .9;
    for (const dy of [-size * .55, 0, size * .55]) {
      ctx.beginPath();
      ctx.moveTo(x - size * 1.4, y + dy); ctx.lineTo(x - size * 2.6, y + dy);
      ctx.stroke();
    }
  } else if (front && feature === 'dart') {
    // A swept dart beak: it accelerates.
    ctx.beginPath();
    ctx.moveTo(x + size * 1.9, y);
    ctx.lineTo(x + size * .3, y - size * .55);
    ctx.lineTo(x + size * .3, y + size * .55);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (front && feature === 'fuse') {
    // A lit fuse, on the darkest body in the bag.
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.quadraticCurveTo(x + size * .5, y - size * 1.9, x + size * .1, y - size * 2.3);
    ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = outline; ctx.stroke();
    ctx.fillStyle = PALETTE.spring;
    ctx.beginPath(); ctx.arc(x + size * .1, y - size * 2.4, size * .34, 0, TAU);
    ctx.fill(); ctx.stroke();
  } else if (front && feature === 'crest') {
    // A hard spiked crest.
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const bx = x - size * .55 + i * size * .55;
      ctx.moveTo(bx, y - size * .85);
      ctx.lineTo(bx + size * .28, y - size * 1.75);
      ctx.lineTo(bx + size * .55, y - size * .85);
    }
    ctx.fillStyle = tone; ctx.fill(); ctx.stroke();
  } else if (front && feature === 'egg') {
    // The payload it carries, visible underneath.
    ctx.beginPath();
    ctx.ellipse(x, y + size * 1.15, size * .5, size * .66, 0, 0, TAU);
    ctx.fillStyle = PALETTE.cream; ctx.fill(); ctx.stroke();
  } else if (front && feature === 'bulk') {
    // Puffed cheeks on visibly the biggest body.
    ctx.fillStyle = tone;
    for (const dx of [-size * .95, size * .95]) {
      ctx.beginPath(); ctx.arc(x + dx, y + size * .25, size * .48, 0, TAU);
      ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
}
export function drawSlingshot(r, camera, round, aim) {
  const ctx = r.ctx; const now = nowMs(r);
  updateTrail(r, round, now); drawTrail(r, camera, now);
  const vector = round?.phase === 'aiming' && (aim?.dragging ?? aim?.active) ? aimVector(aim) : null;
  if (vector) { drawTrajectory(ctx, camera, vector); drawPowerGauge(ctx, camera, vector); }
  const base = worldToScreen(camera, TUNE.slingX, 0); const joint = worldToScreen(camera, TUNE.slingX, 1.35);
  const left = worldToScreen(camera, TUNE.slingX - .58, 2.55); const right = worldToScreen(camera, TUNE.slingX + .58, 2.55);
  const heldWorld = vector ? { x: TUNE.slingX + vector.dx, y: TUNE.slingY + vector.dy } :
    { x: TUNE.slingX, y: TUNE.slingY - .34 };
  const pouch = worldToScreen(camera, heldWorld.x, heldWorld.y); const slackAge = (now - r.releaseAt) / 1000;
  const showBands = Boolean(vector) || round?.phase === 'aiming' || slackAge < .3;
  ctx.save();
  ctx.fillStyle = PALETTE.groundTop; ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = Math.max(1.5, camera.scale * .045);
  ctx.beginPath(); ctx.ellipse(base.x, base.y + camera.scale * .02,
    camera.scale * 1.15, camera.scale * .34, 0, Math.PI, TAU); ctx.fill(); ctx.stroke();
  if (showBands) {
    const sag = vector ? camera.scale * .02 : camera.scale * .20;
    ctx.globalAlpha = round?.phase === 'flying' ? Math.max(0, 1 - slackAge / .3) : 1;
    taperedBand(ctx, left, pouch, sag, camera.scale * .075, PALETTE.ink);
    taperedBand(ctx, left, pouch, sag, camera.scale * .045, PALETTE.woodDark);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PALETTE.ink; ctx.lineWidth = camera.scale * .48;
  ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(joint.x, joint.y);
  ctx.moveTo(joint.x, joint.y); ctx.lineTo(left.x, left.y);
  ctx.moveTo(joint.x, joint.y); ctx.lineTo(right.x, right.y); ctx.stroke();
  ctx.strokeStyle = PALETTE.wood; ctx.lineWidth = camera.scale * .32; ctx.stroke();
  ctx.strokeStyle = PALETTE.woodDark; ctx.lineWidth = Math.max(1, camera.scale * .035);
  ctx.beginPath(); ctx.moveTo(base.x - camera.scale * .08, base.y - camera.scale * .25);
  ctx.lineTo(joint.x - camera.scale * .08, joint.y + camera.scale * .10); ctx.stroke();
  // Draw the loaded critter whenever there is one to fire, not only while dragging. This
  // was gated on `vector`, so before the player touched anything the pouch sat empty — and
  // a naive playtester twice reported being unable to tell whether a critter was loaded,
  // whether its shot had fired, or whether the next one needed a click to load. An empty
  // sling between shots is the game saying "nothing here".
  const ammoLoaded = round?.phase === 'aiming' && (round.bag?.length ?? 0) > (round.shotIndex ?? 0);
  if (vector || ammoLoaded) {
    drawHeldCritter(r, camera, round, heldWorld.x, heldWorld.y,
      clamp(2.5 * Math.sqrt(camera.zoom), 1.5, 4));
  }
  if (showBands) {
    ctx.globalAlpha = round?.phase === 'flying' ? Math.max(0, 1 - slackAge / .3) : 1;
    taperedBand(ctx, right, pouch, vector ? camera.scale * .02 : camera.scale * .20,
      camera.scale * .075, PALETTE.ink);
    taperedBand(ctx, right, pouch, vector ? camera.scale * .02 : camera.scale * .20,
      camera.scale * .045, PALETTE.woodDark);
    ctx.fillStyle = PALETTE.woodDark; ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = Math.max(1, camera.scale * .04);
    ctx.beginPath(); ctx.ellipse(pouch.x, pouch.y + camera.scale * .13,
      camera.scale * .25, camera.scale * .13, 0, 0, TAU); ctx.fill(); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.restore();
  drawReleasePuff(ctx, camera, r, now);
}
function collectItems(r, round, camera, alpha) {
  const items = [];
  const live = new Set();
  for (const body of round?.world?.bodies ?? []) {
    if (body.dead || body.role === 'ground') continue;
    live.add(body.id);
    items.push(makeItem(r, body, camera, alpha));
  }
  for (const id of r.poses.keys()) if (!live.has(id)) r.poses.delete(id);
  return items;
}
export function draw(r, round, camera, alpha, aim = round?.aim, editor = null) {
  if (!r?.ctx || !camera) throw new TypeError('draw requires a renderer and camera');
  if (r.world !== round?.world) {
    r.world = round?.world ?? null;
    r.poses.clear();
    r.trail = [];
    r.flightId = null;
  }
  r.camera = camera;
  layoutCamera(camera, r.width, r.height);
  const mix = clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1);
  const now = nowMs(r);
  const shake = shakeFor(r, now);
  const outline = clamp(2.5 * Math.sqrt(clamp(camera.zoom ?? 1, 0.25, 4)), 1.5, 4);
  const ctx = r.ctx;
  setBaseTransform(r);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 1;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, r.width, r.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(camera.viewportX, camera.viewportY, camera.viewportW, camera.viewportH);
  ctx.clip();
  ctx.translate(shake.x, shake.y);
  drawBackground(r, round, camera);
  if (editor) drawEditorGrid(ctx, camera, editor.grid);
  drawSlingshot(r, camera, round, aim);
  const items = collectItems(r, round, camera, mix);
  const groups = new Map();
  const shadows = new r.Path();
  const outlines = new r.Path();
  for (const item of items) {
    if (!groups.has(item.style)) groups.set(item.style, []);
    groups.get(item.style).push(item);
    outlines.addPath(item.path);
    const shadowItem = {
      ...item,
      sx: item.sx + camera.scale * 0.06,
      sy: item.sy + camera.scale * 0.06
    };
    shadows.addPath(bodyPath(r.Path, item.body, shadowItem));
  }
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = PALETTE.ink;
  ctx.fill(shadows);
  ctx.globalAlpha = 1;
  drawBackDetails(r, items, outline);
  drawBodyFills(r, groups);
  drawMotifs(r, groups, outline);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = outline;
  ctx.stroke(outlines);
  drawPigVariants(r, items, outline);
  drawDamage(r, items, outline);
  drawFaces(r, items, outline);
  drawEditorHighlights(r, items, camera, editor, outline);
  drawEditorGhost(r, camera, editor, outline);
  drawEffects(r, camera, now, outline);
  if (editor) drawEditorSlingMarker(ctx, camera);
  ctx.restore();
  r.effects = r.effects.filter((effect) => effectProgress(effect, now) < 1);
}
export function drawThumbnail(ctx, round, width, height) {
  const Path = ctx?.canvas?.ownerDocument?.defaultView?.Path2D ?? globalThis.Path2D;
  const body = round?.world?.bodies?.find((candidate) =>
    !candidate.dead && (candidate.role === 'block' || candidate.role === 'pig'));
  if (!ctx || !Path || !body || !(width > 0) || !(height > 0)) return;
  const bounds = bodyBounds(body);
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY,
    body.role === 'pig' ? body.r * 2.8 : 0.5);
  const camera = {
    x: body.x,
    y: body.y + (body.role === 'pig' ? body.r * 0.28 : 0),
    scale: Math.min(width, height) / (span * 1.38),
    viewportX: 0, viewportY: 0, viewportW: width, viewportH: height
  };
  const r = { ctx, Path, canvas: ctx.canvas, patterns: new Map() };
  const item = makeStaticItem(Path, body, camera);
  const items = [item];
  const outline = 2;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawBackDetails(r, items, outline);
  drawBodyFills(r, new Map([[item.style, items]]));
  drawMotifs(r, new Map([[item.style, items]]), outline);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = outline;
  ctx.stroke(item.path);
  drawPigVariants(r, items, outline);
  drawFaces(r, items, outline);
  ctx.restore();
}
function previewBodyPaths(ctx, Path, round, camera) {
  const groups = new Map();
  const outlines = new Path();
  for (const body of round?.world?.bodies ?? []) {
    if (body.dead || body.role === 'ground') continue;
    const item = makeStaticItem(Path, body, camera);
    if (!groups.has(item.style)) groups.set(item.style, new Path());
    groups.get(item.style).addPath(item.path);
    outlines.addPath(item.path);
  }
  for (const [key, path] of groups) {
    ctx.globalAlpha = STYLES[key].alpha;
    ctx.fillStyle = STYLES[key].fill;
    ctx.fill(path);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.stroke(outlines);
}
export function drawPreview(ctx, round, w, h) {
  if (!ctx || !(w > 0) || !(h > 0)) return;
  const Path = ctx.canvas?.ownerDocument?.defaultView?.Path2D ?? globalThis.Path2D;
  if (!Path) return;
  const camera = layoutCamera(makeCamera(), w, h);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 1;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.rect(camera.viewportX, camera.viewportY, camera.viewportW, camera.viewportH);
  ctx.clip();
  // At 260x150 the gradient and hill detail are sub-pixel work. Flat fields preserve
  // the silhouette and team-readable material colours at a fraction of the cost.
  ctx.fillStyle = PALETTE.skyTop;
  ctx.fillRect(camera.viewportX, camera.viewportY, camera.viewportW, camera.viewportH);
  const ground = worldToScreen(camera, 0, 0).y;
  ctx.fillStyle = PALETTE.groundTop;
  ctx.fillRect(camera.viewportX, ground, camera.viewportW,
    camera.viewportY + camera.viewportH - ground + 1);
  ctx.fillStyle = PALETTE.groundDeep;
  ctx.fillRect(camera.viewportX, ground, camera.viewportW, 2);
  previewBodyPaths(ctx, Path, round, camera);
  ctx.restore();
}
