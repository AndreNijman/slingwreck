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

- 2026-08-22 `P3.4` **doing** — Implement the remaining pig traits: helm/tusk armour verification, zep balloon, sarge repair

- 2026-08-22 `P3.4` **done** — Implement the remaining pig traits: helm/tusk armour verification, zep balloon, sarge repair. Helm/tusk armour verified from BOTH sides (0.40 ratio armoured, 1.00 unarmoured). Zep balloon hovers and drops when popped. Sarge repair is siege-only, deterministic, skips occupied space, and its test covers the tie-break too. Spring 4.6x rebound for critters only. Gel far-side ratio exactly 0.30 with its own damage unchanged. Sand and large stone both conserve mass exactly (1.2 and 3.8). 24 sim assertions, four engines agree, 9 exercise counts all non-zero.

- 2026-08-22 `P3.5` **done** — Implement remaining material behaviours: spring ammoRestitution, gel absorb, sand chunks, large-stone sub-bodies. Delivered with P3.4 - spring, gel, sand chunks and large-stone splitting were the same task.

- 2026-08-22 `P3.6` **doing** — audio.js — WebAudio synthesis driven by the sim event list

- 2026-08-22 `P3.6` **done** — audio.js — WebAudio synthesis driven by the sim event list. audio.js 259 lines, all synthesis, lazy AudioContext on the Play gesture, 16 voices, 30ms coalescing, compressor bus. Added tools/audio-render-test.mjs because the coverage check only proved a handler EXISTS - it renders every event kind offline and measures peak/tail, so a handler that outputs silence now fails. All 15 audible, none clipping, none ringing, settled verified exactly silent. Also found pages.yml only ran 'check', so the browser smoke test had never run in CI at all; added chromium + npm test + test:audio to the workflow.

- 2026-08-22 `P3.7` **doing** — tools/playtest.mjs --all — assert every tap ability measurably changes the outcome

### P3 in progress — 2026-08-22

Six of eight done: the determinism gate extended to `sim.js`, the ten underspecified
parameters authored, all eight critter abilities, all four pig traits, all four material
behaviours, and audio.

`tools/sim-test.mjs` is at 24 assertions. Every ability, trait and material is asserted
as a **measured difference between having it and not having it**, printing both numbers,
because a feature that does nothing measurable is a bug and nothing else catches it. The
numbers line up exactly with the authored data — gel's far-side damage ratio is 0.30,
both armour ratios are 0.40, and sand and large stone each conserve mass to the digit.

#### The flaky gate, twice

The portrait smoke assertion was fixed in P3.3 and was still not fixed.

After the first fix it passed six times idle with an identical score, which looked
conclusive. It was not: under eight busy CPU workers it produced a different shot one run
in three. It still *passed*, because the assertion is "at least one pig" — so it was
concealing its own nondeterminism rather than reporting it.

The remaining cause turned out to be a **gameplay bug**, not a test bug. `P2.5b`
specified that the aiming camera zooms out at full stretch. The draw vector was being
recomputed each frame with `screenToWorld` against the live camera, so the mapping
shifted while the pointer was still down, by an amount that depended on how many frames
had elapsed. Read as a player rather than as a test: **you pull the sling back, the
camera zooms out, and your aim slides under your finger without you moving it.**

The aim is now anchored — screen-space delta since the press, converted with the scale
captured at the press. Ten runs, six idle and four under load, all report an identical
score of 11,600 and 2 of 3 pigs.

One consequence, noted deliberately: because the draw uses the press-time scale, the
pouch's *screen* position drifts from the pointer by however much the camera zoom
changes during the drag. That zoom change is currently about 1%, so it is invisible. If
the aiming zoom-out is ever made more dramatic, this becomes a visible lag and the right
answer is to reduce the zoom during drag, **not** to go back to live conversion — the
aim being what you pointed at matters more than the pouch tracking your finger exactly.

Two lessons, now in `docs/BUILD_PLAN.md`: passing is not the same as deterministic, and a
test should be measured under load before it is believed.

#### Audio, and a check that could not fail

`audio.js` is all synthesis, no files, with a lazy `AudioContext`, a 16-voice cap and
30 ms coalescing so a collapsing tower is one shatter rather than twenty.

The event-coverage check added alongside it asserts that every kind in `EVENT_KINDS` has
an entry in `EVENT_SOUNDS`. That proves a handler *exists*; it does not prove the handler
makes any sound, which is the same failure one level down.
`tools/audio-render-test.mjs` now renders every kind through a real WebAudio graph
offline and measures peak and tail energy. All 15 are audible, none clip, none are still
ringing at 2.5 s, and `settled` is verified to be exactly silent rather than silent by
omission.

