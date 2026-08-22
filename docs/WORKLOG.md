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
