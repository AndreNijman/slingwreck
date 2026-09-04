import { AMMO_BY_ID, MATERIALS, PIGS, SHAPES, TUNE } from './data.js?v=20260904-2';

// Prefixes of each template are deliberately stable: a lower budget removes the last
// reinforcement instead of leaving a roof whose supports were removed. Campaign balance
// only uses the aimer today; these are the deterministic starting point for solo Siege.
export const FORTRESS_TEMPLATES = Object.freeze([
  {
    id: 'low-keep',
    pigs: [['runt', 9, 0.296875, 0], ['king', 12, 0.6875, 0],
      ['runt', 15, 0.296875, 0]],
    blocks: [
      ['pillar', 'wood', 8, 2, 0], ['pillar', 'wood', 10, 2, 0],
      ['pillar', 'stone', 11, 2, 0], ['pillar', 'stone', 13, 2, 0],
      ['pillar', 'wood', 14, 2, 0], ['pillar', 'wood', 16, 2, 0],
      ['post', 'wood', 8, 5, 0], ['post', 'wood', 10, 5, 0],
      ['post', 'stone', 11, 5, 0], ['post', 'stone', 13, 5, 0],
      ['post', 'wood', 14, 5, 0], ['post', 'wood', 16, 5, 0]
    ]
  },
  {
    id: 'split-towers',
    pigs: [['runt', 6, 0.296875, 0], ['king', 12, 0.6875, 0],
      ['runt', 19, 0.296875, 0]],
    blocks: [
      ['pillar', 'wood', 5, 2, 0], ['pillar', 'wood', 7, 2, 0],
      ['pillar', 'stone', 11, 2, 0], ['pillar', 'stone', 13, 2, 0],
      ['pillar', 'wood', 18, 2, 0], ['pillar', 'wood', 20, 2, 0],
      ['post', 'wood', 5, 5, 0], ['post', 'wood', 7, 5, 0],
      ['post', 'stone', 11, 5, 0], ['post', 'stone', 13, 5, 0],
      ['post', 'wood', 18, 5, 0], ['post', 'wood', 20, 5, 0]
    ]
  }
]);

function blockCost(tuple) {
  return SHAPES[tuple[0]].area * MATERIALS[tuple[1]].cost;
}

