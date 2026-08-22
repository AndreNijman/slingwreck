import { EPISODES as DATA_EPISODES } from './data.js';
import {
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

  // Idea: Arc Nib onto the exposed Runt perched above the table instead of battering its legs.
  {
    id: 'sty-02',
    episode: 1,
    index: 2,
    name: 'Table Manners',
    blueprint: tunedBlueprint(
      composeMotifs(structure('table manners', [
        block('post', 'wood', 15, 1),
        block('plank', 'glass', 15, 2.25)
      ], [pig('runt', 15, 2.5)])),
      /* level-export:sty-02:start */ null /* level-export:sty-02:end */
    ),
    bag: ['nib', 'nib'],
    stars: null
  },

  // Idea: Arc past the wooden front leg to break the far glass pillar and tip the tall frame right.
  {
    id: 'sty-03',
    episode: 1,
    index: 3,
    name: 'Far Side',
    blueprint: tunedBlueprint(
      composeMotifs(structure('far-side frame', [
        block('pillar', 'wood', 13, 2),
        block('pillar', 'glass', 17, 2),
        block('plank', 'wood', 15, 4.25)
      ], [pig('swine', 15)])),
      /* level-export:sty-03:start */ null /* level-export:sty-03:end */
    ),
    bag: ['nib', 'nib'],
    stars: null
  },

  // Idea: Split Chip into the stacked glass face so several panes fail before the wooden frame can catch them.
  {
    id: 'sty-04',
    episode: 1,
    index: 4,
    name: 'First Split',
    blueprint: tunedBlueprint(
      composeMotifs(
        stack({ x: 13, height: 4, materials: 'glass' }),
        structure('wooden back frame', [
          block('pillar', 'wood', 15, 2),
          block('slab', 'wood', 14, 4.5)
        ], [pig('swine', 14)])
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

  // Idea: Split through the centre of the tall window wall so the fan breaks several glass uprights at once.
  {
    id: 'sty-06',
    episode: 1,
    index: 6,
    name: 'Window Wall',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('three tall glass uprights', [
          block('pillar', 'glass', 12, 2),
          block('cube', 'glass', 12, 4.5),
          block('pillar', 'glass', 14, 2),
          block('cube', 'glass', 14, 4.5),
          block('pillar', 'glass', 16, 2),
          block('cube', 'glass', 16, 4.5)
        ], []),
        structure('window wall roof', [
          block('slab', 'wood', 13, 5.5),
          block('slab', 'wood', 15, 5.5)
        ], [pig('runt', 13), pig('swine', 15)])
      ),
      /* level-export:sty-06:start */ null /* level-export:sty-06:end */
    ),
    bag: ['chip', 'nib'],
    stars: null
  },

  // Idea: Accelerate Wedge through the single wooden spine carrying the entire glass crown.
  {
    id: 'sty-07',
    episode: 1,
    index: 7,
    name: 'The Spine',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('wooden spine and glass crown', [
          block('pillar', 'wood', 15, 2),
          block('post', 'wood', 15, 5),
          block('plank', 'glass', 15, 6.25)
        ], [pig('swine', 15, 6.5)])
      ),
      /* level-export:sty-07:start */ null /* level-export:sty-07:end */
    ),
    bag: ['wedge', 'nib'],
    stars: null
  },

  // Idea: Accelerate Wedge through the lower shelf's exposed end so the upper scaffold folds down.
  {
    id: 'sty-08',
    episode: 1,
    index: 8,
    name: 'Bottom Shelf',
    blueprint: tunedBlueprint(
      composeMotifs(structure('two wooden shelves', [
        block('pillar', 'wood', 13, 2),
        block('pillar', 'wood', 17, 2),
        block('plank', 'wood', 15, 4.25),
        block('post', 'wood', 13, 5.5),
        block('post', 'wood', 17, 5.5),
        block('plank', 'wood', 15, 6.75)
      ], [pig('runt', 15, 7)])),
      /* level-export:sty-08:start */ null /* level-export:sty-08:end */
    ),
    bag: ['wedge', 'nib'],
    stars: null
  },

  // Idea: Hit the wooden mast high with Wedge so it topples right onto the otherwise sheltered Swine.
  {
    id: 'sty-09',
    episode: 1,
    index: 9,
    name: 'Falling Timber',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('toppling mast', [
          block('pillar', 'wood', 11, 2),
          block('pillar', 'wood', 13, 2),
          block('plank', 'glass', 12, 4.25),
          block('post', 'wood', 11, 5.5),
          block('post', 'wood', 13, 5.5),
          block('slab', 'wood', 12, 7)
        ], [pig('runt', 12, 7.5)]),
        structure('fall target', [
          block('post', 'glass', 16, 1),
          block('post', 'glass', 19, 1),
          block('plank', 'wood', 17.5, 2.25)
        ], [pig('swine', 17.5)])
      ),
      /* level-export:sty-09:start */ null /* level-export:sty-09:end */
    ),
    bag: ['wedge', 'nib', 'nib'],
    stars: null
  },

  // Idea: Use Chip on the glass side and Wedge on the wooden side before Nib cleans up the opened tower.
  {
    id: 'sty-10',
    episode: 1,
    index: 10,
    name: 'Pick a Side',
    blueprint: tunedBlueprint(
      composeMotifs(structure('split-material tower', [
        block('pillar', 'glass', 13, 2),
        block('pillar', 'wood', 17, 2),
        block('plank', 'wood', 15, 4.25),
        block('post', 'glass', 13, 5.5),
        block('post', 'wood', 17, 5.5),
        block('cube', 'glass', 13, 7),
        block('cube', 'wood', 17, 7),
        block('plank', 'glass', 15, 7.75)
      ], [pig('swine', 15), pig('runt', 15, 8)])),
      /* level-export:sty-10:start */ null /* level-export:sty-10:end */
    ),
    bag: ['chip', 'wedge', 'nib'],
    stars: null
  },

  // Idea: Open the tall glass tower with Chip but save Wedge's flatter shot for the low wooden annex.
  {
    id: 'sty-11',
    episode: 1,
    index: 11,
    name: 'High and Low',
    blueprint: tunedBlueprint(
      composeMotifs(
        structure('tall glass tower', [
          block('pillar', 'wood', 10, 2),
          block('pillar', 'wood', 12, 2),
          block('beam', 'glass', 11, 4.25),
          block('pillar', 'glass', 10, 6.5),
          block('pillar', 'glass', 12, 6.5),
          block('beam', 'wood', 11, 8.75)
        ], [pig('runt', 11), pig('runt', 11, 4.5)]),
        structure('low wooden annex', [
          block('post', 'wood', 17, 1),
          block('post', 'wood', 21, 1),
          block('plank', 'glass', 19, 2.25)
        ], [pig('swine', 19)])
      ),
      /* level-export:sty-11:start */ null /* level-export:sty-11:end */
    ),
    bag: ['chip', 'nib', 'wedge'],
    stars: null
  },

  // Idea: Break the wooden feet and glass waist with their matching critters, then use Nib to tip the narrow crown.
  {
    id: 'sty-12',
    episode: 1,
    index: 12,
    name: 'Cross Section',
    blueprint: tunedBlueprint(
      composeMotifs(structure('three-material stages', [
        block('pillar', 'wood', 13, 2),
        block('pillar', 'wood', 17, 2),
        block('plank', 'wood', 15, 4.25),
        block('post', 'glass', 13, 5.5),
        block('post', 'glass', 17, 5.5),
        block('plank', 'glass', 15, 6.75),
        block('cube', 'wood', 14, 7.5),
        block('cube', 'wood', 16, 7.5),
        block('beam', 'wood', 15, 8.25)
      ], [
        pig('runt', 15),
        pig('swine', 15, 4.5),
        pig('runt', 15, 8.5)
      ])),
      /* level-export:sty-12:start */ null /* level-export:sty-12:end */
    ),
    bag: ['wedge', 'chip', 'nib'],
    stars: null
  },

  // Idea: Chip shatters the glass middle, Nib tips the loosened crown, and Wedge drills the last wooden foot.
  {
    id: 'sty-13',
    episode: 1,
    index: 13,
    name: 'The Whole Sty',
    blueprint: tunedBlueprint(
      composeMotifs(structure('full-height staged tower', [
        block('pillar', 'wood', 11, 2),
        block('pillar', 'wood', 15, 2),
        block('pillar', 'wood', 19, 2),
        block('plank', 'wood', 13, 4.25),
        block('plank', 'wood', 17, 4.25),
        block('pillar', 'glass', 13, 6.5),
        block('pillar', 'glass', 17, 6.5),
        block('plank', 'wood', 15, 8.75)
      ], [
        pig('runt', 13),
        pig('runt', 17),
        pig('swine', 15, 4.5),
        pig('runt', 15, 9)
      ])),
      /* level-export:sty-13:start */ null /* level-export:sty-13:end */
    ),
    bag: ['chip', 'nib', 'wedge'],
    stars: null
  }
];
