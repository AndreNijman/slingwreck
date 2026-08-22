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
