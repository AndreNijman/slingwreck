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
