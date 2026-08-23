Fix five legibility failures found by a naive playtest. Read `docs/NAIVE-PLAYTEST.md`
first — it is the evidence for every item below, with the tester's own words.

A vision model was shown the game with **no** information about it and played fourteen
turns. It navigated the menus flawlessly and beat level 1, so the shell and the art work.
Then it lost twice for reasons that are all our fault.

## 1. Pull strength is invisible — highest priority, six of fourteen turns

> "I still do not know how pull distance maps to launch power or trajectory"

It said that, in some form, on turns 6, 7, 8, 10, 11 and 12. **It never once mentioned
seeing a trajectory preview**, though the game draws ten fading dots along the launch
parabola.

Aiming is the only verb in this game and its sole feedback channel is not reaching the
player. This was logged as a cosmetic risk after P2 and deferred; that deferral was wrong.

Make the aim readable:

- Dots must be legible against the sage hills and the parchment sky alike — give them an
  ink outline or a light halo so they never rely on contrast with whatever is behind them.
- Show **power** explicitly. A draw-strength indicator on the sling itself: an arc, a
  filling band, something that reads at a glance and makes "how hard am I pulling" a
  question the screen answers.
- Show the **aim angle**. The dots imply it; make it unmistakable.
- Extend the preview far enough to reach the fortress at a strong pull, so the player can
  see where the shot goes rather than where it starts.

## 2. No confirmation that a shot fired — three turns

> "I still cannot tell whether my last drag fired a shot or was ignored"

Give release an unmistakable acknowledgement: the bands snapping, a puff at the pouch, the
critter's trail, and a clear change in the HUD. It must be obvious from a single frame that
a shot just happened.

## 3. The critter counter cannot be read

> "a small brown critter appears seated in the pouch, yet the counter says 0"

The HUD draws remaining critters as small heads and the tester could not count them, nor
reconcile them with the loaded critter. Keep the drawn heads — they are good — but make the
count unambiguous: larger, clearly separated, with the one currently loaded visibly
distinct from those still waiting, and a numeral as well.

## 4. The win condition is never stated

> "I cannot tell whether I must hit the pig directly or whether toppling the shelf counts
> as destroying it"

Nothing tells the player that pigs are the target. Worse, every level from 3 onward is
built so a pig **cannot** be hit directly, so the obvious reading is the one we forbid.

Say it. A short objective line in the HUD — pigs remaining, drawn as pig heads that empty
as they pop — plus one sentence on the first level of each episode. Do not add a tutorial
sequence; state the goal and let the levels teach the rest.

## 5. Ammo and target look alike

> "the pink thing may be an enemy to crush rather than the ammo"

Said on the **title screen**, before play. Critters are warm red-orange with a cream belly;
pigs are dusty rose. Both sit in the same warm pink-red family.

Separate them. Changing the pigs is the bigger lever — they are the thing there are many of
— but keep them out of genre-standard green, which was a deliberate choice worth keeping.
Cooler, duller, greyer pigs against warm saturated critters would do it. Update
`PALETTE` and say what you changed.

## Verify

1. Regenerate `node tools/frame-shot.mjs`, `node tools/state-shots.mjs` and
   `node tools/level-shots.mjs`, then **look** at the aiming frame and the contact sheet and
   report whether the preview and the power indicator read clearly.
2. `node tools/check.mjs`, `npm test`, `npm run test:audio`, `node tools/level-audit.mjs`.
3. Re-run the naive playtest: `node tools/naive-playtest.mjs --turns 14`. Report how many
   turns mention confusion about pull strength, shot confirmation, the counter, or the
   objective. The six-turn pull-strength complaint should be gone.

That last one is the real acceptance test. The others only prove nothing broke.
