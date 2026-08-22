# Campaign level standard

Derived from building Episode 1 twice. The first attempt validated, settled and looked
tidy, and was still weak — the problems were only visible on the contact sheet. Every
rule below is here because it was violated first.

Applies to all 52 levels. Each episode is checked against it before being called done.

## The premise

**The pig must be protected, or the fortress is decoration.**

The tension in this genre is that the pig is behind something and you have to work out the
way in: which support is load-bearing, which pane is the weak point, what falls onto what.
A level whose correct play is "aim at the pig" has no idea in it, however good the
structure looks.

- The first two levels of the **campaign** may have a directly hittable pig. They teach
  aiming and arc, and a first success should be easy.
- **Everywhere else, no pig may be directly hittable.** Verify it by raycasting a
  plausible arc from the sling and confirming a block is in the way. Do not judge it by
  eye — the first Episode 1 attempt looked fine and had eight of them.
- In the last third of an episode, at least one pig per level should need **two events** —
  a support broken *and* something falling — not one lucky shot.

## Shape

**One nameable idea per level**, written as a comment above it. *This support is
load-bearing. This pane is the way in. This tips right if hit high.* If it cannot be said
in one sentence, the level does not have one yet.

**Vary the vocabulary.** At most a quarter of an episode may be gantries — two legs and a
horizontal top. The first Episode 1 attempt was eight of thirteen and read as variations on
a trestle. Use enclosed bunkers with the pig genuinely inside, towers to topple, walls to
breach, panes to break, and deliberately unbalanced stacks.

**Escalate the silhouette.** Settled height should climb monotonically across an episode,
from roughly 2.5 world units to 11–12. The contact sheet should read as a progression when
scanned top to bottom.

**Use the plot.** It is 24 units wide and 16 tall. At least three levels per episode need
**two targets at meaningfully different ranges**, so the player changes trajectory rather
than repeating one shot. Changing range is a different skill from choosing a critter.

**Difficulty comes from shape, not volume.** A four-piece level with an awkward
load-bearing post is harder than a twenty-piece row. `sty-07` is the reference: four
pieces, one spine, entirely legible. As an episode progresses, give proportionally *fewer*
critters, not more pieces alone.

## Mechanics

- Campaign rule set only: inside the plot, nothing overlapping, at most 120 blocks. No
  King except in a boss level, no budget, no burial-depth rule.
- **Every level must pass `settleTest`** within the strict tolerance. A level that
  collapses before the first shot is not a difficulty choice.
- Bags are hand-picked and **ordered deliberately**. `chip, nib, wedge` plays differently
  from `wedge, chip, nib`; the order is part of the puzzle.
- Only materials and pigs the episode has unlocked, per `EPISODES` in `data.js`.
- Star thresholds stay `null` until P5.8 sets them from bot play. Never invent them.

## Checks before an episode is done

```bash
node tools/level-export.mjs --lint          # all 13 validate and settle
node tools/level-shots.mjs --episode <n>    # then LOOK at the sheet
```

Report, measured rather than judged:

- directly hittable pigs per level, by raycast
- gantry count out of 13
- which levels use two ranges
- the settled height range, and whether it is monotonic
- any level indistinguishable from its neighbour, or an outlier in shape or difficulty

An episode is not done until the contact sheet has been reviewed. A level can validate,
settle, and be beatable by a bot and still be bad, and correctness is all a test can
check.