Writing that test produced three failures that were all **mine**: an `OfflineAudioContext`
reports `suspended`, so `pushEvents` correctly refused to schedule anything; RMS over a
fixed 2.5 s window penalises short sounds, which is all of them; and one generic payload
gave `shatter` wood instead of glass and `gel-absorb` no `amount`. Worth recording — the
harness is as likely to be wrong as the code, and a red test is not automatically a bug
in the thing under test.

#### CI was not running the browser gates at all

`pages.yml` ran only `npm run check`, which is pure Node. The 23-assertion smoke test had
never run in CI, so a broken page could have deployed with every gate reporting green.
The workflow now installs Chromium and runs `npm test` and `npm run test:audio`.

#### P3.7 — the playtest harness, and a conclusion I got wrong

`tools/playtest.mjs` fires every critter into one shared fortress across every tap
timing, prints damage per material against the total available, and fails only when an
ability has **no** timing at which it beats not tapping. 774 measured shots, nine
screenshots, and it was verified to fail by neutering an ability.

It took four passes to make it measure anything trustworthy, and each pass invalidated
the conclusion of the one before:

1. First run: `lob`, `zip` and `chip` looked "strictly worse when tapped". All three were
   artifacts — one fixed tap step for every ability, which is unfair to a detonator, and
   a glass column that read `36.00` both ways because the fixture held exactly 36 hit
   points of glass and both runs destroyed all of it.
2. Sweeping the tap step and reporting damage against the total available cleared all
   three. It also caught something the coarse sample had missed entirely: Zip's winning
   window is five steps wide, so the original sampling had reported a working ability as
   broken.
3. That sweep still stopped at `impactStep - 1`, which is where I got it wrong.

**The mistake worth recording.** Lob measured 2 winning timings out of 46. I read that as
a design fault — a bomb with a 33 ms window — and had the fix built: abilities can now be
tapped at rest, and Lob gained a three-second fuse.

Then the sweep was extended past impact and Lob measured **46 of 226**. The original
number was mostly the truncated window, not the ability. Worse, the rest-phase tap I
added on the strength of it wins **0 of 4** rest steps for Lob and **0 of 43** for Hulk in
this fixture. I changed the design on the basis of a measurement I had not yet
established was sound.

Both changes stay, for reasons that hold independently of the bad number:

- The fuse means an untapped Lob is never simply wasted, and a deliberate tap still beats
  it by 5,500 points, so it is a floor rather than a ceiling. That was checked explicitly
  because a fuse generous enough to dominate tapping would have been worse than no fuse.
- The rest tap is situational rather than useless: `tools/sim-test.mjs` measures a Hulk
  tapped at rest doing 31.47 damage against 17.69 tapped in flight, because wedging into
  a gap and then expanding is exactly what that card is for. The standard fixture simply
  does not present that situation. It also replays bit-identically, which matters because
  the relay audit replays `tapStep`.

The lesson, now rule 9 in `docs/BUILD_PLAN.md`: establish that a measurement is sound
*before* acting on what it says. A truncated window and a saturated metric both look
exactly like a broken feature.

Final winning-timing counts, pre-impact plus post-impact, out of the swept window:
spike 47/47, hulk 123/257, pebble 32/47, lob 46/226, wedge 20/47, boomer 10/47,
chip 5/47, zip 5/47. Chip and Zip stay narrow on purpose — both must be triggered at a
particular distance, which is skill rather than reflex.

- 2026-08-22 `P3.7` **done** — tools/playtest.mjs --all — assert every tap ability measurably changes the outcome. 774-shot sweep across every tap timing, damage reported against material available, fails only when no timing beats untapped. Verified it can fail. Took four passes to measure honestly - see WORKLOG; I acted on Lob's 2/46 before establishing the sweep window was sound, and it was 46/226 once fixed.

- 2026-08-22 `P3.8` **done** — P3 gate — playtest --all green, re-run all suites and the four-engine determinism, commit. check, smoke 23/23, audio render 15/15, sim 25/25, physics 7/7, settle 3/3, playtest 774 shots all WORKING, four engines agree on both scenarios.

### P3 complete — 2026-08-22

Every critter, pig and material in `data.js` now does something, and each one is asserted
as a measured difference rather than a claim.

Gates: `check`, smoke 23/23, audio render 15/15, sim 25/25, physics 7/7, settle-probe
3/3, playtest 774 shots with all nine critters WORKING, and four engines bit-identical on
both the physics and the sim scenario.

Two gaps closed that were not on the plan: the four-engine gate now covers `sim.js` as
well as the solver — it was replaying 40 falling bodies and never touching the code the
relay audit actually replays — and CI now runs the browser gates, which it had never
done, so a broken page could previously have deployed with everything green.

Next: P4, the fortress editor. It comes before the campaign because the campaign is
authored with it, which is the only way it gets enough use to be good.

- 2026-08-22 `P4.1` **doing** — build.js core — palette, 0.5 grid snap, 15-degree rotation, place, remove, drag-sweep, undo

