# SLINGWRECK — design

Every number here is a starting value to be tuned by `tools/balance.mjs`, not a
finished one. Where a number is a guess with no evidence behind it, it says so.

---

## 1. The core loop

Drag back on the slingshot, release, watch a critter arc into a stack of blocks and
hope the stack lands on the pigs. Tap once in flight to trigger that critter's
ability. Clear every pig with the ammo you were given.

That is the whole game in the campaign. Siege keeps it identical and adds the part
that is actually new: you built the thing being knocked down, and so did they, and
you are both swinging at the same time.

## 2. Physics and materials

### 2.1 Bodies

Convex polygons and circles. Every structural piece is a box; balls are circles;
wedges are triangles. Collision is SAT with clipped reference-face contact manifolds,
resolved by a sequential impulse solver with warm starting.

```
TUNE.step               1/60
TUNE.gravity            22          world units / s²
TUNE.velocityIters      8
TUNE.positionIters      3
TUNE.baumgarte          0.20
TUNE.slop               0.005
TUNE.sleepLinear        0.06        below this for sleepTime, the island sleeps
TUNE.sleepAngular       0.12
TUNE.sleepTime          0.55        seconds
TUNE.maxSpeed           90
```

Sleeping is not an optimisation here, it is a **rule**: "the world has settled" is a
game state — it ends the round, it validates a blueprint, it locks in a score — and
the only honest definition of settled is that every island is asleep. Getting sleep
right in phase 1 is therefore load-bearing, not polish.

### 2.2 Materials

`cost` is scrap in Siege. `hp` is per unit area — a plank has four times a cube's
hit points. `thresh` is the normal impulse a contact must exceed before it does any
damage at all, which is what stops a tower damaging itself just by standing there.

| id | name | density | hp/area | thresh | frailty | cost/area | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `glass` | glass | 0.55 | 12 | 1.4 | 2.2 | 1 | also takes damage from tangential impulse; shatters loudly |
| `wood` | wood | 0.75 | 26 | 2.2 | 1.0 | 2 | the default |
| `stone` | stone | 1.90 | 60 | 4.0 | 0.55 | 5 | heavy enough that dropping it is itself a weapon |
| `iron` | iron | 2.90 | 120 | 6.5 | 0.28 | 12 | draft only |
| `tnt` | crate of bang | 0.70 | 8 | 1.0 | 3.0 | 6 | detonates at 0 hp: radius 3.2, impulse 90, direct damage 45 falling off linearly |
| `spring` | spring pad | 0.60 | 20 | 2.0 | 1.2 | 4 | restitution 0.92 against ammo, 0.2 against everything else |
| `gel` | gel | 0.50 | 20 | 3.0 | 1.0 | 4 | absorbs 70% of normal impulse before passing it to neighbours; the anti-Lob block |
| `sand` | sandbag | 1.20 | 35 | 2.6 | 0.9 | 3 | at 0 hp becomes three loose chunks that keep their mass |

Ratios matter more than absolutes. The intended reading: glass is free and useless,
wood is the honest choice, stone is a decision, iron is a card you drew, and the
other four are tools with one job each.

### 2.3 Shapes

| id | w × h | note |
| --- | --- | --- |
| `cube` | 1 × 1 | |
| `slab` | 2 × 1 | |
| `beam` | 2 × 0.5 | |
| `plank` | 4 × 0.5 | the classic span |
| `post` | 0.5 × 2 | |
| `pillar` | 0.5 × 4 | |
| `wedge` | 1 × 1 triangle | |
| `ball` | r 0.5 | rolls, which is usually a mistake for the builder |

### 2.4 Damage

```
dmg = max(0, normalImpulse - mat.thresh) * mat.frailty
```

Brittle materials (`glass`, `tnt`) add `0.5 * max(0, tangentImpulse - thresh)`.
Blocks at 0 hp are removed at the end of the step, spawning debris particles in
`render.js` and, for `sand` and large `stone`, real sub-bodies in `sim.js`.

Explosions apply a radial impulse and direct damage, both falling off linearly to
zero at the radius, with a raycast occlusion check per body so a stone wall shields
what is behind it. Chained TNT resolves over successive steps, never recursively —
recursive chaining is how a five-crate cluster becomes a stack overflow.

## 3. The critters

