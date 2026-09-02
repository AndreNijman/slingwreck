import { MATERIALS, PIGS, SHAPES, TUNE } from './data.js?v=20260902-2';
import { PIG_Y_QUANTUM, seatPigY } from './build.js?v=20260902-2';
import { makeWorld, maxPenetration } from './physics.js?v=20260902-2';
import { BLUEPRINT_VERSION, instantiate } from './sim.js?v=20260902-2';

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function snapped(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  const result = Math.round(value / TUNE.gridSnap) * TUNE.gridSnap;
  return result === 0 ? 0 : result;
}

function materialAt(value, index, label = 'material') {
  const choices = Array.isArray(value) ? value : [value];
  if (!choices.length) throw new RangeError(`${label} must not be empty`);
  const material = choices[index % choices.length];
  if (!MATERIALS[material]) throw new RangeError(`unknown ${label}: ${material}`);
  return material;
}

function makeFragment(label, blocks = [], pigs = []) {
  return { label, blocks, pigs };
}

function block(shape, material, x, y, rotation = 0) {
  if (!SHAPES[shape]) throw new RangeError(`unknown shape: ${shape}`);
  if (!MATERIALS[material]) throw new RangeError(`unknown material: ${material}`);
  if (!Number.isInteger(rotation)) throw new TypeError('rotation must be an integer step');
  return [shape, material, snapped(x, 'block x'), snapped(y, 'block y'), rotation];
}

function pig(blocks, id, x, placementY) {
  if (!PIGS[id]) throw new RangeError(`unknown pig: ${id}`);
  const snappedX = snapped(x, 'pig x');
  const y = seatPigY(blocks, id, snappedX, placementY);
  if (y === null) throw new RangeError('pig placement has no surface beneath it');
  return [id, snappedX, y, 0];
}

function occupants(value, bayCount, storeys, label) {
  const source = value ?? [];
  if (!Array.isArray(source)) throw new TypeError(`${label} pigs must be an array`);
  return source.map((entry, index) => {
    const item = typeof entry === 'string' ? { id: entry } : entry;
    if (!item || typeof item !== 'object') throw new TypeError(`${label} pig must be an id or object`);
    const bay = item.bay ?? index % bayCount;
    const storey = item.storey ?? Math.floor(index / bayCount);
    integer(bay, `${label} pig bay`, 0, bayCount - 1);
    integer(storey, `${label} pig storey`, 0, storeys - 1);
    if (!PIGS[item.id]) throw new RangeError(`unknown pig: ${item.id}`);
    return { id: item.id, bay, storey };
  });
}

function contactDepth(contact) {
  const a = contact.a;
  const b = contact.b;
  const ax = a.x + a.c * contact.localAx - a.s * contact.localAy;
  const ay = a.y + a.s * contact.localAx + a.c * contact.localAy;
  const bx = b.x + b.c * contact.localBx - b.s * contact.localBy;
  const by = b.y + b.s * contact.localBx + b.c * contact.localBy;
  return -((bx - ax) * contact.nx + (by - ay) * contact.ny);
}

function groupFor(body, blockGroups, pigGroups) {
  if (body.role === 'block') return blockGroups[body.blueprintIndex];
  if (body.role === 'pig') return pigGroups[body.blueprintIndex];
  if (body.role === 'balloon') return pigGroups[body.pigBody.blueprintIndex];
  return -1;
}

function checkedFragments(fragments, crossOnly) {
  if (!fragments.length) throw new RangeError('at least one motif is required');
  const blocks = [];
  const pigs = [];
  const blockGroups = [];
  const pigGroups = [];
  for (let group = 0; group < fragments.length; group++) {
    const fragment = fragments[group];
    if (!fragment || !Array.isArray(fragment.blocks) || !Array.isArray(fragment.pigs)) {
      throw new TypeError('a motif must return block and pig tuple arrays');
    }
    for (const tuple of fragment.blocks) {
      if (!Number.isInteger(tuple[4]) ||
          !Number.isInteger(tuple[2] / TUNE.gridSnap) ||
          !Number.isInteger(tuple[3] / TUNE.gridSnap)) {
        throw new RangeError(`${fragment.label ?? `motif ${group}`} contains an unsnapped block`);
      }
      blocks.push(tuple);
      blockGroups.push(group);
    }
    for (const tuple of fragment.pigs) {
      if (!Number.isInteger(tuple[1] / TUNE.gridSnap) ||
          !Number.isInteger(tuple[2] / PIG_Y_QUANTUM)) {
        throw new RangeError(`${fragment.label ?? `motif ${group}`} contains an unsnapped pig`);
      }
      pigs.push(tuple);
      pigGroups.push(group);
    }
  }

  const blueprint = { v: BLUEPRINT_VERSION, blocks, pigs };
  const world = makeWorld({ gravity: 0 });
  instantiate(world, blueprint);
  maxPenetration(world);
  for (const contact of world.contacts) {
    if (contact.a.role === 'ground' || contact.b.role === 'ground' ||
        contactDepth(contact) <= TUNE.slop) continue;
    const left = groupFor(contact.a, blockGroups, pigGroups);
    const right = groupFor(contact.b, blockGroups, pigGroups);
    if (crossOnly && left === right) continue;
    const leftLabel = fragments[left]?.label ?? `motif ${left}`;
    const rightLabel = fragments[right]?.label ?? `motif ${right}`;
    throw new RangeError(`motif overlap: ${leftLabel} collides with ${rightLabel}`);
  }
  return blueprint;
}

