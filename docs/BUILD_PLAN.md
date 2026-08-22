# SLINGWRECK — build plan

Nine phases. Each has a **gate**: a command that must pass before the next phase
starts. A phase is not done because the code exists, it is done because the gate is
green and `BUILD_STATE.json` says so.

Phases are ordered so that the riskiest unknown is resolved first. That unknown is
not the gameplay — it is whether a hand-written rigid-body solver stacks boxes
without jitter and produces bit-identical results across four JavaScript engines.
If that fails, the netcode design in `ARCHITECTURE.md` §5 changes, and it is much
cheaper to learn that in phase 1 than in phase 6.

---

## P0 — Scaffold ✅

Repository, configs, planning documents, CI workflow, hub registration steps.

**Gate:** `npm run check` — `tools/check.mjs` verifies the plan and the state agree,
that no unplanned module exists, that cache stamps match, and that nothing in the
simulation violates the determinism ban list. It passes on an empty repository on
purpose: a gate nobody can run until phase 6 is a gate nobody runs.

---

## P1 — Physics core

`physics.js` and `data.js`. No game, no rendering, no canvas.

- Body representation: convex polygon and circle, `(c, s)` rotation, mass and
  inertia from shape and density.
- Broadphase: sort-and-sweep on x. 120 blocks does not need a tree.
- Narrowphase: SAT with reference-face clipping, two-point manifolds for
  face-face contacts. One-point for circles.
- Sequential impulse solver with warm starting, Coulomb friction clamped against the
  normal impulse, restitution applied on the first iteration only.
- Position solver, 3 iterations, Baumgarte with slop.
- **Island sleeping.** Union-find over contacts, an island sleeps when every body in
  it has been under the thresholds for `sleepTime`. Waking propagates.
- Raycast, needed for explosion occlusion and burial-depth validation.
- Seeded xorshift.

**Gate:** `npm run check` runs `tools/physics-test.mjs`:

1. A 10-high stack of cubes is asleep within 2 s and has drifted less than 0.02
   units.
2. A 3-4-5 pyramid of planks and posts stands for 30 s and stays asleep.
3. A dropped ball's bounce heights follow the restitution coefficient within 5%.
4. A box on a 20° ramp with `mu 0.6` does not slide; at `mu 0.2` it does.
5. 200 bodies dropped into a box reach sleep within 6 s and never tunnel out.
6. Reversing gravity and running backward from a settled state does not NaN.
7. Two identical worlds run 3600 steps and produce identical digests.

**Gate:** `npm run test:determinism` — the same seeded scenario, 1800 steps, in Node,
Chromium, Firefox and WebKit, digests compared byte for byte. **This is the phase's
real purpose.** If it fails and cannot be fixed by removing a transcendental, stop
and re-plan the audit model before writing any more code.

---

## P2 — Vertical slice

`sim.js`, `render.js`, `game.js`, a single hard-coded level, and `nib` only.

- Slingshot: drag, aim clamp, release, launch impulse from draw distance.
- Camera: follows the critter out, returns to frame the fortress.
- Damage model, block removal, debris.
- Pigs as bodies that die.
- Win and lose, retry, next.
- A renderer that is genuinely good-looking with three materials and one critter,
  because the art direction is easier to fix now than across 52 levels.

**Gate:** `npm test` — Playwright boots the page, drags the slingshot, fires, kills
a pig, sees the win screen. Fails on any console error, page error or failed
request.

---

## P3 — Content

All 9 critters, all 8 pigs, all 8 materials, explosions and chaining, `audio.js`.

**Gate:** `tools/playtest.mjs --all` fires every critter into a standard test
fortress and dumps telemetry and a screenshot per critter into `shots/`. Asserts
that every ability observably changes the outcome versus not tapping — an ability
whose tap does nothing measurable is a bug, and this is the only way to catch it.

---

## P4 — Editor

`build.js`: palette, snapping, rotation, budget, legality rules, settle test,
blueprint encode and decode.

