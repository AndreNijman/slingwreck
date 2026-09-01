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

## Where P7 actually stands, 2026-09-01 — read this first

**HEAD is `b4254b1`. The tree is clean. P7.8 is done; P7.9 is blocked on one thing only.**

Every clause of the P7.9 gate is green except `balance --siege`:

| gate | state |
| --- | --- |
| `check` · `siege-test` 25/25 · `editor-test` · `physics` · `settle-probe` · level lint 52/52 | green |
| `npm test` 40/40 · `test:siege` 45/45 (×3) · `test:mp` · `audit-test` (×3) | green |
| `playtest --all` 774 shots · `determinism:all` four engines at sim digest `2856ed88` | green |
| `balance --campaign` 52/52, output hash unchanged | green |
| **`balance --siege -n 400`** | **red by design — see below** |

### The one blocker

`airlift` measures **81.4% [69.6%, 89.3%]** round win rate at parity against a 40–65% band.
It is the only one of four flagged cards whose interval clears its threshold; `gale` 69.7%,
`iron-ration` 37.3% and `kingslayer` 33.3% are all flagged on the point estimate, as
BUILD_PLAN requires, but their intervals straddle at 55–70 rounds per card.

**Two harness artefacts were found and removed before that number could be trusted**, and
the history matters if you are tempted to nerf the card:

- the bot did not know to pop an invulnerability shield — worth **1.6** points (`712bb39`)
- `buildFortress` respent the scrap freed by airlift's flight lane — worth **4.3** points

~16 points above the ceiling remain and belong to the card. `data.js` is untouched.

**The lever is not `lift`, `driftRange` or `balloonHp`.** The balloon already dies on shot 1
in 120/120 rounds; the King dies 100% of the time with or without the card (mean 1.65 vs
1.95 shots); and under `--no-lane-respend` the holder already spends 109 fortress scrap
against the opponent's 145 and still wins. The only remaining lever is the total damage
immunity, which is the card's printed text and which DESIGN warns against removing.

**And the band may be the wrong instrument.** `CARD_TIER_RULES` makes tier 3 drawable only
at deficit exactly 2, so a Desperado card can only be held by a player two rounds down
needing three straight wins — while the parity sweep holds deficit equal by construction.
It measures tier-3 cards in a state where they cannot be drawn. DESIGN says the band applies
to Desperado cards *and* that the draw restriction is the guard; both cannot govern tier 3.
0.814³ ≈ 53% for the comeback airlift's holder actually needs is arguably the point of the
card.

**The next measurement, and it is a small one:** a per-card **match** comeback rate from the
natural sweep at the real deficit, rather than a per-round rate at parity. That decides
whether airlift is broken or working. Do that before touching `data.js`.

Closing P7 therefore needs one of: that measurement, a deliberate `data.js` rebalance, or an
amendment to how the gate reads tier 3. It is a design decision, not a defect fix.

### Snapshots

`refs/snapshots/wip-1` … `wip-7` hold in-flight trees from this session; all of it is now
committed, so they are only historical. To take another (includes untracked files, which
`git stash create` drops, and leaves the index and working tree untouched):

```bash
export GIT_INDEX_FILE=/tmp/snap-index && rm -f "$GIT_INDEX_FILE"
git read-tree HEAD && git add -A && tree=$(git write-tree) && unset GIT_INDEX_FILE
git update-ref refs/snapshots/wip-N "$(git commit-tree "$tree" -p HEAD -m 'wip snapshot')"
```

### A note on the gate that was never implemented

`node tools/balance.mjs --siege -n 400` was named as the P7 gate in `BUILD_STATE.json`, as
`balance:siege` in `package.json`, and specified in `docs/BUILD_PLAN.md` — and the arg
parser accepted only `--campaign`, so it had never once executed. Worth remembering that a
command can be named as a gate in three places and still be fiction. Its spec is committed:

```bash
codex exec -m gpt-5.6-sol -s workspace-write --skip-git-repo-check \
  "$(cat tools/prompts/P7.8-siege-balance.md)"
```

Sol's quota is back (it expired 29 August). `tools/balance.mjs` imports
`bots/data/build/levels/physics/sim/relay-audit` and **not** `game.js`, so client-side
fixes do not invalidate its measurements.

### Fixed on 2026-09-01, listed because the write-ups were wrong before

- **The Siege build phase threw away its own budget and cards.** `openEditor()` built the
  correct siege draft and then clobbered it with a bare `makeDraft()` twenty-five lines
  later, so the whole `if (editorSiege)` block was dead and the scrap economy never reached
  the build phase. Fixed in `3441964`. This was the *real* cause of the flat purse that the
  2026-08-25 session declared fixed — that session found a second, genuine bug (the banner
  sat below `frame()`'s editor early return) and wrote off the original two-numbers
  diagnosis, which had been closer to correct.
- **Three assertions in `tools/siege-match.mjs` could not fail.** The banner assertion
  compared `#siege-scrap` against `#scrap-left`, both rendered from the same
  `editorDraft.budget` — it agreed with itself by construction and passed straight through
  the defect above. Two draft assertions passed vacuously whenever `draftsSeen === 0`, i.e.
  any match the player swept. Fixed in `3441964`; the gate went from 22–23 varying
  assertions to a fixed 45, deterministic across eight runs.
- **The P6 gate was red and had been since P7.1**, asserting `reason: 'tie'` — a string
  retired in `9e6b41f` that appears nowhere in the code. The relay was correct throughout.
  Fixed in `ff0eb38`, which now also carries the only live coverage of the sudden-death
  ladder.
- **The bot could not fight airlift.** Fixed in `712bb39`; see the blocker above.

**Still open:** the bot's drafted cards are inert except budget cards, because
`fortressForBudget` never calls `rulesFor`, so an unlock / materialCost / decoyKing /
autoPig card drafted by the bot does nothing. Undecided, and it limits what solo Siege can
tell you about those cards.

**Deployment is separately blocked** on rotating the Cloudflare and R2 credentials, which
were accidentally printed into a transcript on 22 August. They were not used.

## Where things stand

**P0 through P6 are complete with green gates. P7 is at 8/9 with P7.9 blocked** — `node
tools/progress.mjs --full` is authoritative.

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
