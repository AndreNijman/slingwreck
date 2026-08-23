#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../build.js';
import {
  autoCompleteBlueprint,
  cleanName,
  constantTimeEqual,
  hashPassword,
  lobbyIsStale,
  originAllowed,
  p61NotImplemented,
  partitionLobbies,
  roomKey,
  validateBlueprintSubmission
} from '../worker.js';

const BUILD_OPTIONS = { budget: 110, cards: [], seed: 1 };
const REGISTRY_STALE = 30_000;
const VALID = {
  v: 1,
  blocks: [],
  pigs: [
    ['runt', 2, 0.296875, 0],
    ['king', 12, 0.6875, 0],
    ['runt', 22, 0.296875, 0]
  ]
};

test('passwords are SHA-256 hashes and compare in constant time', async () => {
  const [first, same, different, empty] = await Promise.all([
    hashPassword('paper crown'),
    hashPassword('paper crown'),
    hashPassword('paper crowns'),
    hashPassword('')
  ]);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, 'paper crown');
  assert.equal(empty.length, 64);
  assert.equal(constantTimeEqual(first, same), true);
  assert.equal(constantTimeEqual(first, different), false);
  assert.equal(constantTimeEqual(first, first.slice(1)), false);
});

test('cleanName keeps printable ASCII, collapses space, and caps length', () => {
  assert.equal(cleanName('  An\n dré\tThe Builder  ', 'fallback', 14), 'An drThe Build');
  assert.equal(cleanName('☃\n', 'fallback', 14), 'fallback');
  assert.equal(cleanName('abcdefghijklmnopqrstuvwxyz', '', 5), 'abcde');
});

test('origin allowlist accepts only the production families and localhost', () => {
  for (const origin of [
    'https://slingwreck.andrenijman.com',
    'https://games.andrenijman.com',
    'https://slingwreck-relay.example.workers.dev',
    'http://localhost:8787',
    'https://127.0.0.1:4173'
  ]) assert.equal(originAllowed(origin), true, origin);
  for (const origin of [
    '',
    'null',
    'http://slingwreck.andrenijman.com',
    'https://andrenijman.com.evil.example',
    'https://workers.dev.evil.example',
    'https://example.com',
    'not an origin'
  ]) assert.equal(originAllowed(origin), false, origin);
});

test('room keys are stable, bounded, printable identifiers', () => {
  assert.equal(roomKey('  My!!!  Siege_Room-1  '), 'my siege_room-1');
  assert.equal(roomKey('Mý Røøm'), 'm rm');
  assert.equal(roomKey('A'.repeat(40)), 'a'.repeat(24));
});

test('blueprint submission accepts a stable authored blueprint', () => {
  const encoded = encode(VALID);
  const result = validateBlueprintSubmission(encoded, BUILD_OPTIONS);
  assert.equal(result.ok, true);
  assert.equal(result.encoded, encoded);
  assert.deepEqual(result.blueprint, VALID);
  assert.equal(Object.hasOwn(result, 'settledBlueprint'), false);
});

test('blueprint rejection is reasoned, private-ready data and never throws', () => {
  const malformed = validateBlueprintSubmission('%%% hostile', BUILD_OPTIONS);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.stage, 'decode');
  assert.equal(malformed.reason, 'invalid-base64');
  assert.deepEqual(malformed.errors[0].pieceIds, []);

  const incomplete = validateBlueprintSubmission(encode({
    v: 1,
    blocks: [],
    pigs: []
  }), BUILD_OPTIONS);
  assert.equal(incomplete.stage, 'validate');
  assert.deepEqual(incomplete.errors.map((error) => error.code), [
    'king-count', 'too-few-pigs'
  ]);

  const falling = validateBlueprintSubmission(encode({
    ...VALID,
    blocks: [['cube', 'wood', 8, 8, 0]]
  }), BUILD_OPTIONS);
  assert.equal(falling.stage, 'settle');
  assert.equal(falling.errors[0].code, 'unstable');
  assert.deepEqual(falling.errors[0].pieceIds, ['block:0']);

  const flagged = validateBlueprintSubmission(encode({
    ...VALID,
    pigs: [
      ...VALID.pigs,
      ['king', 6, 0.6875, 1],
      ['king', 18, 0.6875, 1]
    ]
  }), { ...BUILD_OPTIONS, cards: ['understudy'] });
  assert.equal(flagged.stage, 'validate');
  assert.ok(flagged.errors.some((error) => error.code === 'piece-limit' &&
    error.pieceIds.includes('pig:4')));
});

test('timer auto-completion always returns a legal authored blueprint', () => {
  const completed = autoCompleteBlueprint('', BUILD_OPTIONS);
  assert.equal(completed.ok, true);
  assert.equal(completed.autoCompleted, true);
  assert.equal(completed.blueprint.blocks.length, 0);
  assert.equal(completed.blueprint.pigs.length, 3);
  assert.equal(validateBlueprintSubmission(completed.encoded, BUILD_OPTIONS).ok, true);

  const partial = autoCompleteBlueprint(encode({
    v: 1,
    blocks: [['cube', 'wood', 8, 0.5, 0]],
    pigs: []
  }), BUILD_OPTIONS);
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.blueprint.blocks, [['cube', 'wood', 8, 0.5, 0]]);
});

test('lobby staleness is expired on reads with joinable rooms first', () => {
  const now = 1_000_000;
  assert.equal(lobbyIsStale({ updated: now - REGISTRY_STALE }, now), false);
  assert.equal(lobbyIsStale({ updated: now - REGISTRY_STALE - 1 }, now), true);
  const result = partitionLobbies(new Map([
    ['room:stale', { name: 'Stale', updated: now - REGISTRY_STALE - 1,
      phase: 'lobby', players: 1, max: 2 }],
    ['room:full', { name: 'Full', updated: now - 2, phase: 'lobby',
      players: 2, max: 2 }],
    ['room:open', { name: 'Open', updated: now - 3, phase: 'lobby',
      players: 1, max: 2 }],
    ['room:playing', { name: 'Playing', updated: now - 4, phase: 'siege',
      players: 2, max: 2 }]
  ]), now);
  assert.deepEqual(result.staleKeys, ['room:stale']);
  assert.deepEqual(result.lobbies.map((lobby) => lobby.name), ['Open', 'Full']);
  assert.equal(result.freshEntries, 3);
});

test('every deferred P6.2 handler has a loud rejection payload', () => {
  for (const feature of ['siege phase', 'preview relay', 'siege audit', 'reconnect']) {
    assert.deepEqual(p61NotImplemented(feature), {
      t: 'err',
      code: 'not-implemented',
      m: `${feature} not implemented in P6.1`
    });
  }
});
