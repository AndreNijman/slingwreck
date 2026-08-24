# SLINGWRECK — deployment

Same shape as every other game in the family: GitHub Pages from the repository root,
a proxied Cloudflare CNAME, the shared `games-guard` Worker in front, and a separate
Worker for the relay.

Nothing here has been done yet. This is the runbook for when P2 is ready to go live.

---

## 1. Repository and Pages

```bash
gh repo create AndreNijman/slingwreck --public --source . --push
```

Then in the repository settings, Pages → Source → **GitHub Actions**. The workflow at
`.github/workflows/pages.yml` gates the deploy on `npm run check`, so a broken
simulation cannot reach the site.

`CNAME`, `.nojekyll`, `robots.txt` and `sitemap.xml` are already in place.

## 2. DNS

Cloudflare, zone `andrenijman.com`:

- `CNAME slingwreck → andrenijman.github.io`, **proxied**.
- SSL/TLS mode Full.

## 3. Register with the guard

The guard is `AndreNijman/games-site`, checked out locally at
`../bloons/_ref/games-site`. Four edits:

1. `worker/index.js` — add `slingwreck.andrenijman.com` to the `HOSTS` set (line ~7).
2. `worker/index.js` — add `"slingwreck.andrenijman.com": "SLINGWRECK"` to
   `GAME_TITLES` (line ~19).
3. `wrangler.jsonc` — add
   `{ "pattern": "slingwreck.andrenijman.com/*", "zone_name": "andrenijman.com" }`
   to `routes`.
4. `index.html` — add a `<a class="game" href="https://slingwreck.andrenijman.com">`
   card with a 1000×525 `slingwreck.png` and a meta line, and add the matching
   JSON-LD entry near line 106.

Then `wrangler deploy` in `games-site`. Until that is done the subdomain returns
`Unknown host` from the guard, which is the correct failure and not a DNS problem.

Suggested hub meta line, once the mode exists:

```
SLINGWRECK — Slingshot demolition · build your own fortress · 1v1 siege · 52 campaign levels
```

## 4. Relay

```bash
npm run deploy        # wrangler deploy, publishes slingwreck-relay
```

Lands at `slingwreck-relay.tung-tung-tung-sahur.workers.dev`, matching the other
relays. `net.js` falls back to that host in production.

If the relay ever needs to read the shared `.andrenijman.com` session cookie — for
example to list lobbies through `/_guard/slingwreck-lobbies` the way BOP does — add a
custom domain route `relay.slingwreck.andrenijman.com` with `custom_domain: true`,
because a `workers.dev` host will never see that cookie.

## 5. Card and social image

```bash
node tools/card-shot.mjs
```

Screenshots a real round into `card.png` (1000×525, for the hub) and `og-image.png`
(1200×630, for links). Copy `card.png` into `games-site` as `slingwreck.png`.

## 6. Live verification

```bash
BASE_URL=https://slingwreck.andrenijman.com \
LIVE_RELAY=https://slingwreck-relay.tung-tung-tung-sahur.workers.dev \
node tools/mp-smoke.mjs
```

## 7. Order of operations

DNS before the guard route, guard route before the hub card, hub card before telling
anyone. Deploying the relay is independent and can happen at any point.

---

# Deployment status — 2026-08-23

**Infrastructure is live. The hub card is deliberately not added yet.**

| step | state |
| --- | --- |
| GitHub repo `AndreNijman/slingwreck`, public | done |
| `git push` of `main` | done |
| Pages enabled, `build_type: workflow` | done |
| Pages workflow run | **passing** — `npm ci`, Chromium install, `check`, `npm test`, `test:audio`, 1m53s |
| Cloudflare DNS `CNAME slingwreck -> andrenijman.github.io`, proxied | done |
| Guard `HOSTS` + `GAME_TITLES` + route, deployed | done, version `86a22bea` |
| All ten guard hosts responding | verified 428 before and after, guard health `{"ok":true,"database":true}` |
| Relay Worker `slingwreck-relay` | deployed, `/health` returns ok |
| Hub card in `games-site/index.html` | **live** |

## The hub card went live 2026-08-24