export function assertNoMotifOverlap(fragment) {
  checkedFragments([fragment], false);
  return fragment;
}

export function assertNoMotifCollision(left, right) {
  checkedFragments([left, right], true);
  return true;
}

export function composeMotifs(...fragments) {
  for (const fragment of fragments) assertNoMotifOverlap(fragment);
  return checkedFragments(fragments, true);
}

export function tower(options = {}) {
  const x = snapped(options.x ?? 0, 'tower x');
  const y = snapped(options.y ?? 0, 'tower y');
  const width = integer(options.width ?? 4, 'tower width', 2, 12);
  if (width % 2) throw new RangeError('tower width must be an even number of units');
  // Four unloaded storeys survive, but an occupant on the top floor turns that
  // version into a solver-balanced needle. Three is the largest reusable promise.
  const storeys = integer(options.storeys ?? 2, 'tower storeys', 1, 3);
  const materials = options.materials ?? 'wood';
  const capped = options.capped ?? true;
  const bayCount = width / 2;
  const blocks = [];
  for (let storey = 0; storey < storeys; storey++) {
    const floor = y + storey * 3;
    const material = materialAt(materials, storey, 'tower material');
    for (let support = 0; support <= bayCount; support++) {
      blocks.push(block('post', material, x + support * 2, floor + 1));
    }
    if (storey < storeys - 1 || capped) {
      for (let bay = 0; bay < bayCount; bay++) {
        blocks.push(block('slab', material, x + bay * 2 + 1, floor + 2.5));
      }
    }
  }
  const pigs = occupants(options.pigs, bayCount, storeys, 'tower').map((item) =>
    pig(blocks, item.id, x + item.bay * 2 + 1, y + item.storey * 3 + 0.5));
  return makeFragment('tower', blocks, pigs);
}

export function bunker(options = {}) {
  const x = snapped(options.x ?? 0, 'bunker x');
  const y = snapped(options.y ?? 0, 'bunker y');
  const width = integer(options.width ?? 4, 'bunker width', 2, 12);
  if (width % 2) throw new RangeError('bunker width must be an even number of units');
  const wallHeight = integer(options.wallHeight ?? 2, 'bunker wall height', 1, 5);
  const wallMaterial = options.wallMaterial ?? 'wood';
  const frontMaterial = options.frontMaterial ?? wallMaterial;
  const backMaterial = options.backMaterial ?? wallMaterial;
  const dividerMaterial = options.dividerMaterial ?? wallMaterial;
  const roofMaterial = options.roofMaterial ?? wallMaterial;
  materialAt(wallMaterial, 0, 'bunker wall material');
  materialAt(frontMaterial, 0, 'bunker front material');
  materialAt(backMaterial, 0, 'bunker back material');
  materialAt(dividerMaterial, 0, 'bunker divider material');
  materialAt(roofMaterial, 0, 'bunker roof material');
  const blocks = [];
  // Each two-unit roof slab owns a wall at both ends. Wider bunkers are therefore
  // a row of cavities, not a long unsupported roof that only happens to stand at
  // small widths.
  for (let support = 0; support <= width / 2; support++) {
    const material = support === 0 ? frontMaterial :
      support === width / 2 ? backMaterial : dividerMaterial;
    for (let row = 0; row < wallHeight; row++) {
      blocks.push(block('cube', material, x + support * 2, y + row + 0.5));
    }
  }
  for (let bay = 0; bay < width / 2; bay++) {
    blocks.push(block('slab', roofMaterial, x + bay * 2 + 1, y + wallHeight + 0.5));
  }
  const placedPigs = occupants(options.pigs ?? ['runt'], width / 2, 1, 'bunker')
    .map((item) => pig(blocks, item.id, x + item.bay * 2 + 1, y + 0.5));
  for (const tuple of placedPigs) {
    if (PIGS[tuple[0]].radius > wallHeight - SHAPES.cube.h / 2) {
      throw new RangeError('bunker wall height is too short for its pigs');
    }
  }
  return makeFragment('bunker', blocks, placedPigs);
}

