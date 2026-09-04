#!/usr/bin/env node

import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AMMO_BY_ID, MATERIALS, PIGS, SHAPES } from '../data.js?v=20260904-1';
import { decode, encode, settleTest, validate } from '../build.js?v=20260904-1';
import { EPISODES, LEVELS } from '../levels.js?v=20260904-1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS_FILE = join(ROOT, 'levels.js');
const LEVEL_MOVE_LIMIT = 0.02;

function usage(message = null) {
  if (message) console.error(message);
  console.error('usage: node tools/level-export.mjs --lint');
  console.error('       node tools/level-export.mjs --export <id>');
  console.error('       node tools/level-export.mjs --import <id> <blueprint>');
  process.exitCode = 2;
}

function findLevel(id, levels = LEVELS) {
  const level = levels.find((candidate) => candidate.id === id);
  if (!level) throw new RangeError(`unknown level id: ${id}`);
  return level;
}

function starsAreSet(stars) {
  return Array.isArray(stars) && stars.length === 3 &&
    stars.every((threshold) => Number.isFinite(threshold));
}

export function costEquivalent(blueprint) {
  let cost = 0;
  for (const tuple of blueprint.blocks) {
    cost += MATERIALS[tuple[1]].cost * SHAPES[tuple[0]].area;
  }
  for (const tuple of blueprint.pigs) cost += PIGS[tuple[0]].cost;
  return cost;
}

function schemaErrors(level, ids) {
  const errors = [];
  if (typeof level.id !== 'string' || !level.id) errors.push('missing id');
  else if (ids.has(level.id)) errors.push('duplicate id');
  ids.add(level.id);
  if (!EPISODES.some((episode) => episode.number === level.episode)) {
    errors.push(`unknown episode ${level.episode}`);
  }
  if (!Number.isInteger(level.index) || level.index < 1) errors.push('invalid index');
  if (typeof level.name !== 'string' || !level.name) errors.push('missing name');
  if (!Array.isArray(level.bag) || level.bag.some((id) => !AMMO_BY_ID[id])) {
    errors.push('invalid bag');
  }
  return errors;
}

function formatCost(cost) {
  return Number.isInteger(cost) ? String(cost) : cost.toFixed(2);
}

export function lintLevels(levels = LEVELS) {
  let failures = 0;
  const ids = new Set();
  const missingStars = [];
  const rows = [];
  let exactRoundTrips = 0;
  for (const level of levels) {
    const schema = schemaErrors(level, ids);
    let validation = { ok: false, errors: [] };
    let settle = {
      ok: false,
      settled: false,
      maxMovement: NaN,
      movedPieces: [],
      deadPigs: []
    };
    let thrown = null;
    let byteIdentical = false;
    try {
      validation = validate(level.blueprint, {
        mode: 'campaign',
        cards: level.cards ?? []
      });
      settle = settleTest(level.blueprint);
      const wire = encode(level.blueprint);
      const decoded = decode(wire);
      byteIdentical = decoded?.ok !== false && encode(decoded) === wire;
      if (byteIdentical) exactRoundTrips++;
    } catch (error) {
      thrown = error;
    }
    const starsSet = starsAreSet(level.stars);
    if (!starsSet) missingStars.push(level.id);
    const pieceCount = (level.blueprint?.blocks?.length ?? 0) +
      (level.blueprint?.pigs?.length ?? 0);
    let cost = NaN;
    try {
      cost = costEquivalent(level.blueprint);
    } catch (error) {
      thrown ??= error;
    }
    const movementPassed = Number.isFinite(settle.maxMovement) &&
      settle.maxMovement < LEVEL_MOVE_LIMIT;
    const passed = !schema.length && !thrown && validation.ok && settle.ok &&
      movementPassed && byteIdentical;
    if (!passed) failures++;
    const issues = [
      ...schema,
      ...validation.errors.map((error) => error.code),
      ...(settle.ok ? [] : [
        settle.settled ? 'moved-during-settle' : 'did-not-settle',
        ...settle.deadPigs.map((id) => `dead:${id}`)
      ]),
      ...(movementPassed ? [] : [`max-movement-not-under-${LEVEL_MOVE_LIMIT}`]),
      ...(byteIdentical ? [] : ['codec-round-trip-changed-bytes']),
      ...(thrown ? [thrown.message] : [])
    ];
    rows.push({
      id: level.id,
      pieceCount,
      cost,
      settled: settle.ok,
      maxMovement: settle.maxMovement,
      starsSet,
      byteIdentical,
      issues,
      passed
    });
  }

  console.log('level    pieces  cost-eq  settles  max-move  stars');
  for (const row of rows) {
    const movement = Number.isFinite(row.maxMovement) ? row.maxMovement.toFixed(5) : 'n/a';
    console.log(
      `${row.id.padEnd(9)}${String(row.pieceCount).padStart(6)}  ` +
      `${formatCost(row.cost).padStart(7)}  ` +
      `${(row.settled ? 'yes' : 'NO').padEnd(7)}  ` +
      `${movement.padStart(8)}  ${row.starsSet ? 'set' : 'missing'}`
    );
    if (row.issues.length) console.log(`  ${row.passed ? 'note' : 'FAIL'}: ${row.issues.join(', ')}`);
  }
  if (missingStars.length) {
    console.log(`stars awaiting P5.8 bot data: ${missingStars.join(', ')}`);
  }
  console.log(`codec round trips byte-identically: ${exactRoundTrips}/${levels.length}`);
  if (failures) console.error(`level lint failed: ${failures}/${levels.length} level(s)`);
  else console.log(`level lint passed: ${levels.length}/${levels.length} level(s)`);
  return { ok: failures === 0, failures, rows, missingStars };
}

