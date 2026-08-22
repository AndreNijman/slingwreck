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

// Pig centres use the codec's 1/64-unit grid. The two Sty pigs are always seated on
// flat quarter-grid surfaces, so their quantised radius is the only offset required.
const PIG_SEAT = { runt: 19 / 64, swine: 26 / 64 };
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
  }
];
