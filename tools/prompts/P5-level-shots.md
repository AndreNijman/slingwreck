Write `tools/level-shots.mjs`. Read `tools/frame-shot.mjs` and
`tools/editor-shots.mjs` first — both already boot a local server and drive the real
renderer in headless Chromium, so reuse that approach rather than inventing a third.

## Why

52 campaign levels cannot be reviewed by reading blueprint data. Every level needs to be
*looked at*, and looking at them has to be one command, not 52.

## What it does

For every level in `levels.js`:

1. Instantiate its blueprint through `sim.js` and settle it — the same
   `TUNE.blueprintSettleSeconds` the lint uses — so the shot shows the level as the
   player will actually meet it, not as authored. If a level settles differently from how
   it was written, the screenshot should reveal that, because that is exactly the class of
   problem worth seeing.
2. Render one frame with the real `render.js`, camera framed on the plot with the
   slingshot marker visible, at 960×540.
3. Write it to `shots/levels/<id>.png`.

Then build a **contact sheet**: every level as a tile in one grid image, each labelled
with its id, piece count and the bag it is played with, written to
`shots/levels/_contact-sheet.png`. Draw the tiles into a single large canvas in the page
and screenshot that once, rather than compositing PNG files afterwards.

The contact sheet is the point of the tool. Reviewing a campaign is about the *progression*
— whether level 7 is visibly harder than level 3, whether an episode's silhouettes are too
similar, whether one level is an outlier — and none of that is visible one screenshot at a
time.

## Flags

- no arguments — every level, plus the contact sheet
- `--episode <n>` — one episode, plus a contact sheet for just that episode
- `--level <id>` — one level, no contact sheet
- `--no-sheet` — skip the contact sheet

## Details that matter

- Print a table as it goes: level id, piece count, and whether anything moved during the
  settle. A level whose shot required movement is worth flagging in the output, not just
  in the image.
- Deterministic: the same levels must produce byte-identical PNGs on a second run, since a
  diff between runs is a useful signal. Seed anything that needs seeding and do not draw
  transient effects.
- Fail non-zero if any level throws, produces a blank frame, or reports a console error.
  A blank frame is a real failure mode — an all-sky image looks fine in a thumbnail grid
  and means the camera missed the fortress.
- Detect the blank case rather than trusting it: sample the frame and assert a minimum
  proportion of non-background pixels.

## Acceptance

1. `node tools/level-shots.mjs` writes one PNG per level plus the contact sheet, and
   prints the table.
2. Run it twice and confirm the PNGs are byte-identical.
3. Deliberately break one level's camera framing or blank a level, show the blank-frame
   detection failing, then restore.
4. `node tools/check.mjs` still passes.

Add the tool to `docs/FILE-PLAN.json`. Write only `tools/level-shots.mjs` and that entry.
