import { EPISODES as DATA_EPISODES } from './data.js';
import {
  bunker,
  composeMotifs,
  stack,
  tower
} from './motifs.js';

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
const PIG_SEAT = { runt: 19 / 64, swine: 26 / 64, hogg: 37 / 64, helm: 27 / 64 };
function pig(id, x, surfaceY = 0) {
  return [id, x, surfaceY + PIG_SEAT[id], 0];
}

function structure(label, blocks, pigs) {
  return { label, blocks, pigs };
}

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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    stars: null
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
    bag: ['nib', 'nib'], stars: null
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
    bag: ['nib', 'nib'], stars: null
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
    bag: ['chip', 'chip'], stars: null
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
    bag: ['spike', 'nib'], stars: null
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
    bag: ['spike', 'spike'], stars: null
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
    bag: ['spike', 'spike'], stars: null
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
    bag: ['lob', 'nib'], cards: ['sapper'], stars: null
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
    bag: ['lob', 'nib'], cards: ['sapper'], stars: null
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
    bag: ['lob', 'spike'], cards: ['sapper'], stars: null
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
    bag: ['chip', 'lob'], stars: null
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
    bag: ['wedge', 'nib'], stars: null
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
    bag: ['chip', 'wedge', 'nib'], stars: null
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
    bag: ['chip', 'spike', 'lob', 'wedge', 'nib'], cards: ['sapper'], stars: null
  }
];
