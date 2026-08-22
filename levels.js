import { EPISODES as DATA_EPISODES } from './data.js';
import {
  bridge,
  bunker,
  composeMotifs,
  scaffold,
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

export const LEVELS = [
  {
    id: 'sty-01',
    episode: 1,
    index: 1,
    name: 'Knock Knock',
    blueprint: tunedBlueprint(
      composeMotifs(bunker({
        x: 14,
        width: 2,
        wallHeight: 1,
        wallMaterial: 'glass',
        roofMaterial: 'wood',
        pigs: ['runt']
      })),
      /* level-export:sty-01:start */ null /* level-export:sty-01:end */
    ),
    bag: ['nib', 'nib'],
    stars: null
  },
  {
    id: 'sty-02',
    episode: 1,
    index: 2,
    name: 'Split Decision',
    blueprint: tunedBlueprint(
      composeMotifs(
        tower({
          x: 13,
          width: 4,
          storeys: 1,
          materials: 'glass',
          pigs: [
            { id: 'runt', bay: 0 },
            { id: 'swine', bay: 1 }
          ]
        }),
        stack({ x: 20, height: 3, materials: ['wood', 'glass'] })
      ),
      /* level-export:sty-02:start */ null /* level-export:sty-02:end */
    ),
    bag: ['chip', 'nib', 'nib'],
    stars: null
  },
  {
    id: 'sty-03',
    episode: 1,
    index: 3,
    name: 'Under and Over',
    blueprint: tunedBlueprint(
      composeMotifs(
        bridge({
          x: 9,
          span: 8,
          supports: 5,
          supportHeight: 1,
          supportMaterial: 'wood',
          deckMaterial: 'glass',
          pigs: [
            { id: 'runt', bay: 1 },
            { id: 'swine', bay: 3 }
          ]
        }),
        scaffold({
          x: 19,
          bays: 1,
          height: 2,
          postMaterial: 'wood',
          plankMaterial: 'glass',
          pigs: ['runt']
        })
      ),
      /* level-export:sty-03:start */ null /* level-export:sty-03:end */
    ),
    bag: ['wedge', 'chip', 'nib', 'nib'],
    stars: null
  }
];
