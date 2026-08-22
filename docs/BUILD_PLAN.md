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

`levels.js`, 52 levels authored in the editor and exported, episode and level select,
three-star thresholds, progress save through `/_guard/profile` with `localStorage`
fallback.

**Gate:** `tools/balance.mjs --campaign` — a bot plays every level; flags any level
that is unwinnable, any where three stars is impossible, and any where three stars
falls out of firing at the ground. Every level must be completable by the bot with
at least one critter to spare.

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

## Estimated size

| File | Line budget |
| --- | --- |
| `data.js` | 700 |
| `physics.js` | 900 |
| `sim.js` | 1100 |
| `levels.js` | 800 |
| `build.js` | 600 |
| `bots.js` | 450 |
| `render.js` | 1100 |
| `audio.js` | 200 |
| `net.js` | 150 |
| `game.js` | 1300 |
| `worker.js` | 800 |
| **total** | **~8100** |

Comparable to `bop` at roughly 7100. A file that runs 30% over its budget is a
signal that it is doing two jobs, and gets split rather than excused.