- 2026-08-22 `P4.1` **done** — build.js core — palette, 0.5 grid snap, 15-degree rotation, place, remove, drag-sweep, undo. Delivered together in build.js + tools/editor-test.mjs; see the P4 worklog entry.

- 2026-08-22 `P4.2` **done** — Budget accounting — material and pig costs, card-modified costs, early-lock scrap bonus. Delivered together in build.js + tools/editor-test.mjs; see the P4 worklog entry.

- 2026-08-22 `P4.3` **done** — Legality rules — plot bounds, no overlap at rest (maxPenetration), 120-block cap, exactly one King, at least two other pigs, burial depth <= 5 by 64-ray sampling. Delivered together in build.js + tools/editor-test.mjs; see the P4 worklog entry.

- 2026-08-22 `P4.4` **done** — Settle test — 3 s simulation, reject a blueprint that collapses or kills its own pigs, return the offending pieces. Delivered together in build.js + tools/editor-test.mjs; see the P4 worklog entry.

- 2026-08-22 `P4.5` **done** — Blueprint encode and decode — compact wire format, round-trip exact. Delivered together in build.js + tools/editor-test.mjs; see the P4 worklog entry.

- 2026-08-22 `P4.7` **done** — tools/editor-test.mjs — 200 generated blueprints round-tripped, every legality rule rejecting exactly what it should, a validated blueprint always settles. Delivered together in build.js + tools/editor-test.mjs; see the P4 worklog entry.

### P4 — the fortress editor

`build.js` is the editor's logic: drafts, snapping, budget, eight legality rules, the
settle test, and a bit-packed blueprint codec. It produces plain data and never builds a
world of its own; `sim.js` remains the only thing that turns a blueprint into bodies.
`tools/editor-test.mjs` covers 200 seeded codec round trips, one crafted case per
legality code, nine hostile payloads, and the settle guarantee.

Encoding is 368 bytes against 1786 of JSON, a 79% saving on something that crosses the
wire every round.

Three format seams were reported rather than papered over, and one of them was a netcode
bug wearing an editor bug's clothes.

**The bug.** `fromBlueprint` set `decoy: false` unconditionally, because the pig tuple
`[pigId, x, y]` had nowhere to put it. The editor's King rule worked correctly on the
draft — its test passed — and the flag was then discarded on encode. A **Decoy King
would have arrived at the opponent as a real King**, and popping it would have ended the
round: the precise inverse of what the card does. The Flak Hog had the same problem,
since `chosenBy: 'builder'` marks one specific placed pig. Pig tuples now carry a flags
bitfield, at a measured cost of 15.3 bytes, and an assertion checks both marks survive a
round trip. The absence of exactly that assertion is what let it through.

**The architectural one.** `settleTest` returned a `settledBlueprint`, and settled
coordinates are arbitrary floats the grid-snapped codec cannot express. The design said
both players attack the settled state, which implied shipping it.

The resolution is that the settled state never crosses the wire at all. The relay
validates a blueprint and settles it to confirm it stands, then sends the **authored**
blueprint; both sides settle it themselves and reach the identical state, because the
simulation is bit-identical across four engines. That is what the determinism work in P1
and P3.1 was for and it had not yet been cashed in. It is smaller, needs no second
format, and puts nothing on the wire that is not derived from data the relay already
validated. The field was deleted rather than left available to be misused in P6, and an
assertion now pins the property it depends on: the same authored blueprint settled in two
separate worlds produces identical digests.

**One capability removed.** Free rotation with `Shift` was written into the editor
controls in P2.5 without checking it against the blueprint format. An arbitrary angle
needs a second, much larger codec; 24 steps of 15° is ample for a fortress. A capability
that cannot survive serialisation should not exist in the editor at all.

- 2026-08-22 `P4.6` **doing** — Editor UI — ghost preview, palette, budget meter, validation feedback, settle-test button

- 2026-08-22 `P4.6` **done** — Editor UI — ghost preview, palette, budget meter, validation feedback, settle-test button. Fortress workshop UI: parts bin with real rendered thumbnails and costs, locked materials naming their unlocking card, hover pricing, human-readable validation with numbered leader lines to the offending pieces, on-screen settle test, blueprint copy/paste. Reviewed by screenshot: first pass framed the sling at 21 px/unit so a cube was 21 px and the overlap error was an unreadable smudge; refrained to the plot at 27.4 px/unit with the sling as an edge badge. Portrait is 15 px/unit - cramped but the whole plot is visible, reported as a number rather than a reassurance.

- 2026-08-22 `P4.8` **done** — P4 gate — editor-test green, all prior suites and four-engine determinism, commit. editor 20+, check, smoke 32/32, audio 15/15, sim 25/25, physics 7/7, settle 3/3, four engines agree.

- 2026-08-22 `P5.1` **doing** — Structural motif library — tower, bunker, bridge, stack, keep; composable and parameterised