Nine, one tap ability each, fired in a fixed bag order. Ability triggers on tap; Lob and
Hulk remain tappable while settling so they can be used after coming to rest. An untapped
critter still does its base impact damage, and Lob also has its automatic fuse.

| id | name | mass | radius | ability | good against |
| --- | --- | --- | --- | --- | --- |
| `nib` | Nib | 1.00 | 0.32 | none | nothing in particular; the baseline |
| `chip` | Chip | 0.70 | 0.28 | splits into three at −22°, 0°, +22°, each keeping the parent's speed | glass, wide shallow fronts |
| `wedge` | Wedge | 0.95 | 0.30 | accelerates 2.1× along current heading | wood, drilling a single column |
| `lob` | Lob | 1.60 | 0.36 | detonates on tap, including at rest: radius 3.6, impulse 130, damage 60; untapped fuse fires 3 s after first contact or when culled without contact | clusters, TNT, buried pigs |
| `pebble` | Pebble | 0.85 | 0.30 | drops a 1.4-mass payload downward at 6, recoils up at 4.5 | anything behind a tall front wall |
| `boomer` | Boomer | 0.90 | 0.30 | reverses horizontal velocity, keeps vertical | the back of the fortress |
| `hulk` | Hulk | 2.40 | 0.40 → 0.80 | inflates on tap, including at rest, to 4× area over 0.12 s, shoving what it touches | wedged into a gap; splits towers apart |
| `spike` | Spike | 1.30 | 0.26 | hardens: passes through glass without slowing, +80% damage to stone | stone cores |
| `zip` | Zip | 0.55 | 0.22 | blinks 3.5 units forward, keeping speed | precision, tight windows |

Impact damage is `impulse` from the physics, so a Hulk does more because it weighs
more, not because of a special case. Only the ability numbers above are authored.

Campaign unlocks them in that order across the four episodes. Siege starts everyone
with `nib`, `chip`, `wedge`, `lob` and the rest arrive through the draft.

## 4. The pigs

| id | name | hp | cost | radius | behaviour |
| --- | --- | --- | --- | --- | --- |
| `runt` | Runt | 1 | 3 | 0.30 | |
| `swine` | Swine | 2 | 5 | 0.40 | |
| `hogg` | Hogg | 4 | 9 | 0.58 | heavy enough to crush a glass block it lands on |
| `helm` | Helmet Hog | 3 | 8 | 0.42 | ignores the first 60% of damage from above |
| `tusk` | Tusker | 3 | 8 | 0.44 | ignores the first 60% of damage from the slingshot side; full damage from behind or above |
| `zep` | Zeppelin Hog | 1 | 6 | 0.34 | tethered to a balloon, hovers, drifts ±1.5 units. Pop the balloon and it falls, and the fall usually finishes it |
| `sarge` | Sarge | 5 | 12 | 0.46 | every 6 s restores 25% of one adjacent damaged block's hp. Siege only. Killing it is often worth more than the points |
| `king` | King Hog | 8 | 0 (mandatory) | 0.68 | the crown. In the campaign a boss; in Siege, popping it ends the round instantly |

Pigs take damage from impulse the same way blocks do, with `thresh 1.0` and
`frailty 1.0`, so a plank falling on a Runt kills it and a plank falling on the King
does not.

## 5. Campaign

Four episodes, twelve levels each, plus a boss level per episode — 52 levels.

| Episode | Theme | Introduces |
| --- | --- | --- |
| 1 — Sty | flat ground, wood and glass | `nib`, `chip`, `wedge`, Runt, Swine |
| 2 — Quarry | slopes, stone, gaps to drop into | `lob`, `spike`, Hogg, Helmet Hog, TNT |
| 3 — Highwind | towers, spring pads, wind | `pebble`, `boomer`, Tusker, Zeppelin Hog |
| 4 — Ironworks | iron, gel, moving platforms | `hulk`, `zip`, Sarge, iron |

Levels are authored **in the Siege fortress editor** and exported to `levels.js` by
`tools/level-export.mjs`. That is not a convenience, it is the reason the editor gets
enough use to be good: if the campaign is built with it, its bugs surface early.

Scoring: `10 000 × unused ammo + 5 000 × pig + 100 × cost of destroyed blocks`.
Three star thresholds per level, authored, sanity-checked by a bot run in
`tools/balance.mjs --campaign` that flags any level where three stars is impossible
or where three stars is achievable by firing every critter at the ground.

