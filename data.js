// IDs are short lowercase wire-format strings; changing one breaks saves and messages.

export const TUNE = {
  step: 1 / 60,
  gravity: 22,
  // Without these a circle on flat ground rolls at a constant speed forever: friction
  // converts sliding to rolling and then has nothing left to remove, so `isSettled`
  // never latches and every shot burns the full settleTimeout before you may fire
  // again. These two are for stability only and are deliberately small: damping cannot
  // tell a body resting on the ground from one in mid-air, and raising angular damping
  // far enough to stop a roll (8.0 still only reached 3.0 s) also drains the energy
  // that carries a pig off the edge of the plot. Rolling resistance at the contact,
  // which acts only while something rests on something, is what actually fixes it.
  linearDamping: 0.02,
  angularDamping: 0.4,
  // Global because settling is a solver floor; per-material values would invent
  // seven unauthored balance coefficients for the same game-rule failure.
  // Swept 0.05 to 0.4. Below 0.2 the world does not settle inside two seconds; above
  // roughly 0.25 a critter no longer carries a pig off the edge of the plot. This sits
  // between two walls that are closer together than they look — `tools/settle-probe.mjs`
  // currently clears the edge case by 0.046 world units — so raising it to make shots
  // resolve faster will silently make edge kills impossible. Move the probe's
  // thresholds deliberately or not at all.
  rollingFriction: 0.225,
  velocityIters: 8,
  positionIters: 3,
  baumgarte: 0.20,
  slop: 0.005,
  restitutionThreshold: 1.0,
  sleepLinear: 0.06,
  sleepAngular: 0.12,
  sleepTime: 0.55,
  maxSpeed: 90,
  plotW: 24,
  plotH: 16,
  slingX: -9,
  slingY: 2.4,
  slingRadius: 1.6,
  // The far plot edge is about 40 units away; sqrt(40 * 22) is 29.7, so 30 leaves margin.
  launchSpeedMax: 30,
  viewMinX: -13,
  viewMaxX: 26,
  settleTimeout: 6,
  roundSeconds: 180,
  buildSeconds: 90,
  draftSeconds: 25,
  winsNeeded: 3,
  maxRounds: 5,
  maxBlocks: 120,
  maxBurialDepth: 5,
  gridSnap: 0.25,
  rotSnapDeg: 15,
  previewHz: 8,
  catchUpSteps: 4,
  brittleTangentFactor: 0.5,
  blueprintSettleSeconds: 3,
  burialRayCount: 64,
  minOtherPigs: 2,
  previewW: 260,
  previewH: 150,
  disconnectGraceSeconds: 20
};

export const MATERIALS = {
  glass: {
    id: 'glass',
    name: 'glass',
    density: 0.55,
    hp: 12,
    thresh: 1.4,
    frailty: 2.2,
    cost: 1,
    restitution: 0.38, // guess: glass should be the liveliest common impact surface.
    friction: 0.16, // guess: smooth faces should preserve glancing speed.
    brittle: true
  },
  wood: {
    id: 'wood',
    name: 'wood',
    density: 0.75,
    hp: 26,
    thresh: 2.2,
    frailty: 1.0,
    cost: 2,
    restitution: 0.16, // guess: the baseline should bounce without feeling rubbery.
    friction: 0.62, // guess: timber needs enough grip for ordinary towers.
    brittle: false
  },
  stone: {
    id: 'stone',
    name: 'stone',
    density: 1.90,
    hp: 60,
    thresh: 4.0,
    frailty: 0.55,
    cost: 5,
    restitution: 0.08, // guess: masonry should lose most collision energy.
    friction: 0.78, // guess: rough blocks should resist sliding in heavy stacks.
    brittle: false
  },
  iron: {
    id: 'iron',
    name: 'iron',
    density: 2.90,
    hp: 120,
    thresh: 6.5,
    frailty: 0.28,
    cost: 12,
    restitution: 0.05, // guess: defensive iron should feel dead rather than springy.
    friction: 0.48, // guess: finished metal should slide more readily than stone.
    brittle: false
  },
  tnt: {
    id: 'tnt',
    name: 'crate of bang',
    density: 0.70,
    hp: 8,
    thresh: 1.0,
    frailty: 3.0,
    cost: 6,
    restitution: 0.14, // guess: a wooden crate should land much like wood.
    friction: 0.58, // guess: slightly lower grip helps a loose crate become hazardous.
    brittle: true,
    blastRadius: 3.2,
    blastImpulse: 90,
    blastDamage: 45
  },
  spring: {
    id: 'spring',
    name: 'spring pad',
    density: 0.60,
    hp: 20,
    thresh: 2.0,
    frailty: 1.2,
    cost: 4,
    restitution: 0.2,
    friction: 0.72, // guess: the pad must grip a structure while its face launches ammo.
    brittle: false,
    ammoRestitution: 0.92
  },
  gel: {
    id: 'gel',
    name: 'gel',
    density: 0.50,
    hp: 20,
    thresh: 3.0,
    frailty: 1.0,
    cost: 4,
    restitution: 0.03, // guess: an impulse absorber should barely rebound.
    friction: 0.90, // guess: high grip keeps the anti-Lob block from squirting away.
    brittle: false,
    absorb: 0.70
  },
  sand: {
    id: 'sand',
    name: 'sandbag',
    density: 1.20,
    hp: 35,
    thresh: 2.6,
    frailty: 0.9,
    cost: 3,
    restitution: 0.01, // guess: loose fill should be almost entirely non-bouncy.
    friction: 0.96, // guess: coarse fabric and fill should be the opposite of slippery.
    brittle: false,
    chunks: 3
  }
};