- 2026-08-22 `P5.1` **done** — Structural motif library — tower, bunker, bridge, stack, keep; composable and parameterised. Six parameterised motifs with settle assertions at default and extreme parameters, campaign/siege rule split, three example levels, bidirectional level-export tool. Fixed along the way: gridSnap 0.5 could not express a plank's 0.25 half-height and no pig radius aligned to any grid, so settleTest had been loosened to 0.55 units - grid is now 0.25, pigs seat themselves by raycast, movement is 0.0002-0.011 against a strict 0.05. Then found the tight tolerance rejected every Zeppelin Hog, which would have broken all of Episode 3; exempted by traits.balloon and added drift-extreme bounds checking.

- 2026-08-22 `P5.1d` **doing** — tools/level-shots.mjs — a PNG per level plus a contact sheet of the whole campaign

- 2026-08-22 `P5.1d` **done** — tools/level-shots.mjs — a PNG per level plus a contact sheet of the whole campaign. Per-level PNGs plus an adaptive contact sheet (8x7 for 52), settled framing on the structure bounds with a 10-unit minimum, numeric movement column flagged above 0.005, blank-frame detection demonstrated. First pass framed sling-to-plot at 9 px/unit which made every structure unreadable - third time this project has framed the whole playfield instead of the subject.

- 2026-08-22 `P5.2` **doing** — Episode 1 'Sty' — 13 levels, teaches nib/chip/wedge, runt/swine, wood and glass

- 2026-08-22 `P5.2` **done** — Episode 1 'Sty' — 13 levels, teaches nib/chip/wedge, runt/swine, wood and glass. 13 levels, rebuilt once after the contact sheet showed 8 gantries and 8 directly hittable pigs. Now 2 gantries, only the two tutorial pigs directly hittable, heights 2.5-12.0 monotonic, five levels using two ranges.

- 2026-08-22 `P5.3` **doing** — Episode 2 'Quarry' — 13 levels, adds lob/spike, hogg/helm, stone and TNT

- 2026-08-22 `P5.3` **done** — Episode 2 'Quarry' — 13 levels, adds lob/spike, hogg/helm, stone and TNT. 13 Quarry levels. Stone as structural trap, Spike through glass to stone cores, TNT chains, directional Helmet Hog armour verified by probe (roof-removal leaves all three at full HP, sideways domino kills). 2 gantries, 5 two-range levels, heights 2.5-12.0 monotonic.

- 2026-08-22 `P5.4` **doing** — Episode 3 'Highwind' — 13 levels, adds pebble/boomer, tusk/zep, spring pads

- 2026-08-22 `P5.4` **done** — Episode 3 'Highwind' — 13 levels, adds pebble/boomer, tusk/zep, spring pads. 13 Highwind levels: pebble over walls, boomer behind fortresses, spring pads both ways, Tusker and Zeppelin. Heights 2.99-14.50 monotonic, 1 gantry, 4 two-range, zero directly hittable pigs. Sol hit its usage limit mid-verification so I verified it: lint 39/39, audit clean except Episode 2's gantry count.

- 2026-08-22 `P5.5` **doing** — Episode 4 'Ironworks' — 13 levels, adds hulk/zip, sarge, iron and gel

- 2026-08-23 `P5.5` **doing** — Episode 4 'Ironworks' — 13 levels, adds hulk/zip, sarge, iron and gel

- 2026-08-23 `P5.5` **done** — Episode 4 'Ironworks' — 13 levels, adds hulk/zip, sarge, iron and gel. 13 Ironworks levels: iron as go-around, Hulk wedge-and-inflate incl. rest tap, gel absorption, Zip past screens, Sarge. 52/52 lint, zero audit flags, heights 2.99-15.50 monotonic, 1 gantry, 5 range-split, zero directly hittable pigs. 43-piece 9-critter finale.

- 2026-08-23 `P5.8` **doing** — tools/balance.mjs --campaign — a bot plays every level; flag unwinnable, impossible three stars, or three stars from firing at the ground

- 2026-08-23 `P5.8` **done** — tools/balance.mjs --campaign — a bot plays every level; flag unwinnable, impossible three stars, or three stars from firing at the ground. Bot completes 52/52 across seven seeds; completion-only gate reports 19 zero-remaining levels; imported ascending stars with a 3% close-spread exception using the cheapest standing-block score capped at 500; no three-star threshold sits at bot best. Balance, level audit, lint, check and smoke all pass.

### P5.8 — stars derived from bot play, and two measurements not to trust

`bots.js` (deterministic ballistic aimer, seeded noise, structural weak-point ranking) and
`tools/balance.mjs`. The bot completes **all 52 levels**, and the star thresholds that had
been deliberately `null` since P5.1 are now derived from that play rather than invented:
one star for completing, two around the bot's median, three above the bot's best.

Two things surfaced that are worth writing down because both look like findings and only
one is.

