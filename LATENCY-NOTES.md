# SLINGWRECK latency notes

Line references in the first five sections are to origin/main (fcf2428), the
code as it was before this branch; `git show fcf2428:<file>` to follow them.

## Authority model: (a), with a relay referee

Not lockstep. The two players' worlds never interact (ARCHITECTURE.md:121-133,
worker.js:3-7): each client runs one live world, its own attack on the
opponent's fortress, and is the authority for it (game.js:1696-1712 steps it
locally, game.js:1536 launches locally). The relay validates and settles both
blueprints at build (worker.js:1063, 1110), audits each attack by replaying the
shot log through the same sim.js (worker.js:1254-1316, 1418), and decides
rounds, drafts and the match (worker.js:1502-1590). Nobody simulates anyone
else's world.

The only remote entity on screen is the corner preview (index.html:220-229):
your own fortress under the opponent's attack. It is never simulated locally.
The opponent's client sends quantised poses of the blocks that changed
(siege-online.js:713-745), the relay forwards them (worker.js:1320-1330), and
the receiver writes them into a static "shadow round" and redraws
(siege-online.js:747-773). ARCHITECTURE.md:147-149: "allowed to be wrong by a
frame; nothing depends on it".

## What already hides delay

- Your own attack is fully local: aiming, launch, taps and physics never wait
  for the network (game.js:1536, 1696-1712). Shots, taps and score boundaries
  are reported after the fact (siege-online.js:671-711); the audit runs behind
  play.
- Reconnect mid-round rebuilds the attack from (blueprint, seed, shot log)
  (worker.js:1387-1416, siege-online.js:776-812).
- The corner preview: nothing. Each frame is drawn the moment it arrives
  (siege-online.js:747-767), so the preview moves at the network's arrival
  rhythm, about 7.5 Hz (the 8 Hz limit at 60 fps rAF is every 8th frame,
  133 ms), in steps.

## Rates and message types

- `ping`/`pong`: 1 Hz per socket from the moment it opens, so pings already
  flow in the lobby (net.js:61-67).
- `preview`: at most 8 Hz per attacker (data.js:53, relay-audit.js:154-161),
  only when a body moved (siege-online.js:740), forwarded to the one opponent.
  The relay drops a frame that arrives less than 125 ms after the last one it
  accepted from that socket (worker.js:1324), so uplink jitter loses frames.
  The Smokescreen card slows it to one per 3 s (data.js:528).
- `shot`, `tap`, `score`, `remote-tnt`: events, a few per shot.
- `draft`: the build draft every 2 s while building (siege-online.js:37).
- Clocks: `build-clock`, `siege-clock`, `draft-clock` once a second from the
  250 ms room tick (worker.js:1686-1757).
- Lobby list: HTTP `GET /lobbies` every 3 s while the lobby is open
  (siege-online.js:36, 188-191).

## Room lifecycle

- Create: `/ws?room=<name>`; the Durable Object is `ROOMS.getByName(roomKey(name))`
  (worker.js:324-326), placed near whoever first reaches it. First message
  `create` (worker.js:729-748).
- Join: `join`, lobby phase only, two players max (worker.js:749-783).
- Start (match start): the host's `start` with exactly two players
  (worker.js:966-984, `startBuild`). This is where the room may move (item 4).
  Later rounds start from the relay itself (draft pick -> `beginBuild`), not
  from `start`.
- End: `match-over` (worker.js:1576); the room resets when its last socket goes
  (worker.js:884-947, tick at 1698-1701). Rooms persist their state to storage
  and an alarm covers the disconnect grace (worker.js:438-468, 1759-1768).

## Item 1 plan

Remote entities (the corner preview), per the (a) recipe:

- A playout buffer for preview frames: each frame carries the sender's sim
  step (`k`, one extra number; the relay forwards the frame untouched and old
  clients ignore it). The receiver anchors to a sliding-window minimum of
  arrival minus send time and plays frames out at an adaptive delay (send
  interval plus the 95th-percentile lateness, clamped), interpolating each
  body's pose between the two frames around the playout time. Snap when a body
  jumps further than it could move in one frame, and across gaps too long to
  interpolate (Smokescreen's 3 s).
- No extrapolation: a frame only lists bodies that moved, and no frame is sent
  when nothing moved (siege-online.js:740), so a missing frame usually
  means "unchanged". Extrapolating would push every block that just landed
  through the ground. Holding the last pose is correct in that case.
- Frames from an old client (no `k`) fall back to arrival time.
- The relay's per-frame limit gets a little jitter tolerance (keeping the same
  average rate), so frames that arrive early because the previous one was late
  are not dropped.
- Measure first (tests/latency/harness.mjs): a real bot attack through sim.js,
  200 ms RTT +-40 ms, before (draw on arrival, strict relay limit) vs after.

Local player: already instant (model (a)); nothing to predict.

Not rollback: (d) does not apply.

## Item 1 results

`node tests/latency/harness.mjs`: five campaign fortresses (LEVELS 51, 25, 12,
38, 18), 40 s of bot attack each through sim.js, frames from the real encoder,
two in-order legs through the relay's limit, a 60 fps view. Means over the five:

| both players at 200 ms RTT +-40 ms | error | shape | lag | stutter | dropped |
|---|---|---|---|---|---|
| before: draw on arrival, strict relay limit | 0.707 | 0.156 | 298 ms | 99.6 % | 24.0 % |
| tolerant relay limit only | 0.663 | 0.100 | 271 ms | 99.8 % | 0 % |
| buffer only, strict relay limit | 0.822 | 0.089 | 370 ms | 28.1 % | 24.0 % |
| after: buffer + tolerant relay limit | 0.815 | 0.042 | 359 ms | 7.2 % | 0 % |

| both at 40 ms RTT, no jitter | error | shape | lag | stutter | dropped |
|---|---|---|---|---|---|
| before | 0.326 | 0.095 | 117 ms | 99.8 % | 0 % |
| after | 0.475 | 0.036 | 175 ms | 7.1 % | 0 % |

- error: distance between the drawn and the real block, now. shape: the same
  after the best constant delay is taken out (steps and wobble). stutter:
  display frames where a moving block froze or jumped.
- The strict relay limit dropped a quarter of the frames on a jittery line: a
  frame held up upstream makes the next one arrive early and it was thrown
  away. The tolerant limit (worker.js `previewAccepted`, 60 ms of slack, the
  same average rate) loses none and is better on every number.
- The buffer trades about 60 ms more lag (one send gap plus the jitter it
  covers) for motion that is four times truer to the real motion (shape) and
  smooth (stutter 7 % against 99 %, where "before" moves in 133 ms steps).
  Error-vs-now goes up because the picture is drawn later; the preview is a
  glance at your own fortress, and ARCHITECTURE.md already allows it to be
  wrong by a frame, so smooth and a little later is the better trade.
- `?preview-legacy` in the URL draws frames on arrival, as before, for an A/B.

## Item 4: limits

- Only at match start, once per room (`moveTried`), with two players whose
  probes and pings are known. A player whose probes failed (`regions` never
  sent) keeps the room where it is.
- During the move the old object answers every new connection with `move`
  and closes it; a socket that never reconnects with its ticket loses its seat
  after ADOPT_WAIT (6 s) and the other player waits in the shard's lobby. A
  password room keeps its hash; a late joiner still needs the password.
- The old object keeps `moved` in storage until the shard empties and calls
  `/_released`. If that call is lost, the next `create` on the old name is sent
  to the shard, which (empty, reset) hosts it there; the next time that shard
  empties it releases again. So the name is never stuck, only served from the
  shard's region until then.
- The registry entry is shared: the shard upserts under the same key, so the
  old object deletes its state without removing the listing.
- wrangler dev runs every object in one place, so the integration test proves
  the protocol, not the placement; `locationHint` is honoured only on Cloudflare.