Progress persists through the guard's `/_guard/profile` endpoint (per-account,
per-game JSON blob) with `localStorage` as the offline fallback.

## 6. Siege — the 1v1

### 6.1 Match shape

Best of five. First to three round wins takes the match, so a match is three to five
rounds long.

Each round is **Build → Siege → Draft**.

### 6.2 Build phase — 90 seconds, simultaneous, hidden

You spend scrap on a fortress inside a 24 × 16 plot.

```
budget = 110 + 25 * (round - 1) + 15 * roundsBehind
```

So round 1 is 110 for both; a player down 0–2 going into round 3 gets 160 + 30 = 190
against their opponent's 160, on top of two draft cards. Rubber-banding is
deliberate and it is the whole point of the mode.

Rules, all validated by the relay on lock-in:

- Exactly **one King Hog**, free and mandatory.
- At least **two other pigs**.
- At most **120 blocks** — a perf ceiling and a preview-readability ceiling.
- Everything inside the plot bounds. Nothing overlapping at rest.
- **Burial depth ≤ 5.** From 64 sampled directions, a straight ray to the King must
  cross at most five distinct blocks in the best case. Turtling the King inside a
  solid iron cube is not a strategy, it is a stalemate, and the rule exists so the
  mode never discovers that.
- **The settle test.** The relay simulates the blueprint for 3 seconds under gravity.
  If it collapses, or any pig dies, the blueprint is rejected and returned with the
  offending pieces highlighted. The client offers the same test on a button so this
  is never a surprise. The **settled** state is what both players attack, so nobody
  wins points from a tower falling over on its own.

Editor controls: click to place, drag to sweep a row, right-click to remove,
`R` to rotate in 15° steps, `G` toggles the 0.5
grid snap, `T` runs the settle test, `Space` locks in early. Locking in early banks
`+2 scrap per remaining 10 seconds` into the next round, which is the only reason to
ever stop fiddling.

If the timer expires unlocked, whatever is placed is auto-completed to legality and
locked.

### 6.3 Siege phase — simultaneous, 3 minute cap

Both players attack the opponent's settled fortress **at the same time**, each in
their own local world. Simultaneity is what makes the corner preview mean anything:
you can watch them two shots from your King and decide to stop lining up the perfect
angle and just throw.

**The bag.** `6 + round` critters, so 7 through 11. Composition is rolled from the
match seed and is **identical for both players** unless a card has changed one of
them. You see the whole bag up front and fire it in order — no choosing, which keeps
the interesting decision on where to aim rather than what to pick.

**Round ends when** any of:

1. A King Hog pops. That player wins the round immediately. This is the primary win
   condition and everything else is a fallback.
2. Both bags are spent and both worlds have settled (see §2.1 — settled means every
   island asleep, with a 6-second hard timeout).
3. The 3-minute clock expires.

**If nobody popped a King**, the higher siege score wins:

| | points |
| --- | --- |
| block destroyed | `10 × cost` |
| block knocked entirely off the plot | `15 × cost` on top |
| Runt / Zeppelin | 300 / 400 |
| Swine / Helmet / Tusker | 500 / 700 / 700 |
| Hogg / Sarge | 900 / 1000 |
| unused critter at round end | 400 each |
| **breach bonus** | 1200 if the King has clear line of sight from the slingshot arc at round end |

The breach bonus exists so that "I got so close" is worth something, and so that a
round decided on points still rewards the player who was actually about to win.

Exact tie: sudden death, one Lob each at the same fortresses, higher damage wins.
Still tied: the player whose fortress cost less scrap wins, which rewards efficiency
and terminates.

**The corner preview**, top right, 260 × 150 px: your own fortress, live, being taken
apart by them. Their score, their ammo remaining, and a crown icon that is lit while
your King lives. Updates at 8 Hz. A card can degrade this.

**Disconnects:** 20 seconds of grace, then the round goes to the connected player.
Reconnecting mid-round is supported — the relay holds the blueprint, the seed and the
shot log, and hands them over to fast-forward.

### 6.4 Draft phase — 25 seconds

The **loser of the round** draws three cards and keeps one. The winner gets +10
scrap and nothing else.

Card tier is drawn from the deficit, not just the round number:

| Situation | Tier |
| --- | --- |
| down by 1 | Reinforce |
| down by 1, round 4 or later | Reinforce or Dirty |
| down by 2 | Dirty or Desperado |
| down by 2 and it is match point | Desperado, guaranteed |

Cards are permanent for the rest of the match. Never more than one copy of a unique
card.

#### Tier 1 — Reinforce

| id | name | effect |
| --- | --- | --- |
| `iron-ration` | Iron Ration | unlock iron; 2 iron pieces per round |
| `sapper` | Sapper | unlock TNT crates; 2 per round |
| `hardhats` | Hard Hats | every pig you place gets +1 hp |
| `bedrock` | Bedrock | the bottom row of your plot becomes indestructible |
| `deep-pockets` | Deep Pockets | +30 scrap every round from now on |
| `extra-clip` | Extra Clip | +2 critters in your bag every round |
| `gelworks` | Gelworks | unlock gel; 4 pieces per round |
| `quarryman` | Quarryman | stone costs you 3 instead of 5 |
| `armoury` | Armoury | add `spike` and `pebble` to your bag pool |

#### Tier 2 — Dirty

| id | name | effect |
| --- | --- | --- |
| `smokescreen` | Smokescreen | their preview of your fortress updates once every 3 seconds instead of 8 times a second |
| `understudy` | Understudy | place a Decoy King. Identical in the preview. Popping it does nothing except waste their shot |
| `flak-hog` | Flak Hog | one pig throws a stone every 4 s at incoming critters. Hitting one costs it half its speed |
| `springloaded` | Spring Loaded | unlock spring pads; 4 per round |
| `gale` | Gale | a constant 2.5-unit headwind against critters fired at your fortress |
| `bombardier` | Bombardier | your first shot each round is a free Lob that does not consume a bag slot |
| `mason` | Mason | after every third enemy shot, one destroyed block of yours returns at half hp |
| `sappers-union` | Sappers' Union | your TNT does 1.5× damage and has 1.4× radius |
| `long-arm` | Long Arm | your slingshot pulls 25% further, so everything arrives faster |

#### Tier 3 — Desperado (only when 2 rounds down)

| id | name | effect |
| --- | --- | --- |
| `airlift` | Airlift | your King rides a balloon and drifts. The balloon must be shot down before the King can be hurt at all |
| `remote-detonator` | Remote Detonator | your TNT is inert until you tap once per round, then every crate fires at the same instant |
| `second-slingshot` | Second Slingshot | you fire from two slingshots at different heights, alternating, which opens angles that do not otherwise exist |
| `kingslayer` | Kingslayer | one critter in your bag homes weakly toward the enemy King after the tap |
| `tectonic` | Tectonic | your plot tilts 8° away from the slingshot, so everything that breaks rolls back toward the shooter and out of play |
| `conscription` | Conscription | +5 free Runts placed automatically in the gaps of your fortress each round |
| `heavy-industry` | Heavy Industry | iron costs you 6 instead of 12, and you may place unlimited iron |

**Balance intent.** Desperado cards are supposed to feel unfair. The player holding
one is down 0–2 and needs three rounds in a row. The guard against a runaway is that
the cards only ever go to the player who is losing, and the win condition is a hard
objective (pop the King) rather than an accumulating resource. `tools/balance.mjs`
runs bot matches across card combinations and flags any card whose holder exceeds a
65% round win rate at parity, or falls below 40%.

**The known risk, stated up front:** `airlift` plus `gale` plus `bedrock` is a
defensive lock that may simply be unbeatable. The intended counters are `pebble`
(drops from above, ignores the headwind's horizontal component) and `zip` (blinks
past the wind), both of which the *attacker* needs to already own. If the harness
confirms the lock, the fix is to make `airlift` mutually exclusive with `gale` in the
draw, not to nerf either into pointlessness.

## 7. Solo Siege

The same mode against a bot. Bots build from a library of hand-authored fortress
templates scaled to the budget, and aim with a closed-form ballistic solve plus
difficulty-scaled noise, biased toward whatever the templates say is the weak point.
It exists to test the mode without two humans, and `tools/balance.mjs` drives it.

## 8. Controls

| Input | Does |
| --- | --- |
| drag from the slingshot, release | aim and fire |
| click, tap, or `Space` in flight | trigger the ability |
| `R` | restart the level (campaign only) |
| mouse wheel / pinch | zoom the camera between the sling and the fortress |
| `M` | mute |