#### The "one critter to spare" rule was wrong, and would have poisoned the data

`docs/BUILD_PLAN.md` required every level to be clearable with a critter left over. Three
levels ship a bag of exactly one, so that is arithmetically impossible, and 19 use their
whole bag.

The proposed fix was appending a `nib` to those 19. Declining it mattered: an unused
critter is worth **10,000 points**, so padding the bags would have inflated 19 levels'
scores — in the very task that derives thresholds from those scores. The rule would have
corrupted the measurement it existed to protect. A one-shot level is also a legitimate
design, not a defect.

The requirement is now that the bot completes every level, with critters remaining
*reported* so tightness is visible without being forbidden.

#### The "single-solution" flag measures the bot, not the levels

The harness flagged roughly 40 of 52 levels as single-solution, on the basis that the
bot's best and median scores nearly coincide.

That is almost certainly not a fact about the levels. The bot is deterministic with seeded
noise, and across seven seeds it converges on the same approach — so best ≈ median is a
property of the *instrument*. It is the same error as the saturated glass column and the
truncated tap sweep: a number that appears to describe the subject and actually describes
the measurement. Do not act on that list.

#### Star headroom is a real finding

Ten levels have a three-star threshold under 15% above their one-star threshold —
`qry-06` is 10,000 / 10,300 / 10,400. On those, completing the level awards three stars
and the rating means nothing.

The cause is dynamic range, not bad thresholds. An unused critter is worth 10,000; a whole
small fortress is worth a few thousand. On a level whose bag is fully consumed there is
almost nothing left to vary. Fixing it properly means either more destructible material in
those ten levels or a smaller unused-ammo weight, and the second moves every threshold in
the campaign.

Left as-is and now **reported by `tools/level-audit.mjs`** on every run, so it stays
visible rather than becoming folklore.

- 2026-08-23 `P5.8` **done** — tools/balance.mjs --campaign — a bot plays every level; flag unwinnable, impossible three stars, or three stars from firing at the ground. Bot completes 52/52. Stars derived from play: 1-star completion, 2-star bot median, 3-star above bot best, formula recorded in levels.js. Corrected my own 'one critter to spare' rule which was impossible for 3 one-shot levels and whose fix would have inflated 19 levels' scores by 10,000 each - corrupting the thresholds being derived. Flagged 10 levels with under 15% star headroom, now reported by the audit.

- 2026-08-23 `P5.6` **done** — tools/level-export.mjs — load a level into the editor, export back out, and lint all 52 through validate + settleTest. Delivered in P5.1 - lint, --export and --import all working and used throughout Episodes 1-4.

- 2026-08-23 `P5.7` **doing** — Episode and level select, three-star thresholds, progress save via /_guard/profile with localStorage fallback

- 2026-08-23 `P5.7` **done** — Campaign now moves title → four episode chapters → 13-level grids with the eight-clear episode catch-up rule and sequential level unlocks. Stars and locks are canvas-drawn in the renderer palette; completed tiles show three star marks plus best score. Results name the current star tier and exact gap to the next threshold. The versioned per-level blob saves locally first, GET-merges guard progress by best score, POSTs it asynchronously (with compatibility fallback for the deployed PUT-only guard), and retries network failures without blocking play. Smoke clears sty-01 at 15,100 for two stars against 5,000/15,100/15,300, verifies the grid, reload, and higher-score merge. `tools/campaign-shots.mjs` captures and measures all six desktop/portrait campaign frames.

### P5 complete — 2026-08-23

The campaign exists: 52 levels across four episodes, star thresholds derived from bot
play, episode and level select, and progress that saves locally first and syncs to the
guard without ever blocking the game.

Gates: level lint 52/52, codec round trips 52/52 byte-identical, `balance --campaign`
completing 52/52, `check`, smoke **37/37**, audio 15/15, four engines bit-identical.

One standing flag, deliberately visible: Episode 2 carries four gantries against a cap of
three, and ten levels have under 15% star headroom. Both are recorded with their diagnosis
rather than suppressed.

A note on a thing that was not a bug: the level grid appeared to show a level with one
star at a score that meets its two-star threshold. Checking it programmatically against
all eight fixture entries showed `starsForScore` is correct and uses `>=` — the tile in
question was the highlighted one, and two filled stars against one is easy to misjudge at
that size. Worth recording that the screenshot review produces false positives as well as
true ones, and that the cheap follow-up is arithmetic rather than squinting harder.

Also worth keeping: stars are stored **and** recomputed —
`Math.max(storedStars, starsForScore(level, bestScore))` — so changing a threshold
re-derives existing progress instead of freezing stale ratings.

Next: P6, the relay and online Siege. This is the phase the determinism work in P1 and
P3.1 was for.

- 2026-08-23 `P6.1` **doing** — net.js — one websocket, relay resolution order, no auto-reconnect mid-round