export function bridge(options = {}) {
  const x = snapped(options.x ?? 0, 'bridge x');
  const y = snapped(options.y ?? 0, 'bridge y');
  const span = integer(options.span ?? 8, 'bridge span', 2, 16);
  const supports = integer(options.supports ?? span / 2 + 1, 'bridge supports', 2, 9);
  if (span !== (supports - 1) * 2) {
    throw new RangeError('bridge supports must be two units apart across the span');
  }
  const supportHeight = integer(options.supportHeight ?? 2, 'bridge support height', 1, 4);
  const supportMaterial = options.supportMaterial ?? 'wood';
  const deckMaterial = options.deckMaterial ?? supportMaterial;
  materialAt(supportMaterial, 0, 'bridge support material');
  materialAt(deckMaterial, 0, 'bridge deck material');
  const blocks = [];
  for (let support = 0; support < supports; support++) {
    for (let row = 0; row < supportHeight; row++) {
      blocks.push(block('cube', supportMaterial, x + support * 2, y + row + 0.5));
    }
  }
  for (let bay = 0; bay < supports - 1; bay++) {
    blocks.push(block('slab', deckMaterial, x + bay * 2 + 1, y + supportHeight + 0.5));
  }
  const placedPigs = occupants(options.pigs, supports - 1, 1, 'bridge')
    .map((item) => pig(blocks, item.id, x + item.bay * 2 + 1, y + 0.5));
  return makeFragment('bridge', blocks, placedPigs);
}

export function stack(options = {}) {
  const x = snapped(options.x ?? 0, 'stack x');
  const y = snapped(options.y ?? 0, 'stack y');
  const height = integer(options.height ?? 4, 'stack height', 1, 10);
  const shape = options.shape ?? 'cube';
  if (shape !== 'cube' && shape !== 'slab') {
    throw new RangeError('stack shape must be cube or slab');
  }
  const materials = options.materials ?? 'wood';
  const blocks = [];
  for (let row = 0; row < height; row++) {
    blocks.push(block(shape, materialAt(materials, row, 'stack material'), x, y + row + 0.5));
  }
  return makeFragment('stack', blocks, []);
}

export function keep(options = {}) {
  const x = snapped(options.x ?? 0, 'keep x');
  const y = snapped(options.y ?? 0, 'keep y');
  const outerWidth = integer(options.outerWidth ?? 12, 'keep outer width', 8, 16);
  const towerWidth = integer(options.towerWidth ?? 4, 'keep tower width', 2, 8);
  if (outerWidth % 2 || towerWidth % 2 || towerWidth > outerWidth - 4) {
    throw new RangeError('keep widths must be even with two units clear around the tower');
  }
  const wallHeight = integer(options.wallHeight ?? 3, 'keep wall height', 1, 5);
  const wallMaterial = options.wallMaterial ?? 'stone';
  const wallBlocks = [];
  for (let row = 0; row < wallHeight; row++) {
    wallBlocks.push(block('cube', wallMaterial, x, y + row + 0.5));
    wallBlocks.push(block('cube', wallMaterial, x + outerWidth, y + row + 0.5));
  }
  wallBlocks.push(block('slab', wallMaterial, x, y + wallHeight + 0.5));
  wallBlocks.push(block('slab', wallMaterial, x + outerWidth, y + wallHeight + 0.5));
  const inner = tower({
    x: x + (outerWidth - towerWidth) / 2,
    y,
    width: towerWidth,
    storeys: options.storeys ?? 2,
    materials: options.towerMaterials ?? ['wood', 'stone'],
    capped: options.capped ?? true,
    pigs: options.pigs ?? [{ id: 'king', bay: 0, storey: 0 }]
  });
  const combined = composeMotifs(makeFragment('keep outer wall', wallBlocks, []), inner);
  return makeFragment('keep', combined.blocks, combined.pigs);
}

export function scaffold(options = {}) {
  const x = snapped(options.x ?? 0, 'scaffold x');
  const y = snapped(options.y ?? 0, 'scaffold y');
  const bays = integer(options.bays ?? 1, 'scaffold bays', 1, 4);
  const height = options.height ?? 2;
  if (height !== 2 && height !== 4) throw new RangeError('scaffold height must be 2 or 4');
  const postMaterial = options.postMaterial ?? 'wood';
  const plankMaterial = options.plankMaterial ?? postMaterial;
  materialAt(postMaterial, 0, 'scaffold post material');
  materialAt(plankMaterial, 0, 'scaffold plank material');
  const postShape = height === 2 ? 'post' : 'pillar';
  const blocks = [];
  for (let support = 0; support <= bays; support++) {
    blocks.push(block(postShape, postMaterial, x + support * 4, y + height / 2));
  }
  for (let bay = 0; bay < bays; bay++) {
    blocks.push(block('plank', plankMaterial, x + bay * 4 + 2, y + height + 0.25));
  }
  const placedPigs = occupants(options.pigs, bays, 1, 'scaffold')
    .map((item) => pig(blocks, item.id, x + item.bay * 4 + 2, y + 0.5));
  return makeFragment('scaffold', blocks, placedPigs);
}
