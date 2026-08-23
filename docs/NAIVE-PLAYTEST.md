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