Touch: drag anywhere from the slingshot to aim, lift to fire, tap anywhere to
trigger. The editor is drag-to-place with a floating palette.

## 9. Explicitly not in it

- No energy, no lives, no timers between attempts, no purchases of any kind.
- No accounts required. The guard supplies one if you want progress synced.
- No more than two players in Siege. A four-way version of this mode has an obvious
  problem — everyone attacks the weakest fortress — and solving it is a different
  design, not a bigger version of this one.
- No level editor sharing in v1. The editor exists, the export tool exists, but
  hosting other people's levels is a moderation problem and it can wait.

---

## 10. Resolved ambiguities

Writing `data.js` surfaced eleven places where this document described a mechanic without
giving it a number, or gave two numbers that disagreed. They are resolved here and in
`data.js`; the reasoning lives next to each value in that file, because the reasoning is
what stops someone "tidying" it later.

| Was ambiguous | Resolved as |
| --- | --- |
| Lob had no fallback if the player did not tap before it stopped or left play | Lob remains tappable while settling. Untapped Lob detonates **3 seconds (180 fixed steps) after first contact**, or at the no-contact cull point; manual and automatic detonation emit the same `boom` feedback |
| Hulk "3× volume" versus "0.40 → 0.86" — neither is 3× and this is a 2D game | **4× area**, radius 0.40 → 0.80. The square root is exactly 2, so the radius is a clean decimal rather than an irrational in a file three hosts must agree on bit for bit |
| Chip's "spread 22°" — total or per fragment, and momentum or speed | 22° **between adjacent** fragments (−22, 0, +22). Each keeps the parent's **speed** and a third of its mass. Splitting the momentum three ways would make tapping worse than not tapping, which an ability must never be |
| Pebble's payload had no mass, size, speed or recoil | radius 0.34, mass 1.4, released downward at 6, carrier recoils up at 4.5. The payload outweighs the critter carrying it — that is the mechanic |
| Gale's "2.5" had no unit | an **acceleration**, 2.5 u/s², about 11% of gravity, on critters only. As a force it would affect a Zip and a Hulk identically, which is wrong |
| Kingslayer "homes weakly" | 9 u/s² applied **perpendicular to velocity** for 1.5 s. Perpendicular-only bends the arc without adding speed, so it corrects a near miss and cannot rescue a bad shot |
| Airlift's King drift had no range | the same ±1.5 over 5 s as a Zeppelin Hog. A second drift pattern to learn would be difficulty, not depth. Balloon is a separate 1 hp body |
| Flak Hog did not say **which** pig | **the builder picks it** with a toggle in the editor. Every automatic rule was arbitrary or exploitable, and all of them hid a decision worth making. A player's explicit choice is also the most replayable input there is |
| Mason did not say which block returns | the **earliest destroyed** unrestored block whose original space is clear. Rebuilds bottom-up, which is what a defender wants, and is the only option that is both deterministic and legible to the player watching it |
| Decoy King had no cost or stats | 6 scrap, King stats, identical in the preview, and it does **not** satisfy the one-King rule. Paying for the decoy competes with paying for walls |
| Second Slingshot had no second height | same x, 3.6 units higher. A different x would change the range of every shot and rebalance the whole bag; height changes only the angles, which is what the card sells |
| Free rotation with `Shift` in the editor | **removed.** 24 steps of 15° is ample for a fortress, and an arbitrary angle cannot be represented in the grid-snapped wire codec without a second, much larger format. It was written into the controls without checking it against the blueprint format |
| Whether the **settled** fortress crosses the wire | it does not. The relay validates and settles a blueprint to confirm it stands, then sends the **authored** blueprint; both sides settle it themselves and get the identical result, because the simulation is bit-identical across engines. Settled poses are arbitrary floats that the codec cannot express |
| The Decoy King and the Flak Hog both mark a *specific placed pig*, which the `[pigId, x, y]` tuple could not express | the pig tuple gains a fourth element, a flags integer. Bit 0 is decoy, bit 1 is flak. Without it both marks were silently lost on encode, so a decoy would have arrived at the opponent as a real King |

Two things remain deliberately unauthored until there is evidence to author them from:
the per-level campaign star thresholds, which arrive with the levels in P5, and the 23
values in `data.js` marked `// guess`, which `tools/balance.mjs` exists to revisit.
