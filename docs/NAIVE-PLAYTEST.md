# Naive playtest findings

`tools/naive-playtest.mjs` screenshots the running game, hands each frame to a vision
model told **nothing** about it, and executes whatever action it returns. It reports what
it sees, what it thinks the goal is, and what it cannot work out.

The point is the last of those. Nobody who has built a game can judge its legibility — I
know the slingshot is a slingshot and that pulling back and down launches forward and up.
A first-time player knows neither, and that gap is invisible from the inside.

First run: `stealth/ox-alpha`, 14 turns, 2026-08-23.

## What worked

Navigation was **completely legible**. Title → Campaign → Episode → Level, first try, zero
confusion. It correctly inferred the whole structure from the pictures: that dashed borders
with padlocks meant locked, that "0 of 39 stars" was progress, that clearing eight levels
unlocks the next chapter. It also read the genre instantly — "this looks like an Angry
Birds-style slingshot destruction game" — and it **beat level 1**, earning two stars with
15,100 points, then advanced.

So the shell, the art direction and the level design communicate. What follows is
everything that does not.

## 1. Pull strength is invisible — mentioned in six of fourteen turns

> "I still do not know how pull distance maps to launch power or trajectory"
> "I am guessing a shorter pull gives a lower, faster shot"
> "I still cannot tell exactly how pull length and angle map to flight path"

It said a version of this on turns 6, 7, 8, 10, 11 and 12, and it lost the level twice
before stumbling into a flat hard pull that worked. It never once mentioned seeing a
trajectory preview.

The game **has** a trajectory preview: ten fading dots along the launch parabola. It is
drawn too faint against the sage hills to register, which was noted as a cosmetic risk in
`BUILD_STATE.json` after P2 and deferred.

**That deferral was wrong.** This is not cosmetic. Aiming is the only verb in the game, and
its sole feedback channel is not reaching the player. Highest priority fix.

## 2. No confirmation that a shot was fired — three turns

> "I still cannot tell whether my last drag fired a shot or was ignored"
> "I cannot tell whether the counter really says 0 or 1, nor where my launched critter went"

A release produces no unmistakable acknowledgement. The critter leaves the pouch and the
camera follows it, but on a frame-by-frame view — which is how anyone glancing away
experiences it — nothing says *that happened*.

## 3. The critter counter cannot be read

> "a small brown critter appears seated in the empty slingshot pouch, yet the counter says 0"

The HUD draws remaining critters as small heads. It looked like the count and the pouch
disagreed. Drawn heads were chosen over a number deliberately, and at HUD size they are too
small to count.

## 4. The win condition is not stated anywhere

> "I cannot tell whether I must hit the pig directly or whether toppling the shelf counts
> as destroying it"

Nothing tells the player that pigs are the target and that clearing them all ends the
level. It guessed correctly from genre familiarity, which a child or a non-gamer will not
have. Every level is also designed so a pig **cannot** be hit directly, which makes this
worse: the obvious interpretation is the one the game forbids.

## 5. Ammo and target look alike

> "unclear whether the pink critter under the structure is the target or one of the
> projectiles — the pink thing may be an enemy to crush rather than the ammo"

Said on the title screen, before play. Critters are warm red-orange with a cream belly;
pigs are dusty rose. Choosing dusty rose over the genre-standard green felt like a good
call — and it left the thing you fire and the thing you fire at in the same warm
pink-red family.

## What this run does not cover

One model, one session, fourteen turns, and only the first two levels. It says nothing
about the later episodes, the editor, or Siege. Worth re-running per episode and after the
fixes above, and worth running against the editor, which is a far denser interface than
anything tested here.

---

# Full campaign run — 2026-08-24

`tools/naive-campaign.mjs` plays all 52 levels with a vision model that has been told
nothing, films each one, and concatenates a single film of the whole campaign. Two runs,
before and after the critter work.

## The comparison

| | before | after |
| --- | --- | --- |
| won | 17 / 52 | **19 / 52** |
| lost | 26 | 30 |
| unfinished inside 16 turns | 9 | **3** |
| lines mentioning abilities, taps or bird types | 24 | **93** |

**The win rate is not the result.** It moved by two levels, which is inside the noise of a
stochastic tester — `sty-01` was won in one run and lost in the other.

The result is the last row. Before the change, the tester played 52 levels and barely
referred to abilities at all; the birds were one colour and one silhouette, so there was
nothing to refer to. After, it talks about them roughly four times as often. It is now
playing a game with nine tools in it rather than a game with one.

The second real signal is **unfinished falling from 9 to 3**. Those were levels where the
tester ran out of turns still flailing. Knowing what a critter does turns an unresolved
level into a decided one, win or lose.

The clearest single case was `sty-07`, "The Spine" — a four-piece level whose whole idea is
drilling through one load-bearing post. The tester met the Wedge card, read *"tap to
accelerate hard, drills straight through wood"*, and took it in **two turns on the first
attempt for two stars**. In the baseline it needed several attempts and never mentioned an
ability.

## The difficulty curve, measured rather than assumed

| episode | won |
| --- | --- |
| 1 — Sty | 7 / 13 |
| 2 — Quarry | 7 / 13 |
| 3 — Highwind | 3 / 13 |
| 4 — Ironworks | 2 / 13 |

That is a real curve and it is roughly the shape the episodes were designed for: the first
half approachable to someone with no context, the back half not. `tools/balance.mjs`
answers a different question — its bot clears 52/52 with a ballistic solver and full
knowledge — so this is the only measurement of the campaign as a stranger meets it.

Whether episodes 3 and 4 are *too* hard is a judgement call that now has evidence under
it rather than opinion.

## All nine introductions fired where intended

`sty-01` Nib · `sty-04` Chip · `sty-07` Wedge · `qry-04` Spike · `qry-07` Lob ·
`hwd-01` Pebble · `hwd-04` Boomer · `iro-04` Hulk · `iro-10` Zip

One critter roughly every six levels, and that cadence emerged from four separately
authored episodes rather than being planned centrally.

## Four harness faults that first presented as game results

Worth recording, because each produced a confident and wrong number:

1. **Breaking on first loss.** Recorded "lost" for levels the tester goes on to win on its
   third attempt. A real player reads the failure screen and presses Retry.
2. **Rate limits scored as defeat.** Six workers against a free endpoint got throttled, and
   one 429 aborted the level after a single turn — printed as `unfinished, 1 turn`, which
   reads as the tester failing rather than the harness being throttled.
3. **Deadlock on the tutorial card.** Waiting for `phase === 'aiming'` never returned,
   because the card deliberately gates the round. Nine minutes, zero levels.
4. **The seen-critters list resetting.** Every level runs in a fresh context, so the tester
   met the same introduction on all 52 and every line read `+Nib`.

Together with the saturated glass column and the truncated tap sweep from P3, that is six
occasions on this project where a measurement described the instrument rather than the
subject. It is the single most recurrent failure mode in the build, and the reliable
defence has been a control: run the same test against something known-good and see whether
it fails identically.

## Artefacts

- `shots/naive-campaign/report.md` — per level: outcome, stars, score, attempts, turns,
  and every confusion in the tester's own words
- `shots/naive-campaign/video/` — 52 webm clips, one per level, in campaign order
- `shots/naive-campaign/campaign.webm` — 434 MB, the whole campaign in one film
- `shots/critter-sheet.png`, `shots/critter-ingame.png` — the nine birds as art and at real
  gameplay size
