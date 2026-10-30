# Wheelkeepers

A browser arcade game for the Squeekchain community. Guide a collector around a hamster wheel, catch seeds, avoid glitches, and survive as the pace increases.

**[Play Wheelkeepers](https://wheelkeepers.dpdns.org/)**

## How to play

- Move the mouse around the wheel to aim. On a phone, hold and drag on the playfield.
- Arrow keys and A/D are also supported.
- Catch seeds to earn points and avoid glitches to protect your three hearts.
- The run continues until you lose all hearts, with increasing difficulty.

Practice is available without a wallet. Connect an Ethereum wallet and sign a message to enter the leaderboard. Playing does not require tokens, gas, transaction approvals, or NFT ownership. Wallet addresses used for ranked play are visible on the public leaderboard.

## Squeekchain integration

Live courses use data from the official Squeekchain status feed. The game shows the feed's availability and offers practice mode when live data is unavailable.

## Boost events

A fresh hardware transition from resting to running opens a shared 90-second entry window. Each Boost lasts up to 75 seconds (or three lost hearts). The event freezes the seed and starting RPM for all participants: slow wheels produce arcs, faster wheels produce spirals. A 12-seed golden orbit appears at 12, 30, 48 and 66 seconds; catching the full sequence awards +500 points.

Exit or Escape immediately returns to the arcade. Exited runs are abandoned without submitting a score. Existing seeds and glitches finish their flights before the golden sequence reaches the collector; charging never clears the field.

The entry window and any started run survive a hamster rest or an unavailable feed. Continued running does not continually create events. Event detection follows visitor polling; activity entirely between observations can be missed. The hardware signal is persisted in D1 so concurrent visitors and Worker restarts share one event.

Sign in before joining a live Boost to save a server-verified score to that event's leaderboard. These scores never enter the ordinary all-time board. **Practice Boost** in the Squeekchain card is a clearly labelled, always-available practice run with a separate device best; it does not simulate a hardware event or submit a score.

After updating, apply the new D1 migration before serving the updated app. The local command below applies it only to the development database.

## Run locally

Requires Node.js 22.13 or newer and npm.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open [localhost:5173](http://localhost:5173/).

Local development uses a local database. The migrations do not connect to the deployed game's database. No production credentials are required.

## Static hosting (imd.site / IPFS)

A static pin contains the frontend, not the Worker or D1 database. Production
clients on another origin explicitly use `https://wheelkeepers.dpdns.org/api/`.
The canonical site and local development retain same-origin API requests.

The Worker permits the exact published frontend origin listed in
`lib/hosting.mjs`: `https://wheelkeepers-a-little-hamster-a.imd.site`.
Add any replacement frontend origin there and redeploy the Worker before moving
the frontend. Unrelated pins on shared IPFS gateways are intentionally not
authorized; use a dedicated trusted hostname.

External clients sign wallet messages for their own frontend domain. They use
origin-bound bearer sessions kept in the current tab's sessionStorage, expiring
after one day, without third-party cookies. The canonical site keeps HttpOnly,
SameSite=Lax cookies. Both use the same server-verified scores and D1 leaderboard.
The client checks the API before asking the wallet for account access and gives
a readable service error if the API is unavailable.

To prepare a static upload, build and start a production preview:

```sh
npm run build
npm run start -- --port 8789
```

In another terminal, export to a new directory:

```sh
npm run export:static -- --preview-url http://127.0.0.1:8789 --out outputs/ipfs
```

Upload that directory's contents with `index.html` at the root. Keep the
Cloudflare Worker online; the static frontend still needs it for live status,
wallet authentication and leaderboards. Fonts and their licenses are included
in `public/fonts/`, with no Google Fonts request on page load.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

With the local dev server running, `node --experimental-strip-types tests/boost-integration.mjs` verifies a full 75-second event run against local D1 and removes its disposable account and fixtures afterward.

`node --experimental-strip-types tests/static-api-integration.mjs` checks a local
production preview on port 8789 for external sign-in, preflight, cookie isolation
and nonce replay protection. `WK_TEST_STATIC=1` also runs the full Boost integration
through the external origin's bearer authentication; set `WK_TEST_ORIGIN` to the
local server being tested. The fixed production API can be checked with
`node --experimental-strip-types tests/static-api-integration.mjs --production`;
it uses a disposable signing key, submits no scores, and revokes its sessions.

## About

Wheelkeepers is an independent community project and is not an official Squeekchain product. Third-party license notices are retained alongside the corresponding assets and tools.