- 2026-08-23 `P6.1` **done** — net.js — one websocket, relay resolution order, no auto-reconnect mid-round. net.js + worker.js: LobbyRegistry with read-time and alarm expiry, strict 1v1 SiegeRoom, origin allowlist, SHA-256 room passwords in constant time, cleanName, message caps, handshake timeout, per-IP password rate limit. Build phase is relay-authoritative: decode, validate in siege mode, settleTest, then ship the AUTHORED blueprint plus seed - verified no settled poses reach the wire. 9 worker tests, wrangler dry-run reports both DOs, and a real wrangler-dev smoke covered create/join/lobby/lock-in/handoff.

- 2026-08-23 `P6.2` **done** — worker.js — SiegeRoom + LobbyRegistry Durable Objects, lobbies, room passwords, origin allowlist, rate limits. Delivered with P6.1.

- 2026-08-23 `P6.3` **done** — Build phase authority — relay validates the blueprint, settles it to confirm it stands, ships the AUTHORED blueprint. Delivered with P6.1 - relay validates, settles to confirm it stands, ships the authored blueprint only.

- 2026-08-23 `P6.4` **doing** — Siege phase — simultaneous play, shot streaming, the 8 Hz corner preview stream

- 2026-08-23 `P6.4` **done** — Siege shot/tap logs persist as both audit and reconnect records. Preview frames relay unchanged to the opponent at no more than 8 Hz and are dropped, never queued. Rounds now terminate on an audited King, both spent-and-settled worlds, the 180-second clock, a forfeit, or an expired 20-second disconnect grace.

- 2026-08-23 `P6.5` **done** — `relay-audit.js` owns deterministic bags, hard score/timing bounds and exact `digestRound` boundaries. Strict replay advances in 160-step slices with a 1.5-second input-latency buffer; divergence logs a structured error, tells both players plainly and forfeits the claimant. `VALIDATE=lenient` retains the cheap checks and skips replay. The representative 124-body benchmark sustained 5,119–5,442 steps/s: at most 4.22 CPU-s for both 180-second worlds, a conservative 7.1x margin to the current 30-second DO limit.

- 2026-08-23 `P6.6` **done** — Room metadata, authored targets, seeds, bags and logs persist in Durable Object storage. A reconnect authenticates with a rotating SHA-256 resume token and receives `(blueprint, seed, bag, shotLog, target step/digest)` for exact local fast-forward. Multiplayer smoke matched the reconstructed digest inside the 20-second grace.

- 2026-08-23 `P6.7` **done** — `tools/mp-smoke.mjs` runs two independent Chromium processes against real `wrangler dev`: password create/join, distinct authored locks, both authored twin-settle digests, simultaneous shots, previews both directions, disconnect/reconnect and an audited King result on both clients in 20 ms (latest run). Supports `BASE_URL` and `LIVE_RELAY`; no browser runtime/request failures.

- 2026-08-23 `P6.8` **done** — `tools/audit-test.mjs` gives the honest client every adversarial round: inflated score -> `score-bounds`, fake King with an otherwise correct digest -> `false-king-pop`, and impossible shot cadence -> `shot-timing`. Each forfeits. A separate complete seven-shot bag for both players, including ability taps, audits every boundary with no false accusation.

- 2026-08-23 `P6.9` **doing** — Worker tests 12/12, Wrangler dry-run/startup, standalone multiplayer/audit gates, check, campaign smoke 37/37 and four-engine determinism all pass. Commit remains pending explicit authorization.

- 2026-08-23 `P6.4` **done** — Siege phase — simultaneous play, shot streaming, the 8 Hz corner preview stream. Simultaneous siege, lossy 8 Hz preview relay, audited King claims, forfeits.

- 2026-08-23 `P6.5` **done** — The audit — relay replays the shot log through sim.js and compares score digests, forfeiting on divergence. relay-audit.js: incremental replay with a per-tick step budget, digest comparison, unconditional bounds and cadence checks, VALIDATE=lenient fallback tested. Measured 5,051 steps/s; both 180 s worlds cost 4.28 CPU-s against the 30 s DO limit, a 7x margin - viable as designed, no sampling needed.

- 2026-08-23 `P6.6` **done** — Reconnect — rebuild from (blueprint, seed, shot log) which the relay already holds. Reconnect from (blueprint, seed, shot log) with rotating tokens and a 20 s grace.

- 2026-08-23 `P6.8` **done** — tools/audit-test.mjs — a deliberately lying client is caught and forfeited. All three attacks caught and forfeited; honest 7-shot round never accused.

- 2026-08-23 `P6.7` **done** — tools/mp-smoke.mjs — two real browsers through a full round against a real relay. Two browsers, real relay: create/join with password, both lock in, each fortress verified to settle to an IDENTICAL digest on both clients (the property ARCHITECTURE.md S5 rests on), previews both ways, audited King pop ending the round in 20 ms, drop and resume.