Built before the campaign on purpose, because the campaign is authored with it.

**Gate:** `tools/editor-test.mjs` — round-trips 200 randomly generated blueprints
through encode and decode; asserts every legality rule rejects exactly what it
should, including burial depth and the settle test; asserts a blueprint that passes
validation always settles.

---

## P5 — Campaign

`levels.js`, 52 levels, episode and level select, three-star thresholds, progress save
through `/_guard/profile` with `localStorage` fallback.

### A correction to how the levels get authored

P0 said the levels would be "authored in the Siege fortress editor and exported", and
that the editor would therefore get enough use to become good. The second half holds. The
first half does not survive contact with how this project is actually built: 52 levels
placed piece by piece through a pointer is not something this workflow can do, and
pretending otherwise would mean either 52 bad levels or a stalled phase.

So the authoring path is inverted, and the editor's role changes rather than disappears:

- **Levels are authored as data** — blueprint literals in `levels.js`, built from a small
  set of structural motifs (a tower, a bunker, a bridge, a stack) composed and varied per
  level. Composition in code is *better* for a set of 52 that has to teach a mechanic per
  episode, because the progression can be reasoned about directly rather than eyeballed.
- **Every level is then validated through `build.js`**, which already exists and already
  enforces the rules: inside the plot, nothing overlapping at rest, and — the one that
  matters most here — it must pass `settleTest`, so no shipped level can collapse on its
  own before the player takes a shot.
- **The editor is where levels get inspected and tuned.** `tools/level-export.mjs` gains
  a companion: load any level *into* the editor by index, adjust it, copy the encoded
  string back out. That is the loop that makes a level good, and it is the loop the
  editor's export and import were built for.

The editor still earns its cost: Siege cannot exist without it, and it is the only way to
look at a level and change one plank.

**Gate:** `tools/balance.mjs --campaign` — a bot plays every level; flags any level that
is unwinnable, any where three stars is impossible, and any where three stars falls out
of firing at the ground. Every level must be completable by the bot with at least one
critter to spare. Plus: **every level must pass `validate` and `settleTest`**, asserted
for all 52, because a level that collapses before the first shot is not a difficulty
choice.

**And every level gets looked at.** `tools/level-shots.mjs` renders each one after its
settle and builds a contact sheet of the whole campaign. An episode is not done until the
contact sheet has been reviewed. A level can pass validation, settle cleanly, be
completable by a bot, and still be a bad level — too similar to its neighbour, an
unreadable silhouette, or a difficulty spike — and none of that is visible in a table of
numbers. This is rule 3 applied to content instead of to code.

---

## P6 — Relay and online Siege

`worker.js`, `net.js`, lobbies, build phase authority, shot streaming, the audit
replay, the corner preview stream, reconnect.

**Gate:** `npm run test:mp` — two real browsers against a real relay: create and
join, both build and lock in, both siege simultaneously, previews update on both
sides, a King pop ends the round on both clients within 500 ms, one client drops and
reconnects and resumes.

**Gate:** `tools/audit-test.mjs` — a deliberately lying client reports an inflated
score and is caught and forfeited.

**Fallback, decided now so it is not decided under pressure:** if cross-engine
determinism proved unreliable in P1, the audit degrades to `VALIDATE=lenient` —
bounds, shot timing and plausibility only — and the README says so plainly rather
than claiming an anti-cheat that does not work.

---

## P7 — Match flow

Best of five, the draft, all 25 cards, scrap budgets, tier selection from deficit,
sudden death, results.

**Gate:** `tools/balance.mjs --siege -n 400` — bot matches across card combinations.
Flags any card whose holder exceeds a 65% round win rate at parity or falls below
40%, and reports the distribution of round outcomes by win condition. If more than
70% of rounds resolve on points rather than a King pop, the mode is not working as
designed and the numbers move.

---

## P8 — Polish and ship

