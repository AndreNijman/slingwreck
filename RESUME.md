# Resume here

```bash
node tools/progress.mjs --full     # phase, task ledger, worklog tail, git log
npm run check                      # is what exists actually working
```

Everything below is derived from those two commands and from `git log`. If this file
and `BUILD_STATE.json` ever disagree, **`BUILD_STATE.json` wins** — it is written by a
tool, this one is written by hand.

## Read in this order

1. `ARCHITECTURE.md` — the frozen contract. §3 (determinism) and §5 (netcode) are the
   two decisions everything else hangs off.
2. `docs/DESIGN.md` — what the game is. §10 records the ambiguities that have been
   resolved and why.
3. `docs/BUILD_PLAN.md` — the phase you are in and the gate that ends it.
4. `docs/WORKLOG.md` — what happened, including what went wrong.
5. `BUILD_STATE.json` — machine-readable state, the task ledger and the open risks.

## Where things stand

**P0, P1 and P2 are complete with green gates. P3 is in progress.**

The game is playable: title screen, drag-to-aim slingshot with a trajectory preview, a
two-tower level with a TNT crate, destruction, scoring, win and lose, restart, and
portrait touch.

**Nothing is deployed.** No GitHub repository, no DNS record, no guard registration, no
relay. `docs/DEPLOY.md` is the runbook.

## The gates

| command | covers |
| --- | --- |
| `npm run check` | data invariants, simulation purity, line budgets, cache stamps, plan-versus-code drift, and it runs the three headless suites |
| `npm test` | 22 assertions driving the real page in Chromium, desktop and portrait touch |
| `npm run test:determinism:all` | **four** JS engines, physics and sim scenarios, via podman |
| `npm run test:determinism` | three engines; exits non-zero on the missing fourth rather than passing a partial run |

`npm run test:determinism:all` needs podman because WebKit cannot launch on this host —
APEX-OS is atomic and lacks the libraries Playwright's WebKit build wants. Run it after
**any** change to `physics.js`, `sim.js` or `data.js`.

## How this build works

- **One task in `doing` at a time.** `node tools/progress.mjs start P3.4` before
  touching a file, `done` after its gate passes. Both append to `docs/WORKLOG.md`.
- **Commit only at a green gate**, never at a "should work". `git log` is the recovery
  point, so every commit must be a state the check passes in.
- **A dirty tree at resume means the last task is not done**, whatever its status says.
  Re-run the gate first.
- Implementation is delegated to `gpt-5.6-sol` through `codex exec -m gpt-5.6-sol` on
  the ChatGPT OAuth session. Prompts are committed under `tools/prompts/` so a delegated
  step is repeatable rather than a message that scrolled away.
- **Delegated work is not done until it has been reviewed and the gate run locally.** A
  subagent reporting success is a claim, not evidence. Every task so far has needed
  corrections; `docs/WORKLOG.md` lists them.

## Things already decided, so stop re-deciding them

- ES modules, not `<script src>`. The relay and the tools must import the same sim.
- Y is up in the sim; the renderer flips.
- One world unit is one standard cube edge. The plot is 24 × 16, the sling is at x −9.
- Fixed `1/60` step, capped at 4 steps of catch-up, with `capturePose` called **before**
  each step so interpolation stays correct across catch-up frames.
- Siege is simultaneous, not turn-based. The corner preview is the reason.
- Popping the King ends the round instantly. Points are the fallback, not the goal.
- Best of five, and the draft only ever rewards the player who is losing.
- No third-party libraries. The solver is hand-written.
- Art direction is "chunky storybook": warm 1970s picture-book palette, ink outlines,
  stable per-body edge wobble, dusty-rose pigs rather than green. See `shots/`.

## Traps worth knowing before you change anything

- `TUNE.rollingFriction` is `0.225` and it sits between two close walls. Below `0.2`
  nothing settles within two seconds and every shot stalls on the settle timeout; above
  about `0.25` a critter can no longer carry a pig off the edge of the plot.
  `tools/settle-probe.mjs` currently clears that second case by 0.046 world units.
- Baumgarte belongs **only** in the position pass. Adding a velocity bias as well
  double-corrects and injects energy, which is the usual reason a hand-written solver
  cannot stack more than a few boxes.
- Inside `physics.js`, `sim.js` and `data.js` the only permitted `Math` members are
  `sqrt`, `abs`, `min`, `max`, `floor`, `ceil`, `round` and `sign`. Rotations use
  precomputed `(c, s)` literals. `tools/check.mjs` fails the build on anything else.
- A test scene whose bodies start inside each other tests recovery from a bad initial
  condition, not the solver. Call `maxPenetration` and assert it, the way
  `tools/physics-test.mjs` does.
- Look at the rendering. `tools/frame-shot.mjs` and `tools/state-shots.mjs` write PNGs
  to `shots/`. Three real defects in P2 — including a missing slingshot — were invisible
  in every written report and obvious in the first screenshot.
