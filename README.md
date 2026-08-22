# SLINGWRECK

A browser physics demolition game. Haul a critter back into a slingshot, let go, and
bring a pig fortress down on top of the pigs inside it.

There is a single-player campaign of authored levels, and there is **Siege** — a 1v1
mode where you *build* the fortress. You place every block, every pig and your King
Hog, your opponent does the same behind a curtain, and then you both attack each
other at the same time while a live window in the corner shows their critters
chewing through the tower you just spent ninety seconds on.

**Status: in development, playable, not deployed.** The campaign's first level plays
end to end — aim, fire, collapse, score, win. The fortress editor, the campaign proper
and the whole Siege mode are still to come. See
[`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) for the phase plan and
[`docs/WORKLOG.md`](docs/WORKLOG.md) for what has actually happened.

Will play at `https://slingwreck.andrenijman.com` once there is enough of it to be
worth showing.

---

## What is in it

- **Real rigid-body physics.** Boxes, planks and balls with rotation, stacking,
  friction and impulse-driven material damage. Written from scratch — no Box2D, no
  Matter.js, no Planck, no engine of any kind.
- **9 critters**, each a distinct mechanic on tap: split into three, accelerate,
  detonate, drop a payload, reverse direction, inflate, harden, blink forward.
- **8 pig types** including armoured, helmeted, balloon-borne and a repair pig, plus
  the King Hog.
- **8 materials** — glass, wood, stone, iron, TNT, spring pads, gel and sandbags —
  with real densities, so a stone slab on a glass post behaves the way it looks like
  it should.
- **A campaign** of authored levels across four episodes, scored out of three stars.
- **Siege**: 1v1, best of five, with a build phase, simultaneous attacks, a live
  opponent preview, and a comeback draft where the player who lost the round picks
  one of three cards that are allowed to be genuinely unfair.

## Siege in one paragraph

Ninety seconds to spend your scrap on a fortress and hide a King Hog in it. Both
fortresses lock, both players attack at once with identical ammo bags. Pop the enemy
King and the round ends instantly in your favour; if nobody does, the higher siege
score takes it. Then the loser draws three cards and keeps one — iron blocks, a decoy
king, a flak pig that shoots your critters out of the air, a headwind, a king on a
balloon — and everyone rebuilds with a bigger budget. First to three rounds wins.

Full rules, rosters, costs and the card list: [`docs/DESIGN.md`](docs/DESIGN.md).

## Layout

Files marked *planned* do not exist yet.

| File | Job |
| --- | --- |
| `data.js` | tuning, materials, shapes, the critter roster, the pig roster, the draft cards. Imported by client, relay and tools, so numbers cannot drift |
| `physics.js` | the solver and nothing else: bodies, SAT, contacts, sequential impulses, sleeping, raycasts, deterministic scalar math |
| `sim.js` | the game on top of the solver: critter abilities, damage, explosions, pigs, scoring, round state, wire format. No DOM, no network, no `Math.random`, no wall clock |
| `levels.js` *(planned)* | campaign levels as authored data, exported from the same editor Siege uses |
| `build.js` *(planned)* | the fortress editor: snapping, budget, legality rules, blueprint encode and decode |
| `bots.js` *(planned)* | fortress templates and a ballistic aimer, for solo Siege and the balance harness |
| `render.js` | canvas renderer including the corner preview. Every pixel drawn in code |
| `audio.js` *(planned)* | WebAudio synthesis. No audio files |
| `net.js` *(planned)* | one websocket |
| `game.js` | screens, input, HUD, campaign flow, siege flow |
| `worker.js` *(planned)* | the relay: `SiegeRoom` and `LobbyRegistry` Durable Objects, blueprint validation, replay validation |

No bundler, no framework, no TypeScript. `physics.js` and `sim.js` never touch a
browser API, which is the only reason the relay and the headless tools can run them.

## The physics is real, and it is measured

The solver is written from scratch: convex polygons and circles, SAT with clipped
two-point manifolds, warm starting, sequential impulses with accumulated-impulse
clamping, a 2×2 block solve, non-linear position correction, union-find islands and
sleeping, and rolling resistance at contacts. `tools/physics-test.mjs` asserts what it
does rather than claiming it:

| scene | result |
| --- | --- |
| 10-cube stack | asleep in 0.97 s, drift 0.000075 |
| three-tier post-and-plank pyramid | asleep, standing, max travel 0.021 |
| dropped ball, e = 0.72 | measured 0.723, 0.47% error |
| box on a 20° ramp | µ 0.6 slides 0.002, µ 0.2 slides 15.9 |
| 200 bodies into a bin | all asleep by 6 s, none escaped |

Sleeping is a **game rule**, not an optimisation: "the world has settled" ends a round,
validates a blueprint and locks a score.

## How the netcode works

Different from a brawler, and simpler, because of one structural fact: **neither
player's inputs affect the other player's simulation.** You attack their fortress,
they attack yours; the two worlds never interact. So there is no need for a 60 Hz
authoritative dual simulation.

Instead each client is authoritative for the world it is attacking, and the relay
audits it. Clients send their shots — time, ammo index, aim vector, tap time — and
the Durable Object replays those shots through the same `sim.js` at its own pace,
comparing score digests. Drift beyond tolerance forfeits the round. The corner
preview is a separate cheap 8 Hz stream of quantised block poses and a score.

The build phase *is* server-authoritative: the relay validates the blueprint against
the budget and the legality rules, settles it under gravity itself, and ships the
settled result to both sides. You do not get to attack a tower that has not stood up
on its own first.

That whole model rests on one assumption, so it is **measured rather than assumed**:
`npm run test:determinism:all` runs the same seeded physics scenario and the same
seeded round of the real game in V8, SpiderMonkey and JavaScriptCore, and compares a
hash of the raw IEEE-754 bits of every body pose and every hit point. All four engines
agree at every checkpoint. That is only possible because the simulation stores rotation
as a `(cos, sin)` pair integrated with arithmetic alone and never calls a `Math`
function beyond `sqrt` — see [`ARCHITECTURE.md`](ARCHITECTURE.md) §3.

## Development

```bash
npm install
npm run serve                 # static server on :4173 — this plays the game
npm run check                 # data invariants, simulation purity, line budgets,
                              # cache stamps, plan drift, plus the headless suites
npm test                      # 22 assertions driving the real page, desktop and portrait touch
npm run test:determinism:all  # four JS engines, physics and sim scenarios
node tools/frame-shot.mjs     # write an inspection frame to shots/
node tools/state-shots.mjs    # play a real round and capture each state
node tools/progress.mjs --full  # where the build is up to
```

Not wired up yet: `npm run dev` and `npm run deploy` (no relay until P6),
`npm run test:mp`, `npm run balance`.

`npm run test:determinism:all` runs inside the official Playwright container under
podman, because WebKit will not launch on an atomic host. The plain
`npm run test:determinism` covers three engines and **exits non-zero** on the missing
fourth rather than quietly reporting success on a partial run.

## Licence and attribution

No licence yet. The repository is public but no rights are granted.

SLINGWRECK is an original implementation inspired by the slingshot-demolition genre,
and by *Angry Birds* in particular. It uses no third-party code and no extracted
assets: the physics solver, the levels, the UI copy, every drawn pixel and every
synthesised sound here are written from scratch. Mechanical behaviour researched
from public sources is recorded in [`docs/reference.md`](docs/reference.md) as it is
gathered, kept separate from the design so the two cannot be confused.