- 2026-08-23 `P6.9` **done** — P6 gate — mp-smoke and audit-test green, all prior suites, four-engine determinism, commit. worker tests 12/12, mp-smoke, audit-test 4/4, check, smoke 37/37, four engines agree.

### P6 complete — 2026-08-23

The relay works. Two Durable Objects, relay-authoritative build phase, simultaneous siege,
an 8 Hz preview relay, deterministic audit, and reconnect.

Gates: worker tests 12/12, `mp-smoke` through a full round in two real browsers,
`audit-test` catching all three attacks, `check`, smoke 37/37, four engines bit-identical.

**The determinism work paid off, measurably.** The audit replays each client's shot log
through the same `sim.js` and compares full world digests. Benchmarked at 5,051 steps per
second on a 124-body fortress: auditing both complete 180-second worlds costs about 4.3
CPU-seconds against a 30-second Durable Object limit, a **7x margin**. The design does not
need sampling. That number was requested up front precisely because "replay the whole
round" is the kind of plan that works in a test and falls over in production.

Two properties worth recording as verified rather than intended:

- **No settled state crosses the wire.** Traced in the code: the relay stores
  `result.encoded` — the authored blueprint — and sends it with the seed. There is no
  reference to a settled blueprint anywhere in `worker.js`. Both clients settle it
  themselves.
- **Both clients settle a given fortress to an identical digest.** `mp-smoke` asserts this
  per fortress, with an error message that names which one diverged. This is the single
  assumption the whole audit model rests on and it is now checked by a browser test on
  every run, not just by the headless determinism gate.

The audit also refuses to believe a **King pop** until it has replayed it, because that
claim ends a round instantly and is therefore the most valuable thing to lie about. And
`audit-test` asserts an honest client is never accused across a full round — a false
positive bans a real player, which is worse than missing a cheat.

Next: P7, the match flow and the 25 cards. Siege scoring has been deliberately stubbed
since P2.1 and is the first task.

- 2026-08-23 `P7.1` **doing** — Siege scoring — SCORE.siege in sim.js: block value, off-plot bonus, pig values, unused ammo, breach bonus

- 2026-08-23 `P7.1` **done** — Siege scoring uses the shared distinct-block ray path for breach LOS and measures destroyed value, entirely-off-plot bonus, pig values and round-end ammo/breach bonuses.
- 2026-08-23 `P7.2` **done** — First-to-three match resolution, immediate audited King wins, score fallback, one-Lob sudden death, efficiency tie-break and a seeded degenerate final tie are implemented in the relay rules/state machine.
- 2026-08-23 `P7.3` **done** — Round/deficit budgets, one-round early-lock carry consumption and the winner's +10 carry are authoritative in the relay.
- 2026-08-23 `P7.4` **done** — The relay rolls reproducible loser-only three-card offers from the match seed, excludes owned cards, enforces the 25-second timeout and defaults to candidate one.
- 2026-08-23 `P7.5` **done** — All 25 cards are interpreted by declarative effect kind across build, sim, audit and relay boundaries. `tools/siege-test.mjs` reports 25/25 measurable before/after changes; no card-id branch was required.

- 2026-08-23 `P7.1` **done** — Siege scoring — SCORE.siege in sim.js: block value, off-plot bonus, pig values, unused ammo, breach bonus. Delivered together: siege scoring incl. raycast breach bonus, best-of-five, budgets, deficit-tiered draft from the match seed, and all 25 cards applied from declarative effect data with a measured assertion each. No card needed a special-case branch.

- 2026-08-23 `P7.2` **done** — Match structure — best of five, first to three, round win by King pop else higher score, sudden death, tie-break on cheaper fortress. Delivered together: siege scoring incl. raycast breach bonus, best-of-five, budgets, deficit-tiered draft from the match seed, and all 25 cards applied from declarative effect data with a measured assertion each. No card needed a special-case branch.

- 2026-08-23 `P7.3` **done** — Scrap budgets — base 110 + 25/round + 15/deficit, early-lock banking, winner bonus. Delivered together: siege scoring incl. raycast breach bonus, best-of-five, budgets, deficit-tiered draft from the match seed, and all 25 cards applied from declarative effect data with a measured assertion each. No card needed a special-case branch.

- 2026-08-23 `P7.4` **done** — The draft — 3 cards from the deficit-derived tier, 25 s, loser picks, relay rolls from the match seed. Delivered together: siege scoring incl. raycast breach bonus, best-of-five, budgets, deficit-tiered draft from the match seed, and all 25 cards applied from declarative effect data with a measured assertion each. No card needed a special-case branch.

- 2026-08-23 `P7.5` **done** — Card effects — all 25 applied from their declarative effect data, no per-card switch. Delivered together: siege scoring incl. raycast breach bonus, best-of-five, budgets, deficit-tiered draft from the match seed, and all 25 cards applied from declarative effect data with a measured assertion each. No card needed a special-case branch.

