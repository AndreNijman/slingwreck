# Resume here

Read in this order, then start P1.

1. `ARCHITECTURE.md` — the frozen contract. §3 (determinism) and §5 (netcode) are the
   two decisions everything else hangs off.
2. `docs/DESIGN.md` — what the game actually is. All numbers are starting values.
3. `docs/BUILD_PLAN.md` — the phase you are in and the gate that ends it.
4. `BUILD_STATE.json` — machine-readable state and the open risks.

## Where things stand

P0 is done. The repository is scaffolded and the design is decision-complete: there
is no gameplay question left that needs answering before code can be written.

**Nothing is deployed.** No GitHub repository, no DNS record, no guard registration,
no relay. `docs/DEPLOY.md` is the runbook for when P2 is worth showing.

## Next action

Start P1: `data.js` and `physics.js`, then `tools/physics-test.mjs` and
`tools/determinism-test.mjs`.

Write the determinism test **first**, against a trivial two-body scene, before the
solver is finished. It is the phase's real gate and the whole netcode design depends
on it. Discovering in phase 6 that `Math.atan2` differs between V8 and
JavaScriptCore would cost the audit model; discovering it in phase 1 costs an hour.

Do not write `render.js` during P1. The temptation to look at the physics is real and
`tools/physics-test.mjs` printing numbers is enough. A renderer written to debug a
solver becomes a renderer nobody wants to throw away.

## Things already decided, so stop re-deciding them

- ES modules, not `<script src>`. The relay and the tools must import the same sim.
- Y is up in the sim. The renderer flips.
- One world unit is one standard cube edge. The plot is 24 × 16.
- Fixed `1/60` step, capped at 4 steps of catch-up.
- Siege is simultaneous, not turn-based. The corner preview is the reason.
- Popping the King ends the round instantly. Points are the fallback, not the goal.
- Best of five, and the draft only ever rewards the player who is losing.
- No third-party libraries. The solver is hand-written.