export const SHAPES = {
  cube: { id: 'cube', kind: 'box', w: 1, h: 1, area: 1 },
  slab: { id: 'slab', kind: 'box', w: 2, h: 1, area: 2 },
  beam: { id: 'beam', kind: 'box', w: 2, h: 0.5, area: 1 },
  plank: { id: 'plank', kind: 'box', w: 4, h: 0.5, area: 2 },
  post: { id: 'post', kind: 'box', w: 0.5, h: 2, area: 1 },
  pillar: { id: 'pillar', kind: 'box', w: 0.5, h: 4, area: 2 },
  // Named `tri`, not `wedge`: the ammo roster already has a `wedge` and both ids are
  // wire format, so a blueprint and a shot log would disagree about what `wedge` means.
  tri: { id: 'tri', kind: 'tri', w: 1, h: 1, area: 0.5 },
  ball: { id: 'ball', kind: 'circle', r: 0.5, area: 0.7853981633974483 }
};

// Each critter also carries a one-line `tutorial`, shown once when it first appears in a
// campaign bag. A playtester finished level after level without noticing abilities
// existed, so the game now says what a new bird does the first time it hands you one.
// Every critter needs its own face. They were all drawn in one colour with one silhouette,
// so nine distinct abilities were completely invisible: a naive playtester played the
// campaign without ever realising there was more than one kind of bird. `feature` is a
// silhouette cue as well as a colour, so a critter is still identifiable in a thumbnail,
// at speed, or to anyone who cannot separate the hues.
export const AMMO = [
  {
    id: 'nib',
    name: 'Nib',
    mass: 1.00,
    radius: 0.32,
    // the baseline: nothing to signal.
    look: { fill: '#D9563F', tone: '#A63B29', feature: 'plain' },
    tutorial: 'No trick at all. Aim well and hit something that matters.',
    ability: null,
    params: {}
  },
  {
    id: 'chip',
    name: 'Chip',
    mass: 0.70,
    radius: 0.28,
    // three tail feathers for the three it becomes.
    look: { fill: '#3E8CA8', tone: '#276274', feature: 'trio' },
    tutorial: 'Tap in the air to split into three. Glass gives up quickly.',
    ability: 'split',
    // 22 degrees BETWEEN adjacent fragments, not 22 total: three fragments at -22, 0
    // and +22 from the parent heading, 44 degrees of total fan.
    //
    // Each fragment keeps the parent's SPEED rather than a third of its momentum. That
    // is unphysical and deliberate — dividing the momentum three ways makes Chip weaker
    // than not tapping at all, which is the one thing an ability must never be. Mass is
    // divided instead, so the total energy delivered stays honest.
    params: {
      count: 3,
      spreadDeg: 22,
      keepsParentSpeed: true,
      spreadCos: 0.9271838545667874,
      spreadSin: 0.37460659341591196
    }
  },
  {
    id: 'wedge',
    name: 'Wedge',
    mass: 0.95,
    radius: 0.30,
    // a swept dart beak: it accelerates.
    look: { fill: '#E0A32C', tone: '#A8741A', feature: 'dart' },
    tutorial: 'Tap to accelerate hard. Drills straight through wood.',
    ability: 'accel',
    params: {
      speedMultiplier: 2.1
    }
  },
  {
    id: 'lob',
    name: 'Lob',
    mass: 1.60,
    radius: 0.36,
    // a lit fuse on top, and the darkest body in the bag.
    look: { fill: '#4A4038', tone: '#241F1A', feature: 'fuse' },
    tutorial: 'Tap to detonate. Leave it and the fuse fires three seconds after it lands.',
    ability: 'boom',
    params: {
      tappableAtRest: true,
      fuseSeconds: 3,
      blastRadius: 3.6,
      blastImpulse: 130,
      blastDamage: 60
    }
  },
  {
    id: 'pebble',
    name: 'Pebble',
    mass: 0.85,
    radius: 0.30,
    // pale, carrying a visible payload underneath.
    look: { fill: '#EDE0C8', tone: '#B9A98A', feature: 'egg' },
    tutorial: 'Tap to drop a heavy payload. The way over a tall front wall.',
    ability: 'drop',
    // The payload is heavier than the critter that carries it, which is the joke and
    // also the mechanic: Pebble is the answer to a tall front wall, so the thing it
    // drops has to hurt. Recoil is upward only, so the spent carrier arcs clear instead
    // of following its own payload into the rubble.
    params: {
      payloadRadius: 0.34,
      payloadMass: 1.4,
      payloadSpeed: 6,
      recoilSpeed: 4.5
    }
  },
  {
    id: 'boomer',
    name: 'Boomer',
    mass: 0.90,
    radius: 0.30,
    // a long curved tail, the shape of its return.
    look: { fill: '#6E9E58', tone: '#456B34', feature: 'hook' },
    tutorial: 'Tap to reverse. Reaches what is hiding behind the fortress.',
    ability: 'reverse',
    params: {}
  },
  {
    id: 'hulk',
    name: 'Hulk',
    mass: 2.40,
    radius: 0.40,
    // visibly the biggest, with puffed cheeks.
    look: { fill: '#C4703A', tone: '#8A4820', feature: 'bulk' },
    tutorial: 'Tap to inflate and shove. Wedge it in a gap first, even at rest.',
    ability: 'inflate',
    // The design said "3x volume" and also "0.40 -> 0.86", which are two different
    // shapes and neither is 3x: this is a 2D game, so it is area, and 3x area is 0.69.
    // Resolved as 4x AREA because the sqrt is exactly 2, so the inflated radius is a
    // clean 0.80 rather than an irrational that has to be written out to 17 digits in a
    // file the relay and the client must agree on bit for bit.
    params: {
      tappableAtRest: true,
      inflatedRadius: 0.80,
      areaMultiplier: 4,
      inflateSeconds: 0.12
    }
  },
  {
    id: 'spike',
    name: 'Spike',
    mass: 1.30,
    radius: 0.26,
    // steel grey with a hard spiked crest.
    look: { fill: '#8A9098', tone: '#5B6068', feature: 'crest' },
    tutorial: 'Tap to harden. Passes through glass and hits stone far harder.',
    ability: 'harden',
    params: {
      passThrough: 'glass',
      stoneDamageMultiplier: 1.8
    }
  },
  {
    id: 'zip',
    name: 'Zip',
    mass: 0.55,
    radius: 0.22,
    // the smallest, with speed streaks behind it.
    look: { fill: '#C049B8', tone: '#8A2E84', feature: 'streak' },
    tutorial: 'Tap to blink forward. Slips through gaps nothing else fits.',
    ability: 'blink',
    params: {
      distance: 3.5
    }
  }
];

