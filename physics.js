import { MATERIALS, SHAPES, TUNE } from './data.js';

const DIGEST_BUFFER = new ArrayBuffer(8);
const DIGEST_VIEW = new DataView(DIGEST_BUFFER);
const DIGEST_FIELDS = ['x', 'y', 'c', 's', 'vx', 'vy', 'av'];

function resolveDefinition(value, definitions, label) {
  if (typeof value === 'string') {
    const resolved = definitions[value];
    if (!resolved) throw new RangeError(`unknown ${label} id: ${value}`);
    return resolved;
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${label} must be an id or a definition object`);
  }
  return value;
}

function polygonVerts(shape) {
  if (shape.kind === 'circle') return new Float64Array(0);

  const w = shape.w;
  const h = shape.h;
  if (shape.kind === 'box') {
    const hw = w / 2;
    const hh = h / 2;
    return new Float64Array([
      -hw, -hh,
      hw, -hh,
      hw, hh,
      -hw, hh
    ]);
  }
  if (shape.kind === 'tri') {
    // Starting from (0,0), (w,0), (0,h), subtracting the centroid (w/3,h/3)
    // makes later rotation independent of an offset shape origin.
    return new Float64Array([
      -w / 3, -h / 3,
      2 * w / 3, -h / 3,
      -w / 3, 2 * h / 3
    ]);
  }
  throw new RangeError(`unsupported shape kind: ${shape.kind}`);
}

function inertiaFor(shape, mass) {
  if (shape.kind === 'box') {
    return mass * (shape.w * shape.w + shape.h * shape.h) / 12;
  }
  if (shape.kind === 'circle') return mass * shape.r * shape.r / 2;
  if (shape.kind === 'tri') {
    // At the right-angle vertex I = m(w²+h²)/6. Moving to the centroid at
    // (w/3,h/3) subtracts m(w²+h²)/9, leaving m(w²+h²)/18.
    return mass * (shape.w * shape.w + shape.h * shape.h) / 18;
  }
  throw new RangeError(`unsupported shape kind: ${shape.kind}`);
}

export function makeWorld(opts = {}) {
  return {
    gravity: opts.gravity ?? TUNE.gravity,
    maxSpeed: opts.maxSpeed ?? TUNE.maxSpeed,
    velocityIters: opts.velocityIters ?? TUNE.velocityIters,
    positionIters: opts.positionIters ?? TUNE.positionIters,
    baumgarte: opts.baumgarte ?? TUNE.baumgarte,
    slop: opts.slop ?? TUNE.slop,
    sleepLinear: opts.sleepLinear ?? TUNE.sleepLinear,
    sleepAngular: opts.sleepAngular ?? TUNE.sleepAngular,
    sleepTime: opts.sleepTime ?? TUNE.sleepTime,
    bodies: [],
    nextId: opts.nextId ?? 1,
    time: opts.time ?? 0
  };
}

export function addBody(world, def) {
  const shape = resolveDefinition(def.shape, SHAPES, 'shape');
  const mat = resolveDefinition(def.mat, MATERIALS, 'material');
  const verts = polygonVerts(shape);
  const mass = shape.area * mat.density;
  if (!(mass > 0)) throw new RangeError('dynamic body mass inputs must be positive');

  const inertia = inertiaFor(shape, mass);
  const isStatic = Boolean(def.isStatic);
  const maxHp = shape.area * mat.hp * (def.hpScale ?? 1);
  const body = {
    id: world.nextId++,
    kind: shape.kind,
    shape,
    mat,
    hw: shape.kind === 'circle' ? 0 : shape.w / 2,
    hh: shape.kind === 'circle' ? 0 : shape.h / 2,
    r: shape.kind === 'circle' ? shape.r : 0,
    verts,
    x: def.x ?? 0,
    y: def.y ?? 0,
    c: def.c ?? 1,
    s: def.s ?? 0,
    // Accepted here rather than assigned by the caller afterwards: a body is meant to
    // keep one hidden class for its whole life, and post-hoc assignment is how that
    // discipline erodes one convenience at a time.
    vx: def.vx ?? 0,
    vy: def.vy ?? 0,
    av: def.av ?? 0,
    im: isStatic ? 0 : 1 / mass,
    ii: isStatic ? 0 : 1 / inertia,
    fric: mat.friction,
    rest: mat.restitution,
    isStatic,
    isAsleep: false,
    sleepTimer: 0,
    hp: maxHp,
    maxHp,
    tag: def.tag ?? null,
    dead: false
  };
  world.bodies.push(body);
  return body;
}

export function removeBody(world, body) {
  const index = world.bodies.indexOf(body);
  if (index === -1) return false;
  world.bodies.splice(index, 1);
  return true;
}

// --------------------------------------------------------------------- integrate

function integrate(world, dt) {
  for (const body of world.bodies) {
    if (body.isStatic || body.isAsleep || body.dead) continue;
    body.vy -= world.gravity * dt;
  }
}

// Clamping belongs here, not at the end of `integrate`. A contact impulse — a Lob
// detonating under a stone slab, most obviously — can add far more speed than gravity
// ever does, and a clamp that runs before the solver leaves that impulse unbounded for
// the position integration that immediately follows. One frame at several hundred
// units per second is one frame through the floor.
function clampSpeeds(world) {
  const maxSpeedSq = world.maxSpeed * world.maxSpeed;
  for (const body of world.bodies) {
    if (body.isStatic || body.isAsleep || body.dead) continue;
    const speedSq = body.vx * body.vx + body.vy * body.vy;
    if (speedSq > maxSpeedSq) {
      const scale = world.maxSpeed / Math.sqrt(speedSq);
      body.vx *= scale;
      body.vy *= scale;
    }
  }
}

// -------------------------------------------------------------------- broadphase

function broadphase() {
  // Sort-and-sweep belongs after the integration portability gate proves stable.
}

// ------------------------------------------------------------------- narrowphase

function narrowphase() {
  // SAT and circle manifolds are deliberately absent from the collision-free core.
}

// --------------------------------------------------------------------- warmStart

function warmStart() {
  // Cached impulses cannot exist until contact generation owns stable contact ids.
}

// ----------------------------------------------------------------- solveVelocity

function solveVelocity() {
  // Sequential impulses are the next task, after cross-engine integration passes.
}

// ------------------------------------------------------------- integratePositions

function integratePositions(world, dt) {
  for (const body of world.bodies) {
    if (body.isStatic || body.isAsleep || body.dead) continue;
    body.x += body.vx * dt;
    body.y += body.vy * dt;

    const nc = body.c - body.s * body.av * dt;
    const ns = body.s + body.c * body.av * dt;
    const invLength = 1 / Math.sqrt(nc * nc + ns * ns);
    body.c = nc * invLength;
    body.s = ns * invLength;
  }
}

// ---------------------------------------------------------------- solvePosition

function solvePosition() {
  // Baumgarte correction needs manifolds, so this phase remains an ordered no-op.
}

// ------------------------------------------------------------------------ damage

function damage() {
  // Contact impulse damage is game-facing work built on the future solver output.
}

// -------------------------------------------------------------------- explosions

function explosions() {
  // Radial impulses and occlusion wait for contacts and raycasts in the next task.
}

// ------------------------------------------------------------------------- sleep

function sleep() {
  // Island sleeping requires the contact graph and must not be approximated per body.
}

// -------------------------------------------------------------------------- cull

function cull() {
  // Deferred removal stays a no-op until damage can mark bodies dead during a step.
}

export function step(world, dt = TUNE.step) {
  integrate(world, dt);
  broadphase(world);
  narrowphase(world);
  warmStart(world);
  for (let i = 0; i < world.velocityIters; i++) solveVelocity(world, dt);
  clampSpeeds(world);
  integratePositions(world, dt);
  for (let i = 0; i < world.positionIters; i++) solvePosition(world, dt);
  damage(world, dt);
  explosions(world, dt);
  sleep(world, dt);
  cull(world);
  world.time += dt;
}

function fnvWord(hash, word) {
  hash ^= word;
  // Shift-add keeps the modulo-2³² product exact; direct double multiplication
  // by the FNV prime can exceed JavaScript's exact integer range.
  return (hash + (hash << 1) + (hash << 4) + (hash << 7) +
    (hash << 8) + (hash << 24)) >>> 0;
}

export function digest(world) {
  let hash = 2166136261;
  const bodies = world.bodies.slice().sort((a, b) => a.id - b.id);
  for (const body of bodies) {
    for (const field of DIGEST_FIELDS) {
      // Formatting or toFixed would erase the low-bit difference this gate exists
      // to detect, so the hash consumes the raw IEEE-754 halves instead.
      DIGEST_VIEW.setFloat64(0, body[field]);
      hash = fnvWord(hash, DIGEST_VIEW.getUint32(0));
      hash = fnvWord(hash, DIGEST_VIEW.getUint32(4));
    }
  }
  return hash.toString(16).padStart(8, '0');
}

export function rng(seed) {
  // Zero is xorshift32's absorbing state: seed it with 0 and every call returns 0
  // forever, silently. Seeds reach this function from the wire and from round
  // numbers, so 0 is not a hypothetical input, and a dead RNG does not look like a
  // bug — it looks like a match where nothing is ever randomised.
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

export function rngInt(r, n) {
  return Math.floor(r() * n);
}

// --- boundary helpers, not sim-safe -------------------------------------------
// Never call boundary conversion from a simulation step. The editor's snapped
// rotations use literals so implementation-defined trigonometry cannot leak in.

const DEGREE_ROTATIONS = [
  [1, 0],
  [0.9659258262890683, 0.25881904510252074],
  [0.8660254037844386, 0.5],
  [0.7071067811865476, 0.7071067811865476],
  [0.5, 0.8660254037844386],
  [0.25881904510252074, 0.9659258262890683],
  [0, 1],
  [-0.25881904510252074, 0.9659258262890683],
  [-0.5, 0.8660254037844386],
  [-0.7071067811865476, 0.7071067811865476],
  [-0.8660254037844386, 0.5],
  [-0.9659258262890683, 0.25881904510252074],
  [-1, 0],
  [-0.9659258262890683, -0.25881904510252074],
  [-0.8660254037844386, -0.5],
  [-0.7071067811865476, -0.7071067811865476],
  [-0.5, -0.8660254037844386],
  [-0.25881904510252074, -0.9659258262890683],
  [0, -1],
  [0.25881904510252074, -0.9659258262890683],
  [0.5, -0.8660254037844386],
  [0.7071067811865476, -0.7071067811865476],
  [0.8660254037844386, -0.5],
  [0.9659258262890683, -0.25881904510252074]
];

export function fromDegrees(deg) {
  if (!Number.isFinite(deg)) throw new RangeError('degrees must be finite');
  const step = Math.round(deg / 15);
  if (step * 15 !== deg) throw new RangeError('degrees must be an exact multiple of 15');
  const index = step - Math.floor(step / 24) * 24;
  const pair = DEGREE_ROTATIONS[index];
  return { c: pair[0], s: pair[1] };
}