export function fortressForBudget(budget, templateIndex = 0) {
  if (!Number.isFinite(budget) || budget < 0) throw new RangeError('budget must be non-negative');
  const index = Math.floor(templateIndex);
  const template = FORTRESS_TEMPLATES[((index % FORTRESS_TEMPLATES.length) +
    FORTRESS_TEMPLATES.length) % FORTRESS_TEMPLATES.length];
  let spent = template.pigs.reduce((sum, pig) => sum + PIGS[pig[0]].cost, 0);
  const blocks = [];
  for (const tuple of template.blocks) {
    const cost = blockCost(tuple);
    if (spent + cost > budget) break;
    blocks.push(tuple.slice());
    spent += cost;
  }
  return {
    blueprint: { v: 1, blocks, pigs: template.pigs.map((pig) => pig.slice()) },
    template: template.id,
    spent
  };
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

// Fixed-speed projectile solve. The low/high roots are the two exact solutions of
// y = x*tan(a) - g*x^2*(1 + tan(a)^2)/(2*v^2). The result is converted straight to
// the draw vector accepted by sim.launch, so no trigonometry enters this module.
export function aim(round, target, difficulty = 1, random = round?.rng, arc = 'low') {
  if (!round || !target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new TypeError('aim needs a round and a finite target point');
  }
  if (typeof random !== 'function') throw new TypeError('aim needs a seeded rng function');
  const accuracy = clamp(difficulty, 0, 1);
  const noise = (1 - accuracy) * 0.9;
  const targetX = target.x + (random() * 2 - 1) * noise;
  const targetY = target.y + (random() * 2 - 1) * noise;
  const x = Math.max(TUNE.gridSnap, targetX - TUNE.slingX);
  const y = targetY - TUNE.slingY;
  const speed = TUNE.launchSpeedMax;
  const speedSq = speed * speed;
  const gravity = TUNE.gravity;
  const discriminant = speedSq * speedSq - gravity *
    (gravity * x * x + 2 * y * speedSq);
  const root = Math.sqrt(Math.max(0, discriminant));
  const tangent = (speedSq + (arc === 'high' ? root : -root)) / (gravity * x);
  const vx = speed / Math.sqrt(1 + tangent * tangent);
  const vy = vx * tangent;
  const drawScale = TUNE.slingRadius / speed;
  return {
    dx: -vx * drawScale,
    dy: -vy * drawScale,
    target: { x: targetX, y: targetY },
    arc: arc === 'high' ? 'high' : 'low',
    reachable: discriminant >= 0
  };
}

export const ballisticAim = aim;

function bounds(body) {
  if (body.kind === 'circle') {
    return { minX: body.x - body.r, maxX: body.x + body.r,
      minY: body.y - body.r, maxY: body.y + body.r };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < body.verts.length / 2; index++) {
    const x = body.x + body.c * body.verts[index * 2] - body.s * body.verts[index * 2 + 1];
    const y = body.y + body.s * body.verts[index * 2] + body.c * body.verts[index * 2 + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function overlapX(a, b) {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
}

function bodyMass(body) {
  return body.im > 0 ? 1 / body.im : 0;
}

function segmentAabbTime(x0, y0, x1, y1, box) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let near = 0;
  let far = 1;
  for (const axis of [['minX', 'maxX', x0, dx], ['minY', 'maxY', y0, dy]]) {
    const [minKey, maxKey, start, delta] = axis;
    if (delta === 0) {
      if (start < box[minKey] || start > box[maxKey]) return Infinity;
      continue;
    }
    let a = (box[minKey] - start) / delta;
    let b = (box[maxKey] - start) / delta;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return Infinity;
  }
  return near;
}

function exposed(round, body, bodyBounds) {
  const hitTime = segmentAabbTime(TUNE.slingX, TUNE.slingY, body.x, body.y, bodyBounds);
  for (const other of round.blocks) {
    if (other.dead || other === body) continue;
    const otherTime = segmentAabbTime(TUNE.slingX, TUNE.slingY, body.x, body.y,
      bounds(other));
    if (otherTime + 0.001 < hitTime) return false;
  }
  return true;
}

const MATERIAL_FIT = {
  nib: { glass: 2.0, wood: 1.2, stone: 0.5, iron: 0.2, tnt: 2.4, spring: 1.5, gel: 0.4 },
  chip: { glass: 4.0, wood: 1.0, stone: 0.4, iron: 0.15, tnt: 2.0, spring: 0.7, gel: 0.3 },
  wedge: { glass: 1.4, wood: 4.0, stone: 1.0, iron: 0.35, tnt: 2.0, spring: 0.6, gel: 0.5 },
  lob: { glass: 1.0, wood: 1.2, stone: 0.9, iron: 0.5, tnt: 5.0, spring: 0.7, gel: 0.2 },
  pebble: { glass: 14.0, wood: 1.0, stone: 0.35, iron: 0.25, tnt: 1.8, spring: 0.8, gel: 0.25 },
  boomer: { glass: 4.0, wood: 1.2, stone: 0.5, iron: 0.2, tnt: 2.2, spring: 0.7, gel: 0.2 },
  hulk: { glass: 3.4, wood: 1.7, stone: 0.8, iron: 0.4, tnt: 1.8, spring: 0.8, gel: 0.5 },
  spike: { glass: 2.3, wood: 0.8, stone: 4.5, iron: 0.6, tnt: 1.8, spring: 0.5, gel: 0.3 },
  zip: { glass: 8.0, wood: 0.8, stone: 0.2, iron: 0.1, tnt: 5.0, spring: 0.5, gel: 0.2 }
};

export function rankTargets(round, limit = 6) {
  const ammoId = round.bag[round.shotIndex];
  const fit = MATERIAL_FIT[ammoId] ?? MATERIAL_FIT.nib;
  const livePigs = round.pigs.filter((pig) => !pig.dead);
  const liveBodies = [...round.blocks, ...livePigs].filter((body) => !body.dead);
  const bodyBounds = new Map(liveBodies.map((body) => [body, bounds(body)]));
  const candidates = [];

  for (const block of round.blocks) {
    if (block.dead) continue;
    const box = bodyBounds.get(block);
    let supportedMass = 0;
    for (const upper of liveBodies) {
      if (upper === block || upper.y <= block.y) continue;
      const upperBounds = bodyBounds.get(upper);
      const overlap = overlapX(box, upperBounds);
      if (!(overlap > 0)) continue;
      const vertical = Math.max(0, upperBounds.minY - box.maxY);
      supportedMass += bodyMass(upper) * overlap /
        Math.max(TUNE.gridSnap, upperBounds.maxX - upperBounds.minX) / (1 + vertical * 0.18);
    }
    let dropScore = 0;
    for (const pig of livePigs) {
      const dx = Math.abs(block.x - pig.x);
      if (dx >= 5 || block.y > pig.y + 1.5) continue;
      dropScore += supportedMass * (5 - dx) / (2 + Math.abs(block.y - pig.y));
    }
    const isExposed = exposed(round, block, box);
    const materialFit = fit[block.materialId] ?? 0.5;
    const damageFinish = block.maxHp / Math.max(1, block.hp);
    let score = materialFit * (10 + supportedMass * 25 + dropScore * 40) * damageFinish;
    if (block.shapeId === 'post' || block.shapeId === 'pillar') score += supportedMass * 16;
    if (block.materialId === 'tnt') {
      score += isExposed ? 2400 : livePigs.length > 1 && ammoId !== 'lob' ? 120 : 900;
    }
    if (block.materialId === 'spring' && ammoId === 'nib') score += 1500;
    if (block.materialId === 'spring' && ammoId === 'pebble' && livePigs.length > 1) {
      score += 2000;
    }
    let closestPig = Infinity;
    for (const pig of livePigs) closestPig = Math.min(closestPig, Math.abs(block.x - pig.x));
    const pigRelevance = Math.max(0, 1 - closestPig / 8);
    score *= 0.01 + pigRelevance * 1.7;
    score *= isExposed ? 1.25 : 0.72;
    if (livePigs.length > 1 && round.bag[round.shotIndex + 1] === ammoId) {
      score /= 1 + Math.max(0, block.x) * 0.15;
    }
    const reasons = [];
    if (supportedMass > 0.5) reasons.push(`load ${supportedMass.toFixed(2)}`);
    if (dropScore > 0.25) reasons.push('drops toward pig');
    if (block.materialId === 'tnt') reasons.push(isExposed ? 'exposed TNT' : 'TNT');
    if (isExposed) reasons.push('exposed');
    candidates.push({
      kind: 'block', body: block, point: { x: block.x, y: block.y }, score,
      reasons, material: block.materialId
    });
  }

  for (const balloon of round.balloons) {
    if (balloon.dead || balloon.pigBody.dead || balloon.pigBody.balloon !== balloon) continue;
    // sim.js gates ALL damage to an airlift-held King on this flag while its balloon
    // lives (sim.js:826-827, 955-956) and siege only ends on king.dead (sim.js:1597).
    // That makes popping this balloon a precondition for winning, not a bonus like a
    // Zeppelin Hog's balloon (whose rider can still be damaged normally while aloft):
    // every shot spent elsewhere while it lives buys literally zero progress toward the
    // round's only win condition. A bigger flat number is still a bonus that some
    // structural score could in principle clear (TNT/spring bonuses alone reach
    // 2000-2400 before their multipliers) — the target needs to win unconditionally,
    // so it is scored above anything finite rather than merely raised.
    // Gated on `invulnerableWhileBalloon` alone until 2026-09-02, and that was too narrow.
    // Airlift's damage immunity was removed to weaken the card, and the win rate went UP
    // (parity 82.5% -> 87.9%, comeback 48.3% -> 61.7%) precisely because this gate stopped
    // firing: the bot went back to shooting blocks while `positionBalloons` still pinned
    // the King rigid and out of a collapse's reach. The immunity was never the whole
    // shield — the pin is — so what makes the balloon a precondition is that a King is
    // hanging from it at all, not whether a flag also grants immunity.
    if (balloon.pigBody.invulnerableWhileBalloon || balloon.pigBody.isKing) {
      candidates.push({
        kind: 'balloon', body: balloon, point: { x: balloon.x, y: balloon.y },
        score: Infinity, reasons: ['pops the King\'s balloon'], material: 'balloon'
      });
      continue;
    }
    const bonus = ammoId === 'pebble' && livePigs.length === 1 ? 2600 :
      ammoId === 'pebble' ? 80 : 60;
    candidates.push({
      kind: 'balloon', body: balloon, point: { x: balloon.x, y: balloon.y },
      score: bonus + balloon.x, reasons: ['drops Zeppelin Hog'], material: 'balloon'
    });
  }

  // Once the structure is gone, a surviving exposed pig is cleanup rather than the
  // bot's primary plan. Keeping this fallback out of the ranked structural list is
  // what prevents protected pigs from becoming the default target.
  if (!candidates.length) {
    for (const pig of livePigs) {
      candidates.push({
        kind: 'pig', body: pig, point: { x: pig.x, y: pig.y }, score: 1,
        reasons: ['exposed cleanup'], material: 'pig'
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.body.id - b.body.id);
  return candidates.slice(0, Math.max(1, Math.floor(limit)));
}

export function planShot(round, difficulty = 1, random = round?.rng) {
  const targets = rankTargets(round);
  if (!targets.length) return null;
  const target = targets[0];
  const ammoId = round.bag[round.shotIndex];
  const targetIsExposed = target.reasons.includes('exposed') ||
    target.reasons.includes('exposed TNT');
  // Any ammo can be routed at a King's balloon (see rankTargets), not just pebble. It is
  // small and drifting like a Zeppelin Hog's balloon, so it gets the same lofted arc
  // pebble already used against balloons — gated on the reason string, which only exists
  // for a King's balloon, so ordinary Zeppelin Hog targeting (pebble-only 'high' arc) is
  // untouched. The string used to say "invulnerability shield"; it was renamed once the
  // immunity flag stopped being what made the balloon worth shooting.
  const targetIsKingBalloon = target.reasons.includes("pops the King's balloon");
  let arc = ammoId === 'pebble' && target.kind === 'balloon' || targetIsKingBalloon ||
    ammoId === 'lob' && !targetIsExposed ? 'high' : 'low';
  let point = { ...target.point };
  let activation = 'near';
  if (ammoId === 'pebble') {
    if (target.kind === 'block' && target.material !== 'spring' &&
        !target.reasons.some((reason) => reason.startsWith('load '))) point.y += 1;
    activation = target.material === 'spring' ? 'none' : 'drop';
  } else if (ammoId === 'boomer') {
    let clearance = point.y;
    let columnTop = bounds(target.body).maxY;
    for (const block of round.blocks) {
      if (!block.dead && block.x <= point.x + 0.5) {
        clearance = Math.max(clearance, bounds(block).maxY - 3.5);
      }
      if (!block.dead && block.materialId === target.material &&
          Math.abs(block.x - target.body.x) < TUNE.gridSnap * 2) {
        columnTop = Math.max(columnTop, bounds(block).maxY);
      }
    }
    clearance = Math.max(clearance, columnTop - 1.5);
    point = { x: Math.min(TUNE.viewMaxX - 1, point.x + 1), y: clearance };
    activation = 'reverse';
  } else if (ammoId === 'spike') {
    activation = 'immediate';
  } else if (ammoId === 'hulk') {
    activation = 'contact';
  } else if (ammoId === 'zip') {
    let blockerTop = -Infinity;
    for (const block of round.blocks) {
      if (!block.dead && block !== target.body && block.x < point.x) {
        blockerTop = Math.max(blockerTop, bounds(block).maxY);
      }
    }
    if (blockerTop > point.y + 4) {
      arc = 'high';
      point.y -= 1;
    } else {
      point.y = Math.max(point.y, blockerTop + 0.5);
    }
    activation = 'blink';
  } else if (!AMMO_BY_ID[ammoId]?.ability) {
    activation = 'none';
  }
  return { ammoId, target, point, activation, aim: aim(round, point, difficulty, random, arc) };
}

export function shouldTap(round, plan) {
  const body = round.flying;
  if (!body || body.dead || !plan || plan.activation === 'none') return false;
  if (plan.activation === 'immediate') return true;
  const target = plan.target.point;
  if (plan.activation === 'reverse') return body.x >= target.x + 0.5;
  if (plan.activation === 'drop') {
    return body.x >= target.x - (target.x < 10 ? 4 : 5);
  }
  if (plan.activation === 'blink') return body.x >= target.x - 1.5;
  if (plan.activation === 'contact') {
    return round.world.contacts.some((contact) => contact.a === body || contact.b === body) ||
      body.x >= target.x - 0.4;
  }
  const threshold = plan.ammoId === 'lob' ? 1.8 : plan.ammoId === 'chip' ? 2.8 : 2.2;
  const dx = body.x - target.x;
  const dy = body.y - target.y;
  return dx * dx + dy * dy <= threshold * threshold || body.x >= target.x - threshold;
}
