# Worklog

Append-only. One line per task transition, written by `tools/progress.mjs`, plus a
hand-written session summary at each pause.

The point of this file is that **no progress lives in a chat transcript**. If a
session dies mid-phase — usage limit, crash, closed laptop — `node tools/progress.mjs`
plus this file plus `git log` reconstruct the state completely.

## The resume protocol

```bash
node tools/progress.mjs --full     # where am I, what is next, is the tree clean
npm run check                      # is what exists actually working
```

Rules the build follows so that stays true:

1. **Commit at every green gate**, never at a "should work". `git log` is the recovery
   point, so every commit must be a state the check passes in.
2. **One task in `doing` at a time.** `node tools/progress.mjs start P1.3` before
   touching a file, `done` after the gate for it passes.
3. **Uncommitted work is unfinished work.** If the tree is dirty at resume, the last
   task is not done regardless of what its status says — re-run the gate first.
4. Delegated work is not done until it has been reviewed and the gate run locally.
   A subagent reporting success is a claim, not evidence.

---

## Session 1 — 2026-08-22

Planning and scaffold (P0). Design, architecture contract, build plan, file plan,
deploy runbook, `tools/check.mjs` as the standing gate. Committed
`chore: plan and scaffold SLINGWRECK`.

Started P1.

**Delegation:** implementation is delegated to `gpt-5.6-sol` through the Codex CLI on
the ChatGPT OAuth session (`codex exec -m gpt-5.6-sol`), to keep the Claude context
budget for specification and review. Prompts live in `tools/prompts/` so a delegated
step is repeatable rather than a one-off message.

- 2026-08-22 `P1.1` **doing** — data.js — TUNE, MATERIALS, SHAPES, AMMO, PIGS, CARDS

- 2026-08-22 `P1.1` **done** — data.js — TUNE, MATERIALS, SHAPES, AMMO, PIGS, CARDS. 697 lines. Reviewed: renamed shape wedge->tri (wire-format collision with ammo wedge), replaced hand-written index maps with loops, dropped CONTROLS, removed the unreachable match-point tier rule. 10 design gaps tracked as P3.0.

- 2026-08-22 `P1.2` **doing** — physics.js core — deterministic scalar math, bodies, (c,s) rotation, integration, digest

- 2026-08-22 `P1.2` **done** — physics.js core — deterministic scalar math, bodies, (c,s) rotation, integration, digest. 303 lines. Reviewed: fixed xorshift seed-0 absorbing state, moved the maxSpeed clamp to after solveVelocity (impulses could tunnel), addBody now accepts vx/vy/av. FNV shift-add and triangle inertia verified correct.

- 2026-08-22 `P1.3` **done** — tools/determinism-test.mjs — run against integration-only, across node + 3 browser engines. All four engines bit-identical over 1800 steps, WebKit via podman. npm run test:determinism:all.

- 2026-08-22 `P1.4` **doing** — physics.js solver — broadphase, SAT, manifolds, sequential impulses, position solve

- 2026-08-22 `P1.4` **done** — physics.js solver — broadphase, SAT, manifolds, sequential impulses, position solve. 924 lines. SAT + clipped 2-point manifolds + warm start + 2x2 block solve; Baumgarte confined to the position pass as specified.

- 2026-08-22 `P1.5` **done** — physics.js islands — union-find, sleeping, waking, raycast. Union-find islands excluding statics, sleeping, isSettled, raycast/raycastAll.

- 2026-08-22 `P1.6` **done** — tools/physics-test.mjs — the seven solver assertions. Seven gates. Reviewed: pyramid scene had 4-wide planks at 3-unit spacing so adjacent planks overlapped by a unit; the 0.75 threshold was hiding it. Fixed geometry, tightened to 0.05, added assertNoOverlap to every hand-placed scene and maxPenetration() to physics.js.

- 2026-08-22 `P1.7` **done** — P1 gate — check + determinism green against the full solver, commit. Four engines bit-identical with the full solver. Determinism risk closed.

### P1 complete — 2026-08-22

The determinism gate is green with the full solver. **V8, SpiderMonkey and
JavaScriptCore produce bit-identical digests over 1800 steps** with SAT, clipped
two-point manifolds, warm starting, eight impulse iterations, a 2x2 block solve,
three position iterations, union-find islands and sleeping all active.

That was the project's largest open risk and it is closed. The relay audit model in
`ARCHITECTURE.md` §5 is viable; the lenient fallback is not needed.

Physics quality, measured rather than asserted:

| scene | result |
| --- | --- |
| 10-cube stack | asleep in 0.97 s, drift 0.000074 |
| 3-tier post-and-plank pyramid | asleep, top intact, max travel 0.022 |
| dropped ball, e = 0.72 | measured 0.729, 1.30% error |
| box on a 20 degree ramp | mu 0.6 slides 0.00001, mu 0.2 slides 16.3 |
| 200 bodies into a bin | all asleep by 6 s, none escaped |

Three defects found reviewing the delegated work, all fixed:

1. `rng(0)` returned zero forever — xorshift32's absorbing state. Seeds arrive from
   the wire, so zero is not a hypothetical input, and a dead RNG does not look like a
   bug, it looks like a match where nothing is randomised.
2. The `maxSpeed` clamp ran before the velocity solver, leaving contact impulses
   unbounded for the position integration immediately after. One frame through the
   floor.
3. The pyramid gate used 4-wide planks at 3-unit spacing, so adjacent planks started
   a full unit inside each other. The whole 30 seconds was the structure climbing out
   of that, 0.54 units of travel, passing against a 0.75 threshold chosen to fit the
   observed number. Corrected geometry moves 0.022. `maxPenetration()` now exists in
   `physics.js` and every hand-placed scene asserts it starts clean.

The third is the one worth remembering: **a threshold picked after seeing the
measurement is not a gate, it is a record of one run.**

Next: P2, the vertical slice. Tasks P2.1 to P2.8 are in `BUILD_STATE.json`.

- 2026-08-22 `P2.1` **doing** — sim.js — world build from a level blueprint, slingshot launch, camera-independent round state

- 2026-08-22 `P2.1` **done** — sim.js — world build from a level blueprint, slingshot launch, camera-independent round state. sim.js 598 lines: blueprint format, instantiate, slingshot launch, round phases, shot log.

- 2026-08-22 `P2.2` **done** — sim.js — impulse damage model, block destruction, pig death, settle detection, event list. Impulse damage with directional pig armour, deferred death, queued non-recursive TNT chaining, raycast blast occlusion, event list.

- 2026-08-22 `P2.3` **done** — tools/sim-test.mjs — headless rules assertions: launch, damage thresholds, settle, scoring. 8 assertions incl. shot-log replay determinism. Found and fixed: circles rolled forever with no rolling resistance, so every shot burned the 6 s settle timeout. Now 1.9-2.1 s.

- 2026-08-22 `P2.4` **doing** — render.js — canvas 2D, three materials and one critter, art direction settled here

- 2026-08-22 `P2.4` **done** — render.js — canvas 2D, three materials and one critter, art direction settled here. render.js 1300-line budget. Reviewed by rendering real frames to PNG and looking at them, twice. First pass: camera fitted by width so the fortress was 15% of frame with 70% sky, no slingshot drawn at all, pigs illegible, ground a flat slab. Second pass fixed all five. Trajectory dots still unverified - needs real drag input, do it in P2.5.

- 2026-08-22 `P2.5` **doing** — index.html + style.css + game.js — fixed-step accumulator, drag-aim slingshot, win/lose/retry

- 2026-08-22 `P2.5` **done** — index.html + style.css + game.js — fixed-step accumulator, drag-aim slingshot, win/lose/retry. game.js 495 lines, index.html, style.css. Reviewed by playing it headlessly and looking at frames. Found: aiming camera could not show sling and fortress together (slingX -16 was too far, and my own 'never zoom below default' rule wedged it), and the camera never returned to the fortress after a shot. Moved slingX to -9, viewMinX to -13, three-state camera, background drag-to-pan. Fixed 4 test fixtures that encoded the old geometry; made the reach test stricter (partial draw lands in plot AND full draw overshoots).

- 2026-08-22 `P2.6` **done** — tools/stamp.mjs — rewrite the ?v= cache stamp across every importing file. tools/stamp.mjs; one stamp everywhere, 20260822-1, verified by check.

- 2026-08-22 `P2.7` **doing** — tools/smoke.mjs — Playwright: boot, drag, fire, kill a pig, see the win screen

- 2026-08-22 `P2.7` **done** — tools/smoke.mjs — Playwright: boot, drag, fire, kill a pig, see the win screen. tools/smoke.mjs: 22 assertions through the real UI, desktop + portrait touch, 11-17 s. Verified it actually fails: injected console error -> FAIL + exit 1. Sol also found and fixed the result panel focusing Retry instead of the heading.