The campaign is complete — 52 levels, nine critters, star thresholds derived from play —
so the card now advertises something finished. `tools/card-shot.mjs` generates it from a
real round in `sty-13`, caught mid-collapse with debris still in the air.

The card copy describes **only what is playable**: "Slingshot demolition · 52 levels ·
9 critters · fortress workshop · hand-written physics". Siege's rules, relay and cards all
exist and are tested, but there is no UI to reach them, so the card does not mention it.
Advertising a mode nobody can click would be a lie told to everyone who visits the hub.

Two attempts were needed for the image. The first used `qry-07`, whose tapped Lob wins the
level outright and put the results panel over the entire frame — a screenshot of a dialog
rather than of the game. `sty-13` has thirty pieces and several pigs, so one shot takes a
visible bite without ending the round.

Verifying it took several passes because the guard fetches the hub document from GitHub
Pages with `cacheEverything` at a 30-second TTL. The origin served the new HTML
immediately; the edge did not. A cache purge plus a cache-busting query parameter
confirmed it. Worth knowing before concluding a hub change has failed to deploy.

## What was verified, and one thing that cannot be

Reachability was confirmed at every layer that can be checked without a human: Pages
serves directly, the proxied domain serves `robots.txt`, the guard recognises the host and
renders its device-naming page, and the other nine games were checked before and after the
Worker deploy to make sure nothing regressed.

The last step — name a device, then play — **cannot be automated.** A headless Chromium
stalls on the guard's device-naming form. That is not a fault in this game: an identical
run against `bop.andrenijman.com`, which is live and working, stalls in exactly the same
way with the same single console error. The guard's fingerprinting expects a real browser.

Worth recording because the obvious reading of that first result is "the deployment is
broken", and the control experiment is what showed it was not.

## One thing that went wrong, and how it was caught

The Worker was deployed from a local clone that was **three commits behind origin**. The
push was rejected afterwards, which is what surfaced it. Had those commits touched
`worker/index.js` or `wrangler.jsonc`, the deploy would have silently reverted them for
every game on the domain.

They did not — the net change was one orphaned `wavelength.png` — so nothing was lost. But
the lesson stands: **`git fetch` and confirm you are current before deploying a Worker that
fronts nine other people's games.** Rebased and pushed as `92265c4`.

## The deployment was broken for a day and every check I ran said it was fine

`slingwreck.andrenijman.com` served **"Site not found · GitHub Pages"** from the moment it
was registered until 2026-08-24. The game never loaded once.

Every check I had run passed:

- all ten guard hosts returned **428** — including this one
- the guard reported `{"ok":true,"database":true}`
- `robots.txt` returned 200 through the proxied domain
- `andrenijman.github.io/slingwreck/` returned 200
- the Pages workflow was green on every commit

None of them touched the thing that was broken. **428 is the guard's "name your device"
response, and the guard returns it before it ever fetches upstream** — so a 428 proves the
Worker is alive and proves nothing whatsoever about whether there is a site behind it. The
200 on `robots.txt` came from the guard's asset path, and the 200 on the `github.io` URL
was the *project pages* path, which exists whether or not a custom domain is attached.

The actual fault: enabling Pages with `build_type: workflow` via the API does **not** set
the custom domain. The repository has a `CNAME` file and the workflow uploads it, but the
Pages configuration itself had `cname: null`, so GitHub had nothing routing
`slingwreck.andrenijman.com` to this repository and answered every request with its
generic not-found page.

```bash
gh api -X PUT repos/AndreNijman/slingwreck/pages -f cname=slingwreck.andrenijman.com
```

Note the order: setting `cname` and `https_enforced=true` together fails with *"The
certificate does not exist yet"*. Set the domain, let the certificate provision, then
enforce HTTPS.

**The lesson is about the check, not the config.** I verified the gate and never verified
what was behind it. A deployment check has to assert something only a working deployment
can produce — the game's own markup, its canvas, a string from `index.html` — and not a
status code from the thing standing in front of it. `tools/smoke.mjs` already does exactly
this locally; it should be run against production too:

```bash
BASE_URL=https://slingwreck.andrenijman.com node tools/smoke.mjs
```

That would have failed on day one.
