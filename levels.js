import { EPISODES as DATA_EPISODES } from './data.js?v=20260902-3';
import {
  bunker,
  composeMotifs,
  stack,
  tower
} from './motifs.js?v=20260902-3';

export const EPISODES = DATA_EPISODES;

// The second argument is owned by tools/level-export.mjs. Motifs remain beside an
// imported editor tuning so the authored intent stays visible instead of being lost
// behind a generated tuple dump.
function tunedBlueprint(authored, imported) {
  return imported ?? authored;
}

function block(shape, material, x, y, rotation = 0) {
  return [shape, material, x, y, rotation];
}

// Pig centres use the codec's 1/64-unit grid. Authored pigs here are always seated on
// flat quarter-grid surfaces, so their quantised radius is the only offset required.
const PIG_SEAT = {
  runt: 19 / 64,
  swine: 26 / 64,
  hogg: 37 / 64,
  helm: 27 / 64,
  tusk: 28 / 64,
  zep: 22 / 64,
  sarge: 30 / 64
};
function pig(id, x, surfaceY = 0) {
  return [id, x, surfaceY + PIG_SEAT[id], 0];
}

function structure(label, blocks, pigs) {
  return { label, blocks, pigs };
}

// balance-stars:start
// P5.8 provenance: tools/balance.mjs --campaign, seeds 20905, 40503, 49374, 2823, 24301, 659918, 61453.
// Formula: 1★ = pig count × 5,000 (the completion floor); 2★ = the median bot
// clear rounded down to 100; normally 3★ = the first 100-point step above its best.
// If best is within 3% of median, 3★ = best + the cheaper of 500 or the least
// valuable block left by a best run. If none remains, 3★ = best (and 2★ steps down).
// balance-stars:end

