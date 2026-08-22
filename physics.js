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
    return new Float64Array([-hw, -hh, hw, -hh, hw, hh, -hw, hh]);
  }
  if (shape.kind === 'tri') {
    // Starting from (0,0), (w,0), (0,h), subtracting the centroid (w/3,h/3)
    // makes later rotation independent of an offset shape origin.
    return new Float64Array([
      -w / 3, -h / 3, 2 * w / 3, -h / 3, -w / 3, 2 * h / 3
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
    gravity: opts.gravity ?? TUNE.gravity, maxSpeed: opts.maxSpeed ?? TUNE.maxSpeed,
    linearDamping: opts.linearDamping ?? TUNE.linearDamping,
    angularDamping: opts.angularDamping ?? TUNE.angularDamping,
    rollingFriction: opts.rollingFriction ?? TUNE.rollingFriction,
    velocityIters: opts.velocityIters ?? TUNE.velocityIters,
    positionIters: opts.positionIters ?? TUNE.positionIters,
    baumgarte: opts.baumgarte ?? TUNE.baumgarte, slop: opts.slop ?? TUNE.slop,
    restitutionThreshold: opts.restitutionThreshold ?? TUNE.restitutionThreshold,
    sleepLinear: opts.sleepLinear ?? TUNE.sleepLinear,
    sleepAngular: opts.sleepAngular ?? TUNE.sleepAngular,
    sleepTime: opts.sleepTime ?? TUNE.sleepTime,
    onDamage: opts.onDamage ?? null,
    bodies: [], pairs: [], contacts: [],
    impulseCache: new Map(),
    nextId: opts.nextId ?? 1, time: opts.time ?? 0,
    lastGravity: opts.gravity ?? TUNE.gravity
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
  const id = world.nextId++;
  const body = {
    id, kind: shape.kind, shape, mat,
    hw: shape.kind === 'circle' ? 0 : shape.w / 2,
    hh: shape.kind === 'circle' ? 0 : shape.h / 2,
    r: shape.kind === 'circle' ? shape.r : 0, verts,
    worldVerts: new Float64Array(verts.length),
    worldNormals: new Float64Array(verts.length),
    x: def.x ?? 0, y: def.y ?? 0, c: def.c ?? 1, s: def.s ?? 0,
    // Accepted here rather than assigned by the caller afterwards: a body is meant to
    // keep one hidden class for its whole life, and post-hoc assignment is how that
    // discipline erodes one convenience at a time.
    vx: def.vx ?? 0, vy: def.vy ?? 0, av: def.av ?? 0,
    im: isStatic ? 0 : 1 / mass, ii: isStatic ? 0 : 1 / inertia,
    fric: mat.friction, rest: mat.restitution, isStatic,
    isAsleep: false, sleepTimer: 0,
    islandId: id, wakeIslandId: 0, islandParent: null,
    islandAwake: false, islandAsleep: false, islandReady: false,
    minX: 0, minY: 0, maxX: 0, maxY: 0,
    hp: maxHp, maxHp, tag: def.tag ?? null, dead: false
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
  // Damping is written as `v / (1 + dt*k)` rather than `v * (1 - dt*k)` because the
  // subtractive form goes negative and oscillates once `dt*k` passes 1. This form is
  // unconditionally stable, and it is division and multiplication only, so it costs
  // the determinism contract nothing.
  const linear = 1 / (1 + dt * world.linearDamping);
  const angular = 1 / (1 + dt * world.angularDamping);
  for (const body of world.bodies) {
    if (body.isStatic || body.isAsleep || body.dead) continue;
    body.vy -= world.gravity * dt;
    body.vx *= linear;
    body.vy *= linear;
    body.av *= angular;
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
function updateGeometry(body) {
  if (body.kind === 'circle') {
    body.minX = body.x - body.r; body.maxX = body.x + body.r;
    body.minY = body.y - body.r; body.maxY = body.y + body.r;
    return;
  }
  let minX = Infinity; let minY = Infinity;
  let maxX = -Infinity; let maxY = -Infinity;
  const count = body.verts.length / 2;
  for (let i = 0; i < count; i++) {
    const lx = body.verts[i * 2];
    const ly = body.verts[i * 2 + 1];
    const x = body.x + body.c * lx - body.s * ly;
    const y = body.y + body.s * lx + body.c * ly;
    body.worldVerts[i * 2] = x; body.worldVerts[i * 2 + 1] = y;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ex = body.worldVerts[j * 2] - body.worldVerts[i * 2];
    const ey = body.worldVerts[j * 2 + 1] - body.worldVerts[i * 2 + 1];
    const invLength = 1 / Math.sqrt(ex * ex + ey * ey);
    body.worldNormals[i * 2] = ey * invLength;
    body.worldNormals[i * 2 + 1] = -ex * invLength;
  }
  body.minX = minX; body.minY = minY;
  body.maxX = maxX; body.maxY = maxY;
}
function broadphase(world) {
  const proxies = [];
  for (const body of world.bodies) {
    if (body.dead) continue;
    updateGeometry(body);
    proxies.push(body);
  }
  proxies.sort((a, b) => a.minX - b.minX || a.id - b.id);
  const pairs = [];
  for (let i = 0; i < proxies.length; i++) {
    const a = proxies[i];
    for (let j = i + 1; j < proxies.length; j++) {
      const b = proxies[j];
      if (b.minX > a.maxX) break;
      if (a.maxY < b.minY || b.maxY < a.minY) continue;
      if ((a.isStatic && b.isStatic) || (a.isAsleep && b.isAsleep)) continue;
      pairs.push(a.id < b.id ? { a, b } : { a: b, b: a });
    }
  }
  // Sweep order is geometric; pair order is by id so solver accumulation never
  // changes merely because two unrelated AABBs exchange places on the x axis.
  pairs.sort((p, q) => p.a.id - q.a.id || p.b.id - q.b.id);
  world.pairs = pairs;
}
// ------------------------------------------------------------------- narrowphase
function faceSeparation(a, b) {
  let separation = -Infinity; let face = 0;
  const aCount = a.worldVerts.length / 2; const bCount = b.worldVerts.length / 2;
  for (let i = 0; i < aCount; i++) {
    const nx = a.worldNormals[i * 2];
    const ny = a.worldNormals[i * 2 + 1];
    const offset = nx * a.worldVerts[i * 2] + ny * a.worldVerts[i * 2 + 1];
    let minimum = Infinity;
    for (let j = 0; j < bCount; j++) {
      minimum = Math.min(minimum,
        nx * b.worldVerts[j * 2] + ny * b.worldVerts[j * 2 + 1]);
    }
    const candidate = minimum - offset;
    if (candidate > separation) { separation = candidate; face = i; }
  }
  return { separation, face };
}
function clipSegment(points, nx, ny, offset) {
  const d0 = nx * points[0].x + ny * points[0].y - offset;
  const d1 = nx * points[1].x + ny * points[1].y - offset;
  const in0 = d0 <= 0; const in1 = d1 <= 0;
  if (in0 && in1) return points;
  if (!in0 && !in1) return [];
  const t = d0 / (d0 - d1);
  const clipped = { x: points[0].x + (points[1].x - points[0].x) * t,
    y: points[0].y + (points[1].y - points[0].y) * t,
    iv: in0 ? points[1].iv : points[0].iv };
  return in0 ? [points[0], clipped] : [clipped, points[1]];
}
function collidePolygons(a, b) {
  const sa = faceSeparation(a, b);
  if (sa.separation > 0) return [];
  const sb = faceSeparation(b, a);
  if (sb.separation > 0) return [];

  // A small reference-face hysteresis prevents tiny pose noise from flipping every
  // feature id and throwing away the warm-start cache in a resting stack.
  const referenceIsB = sb.separation > sa.separation * 0.98 + 0.001;
  const reference = referenceIsB ? b : a; const incident = referenceIsB ? a : b;
  const face = referenceIsB ? sb.face : sa.face;
  const refCount = reference.worldVerts.length / 2;
  const incidentCount = incident.worldVerts.length / 2;
  const next = (face + 1) % refCount;
  const r1x = reference.worldVerts[face * 2]; const r1y = reference.worldVerts[face * 2 + 1];
  const r2x = reference.worldVerts[next * 2]; const r2y = reference.worldVerts[next * 2 + 1];
  const refNx = reference.worldNormals[face * 2];
  const refNy = reference.worldNormals[face * 2 + 1];
  const edgeLength = Math.sqrt((r2x - r1x) * (r2x - r1x) +
    (r2y - r1y) * (r2y - r1y));
  const tx = (r2x - r1x) / edgeLength; const ty = (r2y - r1y) / edgeLength;
  let incidentFace = 0; let incidentDot = Infinity;
  for (let i = 0; i < incidentCount; i++) {
    const dot = refNx * incident.worldNormals[i * 2] +
      refNy * incident.worldNormals[i * 2 + 1];
    if (dot < incidentDot) { incidentDot = dot; incidentFace = i; }
  }
  const incidentNext = (incidentFace + 1) % incidentCount;
  let points = [
    { x: incident.worldVerts[incidentFace * 2],
      y: incident.worldVerts[incidentFace * 2 + 1], iv: incidentFace },
    { x: incident.worldVerts[incidentNext * 2],
      y: incident.worldVerts[incidentNext * 2 + 1], iv: incidentNext }
  ];
  points = clipSegment(points, -tx, -ty, -(tx * r1x + ty * r1y));
  if (points.length < 2) return [];
  points = clipSegment(points, tx, ty, tx * r2x + ty * r2y);
  if (points.length < 2) return [];

  const nx = referenceIsB ? -refNx : refNx; const ny = referenceIsB ? -refNy : refNy;
  const contacts = [];
  for (const point of points) {
    const separation = refNx * (point.x - r1x) + refNy * (point.y - r1y);
    if (separation > 0) continue;
    const feature = (referenceIsB ? 128 : 0) + face * 8 + point.iv;
    if (referenceIsB) {
      contacts.push({ nx, ny, ax: point.x, ay: point.y,
        bx: point.x - refNx * separation, by: point.y - refNy * separation,
        feature });
    } else {
      contacts.push({ nx, ny,
        ax: point.x - refNx * separation, ay: point.y - refNy * separation,
        bx: point.x, by: point.y, feature });
    }
  }
  return contacts;
}
function collideCircles(a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y; const radii = a.r + b.r;
  const distanceSq = dx * dx + dy * dy;
  if (distanceSq > radii * radii) return [];
  const distance = Math.sqrt(distanceSq);
  const nx = distance > 0 ? dx / distance : 1;
  const ny = distance > 0 ? dy / distance : 0;
  return [{ nx, ny,
    ax: a.x + nx * a.r, ay: a.y + ny * a.r,
    bx: b.x - nx * b.r, by: b.y - ny * b.r,
    feature: 240 }];
}
function collideCirclePolygon(circle, polygon, circleIsA) {
  let face = 0; let separation = -Infinity;
  const count = polygon.worldVerts.length / 2;
  for (let i = 0; i < count; i++) {
    const nx = polygon.worldNormals[i * 2];
    const ny = polygon.worldNormals[i * 2 + 1];
    const value = nx * (circle.x - polygon.worldVerts[i * 2]) +
      ny * (circle.y - polygon.worldVerts[i * 2 + 1]);
    if (value > separation) { separation = value; face = i; }
  }
  if (separation > circle.r) return [];

  let qx; let qy; let region;
  if (separation <= 0) {
    const nx = polygon.worldNormals[face * 2];
    const ny = polygon.worldNormals[face * 2 + 1];
    qx = circle.x - nx * separation;
    qy = circle.y - ny * separation; region = 3;
  } else {
    let bestDistanceSq = Infinity;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const x0 = polygon.worldVerts[i * 2]; const y0 = polygon.worldVerts[i * 2 + 1];
      const ex = polygon.worldVerts[j * 2] - x0; const ey = polygon.worldVerts[j * 2 + 1] - y0;
      const lengthSq = ex * ex + ey * ey;
      const t = Math.max(0, Math.min(1,
        ((circle.x - x0) * ex + (circle.y - y0) * ey) / lengthSq));
      const x = x0 + ex * t; const y = y0 + ey * t;
      const dx = circle.x - x; const dy = circle.y - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq; qx = x; qy = y; face = i;
        region = t === 0 ? 0 : t === 1 ? 1 : 2;
      }
    }
    if (bestDistanceSq > circle.r * circle.r) return [];
  }

  const dx = circle.x - qx; const dy = circle.y - qy;
  const distanceSq = dx * dx + dy * dy;
  let polyNx; let polyNy;
  if (separation <= 0) {
    polyNx = polygon.worldNormals[face * 2];
    polyNy = polygon.worldNormals[face * 2 + 1];
  } else {
    const distance = Math.sqrt(distanceSq);
    polyNx = distance > 0 ? dx / distance : polygon.worldNormals[face * 2];
    polyNy = distance > 0 ? dy / distance : polygon.worldNormals[face * 2 + 1];
  }
  const nx = circleIsA ? -polyNx : polyNx; const ny = circleIsA ? -polyNy : polyNy;
  const circleX = circle.x + (circleIsA ? nx : -nx) * circle.r;
  const circleY = circle.y + (circleIsA ? ny : -ny) * circle.r;
  const feature = 192 + face * 4 + region;
  return [circleIsA
    ? { nx, ny, ax: circleX, ay: circleY, bx: qx, by: qy, feature }
    : { nx, ny, ax: qx, ay: qy, bx: circleX, by: circleY, feature }];
}
function contactKey(a, b, feature) {
  const sum = a.id + b.id;
  return ((sum * (sum + 1) / 2 + b.id) * 256) + feature;
}
function localPoint(body, x, y) {
  const dx = x - body.x; const dy = y - body.y;
  return { x: body.c * dx + body.s * dy, y: -body.s * dx + body.c * dy };
}
function relativeVelocity(a, b, rax, ray, rbx, rby) {
  return {
    x: b.vx - b.av * rby - a.vx + a.av * ray,
    y: b.vy + b.av * rbx - a.vy - a.av * rax
  };
}
function activeMass(body) { return body.isAsleep ? 0 : body.im; }
function activeInertia(body) { return body.isAsleep ? 0 : body.ii; }
function makeContact(world, a, b, raw, key, cached) {
  const rax = raw.ax - a.x; const ray = raw.ay - a.y;
  const rbx = raw.bx - b.x; const rby = raw.by - b.y;
  const imA = activeMass(a); const imB = activeMass(b);
  const iiA = activeInertia(a); const iiB = activeInertia(b);
  const rnA = rax * raw.ny - ray * raw.nx; const rnB = rbx * raw.ny - rby * raw.nx;
  const tx = -raw.ny; const ty = raw.nx;
  const rtA = rax * ty - ray * tx; const rtB = rbx * ty - rby * tx;
  const normalK = imA + imB + iiA * rnA * rnA + iiB * rnB * rnB;
  const tangentK = imA + imB + iiA * rtA * rtA + iiB * rtB * rtB;
  const radiusA = Math.sqrt(rax * rax + ray * ray);
  const radiusB = Math.sqrt(rbx * rbx + rby * rby);
  const radiusSum = radiusA + radiusB;
  // A static surface's centre is arbitrary (the ground is one wide box), so only
  // the dynamic lever arm represents its contact radius.
  const effectiveRadius = a.isStatic ? radiusB : b.isStatic ? radiusA
    : radiusSum > 0 ? radiusA * radiusB / radiusSum : 0;
  const rollingK = iiA + iiB;
  const velocity = relativeVelocity(a, b, rax, ray, rbx, rby);
  const approach = velocity.x * raw.nx + velocity.y * raw.ny;
  const rest = Math.max(a.rest, b.rest);
  const localA = localPoint(a, raw.ax, raw.ay); const localB = localPoint(b, raw.bx, raw.by);
  return {
    key, a, b, nx: raw.nx, ny: raw.ny, tx, ty,
    localAx: localA.x, localAy: localA.y,
    localBx: localB.x, localBy: localB.y,
    rax, ray, rbx, rby,
    normalMass: normalK > 0 ? 1 / normalK : 0,
    tangentMass: tangentK > 0 ? 1 / tangentK : 0,
    rollingMass: rollingK > 0 ? 1 / rollingK : 0,
    effectiveRadius,
    restitutionBias: approach < -world.restitutionThreshold ? -rest * approach : 0,
    friction: Math.sqrt(a.fric * b.fric),
    rollingFriction: world.rollingFriction,
    pn: cached?.pn ?? 0, pt: cached?.pt ?? 0, pr: cached?.pr ?? 0
  };
}
function wakeIsland(world, islandId) {
  for (const body of world.bodies) {
    if (body.dead || body.isStatic || body.islandId !== islandId) continue;
    body.isAsleep = false; body.sleepTimer = 0; body.wakeIslandId = islandId;
  }
}
export function wakeBody(world, body) {
  if (!body || body.dead || body.isStatic) return;
  wakeIsland(world, body.islandId);
}
function narrowphase(world) {
  const contacts = [];
  for (const { a, b } of world.pairs) {
    let raw;
    if (a.kind === 'circle' && b.kind === 'circle') raw = collideCircles(a, b);
    else if (a.kind === 'circle') raw = collideCirclePolygon(a, b, true);
    else if (b.kind === 'circle') raw = collideCirclePolygon(b, a, false);
    else raw = collidePolygons(a, b);
    for (const point of raw) {
      const key = contactKey(a, b, point.feature);
      const cached = world.impulseCache.get(key);
      if (!cached) {
        if (a.isAsleep && !b.isStatic && !b.isAsleep) wakeIsland(world, a.islandId);
        if (b.isAsleep && !a.isStatic && !a.isAsleep) wakeIsland(world, b.islandId);
      }
      contacts.push(makeContact(world, a, b, point, key, cached));
    }
  }
  world.contacts = contacts;
}
// --------------------------------------------------------------------- warmStart
function applyContactImpulse(contact, ix, iy) {
  const { a, b } = contact;
  const imA = activeMass(a); const imB = activeMass(b);
  const iiA = activeInertia(a); const iiB = activeInertia(b);
  a.vx -= ix * imA; a.vy -= iy * imA;
  a.av -= (contact.rax * iy - contact.ray * ix) * iiA;
  b.vx += ix * imB; b.vy += iy * imB;
  b.av += (contact.rbx * iy - contact.rby * ix) * iiB;
}
function warmStart(world) {
  for (const contact of world.contacts) {
    applyContactImpulse(contact,
      contact.nx * contact.pn + contact.tx * contact.pt,
      contact.ny * contact.pn + contact.ty * contact.pt);
    const iiA = activeInertia(contact.a); const iiB = activeInertia(contact.b);
    contact.a.av -= contact.pr * iiA;
    contact.b.av += contact.pr * iiB;
  }
}
// ----------------------------------------------------------------- solveVelocity
function solveNormal(contact) {
  const velocity = relativeVelocity(contact.a, contact.b,
    contact.rax, contact.ray, contact.rbx, contact.rby);
  const normalSpeed = velocity.x * contact.nx + velocity.y * contact.ny;
  const oldNormal = contact.pn;
  contact.pn = Math.max(0, oldNormal +
    contact.normalMass * (contact.restitutionBias - normalSpeed));
  const increment = contact.pn - oldNormal;
  applyContactImpulse(contact, contact.nx * increment, contact.ny * increment);
}
function solveNormalPair(first, second) {
  const imA = activeMass(first.a); const imB = activeMass(first.b);
  const iiA = activeInertia(first.a); const iiB = activeInertia(first.b);
  const rn1A = first.rax * first.ny - first.ray * first.nx;
  const rn1B = first.rbx * first.ny - first.rby * first.nx;
  const rn2A = second.rax * second.ny - second.ray * second.nx;
  const rn2B = second.rbx * second.ny - second.rby * second.nx;
  const k11 = imA + imB + iiA * rn1A * rn1A + iiB * rn1B * rn1B;
  const k22 = imA + imB + iiA * rn2A * rn2A + iiB * rn2B * rn2B;
  const k12 = imA + imB + iiA * rn1A * rn2A + iiB * rn1B * rn2B;
  const determinant = k11 * k22 - k12 * k12;
  if (determinant <= 0) {
    solveNormal(first); solveNormal(second);
    return;
  }
  const v1 = relativeVelocity(first.a, first.b,
    first.rax, first.ray, first.rbx, first.rby);
  const v2 = relativeVelocity(second.a, second.b,
    second.rax, second.ray, second.rbx, second.rby);
  const speed1 = v1.x * first.nx + v1.y * first.ny;
  const speed2 = v2.x * second.nx + v2.y * second.ny;
  const q1 = k11 * first.pn + k12 * second.pn + first.restitutionBias - speed1;
  const q2 = k12 * first.pn + k22 * second.pn + second.restitutionBias - speed2;
  let x1 = (q1 * k22 - q2 * k12) / determinant;
  let x2 = (q2 * k11 - q1 * k12) / determinant;
  if (x1 < 0 || x2 < 0) {
    x1 = 0; x2 = q2 / k22;
    if (x2 < 0 || k12 * x2 - q1 < 0) {
      x1 = q1 / k11; x2 = 0;
      if (x1 < 0 || k12 * x1 - q2 < 0) {
        x1 = 0; x2 = 0;
        if (-q1 < 0 || -q2 < 0) {
          solveNormal(first); solveNormal(second);
          return;
        }
      }
    }
  }
  const increment1 = x1 - first.pn; const increment2 = x2 - second.pn;
  first.pn = x1; second.pn = x2;
  applyContactImpulse(first, first.nx * increment1, first.ny * increment1);
  applyContactImpulse(second, second.nx * increment2, second.ny * increment2);
}
function solveFriction(contact) {
  const velocity = relativeVelocity(contact.a, contact.b,
    contact.rax, contact.ray, contact.rbx, contact.rby);
  const tangentSpeed = velocity.x * contact.tx + velocity.y * contact.ty;
  const oldTangent = contact.pt; const maxFriction = contact.friction * contact.pn;
  contact.pt = Math.max(-maxFriction, Math.min(maxFriction,
    oldTangent - contact.tangentMass * tangentSpeed));
  const increment = contact.pt - oldTangent;
  applyContactImpulse(contact, contact.tx * increment, contact.ty * increment);
}
function solveRollingFriction(contact) {
  const relativeAngular = contact.b.av - contact.a.av;
  const oldRolling = contact.pr;
  const maxRolling = contact.rollingFriction * contact.pn * contact.effectiveRadius;
  // Clamp the accumulator: clamping eight increments would exceed the load-scaled
  // limit, while global angular damping also drains bodies that are in free flight.
  contact.pr = Math.max(-maxRolling, Math.min(maxRolling,
    oldRolling - contact.rollingMass * relativeAngular));
  const increment = contact.pr - oldRolling;
  const iiA = activeInertia(contact.a); const iiB = activeInertia(contact.b);
  contact.a.av -= increment * iiA;
  contact.b.av += increment * iiB;
}
function solveVelocity(world) {
  for (let i = 0; i < world.contacts.length;) {
    const contact = world.contacts[i];
    const second = world.contacts[i + 1];
    if (second && contact.a === second.a && contact.b === second.b) {
      solveNormalPair(contact, second);
      solveFriction(contact); solveRollingFriction(contact);
      solveFriction(second); solveRollingFriction(second);
      i += 2;
    } else {
      solveNormal(contact); solveFriction(contact); solveRollingFriction(contact);
      i++;
    }
  }
}
function storeImpulses(world) {
  const next = new Map();
  // Contacts, not the Map, own the iteration order. Reversing this silently makes
  // insertion history part of the simulation when stale entries are dropped.
  for (const contact of world.contacts) {
    next.set(contact.key, { pn: contact.pn, pt: contact.pt, pr: contact.pr });
  }
  world.impulseCache = next;
}
// ------------------------------------------------------------- integratePositions
function integratePositions(world, dt) {
  for (const body of world.bodies) {
    if (body.isStatic || body.isAsleep || body.dead) continue;
    body.x += body.vx * dt; body.y += body.vy * dt;
    const nc = body.c - body.s * body.av * dt;
    const ns = body.s + body.c * body.av * dt;
    const invLength = 1 / Math.sqrt(nc * nc + ns * ns);
    body.c = nc * invLength; body.s = ns * invLength;
  }
}
// ---------------------------------------------------------------- solvePosition
function worldPoint(body, x, y) {
  return {
    x: body.x + body.c * x - body.s * y,
    y: body.y + body.s * x + body.c * y
  };
}
function rotateBy(body, angle) {
  if (angle === 0) return;
  const c = body.c - body.s * angle;
  const s = body.s + body.c * angle;
  const invLength = 1 / Math.sqrt(c * c + s * s);
  body.c = c * invLength; body.s = s * invLength;
}
function solvePosition(world) {
  for (const contact of world.contacts) {
    const a = contact.a; const b = contact.b;
    const pointA = worldPoint(a, contact.localAx, contact.localAy);
    const pointB = worldPoint(b, contact.localBx, contact.localBy);
    const rax = pointA.x - a.x; const ray = pointA.y - a.y;
    const rbx = pointB.x - b.x; const rby = pointB.y - b.y;
    const separation = (pointB.x - pointA.x) * contact.nx +
      (pointB.y - pointA.y) * contact.ny;
    // Baumgarte belongs only in this non-linear position pass. A velocity bias as
    // well double-corrects overlap and injects energy into otherwise resting stacks.
    const correction = world.baumgarte * Math.max(0, -separation - world.slop);
    if (correction === 0) continue;
    const imA = activeMass(a); const imB = activeMass(b);
    const iiA = activeInertia(a); const iiB = activeInertia(b);
    const rnA = rax * contact.ny - ray * contact.nx;
    const rnB = rbx * contact.ny - rby * contact.nx;
    const k = imA + imB + iiA * rnA * rnA + iiB * rnB * rnB;
    if (k === 0) continue;
    const impulse = correction / k;
    const ix = contact.nx * impulse;
    const iy = contact.ny * impulse;
    a.x -= ix * imA; a.y -= iy * imA;
    rotateBy(a, -(rax * iy - ray * ix) * iiA);
    b.x += ix * imB; b.y += iy * imB;
    rotateBy(b, (rbx * iy - rby * ix) * iiB);
  }
}
// ------------------------------------------------------------------------ damage
// The solver exposes contacts and their final impulses; sim.js owns what those mean.
function damage(world) { if (world.onDamage) world.onDamage(world); }
// -------------------------------------------------------------------- explosions
function explosions() {}
// ------------------------------------------------------------------------- sleep
function findRoot(body) {
  let root = body;
  while (root.islandParent !== root) root = root.islandParent;
  while (body.islandParent !== body) {
    const next = body.islandParent;
    body.islandParent = root;
    body = next;
  }
  return root;
}
function unionRoots(a, b) {
  const ra = findRoot(a);
  const rb = findRoot(b);
  if (ra === rb) return;
  // The lower-id root wins rather than union-by-rank so island identity is stable.
  if (ra.id < rb.id) rb.islandParent = ra;
  else ra.islandParent = rb;
}
function sleep(world, dt) {
  const bodies = world.bodies.filter((body) => !body.dead && !body.isStatic)
    .sort((a, b) => a.id - b.id);
  for (const body of bodies) {
    body.islandParent = body;
    body.islandAwake = false;
    body.islandAsleep = false;
    body.islandReady = true;
  }
  // Broadphase deliberately omits asleep-asleep pairs. Preserve their last island,
  // including for the one frame in which an impact wakes the whole group.
  for (let i = 0; i < bodies.length; i++) {
    for (let j = 0; j < i; j++) {
      const sameSleepingIsland = bodies[i].isAsleep && bodies[j].isAsleep &&
        bodies[i].islandId === bodies[j].islandId;
      const sameWakeGroup = bodies[i].wakeIslandId !== 0 &&
        bodies[i].wakeIslandId === bodies[j].wakeIslandId;
      if (sameSleepingIsland || sameWakeGroup) unionRoots(bodies[i], bodies[j]);
    }
  }
  for (const contact of world.contacts) {
    if (contact.a.isStatic || contact.b.isStatic || contact.a.dead || contact.b.dead) continue;
    unionRoots(contact.a, contact.b);
  }
  for (const body of bodies) {
    const root = findRoot(body);
    if (body.isAsleep) root.islandAsleep = true;
    else root.islandAwake = true;
  }
  for (const body of bodies) {
    const root = findRoot(body);
    if (root.islandAwake && root.islandAsleep) {
      body.isAsleep = false;
      body.sleepTimer = 0;
    }
  }
  const linearLimitSq = world.sleepLinear * world.sleepLinear;
  for (const body of bodies) {
    const root = findRoot(body);
    body.islandId = root.id;
    body.wakeIslandId = 0;
    if (!body.isAsleep) {
      const linearSq = body.vx * body.vx + body.vy * body.vy;
      if (linearSq < linearLimitSq && Math.abs(body.av) < world.sleepAngular) {
        body.sleepTimer += dt;
      } else {
        body.sleepTimer = 0;
      }
    }
    if (body.sleepTimer < world.sleepTime) root.islandReady = false;
  }
  for (const body of bodies) {
    if (!findRoot(body).islandReady) {
      body.isAsleep = false;
      continue;
    }
    body.isAsleep = true;
    body.sleepTimer = world.sleepTime;
    body.vx = 0;
    body.vy = 0;
    body.av = 0;
  }
}
// -------------------------------------------------------------------------- cull
// Deferred removal remains a no-op until damage can mark bodies dead during a step.
function cull() {}
export function isSettled(world) {
  for (const body of world.bodies) {
    if (!body.dead && !body.isStatic && !body.isAsleep) return false;
  }
  return true;
}

// Deepest overlap currently present, without stepping. Two callers need it and both
// are load-bearing:
//
//   - the build phase, where DESIGN.md forbids a blueprint whose pieces intersect at
//     rest, and
//   - every test scene, because a scene authored with overlapping bodies does not
//     test the solver, it tests the solver's recovery from a bad initial condition.
//     The pyramid gate was originally built with 4-wide planks at 3-unit spacing and
//     spent its whole run climbing out of a one-unit interpenetration, which looked
//     like a solver that could not stack and was really a scene that could not be
//     built. Asserting this up front is cheaper than diagnosing that twice.
// Runs the same broadphase and narrowphase `step` would, so call it on a freshly
// built world before stepping it, not in the middle of a round.
export function maxPenetration(world) {
  broadphase(world);
  narrowphase(world);
  let worst = 0;
  for (const contact of world.contacts) {
    const pointA = worldPoint(contact.a, contact.localAx, contact.localAy);
    const pointB = worldPoint(contact.b, contact.localBx, contact.localBy);
    const depth = -((pointB.x - pointA.x) * contact.nx + (pointB.y - pointA.y) * contact.ny);
    if (depth > worst) worst = depth;
  }
  return worst;
}
export function applyImpulse(world, body, ix, iy, x = body.x, y = body.y) {
  if (!body || body.dead || body.isStatic) return;
  wakeBody(world, body);
  body.vx += ix * body.im;
  body.vy += iy * body.im;
  body.av += ((x - body.x) * iy - (y - body.y) * ix) * body.ii;
}
function aabbRay(body, x0, y0, dx, dy) {
  let near = 0;
  let far = 1;
  if (dx === 0) {
    if (x0 < body.minX || x0 > body.maxX) return false;
  } else {
    let a = (body.minX - x0) / dx;
    let b = (body.maxX - x0) / dx;
    if (a > b) {
      const swap = a;
      a = b;
      b = swap;
    }
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return false;
  }
  if (dy === 0) return y0 >= body.minY && y0 <= body.maxY;
  let a = (body.minY - y0) / dy;
  let b = (body.maxY - y0) / dy;
  if (a > b) {
    const swap = a;
    a = b;
    b = swap;
  }
  near = Math.max(near, a);
  far = Math.min(far, b);
  return near <= far;
}

function rayCircle(body, x0, y0, dx, dy) {
  const fx = x0 - body.x;
  const fy = y0 - body.y;
  const lengthSq = dx * dx + dy * dy;
  const startSq = fx * fx + fy * fy;
  if (startSq <= body.r * body.r) {
    const length = Math.sqrt(startSq);
    const nx = length > 0 ? fx / length : dx !== 0 || dy !== 0
      ? -dx / Math.sqrt(lengthSq) : 1;
    const ny = length > 0 ? fy / length : dx !== 0 || dy !== 0
      ? -dy / Math.sqrt(lengthSq) : 0;
    return { t: 0, x: x0, y: y0, nx, ny };
  }
  if (lengthSq === 0) return null;
  const along = fx * dx + fy * dy;
  const discriminant = along * along - lengthSq * (startSq - body.r * body.r);
  if (discriminant < 0) return null;
  const t = (-along - Math.sqrt(discriminant)) / lengthSq;
  if (t < 0 || t > 1) return null;
  const x = x0 + dx * t;
  const y = y0 + dy * t;
  return { t, x, y, nx: (x - body.x) / body.r, ny: (y - body.y) / body.r };
}

function rayPolygon(body, x0, y0, dx, dy) {
  let enter = 0;
  let exit = 1;
  let enterFace = -1;
  let closestFace = 0;
  let closestDistance = -Infinity;
  const count = body.worldVerts.length / 2;
  for (let i = 0; i < count; i++) {
    const nx = body.worldNormals[i * 2];
    const ny = body.worldNormals[i * 2 + 1];
    const distance = nx * (x0 - body.worldVerts[i * 2]) +
      ny * (y0 - body.worldVerts[i * 2 + 1]);
    if (distance > closestDistance) {
      closestDistance = distance;
      closestFace = i;
    }
    const denominator = nx * dx + ny * dy;
    if (denominator === 0) {
      if (distance > 0) return null;
      continue;
    }
    const t = -distance / denominator;
    if (denominator < 0) {
      if (t > enter) {
        enter = t;
        enterFace = i;
      }
    } else {
      exit = Math.min(exit, t);
    }
    if (enter > exit) return null;
  }
  if (enter < 0 || enter > 1) return null;
  const face = enterFace >= 0 ? enterFace : closestFace;
  return {
    t: enter,
    x: x0 + dx * enter,
    y: y0 + dy * enter,
    nx: body.worldNormals[face * 2],
    ny: body.worldNormals[face * 2 + 1]
  };
}

export function raycastAll(world, x0, y0, x1, y1, filter = null) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const hits = [];
  const bodies = world.bodies.slice().sort((a, b) => a.id - b.id);
  for (const body of bodies) {
    if (body.dead || (filter && !filter(body))) continue;
    updateGeometry(body);
    if (!aabbRay(body, x0, y0, dx, dy)) continue;
    const hit = body.kind === 'circle'
      ? rayCircle(body, x0, y0, dx, dy)
      : rayPolygon(body, x0, y0, dx, dy);
    if (hit) hits.push({ body, ...hit });
  }
  hits.sort((a, b) => a.t - b.t || a.body.id - b.body.id);
  return hits;
}

export function raycast(world, x0, y0, x1, y1, filter = null) {
  const hits = raycastAll(world, x0, y0, x1, y1, filter);
  return hits.length ? hits[0] : null;
}

export function step(world, dt = TUNE.step) {
  if (world.gravity !== world.lastGravity) {
    for (const body of world.bodies) {
      if (body.dead || body.isStatic) continue;
      body.isAsleep = false;
      body.sleepTimer = 0;
      body.wakeIslandId = body.islandId;
    }
    world.lastGravity = world.gravity;
  }
  integrate(world, dt);
  broadphase(world);
  narrowphase(world);
  warmStart(world);
  for (let i = 0; i < world.velocityIters; i++) solveVelocity(world, dt);
  storeImpulses(world);
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
  // The physics gate specifies a 20-degree ramp even though editor snapping is 15
  // degrees. Literals keep that boundary conversion deterministic without admitting
  // trigonometry to the simulation module.
  if (deg === 20) return { c: 0.9396926207859084, s: 0.3420201433256687 };
  if (deg === -20) return { c: 0.9396926207859084, s: -0.3420201433256687 };
  const step = Math.round(deg / 15);
  if (step * 15 !== deg) throw new RangeError('degrees must be an exact multiple of 15');
  const index = step - Math.floor(step / 24) * 24;
  const pair = DEGREE_ROTATIONS[index];
  return { c: pair[0], s: pair[1] };
}