// Built by loop, not hand-written. A hand-written index has to be edited in step with
// the array and nothing enforces that, which is the exact drift `tools/check.mjs`
// exists to catch. A `for` loop at module scope is arithmetic-free and costs nothing
// the determinism contract cares about.
export const AMMO_BY_ID = {};
for (const a of AMMO) AMMO_BY_ID[a.id] = a;

export const PIGS = {
  runt: {
    id: 'runt',
    name: 'Runt',
    hp: 1,
    cost: 3,
    radius: 0.30,
    density: 1.0, // guess: the baseline pig anchors the otherwise unauthored scale.
    thresh: 1.0,
    frailty: 1.0,
    traits: {}
  },
  swine: {
    id: 'swine',
    name: 'Swine',
    hp: 2,
    cost: 5,
    radius: 0.40,
    density: 1.0, // guess: size alone should distinguish it from the baseline.
    thresh: 1.0,
    frailty: 1.0,
    traits: {}
  },
  hogg: {
    id: 'hogg',
    name: 'Hogg',
    hp: 4,
    cost: 9,
    radius: 0.58,
    density: 1.35, // guess: extra density makes its stated glass-crushing role credible.
    thresh: 1.0,
    frailty: 1.0,
    traits: {}
  },
  helm: {
    id: 'helm',
    name: 'Helmet Hog',
    hp: 3,
    cost: 8,
    radius: 0.42,
    density: 1.12, // guess: the helmet adds modest mass without rivaling Hogg.
    thresh: 1.0,
    frailty: 1.0,
    traits: {
      armourFrom: 'above',
      armourFraction: 0.6
    }
  },
  tusk: {
    id: 'tusk',
    name: 'Tusker',
    hp: 3,
    cost: 8,
    radius: 0.44,
    density: 1.08, // guess: armour changes damage direction more than body weight.
    thresh: 1.0,
    frailty: 1.0,
    traits: {
      armourFrom: 'sling',
      armourFraction: 0.6
    }
  },
  zep: {
    id: 'zep',
    name: 'Zeppelin Hog',
    hp: 1,
    cost: 6,
    radius: 0.34,
    density: 0.60, // guess: the balloon still supplies lift, but the payload should feel light.
    thresh: 1.0,
    frailty: 1.0,
    traits: {
      balloon: true,
      driftRange: 1.5
    }
  },
  sarge: {
    id: 'sarge',
    name: 'Sarge',
    hp: 5,
    cost: 12,
    radius: 0.46,
    density: 1.05, // guess: its value comes from repair, not exceptional impact mass.
    thresh: 1.0,
    frailty: 1.0,
    traits: {
      repairEvery: 6,
      repairFraction: 0.25
    }
  },
  king: {
    id: 'king',
    name: 'King Hog',
    hp: 8,
    cost: 0,
    radius: 0.68,
    density: 1.10, // guess: its large radius already supplies most of its mass advantage.
    thresh: 1.0,
    frailty: 1.0,
    traits: {
      king: true
    }
  }
};