export const LEVELS = [
  // Idea: Break the lone glass leg and let the heavy roof fall on the Runt.
  {
    id: 'sty-01',
    episode: 1,
    index: 1,
    name: 'One Bad Leg',
    blueprint: tunedBlueprint(
      composeMotifs(structure('one bad leg', [
        block('post', 'glass', 13, 1),
        block('post', 'wood', 16, 1),
        block('plank', 'wood', 14.5, 2.25)
      ], [pig('runt', 14.5)])),
      /* level-export:sty-01:start */ null /* level-export:sty-01:end */
    ),
    bag: ['nib', 'nib'],
    stars: [5000, 15100, 15300]
  },

  // Idea: Arc Nib onto the exposed Runt perched above the glass shelf instead of battering its post.
  {
    id: 'sty-02',
    episode: 1,
    index: 2,
    name: 'Shelf Service',
    blueprint: tunedBlueprint(
      composeMotifs(structure('sling-side shelf', [
        block('post', 'wood', 15, 1),
        block('plank', 'glass', 15, 2.25)
      ], [pig('runt', 15, 2.5)])),
      /* level-export:sty-02:start */ null /* level-export:sty-02:end */
    ),
    bag: ['nib', 'nib'],
    stars: [5000, 15200, 15400]
  },

  // Idea: Break the bunker’s lone glass end wall so its roof drops into the Runt’s chamber.
  {
    id: 'sty-03',
    episode: 1,
    index: 3,
    name: 'Way In',
    blueprint: tunedBlueprint(
      composeMotifs(bunker({
        x: 12,
        width: 2,
        wallHeight: 3,
        frontMaterial: 'glass',
        backMaterial: 'wood',
        roofMaterial: 'wood',
        pigs: ['runt']
      })),
      /* level-export:sty-03:start */ null /* level-export:sty-03:end */
    ),
    bag: ['nib', 'nib'],
    stars: [5000, 15100, 15200]
  },

  // Idea: Split Chip into the stacked glass face to breach the only openable side of the roofed pen.
  {
    id: 'sty-04',
    episode: 1,
    index: 4,
    name: 'First Split',
    blueprint: tunedBlueprint(
      composeMotifs(
        stack({ x: 9, height: 4, materials: 'glass' }),
        structure('roofed pen behind the glass face', [
          block('pillar', 'wood', 13, 2),
          block('plank', 'wood', 11, 4.25)
        ], [pig('swine', 11)])
      ),
      /* level-export:sty-04:start */ null /* level-export:sty-04:end */
    ),
    bag: ['chip', 'nib', 'nib'],
    stars: [5000, 25400, 25800]
  },

  // Idea: Split at the middle floor so Chip's fan opens both storeys of the narrow glass tower.
  {
    id: 'sty-05',
    episode: 1,
    index: 5,
    name: 'Two Floors',
    blueprint: tunedBlueprint(
      composeMotifs(tower({
        x: 14,
        width: 2,
        storeys: 2,
        materials: 'glass',
        pigs: [
          { id: 'runt', bay: 0, storey: 0 },
          { id: 'runt', bay: 0, storey: 1 }
        ]
      })),
      /* level-export:sty-05:start */ null /* level-export:sty-05:end */
    ),
    bag: ['chip', 'nib'],
    stars: [10000, 20100, 20200]
  },

  // Idea: Change Chip’s arc between the near and far window bunkers, splitting each sling-side pane rather than repeating one shot.
  {
    id: 'sty-06',
    episode: 1,
    index: 6,
    name: 'Near and Far',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 4,
          width: 2,
          wallHeight: 3,
          frontMaterial: 'glass',
          backMaterial: 'wood',
          roofMaterial: 'wood',
          pigs: ['runt']
        }),
        bunker({
          x: 17,
          width: 2,
          wallHeight: 5,
          frontMaterial: 'glass',
          backMaterial: 'wood',
          roofMaterial: 'wood',
          pigs: ['swine']
        }),
        structure('far bunker cap', [
          block('beam', 'wood', 18, 6.25)
        ], [])
      ),
      /* level-export:sty-06:start */ null /* level-export:sty-06:end */
    ),
    bag: ['chip', 'nib'],
    stars: [10000, 10400, 10600]
  },

  // Idea: Accelerate Wedge through the lower wooden spine so the upper mast and glass crown topple right onto the Runt.
  {
    id: 'sty-07',
    episode: 1,
    index: 7,
    name: 'The Spine',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('wooden spine and glass crown', [
          block('pillar', 'wood', 14, 2),
          block('pillar', 'wood', 14, 6),
          block('plank', 'glass', 14, 8.25)
        ], [pig('runt', 15.5)])
      ),
      /* level-export:sty-07:start */ null /* level-export:sty-07:end */
    ),
    bag: ['wedge', 'nib'],
    stars: [5000, 15000, 15200]
  },

  // Idea: Accelerate Wedge through the bottom tower post so two loaded wooden floors fold into the sheltered Swine.
  {
    id: 'sty-08',
    episode: 1,
    index: 8,
    name: 'Bottom Storey',
    blueprint: tunedBlueprint(
      composeMotifs(structure('braced wooden tower', [
        block('pillar', 'wood', 14, 2),
        block('pillar', 'wood', 16, 2),
        block('pillar', 'wood', 18, 2),
        block('slab', 'wood', 15, 4.5),
        block('slab', 'wood', 17, 4.5),
        block('post', 'wood', 14, 6),
        block('post', 'wood', 16, 6),
        block('post', 'wood', 18, 6),
        block('slab', 'wood', 15, 7.5),
        block('slab', 'wood', 17, 7.5),
        block('cube', 'wood', 16, 8.5)
      ], [pig('swine', 15)])),
      /* level-export:sty-08:start */ null /* level-export:sty-08:end */
    ),
    bag: ['wedge', 'nib'],
    stars: [5000, 16200, 16800]
  },

  // Idea: Hit the near mast high so it topples through one glass guard, then change range to open the far bunker.
  {
    id: 'sty-09',
    episode: 1,
    index: 9,
    name: 'Falling Timber',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('toppling mast and guarded target', [
          block('pillar', 'wood', 7, 2),
          block('pillar', 'wood', 7, 6),
          block('cube', 'wood', 7, 8.5),
          block('beam', 'wood', 7, 9.25),
          block('pillar', 'glass', 10, 2)
        ], [pig('runt', 11)]),
        bunker({
          x: 18,
          width: 2,
          wallHeight: 3,
          frontMaterial: 'glass',
          backMaterial: 'wood',
          roofMaterial: 'wood',
          pigs: ['swine']
        })
      ),
      /* level-export:sty-09:start */ null /* level-export:sty-09:end */
    ),
    bag: ['wedge', 'nib', 'nib'],
    stars: [10000, 20700, 20800]
  },

  // Idea: Use Chip on the near glass bunker and Wedge on the far tower’s wooden foot so its floors fall before Nib cleans up.
  {
    id: 'sty-10',
    episode: 1,
    index: 10,
    name: 'Pick a Side',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 5,
          width: 2,
          wallHeight: 4,
          frontMaterial: 'glass',
          backMaterial: 'wood',
          roofMaterial: 'wood',
          pigs: ['runt']
        }),
        structure('split-material tower', [
          block('pillar', 'wood', 15, 2),
          block('pillar', 'wood', 17, 2),
          block('pillar', 'wood', 19, 2),
          block('slab', 'wood', 16, 4.5),
          block('slab', 'wood', 18, 4.5),
          block('pillar', 'glass', 15, 7),
          block('pillar', 'glass', 17, 7),
          block('pillar', 'glass', 19, 7),
          block('slab', 'wood', 16, 9.5),
          block('slab', 'wood', 18, 9.5)
        ], [pig('swine', 16)])
      ),
      /* level-export:sty-10:start */ null /* level-export:sty-10:end */
    ),
    bag: ['chip', 'wedge', 'nib'],
    stars: [10000, 22600, 22800]
  },

  // Idea: Open the near glass tower with Chip but change to Wedge’s flatter shot for the distant roofed wooden annex.
  {
    id: 'sty-11',
    episode: 1,
    index: 11,
    name: 'High and Low',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('tall glass tower', [
          block('pillar', 'glass', 5, 2),
          block('pillar', 'glass', 7, 2),
          block('pillar', 'wood', 9, 2),
          block('slab', 'glass', 6, 4.5),
          block('slab', 'glass', 8, 4.5),
          block('pillar', 'glass', 5, 7),
          block('pillar', 'glass', 7, 7),
          block('pillar', 'glass', 9, 7),
          block('slab', 'wood', 6, 9.5),
          block('slab', 'wood', 8, 9.5),
          block('beam', 'wood', 6, 10.25),
          block('beam', 'wood', 8, 10.25)
        ], [pig('runt', 6), pig('runt', 8, 5)]),
        bunker({
          x: 19,
          width: 2,
          wallHeight: 2,
          frontMaterial: 'wood',
          backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: ['swine']
        })
      ),
      /* level-export:sty-11:start */ null /* level-export:sty-11:end */
    ),
    bag: ['chip', 'nib', 'wedge'],
    stars: [15000, 26900, 27400]
  },

  // Idea: Break the keep’s wooden gate and glass waist with their matching critters so the upper floors fall through all three pigs.
  {
    id: 'sty-12',
    episode: 1,
    index: 12,
    name: 'Cross-Section Keep',
    blueprint: tunedBlueprint(
      composeMotifs(
        stack({ x: 5, height: 5, materials: 'wood' }),
        structure('cross-section keep', [
          block('pillar', 'wood', 10, 2),
          block('pillar', 'wood', 12, 2),
          block('pillar', 'wood', 14, 2),
          block('slab', 'wood', 11, 4.5),
          block('slab', 'wood', 13, 4.5),
          block('pillar', 'glass', 10, 7),
          block('pillar', 'glass', 12, 7),
          block('pillar', 'glass', 14, 7),
          block('slab', 'glass', 11, 9.5),
          block('slab', 'glass', 13, 9.5),
          block('cube', 'wood', 10, 10.5),
          block('cube', 'wood', 12, 10.5),
          block('cube', 'wood', 14, 10.5),
          block('beam', 'wood', 11, 11.25),
          block('beam', 'wood', 13, 11.25)
        ], [
          pig('runt', 11),
          pig('swine', 13, 5),
          pig('runt', 11, 10)
        ]),
        stack({ x: 19, height: 5, materials: 'wood' })
      ),
      /* level-export:sty-12:start */ null /* level-export:sty-12:end */
    ),
    bag: ['wedge', 'chip', 'nib'],
    stars: [15000, 37800, 38200]
  },

  // Idea: Chip opens the near glass bunker, Wedge breaks the raised tower’s wooden foot so its floors fall through both pigs, and Nib finishes the far bay.
  {
    id: 'sty-13',
    episode: 1,
    index: 13,
    name: 'The Whole Sty',
    blueprint: tunedBlueprint(
      composeMotifs(structure('full-height staged tower', [
        block('slab', 'wood', 10, 0.5),
        block('slab', 'wood', 12, 0.5),
        block('slab', 'wood', 10, 1.5),
        block('slab', 'wood', 12, 1.5),
        block('pillar', 'wood', 9, 4),
        block('pillar', 'wood', 11, 4),
        block('pillar', 'wood', 13, 4),
        block('slab', 'wood', 10, 6.5),
        block('slab', 'wood', 12, 6.5),
        block('pillar', 'glass', 9, 9),
        block('pillar', 'glass', 11, 9),
        block('pillar', 'glass', 13, 9),
        block('slab', 'wood', 10, 11.5),
        block('slab', 'wood', 12, 11.5)
      ], [
        pig('swine', 10, 2),
        pig('runt', 12, 7)
      ]),
      bunker({
        x: 2,
        width: 2,
        wallHeight: 3,
        frontMaterial: 'glass',
        backMaterial: 'wood',
        roofMaterial: 'wood',
        pigs: ['runt']
      }),
      bunker({
        x: 19,
        width: 2,
        wallHeight: 4,
        frontMaterial: 'wood',
        backMaterial: 'glass',
        roofMaterial: 'wood',
        pigs: ['runt']
      })),
      /* level-export:sty-13:start */ null /* level-export:sty-13:end */
    ),
    bag: ['chip', 'nib', 'wedge'],
    stars: [20000, 24600, 25500]
  },

  // Idea: Break the glass foot and let the stone beam fall onto the sheltered Runt instead of wasting a shot on the beam.
  {
    id: 'qry-01', episode: 2, index: 1, name: 'Dead Weight',
    blueprint: tunedBlueprint(
      composeMotifs(structure('stone beam on one bad foot', [
        block('post', 'glass', 12, 1),
        block('post', 'wood', 14, 1),
        block('beam', 'stone', 13, 2.25)
      ], [pig('runt', 13)])),
      /* level-export:qry-01:start */ null /* level-export:qry-01:end */
    ),
    bag: ['nib', 'nib'], stars: [5000, 15100, 15300]
  },

  // Idea: Shatter the glass shelf so its stone weight drops through the roofed pen onto the Runt below.
  {
    id: 'qry-02', episode: 2, index: 2, name: 'The Press',
    blueprint: tunedBlueprint(
      composeMotifs(structure('glass shelf and stone press', [
        block('post', 'wood', 12, 1),
        block('post', 'wood', 14, 1),
        block('beam', 'glass', 13, 2.25),
        block('cube', 'stone', 13, 3)
      ], [pig('runt', 13)])),
      /* level-export:qry-02:start */ null /* level-export:qry-02:end */
    ),
    bag: ['nib', 'nib'], stars: [5000, 15100, 15300]
  },

  // Idea: Split Chip at each range to break both glass roofs and drop the paired stone weights into their enclosed pens.
  {
    id: 'qry-03', episode: 2, index: 3, name: 'Twin Shafts',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 3, width: 2, wallHeight: 2,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'glass',
          pigs: ['runt']
        }),
        structure('near stone weight', [block('cube', 'stone', 4, 3.5)], []),
        bunker({
          x: 18, width: 2, wallHeight: 2,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'glass',
          pigs: ['swine']
        }),
        structure('far stone weight', [block('cube', 'stone', 19, 3.5)], [])
      ),
      /* level-export:qry-03:start */ null /* level-export:qry-03:end */
    ),
    bag: ['chip', 'chip'], stars: [10000, 10600, 10800]
  },

  // Idea: Harden Spike into the stone face to open the tall core; every ordinary direct hit is absorbed by the masonry.
  {
    id: 'qry-04', episode: 2, index: 4, name: 'Hard Face',
    blueprint: tunedBlueprint(
      composeMotifs(bunker({
        x: 12, width: 2, wallHeight: 4,
        frontMaterial: 'stone', backMaterial: 'wood', roofMaterial: 'wood',
        pigs: ['runt']
      })),
      /* level-export:qry-04:start */ null /* level-export:qry-04:end */
    ),
    bag: ['spike', 'nib'], stars: [5000, 15000, 15200]
  },

  // Idea: Harden Spike before the glass veil so it passes through untouched and spends its force on the stone core behind it.
  {
    id: 'qry-05', episode: 2, index: 5, name: 'Veiled Core',
    blueprint: tunedBlueprint(
      composeMotifs(
        stack({ x: 9, height: 5, materials: 'glass' }),
        bunker({
          x: 11, width: 2, wallHeight: 5,
          frontMaterial: 'stone', backMaterial: 'wood', roofMaterial: 'wood',
          pigs: ['swine']
        })
      ),
      /* level-export:qry-05:start */ null /* level-export:qry-05:end */
    ),
    bag: ['spike', 'spike'], stars: [5000, 15100, 15200]
  },

  // Idea: Change Spike's arc between the short near core and the glass-veiled far core, hardening before each stone impact.
  {
    id: 'qry-06', episode: 2, index: 6, name: 'Two Faces',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 3, width: 2, wallHeight: 4,
          frontMaterial: 'stone', backMaterial: 'wood', roofMaterial: 'wood',
          pigs: ['runt']
        }),
        stack({ x: 16, height: 5, materials: 'glass' }),
        bunker({
          x: 18, width: 2, wallHeight: 5,
          frontMaterial: 'stone', backMaterial: 'wood', roofMaterial: 'wood',
          pigs: ['swine']
        }),
        structure('far core cap', [block('beam', 'stone', 19, 6.25)], [])
      ),
      /* level-export:qry-06:start */ null /* level-export:qry-06:end */
    ),
    bag: ['spike', 'spike'], stars: [10000, 10300, 10400]
  },

  // Idea: Detonate the exposed end of the fuse so the TNT chain removes the glass wall and drops the capped stone roof into the Runt.
  {
    id: 'qry-07', episode: 2, index: 7, name: 'Short Fuse',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('three-crate fuse', [
          block('cube', 'tnt', 10, 0.5), block('cube', 'tnt', 11, 0.5),
          block('cube', 'tnt', 12, 0.5)
        ], []),
        bunker({
          x: 13, width: 2, wallHeight: 4,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['runt']
        }),
        structure('quarry roof marker', [block('post', 'wood', 14, 6)], [])
      ),
      /* level-export:qry-07:start */ null /* level-export:qry-07:end */
    ),
    bag: ['lob', 'nib'], cards: ['sapper'], stars: [5000, 17200, 17400]
  },

  // Idea: Change range to light both exposed fuses, letting each chain break a glass face and drop a different stone load.
  {
    id: 'qry-08', episode: 2, index: 8, name: 'Long Fuse',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('near fuse', [
          block('cube', 'tnt', 1, 0.5), block('cube', 'tnt', 2, 0.5),
          block('cube', 'tnt', 3, 0.5)
        ], []),
        bunker({
          x: 4, width: 2, wallHeight: 3,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['runt']
        }),
        structure('far fuse', [
          block('cube', 'tnt', 15, 0.5), block('cube', 'tnt', 16, 0.5),
          block('cube', 'tnt', 17, 0.5)
        ], []),
        bunker({
          x: 18, width: 2, wallHeight: 4,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['swine']
        }),
        structure('far fuse marker', [
          block('pillar', 'wood', 22, 2), block('pillar', 'wood', 22, 6)
        ], [])
      ),
      /* level-export:qry-08:start */ null /* level-export:qry-08:end */
    ),
    bag: ['lob', 'nib'], cards: ['sapper'], stars: [10000, 14300, 14500]
  },

  // Idea: Arc Lob over the stone blast wall before detonating, because a boom on the approach leaves the shielded TNT chain out of reach.
  {
    id: 'qry-09', episode: 2, index: 9, name: 'Hold the Boom',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('stone blast wall', [
          block('pillar', 'stone', 12, 2), block('pillar', 'stone', 12, 6)
        ], []),
        structure('shielded TNT well', [
          block('cube', 'tnt', 14, 0.5), block('cube', 'tnt', 15, 0.5)
        ], []),
        structure('tall blast chamber', [
          block('pillar', 'glass', 16, 2), block('pillar', 'glass', 16, 6),
          block('pillar', 'wood', 18, 2), block('pillar', 'wood', 18, 6),
          block('beam', 'stone', 17, 8.25)
        ], [
          pig('swine', 17)
        ])
      ),
      /* level-export:qry-09:start */ null /* level-export:qry-09:end */
    ),
    bag: ['lob', 'spike'], cards: ['sapper'], stars: [5000, 16400, 16600]
  },

  // Idea: Split Chip through the tall glass keel so the stone roof drops vertically through the pen and crushes the Hogg.
  {
    id: 'qry-10', episode: 2, index: 10, name: 'Hogg Press',
    blueprint: tunedBlueprint(
      composeMotifs(structure('two-bay Hogg press tower', [
        block('pillar', 'glass', 9, 2), block('pillar', 'glass', 9, 6),
        block('pillar', 'glass', 13, 2), block('pillar', 'glass', 13, 6),
        block('pillar', 'wood', 17, 2), block('pillar', 'wood', 17, 6),
        block('plank', 'stone', 11, 8.25), block('plank', 'stone', 15, 8.25),
        block('cube', 'wood', 13, 9)
      ], [pig('hogg', 15)])),
      /* level-export:qry-10:start */ null /* level-export:qry-10:end */
    ),
    bag: ['chip', 'lob'], stars: [5000, 15800, 16000]
  },

  // Idea: Accelerate Wedge into the tall first mast so the stepped dominoes drive sideways through Helmet Hog while the tempting roof-drop is blunted.
  {
    id: 'qry-11', episode: 2, index: 11, name: 'Sideways Only',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('sideways quarry dominoes', [
          block('pillar', 'wood', 10, 2), block('pillar', 'wood', 10, 6),
          block('post', 'stone', 10, 9), block('beam', 'wood', 10, 10.25),
          block('pillar', 'wood', 12, 2), block('pillar', 'wood', 12, 6),
          block('pillar', 'wood', 14, 2), block('post', 'wood', 14, 5)
        ], []),
        bunker({
          x: 17, width: 2, wallHeight: 1,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['helm']
        })
      ),
      /* level-export:qry-11:start */ null /* level-export:qry-11:end */
    ),
    bag: ['wedge', 'nib'], stars: [5000, 6700, 16000]
  },

  // Idea: Drop the near stone press onto Hogg, then change range and topple the far mast sideways into Helmet Hog instead of dropping its roof.
  {
    id: 'qry-12', episode: 2, index: 12, name: 'Above and Across',
    blueprint: tunedBlueprint(
      composeMotifs(
        stack({ x: 3, height: 3, materials: 'glass' }),
        stack({ x: 7, height: 3, materials: 'wood' }),
        structure('near Hogg press', [
          block('plank', 'stone', 5, 3.25), block('post', 'stone', 5, 4.5)
        ], [pig('hogg', 5)]),
        structure('far toppling mast', [
          block('pillar', 'wood', 16, 2), block('pillar', 'wood', 16, 6),
          block('post', 'stone', 16, 9), block('cube', 'stone', 16, 10.5)
        ], []),
        bunker({
          x: 19, width: 2, wallHeight: 1,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['helm']
        })
      ),
      /* level-export:qry-12:start */ null /* level-export:qry-12:end */
    ),
    bag: ['chip', 'wedge', 'nib'], stars: [10000, 11400, 11900]
  },

  // Idea: Use every specialist on its matching seam so glass, stone and TNT crush Hogg and send the final mast sideways through Helmet Hog.
  {
    id: 'qry-13', episode: 2, index: 13, name: 'The Whole Quarry',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 2, width: 2, wallHeight: 4,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['runt']
        }),
        structure('veiled stone core', [
          block('pillar', 'glass', 6, 2), block('pillar', 'glass', 6, 6),
          block('pillar', 'stone', 8, 2), block('pillar', 'stone', 8, 6),
          block('pillar', 'wood', 10, 2), block('pillar', 'wood', 10, 6),
          block('beam', 'stone', 9, 8.25)
        ], [
          pig('swine', 9)
        ]),
        structure('Hogg fuse and press', [
          block('cube', 'tnt', 11, 0.5), block('cube', 'tnt', 12, 0.5),
          block('cube', 'glass', 13, 0.5), block('cube', 'glass', 13, 1.5),
          block('cube', 'glass', 13, 2.5), block('cube', 'glass', 13, 3.5),
          block('cube', 'wood', 17, 0.5), block('cube', 'wood', 17, 1.5),
          block('cube', 'wood', 17, 2.5), block('cube', 'wood', 17, 3.5),
          block('plank', 'stone', 15, 4.25)
        ], [pig('hogg', 15)]),
        structure('final toppling mast', [
          block('pillar', 'wood', 18, 2), block('pillar', 'wood', 18, 6),
          block('pillar', 'wood', 18, 10)
        ], []),
        bunker({
          x: 21, width: 2, wallHeight: 1,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['helm']
        })
      ),
      /* level-export:qry-13:start */ null /* level-export:qry-13:end */
    ),
    bag: ['chip', 'spike', 'lob', 'wedge', 'nib'], cards: ['sapper'], stars: [20000, 33700, 44000]
  },

  // Idea: Carry Pebble over the tall stone screen and drop its payload onto the glass lid above the sheltered Runt.
  {
    id: 'hwd-01', episode: 3, index: 1, name: 'Over the Wall',
    blueprint: tunedBlueprint(
      composeMotifs(structure('screened drop box', [
        block('cube', 'stone', 10.5, 0.5),
        block('cube', 'stone', 10.5, 1.5),
        block('cube', 'stone', 10.5, 2.5),
        block('cube', 'wood', 13, 0.5),
        block('cube', 'wood', 13, 1.5),
        block('cube', 'wood', 15, 0.5),
        block('cube', 'wood', 15, 1.5),
        block('slab', 'glass', 14, 2.5)
      ], [pig('runt', 14)])),
      /* level-export:hwd-01:start */ null /* level-export:hwd-01:end */
    ),
    bag: ['pebble'], stars: [5000, 5400, 5600]
  },

  // Idea: Drop Pebble behind the four-high face so its payload breaks the glass shelf and releases the stone press onto the Swine.
  {
    id: 'hwd-02', episode: 3, index: 2, name: 'Air Mail',
    blueprint: tunedBlueprint(
      composeMotifs(structure('wall and loaded drop shaft', [
        block('cube', 'stone', 9.5, 0.5),
        block('cube', 'stone', 9.5, 1.5),
        block('cube', 'stone', 9.5, 2.5),
        block('cube', 'stone', 9.5, 3.5),
        block('cube', 'wood', 13, 0.5),
        block('cube', 'wood', 13, 1.5),
        block('cube', 'wood', 17, 0.5),
        block('cube', 'wood', 17, 1.5),
        block('plank', 'glass', 15, 2.25),
        block('cube', 'stone', 15, 3)
      ], [pig('swine', 15)])),
      /* level-export:hwd-02:start */ null /* level-export:hwd-02:end */
    ),
    bag: ['pebble', 'nib'], stars: [5000, 15200, 15400]
  },

  // Idea: Change Pebble's arc and drop timing to open the short near shaft and the taller far shaft from above.
  {
    id: 'hwd-03', episode: 3, index: 3, name: 'Two Deliveries',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('near screened shaft', [
          block('cube', 'stone', 3.5, 0.5),
          block('cube', 'stone', 3.5, 1.5),
          block('cube', 'stone', 3.5, 2.5),
          block('cube', 'stone', 3.5, 3.5),
          block('cube', 'wood', 6, 0.5),
          block('cube', 'wood', 6, 1.5),
          block('cube', 'wood', 8, 0.5),
          block('cube', 'wood', 8, 1.5),
          block('slab', 'glass', 7, 2.5)
        ], [pig('runt', 7)]),
        structure('far screened shaft', [
          block('cube', 'stone', 14.5, 0.5),
          block('cube', 'stone', 14.5, 1.5),
          block('cube', 'stone', 14.5, 2.5),
          block('cube', 'stone', 14.5, 3.5),
          block('cube', 'stone', 14.5, 4.5),
          block('beam', 'stone', 14.5, 5.25),
          block('cube', 'wood', 18, 0.5),
          block('cube', 'wood', 18, 1.5),
          block('cube', 'wood', 20, 0.5),
          block('cube', 'wood', 20, 1.5),
          block('slab', 'glass', 19, 2.5),
          block('cube', 'stone', 19, 3.5)
        ], [pig('swine', 19)])
      ),
      /* level-export:hwd-03:start */ null /* level-export:hwd-03:end */
    ),
    bag: ['pebble', 'pebble'], stars: [10000, 11200, 11700]
  },

  // Idea: Fly Boomer over the stone-faced keep, then reverse through its glass rear wall into the hidden Runt.
  {
    id: 'hwd-04', episode: 3, index: 4, name: 'Turn Around',
    blueprint: tunedBlueprint(
      composeMotifs(bunker({
        x: 10, width: 4, wallHeight: 5,
        frontMaterial: 'stone', dividerMaterial: 'wood', backMaterial: 'glass',
        roofMaterial: 'wood',
        pigs: [{ id: 'runt', bay: 1 }]
      })),
      /* level-export:hwd-04:start */ null /* level-export:hwd-04:end */
    ),
    bag: ['boomer'], stars: [5000, 5300, 5400]
  },

  // Idea: Hold Boomer's reversal until it clears the capped tower, then strike the rear glass seam instead of the stone front.
  {
    id: 'hwd-05', episode: 3, index: 5, name: 'Late Turn',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 11, width: 4, wallHeight: 5,
          frontMaterial: 'stone', dividerMaterial: 'wood', backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: [{ id: 'swine', bay: 1 }]
        }),
        structure('timing mast', [
          block('pillar', 'wood', 9, 2),
          block('post', 'wood', 9, 5),
          block('cube', 'wood', 9, 6.5)
        ], [])
      ),
      /* level-export:hwd-05:start */ null /* level-export:hwd-05:end */
    ),
    bag: ['boomer', 'nib'], stars: [5000, 5300, 15500]
  },

  // Idea: Reverse one Boomer into each fortress's rear glass wall, changing both launch arc and turn timing between the near and far targets.
  {
    id: 'hwd-06', episode: 3, index: 6, name: 'Near Turn, Far Turn',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 2, width: 2, wallHeight: 3,
          frontMaterial: 'stone', backMaterial: 'glass', roofMaterial: 'wood',
          pigs: ['runt']
        }),
        bunker({
          x: 16, width: 4, wallHeight: 5,
          frontMaterial: 'stone', dividerMaterial: 'wood', backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: [{ id: 'swine', bay: 1 }]
        }),
        structure('far timing mast', [
          block('pillar', 'wood', 22, 2),
          block('pillar', 'wood', 22, 6)
        ], [])
      ),
      /* level-export:hwd-06:start */ null /* level-export:hwd-06:end */
    ),
    bag: ['boomer', 'boomer'], stars: [10000, 10800, 11200]
  },

  // Idea: Land Nib on the spring before the wall so the rebound reaches the glass floor beneath the sealed upper chamber.
  {
    id: 'hwd-07', episode: 3, index: 7, name: 'Upstairs',
    blueprint: tunedBlueprint(
      composeMotifs(structure('spring approach and upper chamber', [
        block('cube', 'spring', 8.5, 0.5),
        block('pillar', 'stone', 11.5, 2),
        block('cube', 'stone', 11.5, 4.5),
        block('pillar', 'wood', 13, 2),
        block('post', 'wood', 13, 5),
        block('pillar', 'wood', 15, 2),
        block('post', 'wood', 15, 5),
        block('slab', 'glass', 14, 6.5),
        block('cube', 'wood', 13, 7.5),
        block('cube', 'wood', 15, 7.5),
        block('slab', 'wood', 14, 8.5)
      ], [pig('runt', 14, 7)])),
      /* level-export:hwd-07:start */ null /* level-export:hwd-07:end */
    ),
    bag: ['nib', 'nib'], cards: ['springloaded'], stars: [5000, 5600, 5900]
  },

  // Idea: Bank Nib off the raised rear spring so it rebounds left through the glass back of the stone-faced pen.
  {
    id: 'hwd-08', episode: 3, index: 8, name: 'Bank Shot',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('stone pen with rear glass window', [
          block('cube', 'stone', 11, 0.5),
          block('cube', 'stone', 11, 1.5),
          block('cube', 'stone', 11, 2.5),
          block('cube', 'stone', 11, 3.5),
          block('cube', 'stone', 11, 4.5),
          block('cube', 'wood', 13, 0.5),
          block('cube', 'wood', 13, 1.5),
          block('cube', 'wood', 13, 2.5),
          block('cube', 'wood', 13, 3.5),
          block('cube', 'wood', 13, 4.5),
          block('cube', 'stone', 15, 0.5),
          block('cube', 'stone', 15, 1.5),
          block('cube', 'stone', 15, 2.5),
          block('cube', 'glass', 15, 3.5),
          block('cube', 'wood', 15, 4.5),
          block('slab', 'stone', 12, 5.5),
          block('slab', 'wood', 14, 5.5)
        ], [pig('runt', 14)]),
        structure('raised rear spring bank', [
          block('pillar', 'spring', 16.25, 2),
          block('post', 'spring', 16.25, 5),
          block('post', 'wood', 16.25, 7),
          block('cube', 'wood', 16.25, 8.5),
          block('beam', 'wood', 16.25, 9.25)
        ], [])
      ),
      /* level-export:hwd-08:start */ null /* level-export:hwd-08:end */
    ),
    bag: ['nib', 'nib'], cards: ['springloaded'], stars: [5000, 15400, 15700]
  },

  // Idea: Avoid the spring-clad front door and accelerate Wedge through the glass shoulder so the stone cap falls through the sheltered Swine.
  {
    id: 'hwd-09', episode: 3, index: 9, name: 'Do Not Bounce',
    blueprint: tunedBlueprint(
      composeMotifs(structure('defensive spring bumper and weak shoulder', [
        block('pillar', 'spring', 9.5, 2),
        block('pillar', 'spring', 10, 2),
        block('pillar', 'stone', 14, 2),
        block('plank', 'wood', 12, 4.25),
        block('pillar', 'glass', 10, 6.5),
        block('pillar', 'stone', 14, 6.5),
        block('plank', 'wood', 12, 8.75),
        block('slab', 'wood', 12, 9.5)
      ], [pig('swine', 12)])),
      /* level-export:hwd-09:start */ null /* level-export:hwd-09:end */
    ),
    bag: ['wedge', 'pebble'], cards: ['springloaded'], stars: [5000, 15200, 16500]
  },

  // Idea: Reverse Boomer through the tall keep's glass rear wall so it hits Tusker from behind, where its sling-facing armour does nothing.
  {
    id: 'hwd-10', episode: 3, index: 10, name: 'Wrong Way Round',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 10, width: 4, wallHeight: 5,
          frontMaterial: 'stone', dividerMaterial: 'wood', backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: [{ id: 'tusk', bay: 1 }]
        }),
        structure('armour lesson mast', [
          block('pillar', 'stone', 8, 2),
          block('pillar', 'stone', 8, 6),
          block('post', 'stone', 8, 9),
          block('beam', 'wood', 8, 10.25)
        ], [])
      ),
      /* level-export:hwd-10:start */ null /* level-export:hwd-10:end */
    ),
    bag: ['boomer', 'nib'], stars: [5000, 16200, 16300]
  },

  // Idea: Lead Pebble over the tall screen and drop its payload onto the drifting balloon so the fall finishes the Zeppelin Hog.
  {
    id: 'hwd-11', episode: 3, index: 11, name: 'Lead the Balloon',
    blueprint: tunedBlueprint(
      composeMotifs(structure('zeppelin screen and fall lane', [
        block('pillar', 'stone', 14.25, 2),
        block('pillar', 'stone', 14.25, 6),
        block('pillar', 'stone', 14.25, 10),
        block('cube', 'stone', 14.25, 12.5),
        block('slab', 'wood', 16.5, 0.5),
        block('slab', 'wood', 18.5, 0.5)
      ], [pig('zep', 16.5, 8.15625)])),
      /* level-export:hwd-11:start */ null /* level-export:hwd-11:end */
    ),
    bag: ['pebble', 'nib'], stars: [5000, 15000, 15400]
  },

  // Idea: Reverse Boomer into the near Tusker's rear seam, then change range and lead Pebble into the far Zeppelin's balloon.
  {
    id: 'hwd-12', episode: 3, index: 12, name: 'Back and Aloft',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 3, width: 4, wallHeight: 4,
          frontMaterial: 'stone', dividerMaterial: 'wood', backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: [{ id: 'tusk', bay: 1 }]
        }),
        structure('far zeppelin screen', [
          block('pillar', 'stone', 15.5, 2),
          block('pillar', 'stone', 15.5, 6),
          block('pillar', 'stone', 15.5, 10),
          block('cube', 'stone', 15.5, 12.5),
          block('beam', 'stone', 15, 13.25),
          block('cube', 'wood', 16.5, 0.5),
          block('cube', 'wood', 17.5, 0.5),
          block('cube', 'wood', 18.5, 0.5),
          block('cube', 'wood', 19.5, 0.5)
        ], [pig('zep', 18, 8.65625)])
      ),
      /* level-export:hwd-12:start */ null /* level-export:hwd-12:end */
    ),
    bag: ['boomer', 'pebble', 'nib'], stars: [10000, 20700, 21200]
  },

  // Idea: Bounce the first Pebble into the tallest mast so it topples onto Tusker, then drop the last Pebble onto the Zeppelin's balloon.
  {
    id: 'hwd-13', episode: 3, index: 13, name: 'The Highwind',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('spring, screen and toppling mast', [
          block('cube', 'spring', 3.5, 0.5),
          block('pillar', 'stone', 5, 2),
          block('pillar', 'stone', 5, 6),
          block('pillar', 'stone', 7, 2),
          block('pillar', 'stone', 7, 6),
          block('pillar', 'glass', 7, 10),
          block('post', 'wood', 7, 13),
          block('beam', 'wood', 7, 14.25)
        ], []),
        bunker({
          x: 9, width: 4, wallHeight: 4,
          frontMaterial: 'stone', dividerMaterial: 'wood', backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: [{ id: 'tusk', bay: 1 }]
        }),
        structure('drifting lookout', [
          block('pillar', 'stone', 17.75, 2),
          block('pillar', 'stone', 17.75, 6),
          block('pillar', 'stone', 17.75, 10),
          block('post', 'stone', 17.75, 13),
          block('slab', 'wood', 20, 0.5),
          block('slab', 'wood', 22, 0.5)
        ], [pig('zep', 20, 9.65625)])
      ),
      /* level-export:hwd-13:start */ null /* level-export:hwd-13:end */
    ),
    bag: ['pebble', 'boomer', 'pebble'], cards: ['springloaded'], stars: [10000, 11200, 11600]
  },

  // Idea: Break the glass end wall and let the iron roof drop into the Runt instead of wasting shots on the metal.
  {
    id: 'iro-01', episode: 4, index: 1, name: 'Dead Metal',
    blueprint: tunedBlueprint(
      composeMotifs(bunker({
        x: 12, width: 2, wallHeight: 2,
        frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'iron',
        pigs: ['runt']
      })),
      /* level-export:iro-01:start */ null /* level-export:iro-01:end */
    ),
    bag: ['nib', 'nib'], cards: ['iron-ration'], stars: [5000, 15100, 15200]
  },

  // Idea: Carry Pebble over the iron screen and drop its payload onto the glass lid that holds the iron weight above the Swine.
  {
    id: 'iro-02', episode: 4, index: 2, name: 'Go Over',
    blueprint: tunedBlueprint(
      composeMotifs(structure('iron screen and loaded drop box', [
        block('pillar', 'iron', 9.5, 2),
        block('cube', 'wood', 13, 0.5), block('cube', 'wood', 13, 1.5),
        block('cube', 'wood', 15, 0.5), block('cube', 'wood', 15, 1.5),
        block('slab', 'glass', 14, 2.5),
        block('cube', 'iron', 14, 3.5)
      ], [pig('swine', 14)])),
      /* level-export:iro-02:start */ null /* level-export:iro-02:end */
    ),
    bag: ['pebble', 'nib'], cards: ['iron-ration'], stars: [5000, 15600, 15800]
  },

  // Idea: Drop through the near glass lid from above, then change range and break the far glass wall so its iron cap falls into the second pen.
  {
    id: 'iro-03', episode: 4, index: 3, name: 'Over and Under',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('near screened drop box', [
          block('pillar', 'iron', 2.5, 2),
          block('cube', 'wood', 5, 0.5), block('cube', 'wood', 5, 1.5),
          block('cube', 'wood', 7, 0.5), block('cube', 'wood', 7, 1.5),
          block('slab', 'glass', 6, 2.5),
          block('cube', 'stone', 6, 3.5)
        ], [pig('runt', 6)]),
        structure('far glass wall and iron cap', [
          block('pillar', 'glass', 18, 2),
          block('pillar', 'wood', 20, 2),
          block('beam', 'iron', 19, 4.25)
        ], [pig('swine', 19)])
      ),
      /* level-export:iro-03:start */ null /* level-export:iro-03:end */
    ),
    bag: ['pebble', 'chip'], cards: ['iron-ration'], stars: [10000, 11200, 11600]
  },

  // Idea: Wedge Hulk between the iron buttress and the glass wall, then inflate so the loaded roof folds into the Runt.
  {
    id: 'iro-04', episode: 4, index: 4, name: 'Expansion Joint',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('iron inflation buttress', [
          block('pillar', 'iron', 10, 2)
        ], []),
        bunker({
          x: 12, width: 2, wallHeight: 4,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'wood',
          pigs: ['runt']
        }),
        structure('loaded bunker cap', [
          block('beam', 'stone', 13, 5.25)
        ], [])
      ),
      /* level-export:iro-04:start */ null /* level-export:iro-04:end */
    ),
    bag: ['hulk'], cards: ['iron-ration'], stars: [5000, 5200, 5300]
  },

  // Idea: Let Hulk settle into the floor pocket before inflating so it shoves the full glass wall and roof into the Swine.
  {
    id: 'iro-05', episode: 4, index: 5, name: 'After It Lands',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('low iron pocket stop', [
          block('post', 'iron', 10.25, 1)
        ], []),
        bunker({
          x: 12, width: 2, wallHeight: 5,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'wood',
          pigs: ['swine']
        })
      ),
      /* level-export:iro-05:start */ null /* level-export:iro-05:end */
    ),
    bag: ['hulk', 'nib'], cards: ['iron-ration'], stars: [5000, 15200, 15400]
  },

  // Idea: Change range and rest each Hulk in its own iron-backed pocket before inflating the near and far glass walls.
  {
    id: 'iro-06', episode: 4, index: 6, name: 'Two Tight Fits',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('near pocket stop', [
          block('post', 'iron', 1.25, 1)
        ], []),
        bunker({
          x: 3, width: 2, wallHeight: 3,
          frontMaterial: 'glass', backMaterial: 'wood', roofMaterial: 'stone',
          pigs: ['runt']
        }),
        structure('far pocket stop', [
          block('post', 'iron', 15.25, 1)
        ], []),
        structure('far tall inflation chamber', [
          block('pillar', 'glass', 17, 2), block('post', 'glass', 17, 5),
          block('pillar', 'wood', 19, 2), block('post', 'wood', 19, 5),
          block('beam', 'stone', 18, 6.25)
        ], [pig('swine', 18)])
      ),
      /* level-export:iro-06:start */ null /* level-export:iro-06:end */
    ),
    bag: ['hulk', 'hulk'], cards: ['iron-ration'], stars: [10000, 10900, 11200]
  },

  // Idea: Fly Boomer past the gel face and timing mast, then reverse into the unshielded glass wall at the rear of the keep.
  {
    id: 'iro-07', episode: 4, index: 7, name: 'Soft Front, Weak Back',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('gelworks timing mast', [
          block('pillar', 'stone', 8, 2), block('post', 'stone', 8, 5),
          block('cube', 'wood', 8, 6.5), block('beam', 'wood', 8, 7.25)
        ], []),
        bunker({
          x: 10, width: 4, wallHeight: 4,
          frontMaterial: 'gel', dividerMaterial: 'wood', backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: [{ id: 'runt', bay: 1 }]
        })
      ),
      /* level-export:iro-07:start */ null /* level-export:iro-07:end */
    ),
    bag: ['boomer', 'nib'], cards: ['gelworks'], stars: [5000, 5100, 5500]
  },

  // Idea: Carry Pebble over the gel-shielded face and drop its payload onto the tall glass roof above the Swine.
  {
    id: 'iro-08', episode: 4, index: 8, name: 'Over the Absorber',
    blueprint: tunedBlueprint(
      composeMotifs(
        stack({ x: 10, height: 4, materials: 'gel' }),
        structure('tall loaded drop chamber', [
          block('pillar', 'wood', 12, 2), block('pillar', 'wood', 12, 6),
          block('pillar', 'wood', 16, 2), block('pillar', 'wood', 16, 6),
          block('plank', 'glass', 14, 8.25)
        ], [pig('swine', 14)])
      ),
      /* level-export:iro-08:start */ null /* level-export:iro-08:end */
    ),
    bag: ['pebble', 'nib'], cards: ['gelworks'], stars: [5000, 15200, 15600]
  },

  // Idea: Reverse Boomer into the near bunker’s glass back, then change range and drop Pebble over the far gel-shielded wall onto its glass lid.
  {
    id: 'iro-09', episode: 4, index: 9, name: 'Back Door, Skylight',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 2, width: 2, wallHeight: 2,
          frontMaterial: 'gel', backMaterial: 'glass', roofMaterial: 'wood',
          pigs: ['runt']
        }),
        structure('far gel screen and drop wall', [
          block('cube', 'gel', 16, 0.5), block('cube', 'gel', 16, 1.5),
          block('pillar', 'stone', 18, 2), block('pillar', 'stone', 18, 6),
          block('cube', 'stone', 18, 8.5), block('beam', 'stone', 18, 9.25)
        ], []),
        structure('far skylight chamber', [
          block('cube', 'wood', 20, 0.5), block('cube', 'wood', 20, 1.5),
          block('cube', 'wood', 22, 0.5), block('cube', 'wood', 22, 1.5),
          block('slab', 'glass', 21, 2.5)
        ], [pig('swine', 21)])
      ),
      /* level-export:iro-09:start */ null /* level-export:iro-09:end */
    ),
    bag: ['boomer', 'pebble'], cards: ['gelworks'], stars: [10000, 11200, 11600]
  },

  // Idea: Blink Zip over the iron screen into the glass support so the heavy roof drops with enough force to crush Sarge.
  {
    id: 'iro-10', episode: 4, index: 10, name: 'Past the Gate',
    blueprint: tunedBlueprint(
      composeMotifs(structure('blink gate and Sarge press', [
        block('pillar', 'iron', 10, 2),
        block('pillar', 'glass', 13, 2),
        block('pillar', 'wood', 17, 2),
        block('pillar', 'stone', 19, 2), block('pillar', 'stone', 19, 6),
        block('post', 'stone', 19, 9), block('beam', 'stone', 19, 10.25),
        block('plank', 'stone', 15, 4.25)
      ], [pig('sarge', 15)])),
      /* level-export:iro-10:start */ null /* level-export:iro-10:end */
    ),
    bag: ['zip', 'nib'], cards: ['iron-ration'], stars: [5000, 5200, 5600]
  },

  // Idea: Blink Zip over the gel wall into the raised TNT pocket so the blast releases the iron press above Sarge.
  {
    id: 'iro-11', episode: 4, index: 11, name: 'Fuse Pocket',
    blueprint: tunedBlueprint(
      composeMotifs(
        stack({ x: 10, height: 4, materials: 'gel' }),
        structure('raised blink fuse', [
          block('post', 'wood', 13, 1), block('post', 'wood', 13, 3),
          block('cube', 'tnt', 13, 4.5)
        ], []),
        structure('iron Sarge press and tall back', [
          block('pillar', 'glass', 15, 2),
          block('pillar', 'wood', 19, 2),
          block('pillar', 'stone', 21, 2), block('pillar', 'stone', 21, 6),
          block('post', 'stone', 21, 9), block('cube', 'stone', 21, 10.5),
          block('beam', 'stone', 21, 11.25),
          block('plank', 'iron', 17, 4.25)
        ], [pig('sarge', 17)])
      ),
      /* level-export:iro-11:start */ null /* level-export:iro-11:end */
    ),
    bag: ['zip', 'nib'], cards: ['gelworks', 'iron-ration', 'sapper'], stars: [5000, 16200, 16600]
  },

  // Idea: Change range and blink timing to trip the near glass press and the far TNT press, dropping a heavy roof onto each Sarge.
  {
    id: 'iro-12', episode: 4, index: 12, name: 'Double Bypass',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('near blink press', [
          block('pillar', 'iron', 3, 2),
          block('pillar', 'glass', 5, 2), block('pillar', 'wood', 9, 2),
          block('plank', 'stone', 7, 4.25)
        ], [pig('sarge', 7)]),
        structure('central smokestack', [
          block('pillar', 'stone', 13, 2), block('pillar', 'stone', 13, 6),
          block('pillar', 'stone', 13, 10), block('cube', 'stone', 13, 12.5),
          block('beam', 'stone', 13, 13.25)
        ], []),
        stack({ x: 16, height: 4, materials: 'gel' }),
        structure('far raised fuse', [
          block('post', 'wood', 18, 1), block('post', 'wood', 18, 3),
          block('cube', 'tnt', 18, 4.5)
        ], []),
        structure('far iron press and smokestack', [
          block('pillar', 'glass', 19, 2),
          block('pillar', 'wood', 23, 2),
          block('plank', 'iron', 21, 4.25)
        ], [pig('sarge', 21)])
      ),
      /* level-export:iro-12:start */ null /* level-export:iro-12:end */
    ),
    bag: ['zip', 'zip', 'wedge'],
    cards: ['gelworks', 'iron-ration', 'sapper'], stars: [10000, 13100, 14100]
  },

  // Idea: Use all nine specialists on the glass veil, blink gate, TNT fuse, stone footing, wood crown, Hulk pocket, rear seam, spring lane and balloon to bring the iron core through Sarge.
  {
    id: 'iro-13', episode: 4, index: 13, name: 'The Whole Works',
    blueprint: tunedBlueprint(
      composeMotifs(
        bunker({
          x: 1, width: 4, wallHeight: 3,
          frontMaterial: 'gel', dividerMaterial: 'wood', backMaterial: 'glass',
          roofMaterial: 'wood',
          pigs: [{ id: 'tusk', bay: 1 }]
        }),
        stack({ x: 6.5, height: 5, materials: 'glass' }),
        structure('spring lane, blink gate and fuse pocket', [
          block('cube', 'spring', 7.5, 0.5),
          block('pillar', 'iron', 8.25, 2),
          block('cube', 'tnt', 9, 0.5)
        ], []),
        tower({
          x: 10, width: 4, storeys: 3,
          materials: ['stone', 'iron', 'wood'],
          pigs: []
        }),
        structure('Sarge inside the iron core', [], [pig('sarge', 13)]),
        structure('stone lock, smokestack and balloon lane', [
          block('pillar', 'stone', 17.5, 2), block('pillar', 'stone', 17.5, 6),
          block('pillar', 'glass', 17.5, 10), block('post', 'wood', 17.5, 13),
          block('cube', 'wood', 17.5, 14.5), block('beam', 'wood', 17.5, 15.25)
        ], [pig('zep', 22, 9.65625)])
      ),
      /* level-export:iro-13:start */ null /* level-export:iro-13:end */
    ),
    bag: ['chip', 'zip', 'lob', 'spike', 'wedge', 'hulk', 'boomer', 'nib', 'pebble'],
    cards: ['gelworks', 'iron-ration', 'sapper', 'springloaded'], stars: [15000, 25500, 62600]
  }
];