Solo Siege bots at three difficulties, `tools/card-shot.mjs` for the 1000×525 hub
card and the 1200×630 social image, `robots.txt` and `sitemap.xml` verified,
accessibility pass, mobile layout, `docs/reference.md` written up.

**Gate:** every previous gate green in CI, plus a live smoke test against
`slingwreck.andrenijman.com` and the deployed relay.

---

## What this build has learned

Every one of these came from a real defect that reached a "verified, all gates pass"
report. They are cheap to apply and expensive to rediscover, so later phases apply them
without being asked.

1. **A threshold chosen after seeing the measurement is not a gate.** The pyramid test
   shipped with a 0.75 limit because the structure moved 0.54. The structure was
   collapsing; the geometry was wrong; correct geometry moves 0.021. Decide the
   threshold from what the code *should* do, then measure.
2. **A scene whose bodies start inside each other tests recovery, not the thing named in
   the assertion.** Call `maxPenetration` and assert it before stepping. This is why
   `physics.js` exports it.
3. **Look at the rendering.** Three defects in P2 — a camera that never showed the
   fortress, illegible pigs, and a slingshot that was never drawn at all — were
   invisible in every written report and obvious in the first PNG.
   `tools/frame-shot.mjs` and `tools/state-shots.mjs` exist for this.
4. **A flaky gate is worse than no gate.** The portrait smoke assertion failed 50% of
   the time and was shipped with a note calling it "timing-sensitive". The fix is to
   remove the race — wait for the condition, act in world space — never to loosen the
   assertion. A deterministic test should print the *same number* every run, not merely
   pass.
5. **Prove a check can fail.** `npm test` was verified by injecting a console error and
   confirming exit code 1. The audio event-coverage check was verified by adding a fake
   event kind. A check nobody has watched fail is decoration.
6. **Assert measured values, not verdicts.** `stack drift 0.000075 < 0.02` is
   debuggable; `PASS` is not.
7. **An ability, trait or material that does nothing measurable is a bug.** Every one
   gets an assertion comparing with-behaviour against without-behaviour, printing both.
   But note the weakness: *"changes the outcome"* is not *"improves the outcome"*. An
   ability that makes things strictly worse passes that assertion. `tools/playtest.mjs`
   carries the stronger criterion — an ability fails if **no** tap timing anywhere beats
   not tapping at all.
8. **Check whether the metric is saturated before believing it.** `chip` appeared to do
   nothing for glass because both the tapped and untapped runs reported 36.0 damage. The
   fixture contained exactly 36 hit points of glass: both runs destroyed all of it and
   the number was the ceiling, not a null result. Report damage against the total
   available, so a saturated measurement looks saturated.
9. **One fixed test condition measures the condition, not the subject.** Tapping every
   ability at the same instant made `lob` look broken — a detonator triggered in open
   air mid-flight *should* underperform one allowed to reach the target. Sweep the
   variable and report the best, plus where the best was.
10. **When a tuning value moves, fixtures break — fix them as fixtures.** Moving the
   slingshot broke four tests that had the old geometry baked in. Updating a fixture's
   *geometry* is correct; relaxing its *threshold* to accommodate the change is how a
   suite quietly stops meaning anything.
11. **Delegated work is a claim, not evidence.** Every task so far needed corrections
   after its report said everything passed.

## Estimated size

| File | Line budget |
| --- | --- |
| `data.js` | 900 |
| `physics.js` | 1100 |
| `sim.js` | 1400 |
| `levels.js` | 800 |
| `build.js` | 600 |
| `bots.js` | 450 |
| `render.js` | 1400 |
| `audio.js` | 200 |
| `net.js` | 150 |
| `game.js` | 1300 |
| `worker.js` | 800 |
| **total** | **~9400** |

Comparable to `bop` at roughly 7100. Raised from an initial 8100 across P1 to P3 as content landed; `docs/FILE-PLAN.json` records the reason beside each change. A file that runs 30% over its budget is a
signal that it is doing two jobs, and gets split rather than excused.