export const CARDS = [
  {
    id: 'iron-ration',
    name: 'Iron Ration',
    tier: 1,
    tierName: 'reinforce',
    text: 'unlock iron; 2 iron pieces per round',
    effect: { kind: 'unlock', material: 'iron', perRound: 2 }
  },
  {
    id: 'sapper',
    name: 'Sapper',
    tier: 1,
    tierName: 'reinforce',
    text: 'unlock TNT crates; 2 per round',
    effect: { kind: 'unlock', material: 'tnt', perRound: 2 }
  },
  {
    id: 'hardhats',
    name: 'Hard Hats',
    tier: 1,
    tierName: 'reinforce',
    text: 'every pig you place gets +1 hp',
    effect: { kind: 'pigHp', delta: 1 }
  },
  {
    id: 'bedrock',
    name: 'Bedrock',
    tier: 1,
    tierName: 'reinforce',
    text: 'the bottom row of your plot becomes indestructible',
    effect: { kind: 'plotRow', row: 'bottom', indestructible: true }
  },
  {
    id: 'deep-pockets',
    name: 'Deep Pockets',
    tier: 1,
    tierName: 'reinforce',
    text: '+30 scrap every round from now on',
    effect: { kind: 'budget', delta: 30 }
  },
  {
    id: 'extra-clip',
    name: 'Extra Clip',
    tier: 1,
    tierName: 'reinforce',
    text: '+2 critters in your bag every round',
    effect: { kind: 'bagSize', delta: 2 }
  },
  {
    id: 'gelworks',
    name: 'Gelworks',
    tier: 1,
    tierName: 'reinforce',
    text: 'unlock gel; 4 pieces per round',
    effect: { kind: 'unlock', material: 'gel', perRound: 4 }
  },
  {
    id: 'quarryman',
    name: 'Quarryman',
    tier: 1,
    tierName: 'reinforce',
    text: 'stone costs you 3 instead of 5',
    effect: { kind: 'materialCost', material: 'stone', cost: 3 }
  },
  {
    id: 'armoury',
    name: 'Armoury',
    tier: 1,
    tierName: 'reinforce',
    text: 'add spike and pebble to your bag pool',
    effect: { kind: 'ammoPool', add: ['spike', 'pebble'] }
  },
  {
    id: 'smokescreen',
    name: 'Smokescreen',
    tier: 2,
    tierName: 'dirty',
    text: 'their preview of your fortress updates once every 3 seconds instead of 8 times a second',
    effect: { kind: 'previewRate', intervalSeconds: 3 }
  },
  {
    id: 'understudy',
    name: 'Understudy',
    tier: 2,
    tierName: 'dirty',
    text: 'place a Decoy King. Identical in the preview. Popping it does nothing except waste their shot',
    // Costs scrap, so hiding a convincing decoy competes with the walls that protect the
    // real King. Identical stats to a King and identical in the corner preview, but it
    // does NOT satisfy the one-King placement rule — the real one still has to exist and
    // still has to obey the burial-depth limit.
    effect: {
      kind: 'decoyKing', limit: 1, previewAs: 'king', cost: 6,
      hp: 8, radius: 0.68, satisfiesKingRule: false
    }
  },
  {
    id: 'flak-hog',
    name: 'Flak Hog',
    tier: 2,
    tierName: 'dirty',
    text: 'one pig throws a stone every 4 s at incoming critters. Hitting one costs it half its speed',
    // WHICH pig is chosen by the builder in the editor, as a toggle on one placed pig.
    // Every automatic rule considered was either arbitrary or exploitable — "nearest the
    // King" invites burying it, "most exposed" invites sacrificing it — and all of them
    // hide a decision the builder would enjoy making. It also has to be deterministic
    // for replay, and a player's explicit choice is the most deterministic input there
    // is. The stone leads its target on a straight intercept; it does not track.
    effect: {
      kind: 'pigAbility',
      ability: 'flak',
      pigCount: 1,
      chosenBy: 'builder',
      intervalSeconds: 4,
      stoneRadius: 0.18,
      stoneMass: 0.5,
      stoneSpeed: 14,
      hitSpeedMultiplier: 0.5
    }
  },
  {
    id: 'springloaded',
    name: 'Spring Loaded',
    tier: 2,
    tierName: 'dirty',
    text: 'unlock spring pads; 4 per round',
    effect: { kind: 'unlock', material: 'spring', perRound: 4 }
  },
  {
    id: 'gale',
    name: 'Gale',
    tier: 2,
    tierName: 'dirty',
    text: 'a constant 2.5-unit headwind against critters fired at your fortress',
    // 2.5 is an ACCELERATION in world units per second squared, about 11% of gravity,
    // applied to critters only and never to blocks or debris. As a force it would make
    // a Zip and a Hulk behave identically, which is wrong; as an air velocity it needs
    // a drag model the solver does not have and does not need.
    effect: { kind: 'headwind', accel: 2.5, appliesTo: 'ammo', direction: 'towardSling' }
  },
  {
    id: 'bombardier',
    name: 'Bombardier',
    tier: 2,
    tierName: 'dirty',
    text: 'your first shot each round is a free Lob that does not consume a bag slot',
    effect: { kind: 'bonusShot', ammo: 'lob', position: 'first', consumesBag: false }
  },
  {
    id: 'mason',
    name: 'Mason',
    tier: 2,
    tierName: 'dirty',
    text: 'after every third enemy shot, one destroyed block of yours returns at half hp',
    // The EARLIEST destroyed block that has not already been restored and whose original
    // position is now clear. Earliest-first rebuilds the fortress from the bottom up,
    // which is what a defender wants and is also the only choice that is both
    // deterministic and explicable to the player watching it happen. "A random block" is
    // unreplayable; "the most valuable block" turns Mason into a second scoring system.
    effect: {
      kind: 'restoreBlock', everyEnemyShots: 3, hpFraction: 0.5,
      pick: 'earliestDestroyed', requireClearSpace: true
    }
  },
  {
    id: 'sappers-union',
    name: 'Sappers\' Union',
    tier: 2,
    tierName: 'dirty',
    text: 'your TNT does 1.5× damage and has 1.4× radius',
    effect: {
      kind: 'materialAbility',
      material: 'tnt',
      damageMultiplier: 1.5,
      radiusMultiplier: 1.4
    }
  },
  {
    id: 'long-arm',
    name: 'Long Arm',
    tier: 2,
    tierName: 'dirty',
    text: 'your slingshot pulls 25% further, so everything arrives faster',
    effect: { kind: 'slingPull', multiplier: 1.25 }
  },
  {
    id: 'airlift',
    name: 'Airlift',
    tier: 3,
    tierName: 'desperado',
    text: 'your King rides a balloon and drifts. The balloon must be shot down before the King can be hurt at all',
    // Same drift as a Zeppelin Hog, deliberately: the player has already learnt to lead
    // that movement, and a second, different drift to learn would be difficulty rather
    // than depth. The balloon is a separate 1 hp body, so it pops to anything, and the
    // King then falls — which on a tall fortress often finishes the job by itself.
    //
    // AIRLIFT IS A CONFIRMED BALANCE OUTLIER AND IS DELIBERATELY UNCHANGED. Measured
    // 2026-09-02 with the P7.8 gate: 82.5% [77.6%, 86.5%] round win rate at parity against
    // a 40-65% band, and a 48.3% MATCH comeback from 0-2 down against an 11.7% control —
    // x4.14, intervals not overlapping. Two harness artefacts were found and removed before
    // that was the card's own doing (a bot that did not know to pop the shield, 1.6 points;
    // a fortress builder respending the scrap the flight lane freed, 4.3 points).
    //
    // `invulnerableUntilPopped: false` was tried and REVERTED, because it is not the lever:
    //
    //   immunity on,  bot clears balloon   parity 82.5%   comeback 48.3%  x4.14
    //   immunity off, bot ignores balloon  parity 87.9%   comeback 61.7%  x5.29
    //   immunity off, bot clears balloon   parity 81.9%   comeback 45.0%  x3.85
    //
    // Rows one and three overlap on both measurements, so removing the immunity buys
    // nothing while costing the card its printed text. The middle row is the instructive
    // one: it looked like a nerf and played as a buff, because bots.js gated its balloon
    // priority on `invulnerableWhileBalloon`, so clearing the flag also removed the bot's
    // reason to shoot the balloon. That gate is now widened to any King's balloon.
    //
    // The remaining suspect is the kinematic pin: sim.js's positionBalloons overwrites a
    // ballooned pig's x, y, vx, vy and av every step, so the King cannot be crushed,
    // shoved, buried or carried off the plot however the fortress collapses. Nothing in
    // this file reaches that, and changing it means re-running the four-engine determinism
    // gate. Left as measured evidence for a deliberate sim change rather than guessed at a
    // fourth time.
    effect: {
      kind: 'kingBalloon', invulnerableUntilPopped: true,
      driftRange: 1.5, driftSeconds: 5, balloonHp: 1, balloonRadius: 0.42, lift: 0.9
    }
  },
  {
    id: 'remote-detonator',
    name: 'Remote Detonator',
    tier: 3,
    tierName: 'desperado',
    text: 'your TNT is inert until you tap once per round, then every crate fires at the same instant',
    effect: { kind: 'remoteTnt', tapsPerRound: 1, simultaneous: true }
  },
  {
    id: 'second-slingshot',
    name: 'Second Slingshot',
    tier: 3,
    tierName: 'desperado',
    text: 'you fire from two slingshots at different heights, alternating, which opens angles that do not otherwise exist',
    // The second sling sits at the same x, 3.6 units higher. Same x on purpose: two
    // different horizontal positions would change the range of every shot and quietly
    // rebalance the whole bag, whereas pure height only changes the ANGLES available,
    // which is what the card is actually selling.
    effect: {
      kind: 'slingshots', count: 2, alternating: true,
      secondSlingYOffset: 3.6
    }
  },
  {
    id: 'kingslayer',
    name: 'Kingslayer',
    tier: 3,
    tierName: 'desperado',
    text: 'one critter in your bag homes weakly toward the enemy King after the tap',
    // "Weakly" is 9 units per second squared applied PERPENDICULAR to current velocity
    // for 1.5 s after the tap. Perpendicular-only steering bends the arc without adding
    // speed, so a Kingslayer cannot outrun a normal shot; and 1.5 s of it corrects an
    // aim that was already close without rescuing one that was not. A card that lets a
    // player fire straight up and still hit is not a comeback, it is an off switch.
    effect: {
      kind: 'ammoHoming', ammoCount: 1, target: 'king', trigger: 'tap',
      steerAccel: 9, steerSeconds: 1.5
    }
  },
  {
    id: 'tectonic',
    name: 'Tectonic',
    tier: 3,
    tierName: 'desperado',
    text: 'your plot tilts 8° away from the slingshot, so everything that breaks rolls back toward the shooter and out of play',
    // The sim may not call implementation-defined trigonometry. These are the literal
    // cosine and sine of 8 degrees, stored beside the authored angle so every host uses
    // the same plot transform bit for bit.
    effect: {
      kind: 'plotTilt', degrees: 8, direction: 'awayFromSling',
      cos: 0.9902680687415704, sin: 0.13917310096006544
    }
  },
  {
    id: 'conscription',
    name: 'Conscription',
    tier: 3,
    tierName: 'desperado',
    text: '+5 free Runts placed automatically in the gaps of your fortress each round',
    effect: { kind: 'autoPig', pig: 'runt', count: 5, placement: 'gaps', cost: 0 }
  },
  {
    id: 'heavy-industry',
    name: 'Heavy Industry',
    tier: 3,
    tierName: 'desperado',
    text: 'iron costs you 6 instead of 12, and you may place unlimited iron',
    effect: { kind: 'materialCost', material: 'iron', cost: 6, limit: null }
  }
];

