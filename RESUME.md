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

## Paused mid-flight, 2026-09-01 — read this first

**HEAD is `abfd28f`, and the tree is dirty on purpose.** Work was interrupted with three
delegated jobs in flight. Nothing is lost; everything below is recoverable.

### The uncommitted tree

| file | what it is | state |
| --- | --- | --- |
| `tools/balance.mjs` (+693) | **P7.8** — the `--siege` mode, written by Sol | incomplete, parses, never run |
| `docs/FILE-PLAN.json` | Sol's budget entry for the above | incomplete |
| `tools/audit-test.mjs` (+147) | the P6 gate fix | written, **not yet verified** |
| `tools/prompts/P7.8-siege-balance.md` | the committed spec for P7.8 | complete, untracked |

Two snapshot refs preserve the in-flight state independently of the working tree:

```bash
git for-each-ref refs/snapshots/          # wip-1, wip-2
git checkout refs/snapshots/wip-2 -- .    # restore if the tree is ever damaged
```

To re-snapshot at any point (includes untracked files, which `git stash create` does not,
and leaves the index and working tree untouched):

```bash
export GIT_INDEX_FILE=/tmp/snap-index && rm -f "$GIT_INDEX_FILE"
git read-tree HEAD && git add -A && tree=$(git write-tree) && unset GIT_INDEX_FILE
git update-ref refs/snapshots/wip-N "$(git commit-tree "$tree" -p HEAD -m 'wip snapshot')"
```

### What P7.8 actually is

**`node tools/balance.mjs --siege -n 400` had never been implemented.** It is named as the
P7 gate in `BUILD_STATE.json`, as `balance:siege` in `package.json`, and specified in
`docs/BUILD_PLAN.md` — but `tools/balance.mjs` accepted only `--campaign` and the gate
command exited on usage. **P7.8 is a build, not a run.** Do not accept a "just run the
gate" framing. Resume it with the committed prompt:

```bash
codex exec -m gpt-5.6-sol -s workspace-write --skip-git-repo-check \
  "$(cat tools/prompts/P7.8-siege-balance.md)"
```

Sol's quota is back (it expired 29 August). `tools/balance.mjs` imports
`bots/data/build/levels/physics/sim/relay-audit` and **not** `game.js`, so client-side
fixes do not invalidate its measurements.

### Still to do, in this order

1. **Verify `tools/audit-test.mjs`** — run it three times. It was the red P6 gate; the fix
   is written but unverified.
2. **`game.js` + gate hardening** — four defects, all confirmed, none started. See
   "Defects found but not yet fixed" below.
3. **Finish P7.8**, then P7.9.

Step 2 must land **before** P7.8 is finalised: it changes solo-Siege scrap economics,
therefore fortress cost, therefore round outcomes.

### Defects found but not yet fixed

- **The Siege build phase throws away its own budget and cards.** `openEditor()` builds the
  correct siege draft, then unconditionally clobbers it with a bare `makeDraft()` about
  twenty-five lines later, so the whole `if (editorSiege)` block is dead. The scrap economy
  never scales with round, deficit or banked time, and drafted cards never unlock a material
  in the editor. This is the *real* cause of the flat purse that the 2026-08-25 session
  declared fixed.
- **Three assertions in `tools/siege-match.mjs` cannot fail.** The banner assertion compares
  `#siege-scrap` against `#scrap-left` — both rendered from the same `editorDraft.budget`,
  so it agrees with itself by construction and passed straight through the defect above.
  Two draft assertions pass vacuously when `draftsSeen === 0`, which happens whenever the
  player sweeps 3–0 and never drafts.
- **`tools/siege-match.mjs` is nondeterministic.** Two runs gave different scorelines *and*
  different assertion counts (23 then 22), because it paces a real-time rAF loop with
  `page.waitForTimeout(2200)`. Rule 4 below applies.
- **The bot's drafted cards are inert except budget cards.** `fortressForBudget` never calls
  `rulesFor`, so an unlock / materialCost / decoyKing / autoPig card drafted by the bot does
  nothing. Undecided.
- **Two claims in `docs/WORKLOG.md` are false** and need correcting in place: "there was
  only ever one calculation" (there were two bugs; that retraction was wrong), and "every
  one of the four defects would have failed it" (the banner assertion cannot fail).

**Deployment is separately blocked** on rotating the Cloudflare and R2 credentials, which
were accidentally printed into a transcript on 22 August. They were not used.

## Where things stand

**P0 through P6 are complete with green gates. P7 is at 7/9** — `node tools/progress.mjs
--full` is authoritative.

The campaign is complete: 52 authored levels across four episodes, star thresholds set from
bot play, level select with unlocks and progress sync. Solo Siege plays end to end — build
phase, lock-in, simultaneous assault, corner preview, round resolution, draft, standings,
best of five — subject to the scrap-economy defect above.

**Online Siege has no UI.** `worker.js`, `net.js` and `relay-audit.js` are built, deployed
and tested, but nothing in the client connects to them.

## The gates

| command | covers |
| --- | --- |
| `npm run check` | data invariants, simulation purity, line budgets, cache stamps, plan-versus-code drift, and it runs the three headless suites |
| `npm test` | 40 assertions driving the real page in Chromium, desktop and portrait touch |
| `npm run test:siege` | a full best-of-five of solo Siege in Chromium — see the nondeterminism note above |
| `npm run test:mp` | the relay end to end: room flow, twin settle digests, simultaneous siege, King-pop resolution |
| `node tools/audit-test.mjs` | the P6 adversarial audit gate, plus one honest round that must draw no accusation |
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