function importedLiteral(blueprint, indent) {
  const lines = JSON.stringify(blueprint, null, 2).split('\n');
  return lines.map((line, index) => index ? indent + line : line).join('\n');
}

export function rewriteLevelSource(source, id, blueprint) {
  const startMarker = `/* level-export:${id}:start */`;
  const endMarker = `/* level-export:${id}:end */`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`levels.js has no import markers for ${id}`);
  }
  if (source.indexOf(startMarker, start + startMarker.length) >= 0 ||
      source.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new Error(`levels.js has duplicate import markers for ${id}`);
  }
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const indent = source.slice(lineStart, start).match(/^\s*/)[0];
  return source.slice(0, start + startMarker.length) + ' ' +
    importedLiteral(blueprint, indent) + ' ' + source.slice(end);
}

function atomicWrite(path, contents, mode) {
  const temporary = `${path}.level-export-${process.pid}`;
  try {
    writeFileSync(temporary, contents, 'utf8');
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch (unused) { /* nothing to clean up */ }
    throw error;
  }
}

async function importLevel(id, wire) {
  findLevel(id);
  const decoded = decode(wire);
  if (decoded?.ok === false) throw new Error(`blueprint decode failed: ${decoded.reason}`);
  const expected = encode(decoded);
  const before = readFileSync(LEVELS_FILE, 'utf8');
  const mode = statSync(LEVELS_FILE).mode;
  const after = rewriteLevelSource(before, id, decoded);
  atomicWrite(LEVELS_FILE, after, mode);
  try {
    const url = pathToFileURL(LEVELS_FILE);
    url.searchParams.set('level-export', `${process.pid}-${Date.now()}`);
    const updated = await import(url.href);
    const actual = encode(findLevel(id, updated.LEVELS).blueprint);
    if (actual !== expected) throw new Error('written blueprint failed its byte-identical export check');
  } catch (error) {
    atomicWrite(LEVELS_FILE, before, mode);
    throw error;
  }
  console.log(`imported ${id}; byte-identical export ${expected}`);
}

async function main(args) {
  if (args.length === 1 && args[0] === '--lint') {
    const result = lintLevels();
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args.length === 2 && args[0] === '--export') {
    console.log(encode(findLevel(args[1]).blueprint));
    return;
  }
  if (args.length === 3 && args[0] === '--import') {
    await importLevel(args[1], args[2]);
    return;
  }
  usage();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