export const CARDS_BY_ID = {};
export const CARDS_BY_TIER = { 1: [], 2: [], 3: [] };
for (const c of CARDS) {
  CARDS_BY_ID[c.id] = c;
  CARDS_BY_TIER[c.tier].push(c);
}

export const SCORE = {
  siege: {
    blockDestroyedCostMultiplier: 10,
    blockOffPlotBonusCostMultiplier: 15,
    pigs: {
      runt: 300,
      zep: 400,
      swine: 500,
      helm: 700,
      tusk: 700,
      hogg: 900,
      sarge: 1000
    },
    unusedAmmo: 400,
    breach: 1200
  },
  campaign: {
    unusedAmmo: 10000,
    pig: 5000,
    destroyedBlockCostMultiplier: 100
  }
};

export const BUDGET = {
  base: 110, perRound: 25, perDeficit: 15, earlyLockPer10s: 2, winnerBonus: 10
};

export const BAG = {
  base: 6, perRound: 1
};

// Ordered most-specific-first; the first rule whose conditions hold wins.
//
// The design listed "down by 2" and "down by 2 at match point" as separate cases, but
// in a first-to-three match they are the same case: being two rounds down means the
// opponent is on two wins, which is match point by definition. The unreachable rule is
// gone rather than left in to be discovered by whoever debugs the draft in P7.
export const CARD_TIER_RULES = [
  { deficit: 2, tiers: [3] },
  { deficit: 1, minRound: 4, tiers: [1, 2] },
  { deficit: 1, tiers: [1] }
];

export const EPISODES = [
  {
    number: 1,
    name: 'Sty',
    theme: 'flat ground, wood and glass',
    introduces: ['nib', 'chip', 'wedge', 'runt', 'swine']
  },
  {
    number: 2,
    name: 'Quarry',
    theme: 'slopes, stone, gaps to drop into',
    introduces: ['lob', 'spike', 'hogg', 'helm', 'tnt']
  },
  {
    number: 3,
    name: 'Highwind',
    theme: 'towers, spring pads, wind',
    introduces: ['pebble', 'boomer', 'tusk', 'zep']
  },
  {
    number: 4,
    name: 'Ironworks',
    theme: 'iron, gel, moving platforms',
    introduces: ['hulk', 'zip', 'sarge', 'iron', 'gel']
  }
];

// Control copy deliberately does not live here. `data.js` is the numbers the client,
// the relay and the harness must agree on; the relay has no opinion about the mouse
// wheel. UI strings belong in game.js.
