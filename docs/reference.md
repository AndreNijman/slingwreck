# Researched behaviour

Kept separate from `DESIGN.md` on purpose. This file records what is *observed* about
the genre from public sources. `DESIGN.md` records what SLINGWRECK *does*. Mixing the
two is how a clone ends up unable to say which of its numbers were chosen and which
were copied, and neither file is trustworthy after that.

Nothing has been gathered yet. The format, once it is:

| Behaviour | Source | Confidence | What SLINGWRECK does |
| --- | --- | --- | --- |
| _e.g._ slingshot draw is clamped to a fixed radius | community wiki, video | high | same, radius 1.6 world units |

## Open questions to research

- Is the launch impulse linear in draw distance, or does it saturate?
- Does the split ability preserve total momentum, or does each fragment keep the
  parent's full speed?
- How is a "star" threshold usually derived — a fraction of the theoretical maximum,
  or hand-set per level?
- Does the genre's damage model use impulse, or relative velocity, or a simple
  hit-point subtraction per collision?

The last one matters most. Impulse is the physically honest choice and it is what
`DESIGN.md` §2.4 specifies, but it makes heavy slow objects far more dangerous than
light fast ones, which may not match how the genre actually feels. If it does not,
the fix is a per-material velocity term, not abandoning impulse.

## Originality note

Everything shipped here is written from scratch: the solver, the levels, the art, the
audio, the copy. No third-party code, no extracted assets, no reused level layouts.
Where a mechanic is researched rather than invented, it is listed above.