- 2026-08-22 `P2.8` **done** — P2 gate — npm test green, re-run test:determinism:all, commit. check green, smoke 22/22, physics 7/7, sim 8/8, settle 3/3, four engines bit-identical.

### P2 complete — 2026-08-22

The game is playable. Title screen, drag-to-aim slingshot, a real level, destruction,
scoring, win and lose, restart, portrait touch.

Gates: `check` clean, `smoke` 22/22 through the real UI in ~11 s, `physics` 7/7,
`sim` 8/8, `settle-probe` 3/3, and four engines still bit-identical.

Three defects found by reviewing rather than by reading a report:

1. **Circles rolled forever.** No rolling resistance anywhere, so a critter on flat
   ground kept exactly 7.0000 units per second indefinitely, `isSettled` never latched,
   and every single shot burned the full 6-second settle timeout before the player
   could fire again. Global angular damping was tried and rejected with numbers — it is
   still too slow at a value high enough to drain spin from a critter in flight, and it
   removes the energy that carries a pig off the plot. Contact rolling resistance,
   which only acts while something rests on something, fixed it: shots now resolve in
   1.6 to 2.1 s.
2. **The camera never showed the fortress.** While aiming, the fortress was entirely
   off-screen; after a shot settled, the camera stayed parked at the slingshot, so the
   player never saw what their shot did. That is the entire feedback loop of the genre.
   Root cause was `slingX` at -16 against a 24-wide plot — over 40 world units, which no
   height-fitted camera can show — compounded by a "never zoom below the default" rule
   in the spec that was simply wrong. Sling moved to -9, three camera states, and
   dragging the background now pans.
3. **The slingshot was not drawn at all** in the first renderer pass. In a slingshot
   game.

All three were only visible by rendering frames to PNG and looking at them. The written
reports for those same passes said everything worked.

Moving `slingX` broke four test fixtures that had the old geometry baked in. They were
fixed as fixtures, not as thresholds — and the reach assertion came back stronger than
it went in: it now requires a partial draw to land inside the plot **and** a full draw
to overshoot it, because a tuning with no headroom passes a plain reach test and is
still wrong.

The smoke gate was verified to actually fail: injecting a console error produces a FAIL
line and exit code 1.

Next: P3, content. **P3.1 first** — the four-engine determinism gate currently covers
`physics.js` only, because its scenario is 40 falling bodies and never touches
`sim.js`. The relay audit replays `sim.js`. Prove that portable before adding eight
abilities' worth of new arithmetic to it.

- 2026-08-22 `P3.1` **doing** — Extend the determinism test to cover sim.js, not just physics.js

- 2026-08-22 `P3.1` **done** — Extend the determinism test to cover sim.js, not just physics.js. Second scenario: 30+ blocks of every material, every pig type, 3 TNT, 6-shot log. Exercise counts 12 blocks destroyed / 5 pigs killed / 3 explosions / 2 TNT chained, so the paths are genuinely hit. All four engines agree on both tables. The relay audit model is now proven for sim.js, not just the solver.

- 2026-08-22 `P3.2` **doing** — Author the underspecified sim params (was P3.0)

- 2026-08-22 `P3.2` **done** — Author the underspecified sim params (was P3.0). All 10 authored in data.js with the reasoning inline, DESIGN.md corrected where it contradicted itself, and a resolved-ambiguities table added. Notable: Hulk is 4x area not 3x volume (sqrt is exactly 2, so the radius stays a clean decimal); Chip fragments keep parent SPEED because splitting momentum would make the tap worse than no tap; Flak Hog's pig is chosen by the builder because every automatic rule was arbitrary, exploitable, or both.

- 2026-08-22 `P3.3` **doing** — Implement the 8 remaining critter abilities: split, accel, boom, drop, reverse, inflate, harden, blink

- 2026-08-22 `P3.3` **done** — Implement the 8 remaining critter abilities: split, accel, boom, drop, reverse, inflate, harden, blink. All 8 abilities, each with a measured tapped-vs-untapped assertion (16 sim assertions now). Chip rotation uses precomputed (c,s) literals so no trig enters the sim; blink raycasts and backs off so it cannot teleport into a block; harden uses a generic pierce filter in physics.js plus a swept damage test in sim.js. Determinism sim scenario now taps every ability. ALSO fixed a 50% flaky smoke assertion that Sol had shipped knowingly: the test pressed at fixed screen pixels while the camera was still easing, so screenToWorld gave a different shot each run. Now waits for camera stability and aims in world space; 13 consecutive runs give an identical score of 6,400 and 1/3 pigs.