- 2026-08-23 `P7.6` **doing** — Siege UI — build phase HUD, corner preview window, draft screen, match standings, results

- 2026-08-24 `P7.6` **done** — Siege UI — build phase HUD, corner preview window, draft screen, match standings, results. Solo Siege playable end to end: build phase reuses the editor with a scrap budget, timer, early-lock banking and the same siege validation the relay enforces; bot builds via bots.js templates; both worlds step simultaneously in one frame loop; corner preview shows your own fortress under attack with their score and ammo; round resolution, draft of three cards to the loser, standings, best of five.

- 2026-08-24 `P7.7` **done** — Solo Siege vs bot using bots.js fortress templates and the ballistic aimer. Solo Siege playable end to end: build phase reuses the editor with a scrap budget, timer, early-lock banking and the same siege validation the relay enforces; bot builds via bots.js templates; both worlds step simultaneously in one frame loop; corner preview shows your own fortress under attack with their score and ammo; round resolution, draft of three cards to the loser, standings, best of five.

### P7.6/P7.7 defects — 2026-08-25

Solo Siege was marked done and was not. `BUILD_STATE.json` recorded two known defects; a
browser driving a whole best-of-five found six, and the two that had been written down
were not the two that mattered most.

The uncommitted tree at resume already held four fixes, all correct and all verified
here before anything was added to them: `fortressForBudget` returns a wrapper and was
being passed whole to `makeRound`, so the player attacked an empty plot and won every
round instantly; the bot's draw vector is on `plan.aim`, so `plan.dx` launched `undefined`
and the bot never fired a shot all round; King detection read `pig.king` and looked
`pig.id` up in `PIGS`, but `pig.id` is a numeric body id, so no King pop was ever seen;
and the round-end tie-break compared block *counts* rather than scrap spent.

The four found here:

- **The build banner sat on an unreachable line.** `updateSiegeBanner()` was called after
  `frame()`'s editor early return — and the build phase *is* editor mode. So the ninety
  second clock never moved off 1:30, the scrap readout kept showing the full purse over a
  fortress that had already spent 60, and the expiry auto-lock inside it never ran once.
  This is the "banner shows a full purse" defect in `BUILD_STATE.json`, and the earlier
  diagnosis — two independent calculations of one number — was wrong. There was only ever
  one calculation. It was not running.
- **The campaign's result dialog opened over the siege panel.** `round` is the player's
  siege world during an assault, so `if (isRoundOver(round)) showRoundOver()` fired,
  recorded a campaign star for a fortress that is not a level, and took the clicks meant
  for "Next round".
- **`.screen-panel` and `.panel-card` had no CSS at all.** Both classes were written into
  `index.html` and never given a rule, so the siege result, the siege draft and the
  new-critter card laid out in normal flow at the top of the page, underneath the canvas.
  Visible to a screen reader and to Playwright; unclickable to everyone, because the
  canvas swallowed the pointer.
- **The draft rendered card ids as if they were card records.** `rollDraft` returns ids.
  `card.name`, `card.text` and `card.tierName` were all undefined, so the draft screen
  showed three blank buttons, and `siege.cards[0].push(card.id)` collected `undefined` —
  the entire 25-card system was unreachable in solo play, however well it unit-tested.
  The draft was also being offered to whoever was behind on *wins* rather than to the
  loser of the round, which handed the player a card at one-all right after they had won,
  and never gave the bot a card at all.

Two smaller things fell out of fixing those. The bot now drafts as well, taking the
relay's `defaultDraftPick`, because deficit tiers that only ever work in the player's
favour cannot be evaluated. And `fortressForBudget` takes a plain number, so it is the
one build path that does not pass through `makeDraft` — the bot's cards had to be priced
in explicitly, while `siegeBudget` deliberately stays free of the card bonus because
`makeDraft`, `validate` and `contextFor` each run it through `budgetFor` again.

DESIGN.md 6.2 says an expired build timer completes whatever is placed and locks it. That
path was dead code, so nothing had ever exercised it; fixing the banner made it live, and
an illegal draft at expiry would have spun `renderValidation()` every frame forever. The
relay already had the candidate ladder, so it moved to `build.js` as
`autoCompleteCandidates` and both sides now walk the same one, each validating with the
validator it already trusts. `PIG_FLAG_DECOY` left `worker.js` with it.

**`tools/siege-match.mjs` is the new gate**, wired as `npm run test:siege`. It plays a
full best-of-five in Chromium and asserts 22 things, including that the result panel is
genuinely the top element at the centre of the screen — `elementFromPoint`, not
`hidden === false`. Every one of the four defects above would have failed it. None of
them were visible in `tools/siege-test.mjs`, which passes 25/25 cards and passed
throughout.
