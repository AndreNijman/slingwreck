# Researched behaviour

Kept separate from `DESIGN.md` on purpose. This file records what is *observed* about
the genre from public sources. `DESIGN.md` records what SLINGWRECK *does*. Mixing the
two is how a clone ends up unable to say which of its numbers were chosen and which
were copied, and neither file is trustworthy after that.

**Status, 2026-09-02.** The right-hand column is now filled in and every figure in it is
measured from this repository, with the command that produces it. The genre column is
deliberately still empty: no public source has been consulted, so there is nothing
honest to put there. That is a gap, not a finding, and it is recorded as one — writing
plausible-sounding genre claims from memory would defeat the only purpose this file has.

Every answer below is therefore a statement about SLINGWRECK alone. None of it is
evidence that the genre does the same thing.

## The four open questions, answered for SLINGWRECK

### Is the launch impulse linear in draw distance, or does it saturate?

**Linear, then hard-clamped.** Measured across draws from 0.16 to 3.2 world units:

    draw    launch speed    speed/draw
    0.160     3.0000          18.7500
    0.400     7.5000          18.7500
    0.800    15.0000          18.7500
    1.200    22.5000          18.7500
    1.600    30.0000          18.7500     <- TUNE.slingRadius
    2.400    30.0000          12.5000
    3.200    30.0000           9.3750

Exactly 18.75 speed per unit of draw — `TUNE.launchSpeedMax / TUNE.slingRadius`, i.e.
30 / 1.6 — up to the sling radius, and flat at 30 beyond it. So the ratio is constant
inside the usable range and the clamp is on speed, not on draw: pulling further than
1.6 is not an error, it simply buys nothing. `game.js` clamps the pointer to the sling
radius anyway, so a player never reaches the flat region; the relay and the bot can,
which is why the clamp exists rather than an assertion.

`launchSpeedMax` is 30 because the far plot edge is about 40 units from the sling and
`sqrt(40 * 22)` is 29.7 — the comment in `data.js` states this. That is a chosen number
derived from the plot geometry, not a copied one.

### Does the split ability preserve total momentum, or does each fragment keep the parent's full speed?

**Each fragment keeps the parent's speed; the mass is divided three ways.** This is
recorded in `data.js` on the Chip entry and is deliberately unphysical: dividing the
momentum three ways makes Chip *weaker* than not tapping, and an ability that punishes
its own use is the one outcome an ability must never have. Dividing mass instead keeps
the total energy delivered honest.

The fan is 22 degrees *between adjacent fragments* — three fragments at -22, 0 and +22
from the parent heading, 44 degrees overall — not 22 degrees in total.

### How is a star threshold derived — a fraction of the theoretical maximum, or hand-set per level?

**Neither. Derived from bot play, in P5.8.** The formula is: one star at the completion
floor, two at the median bot clear, three at the first round 100 above the bot's best
run. Where best came within 3% of median, three stars instead adds the lesser of 500 or
the cheapest block still standing after a best run — every affected level had such a
block, so no level's three-star sits exactly at the bot's best.

All 52 triples are ascending and were imported by `node tools/balance.mjs --campaign
--import`. The run is reproducible: `--campaign` still hashes
`1cc95e355d92a65db5607c0eb80208160ff57c878d3d65bc65392e06b877272f`, and that hash is
checked whenever `bots.js` changes, because changing the aimer would silently invalidate
thresholds derived from it.

### Does the damage model use impulse, relative velocity, or hit-point subtraction per collision?

**Impulse**, as `DESIGN.md` §2.4 specifies, with a per-material threshold below which a
contact does nothing and a per-material frailty multiplier above it. Materials carry
`thresh` and `frailty` in `data.js` precisely so the impulse model can be tuned per
material without abandoning it.

The concern recorded when this question was written — that impulse makes heavy slow
objects far more dangerous than light fast ones — is real and is handled by those two
per-material terms rather than by switching model. Glass has `thresh` 1.4 and `frailty`
2.2; iron has 6.5 and 0.28. A light fast critter still breaks glass; only a heavy one
troubles iron.

## What is still not researched

The genre column. Four specific claims would need a public source before they could be
written down: whether the launch is linear or saturating, how the genre's split ability
divides momentum, how star thresholds are set, and which damage model is used. Until
someone gathers those, the table below stays empty, and none of the answers above should
be read as agreeing or disagreeing with the genre.

| Behaviour | Source | Confidence | What SLINGWRECK does |
| --- | --- | --- | --- |
| _(none gathered)_ | — | — | see the four answers above |

## Originality note

Everything shipped here is written from scratch: the solver, the levels, the art, the
audio, the copy. No third-party code, no extracted assets, no reused level layouts. No
runtime dependencies of any kind — the rigid-body solver, the canvas renderer and the
WebAudio synthesis are all hand-written in this repository.

Where a mechanic is researched rather than invented it belongs in the table above, and
the table is empty. On the current evidence every number in this game was chosen here
and can be traced to a comment explaining why, which is a stronger originality position
than the table was ever going to provide.
