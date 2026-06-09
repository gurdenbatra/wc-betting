# Matchday Ledger — World Cup 2026 betting pool

Friendly, no-real-money pool. Equal daily allowance per matchday; profit/loss
accumulates into a season-long net (the leaderboard). Odds and results come from
The Odds API; standard markets settle automatically; novelty props settle by hand.

Stack: static `index.html` on Netlify · Supabase (Postgres) for data + the rules ·
two Netlify functions triggered by a GitHub Actions cron.

## Pieces
- `schema.sql` — paste into Supabase SQL editor. Creates tables, the `place_bet`
  rule (server-side kickoff lock + daily-allowance check), the `standings` view,
  RLS, and a seeded pool.
- `index.html` — the app. Fill in the four config values near the top.
- `netlify/functions/sync-odds.mjs` — pulls fixtures + opening odds (h2h, totals).
- `netlify/functions/settle.mjs` — pulls scores, auto-settles h2h/totals/btts/cs.
- `netlify/functions/admin.mjs` — token-gated: create prop markets, settle by hand.
- `.github/workflows/cron.yml` — free scheduler that pings the functions.

## Setup (about 20 minutes)
1. **Supabase**: create a project. SQL editor → paste `schema.sql` → Run. Copy the
   printed `pool_id`. From Project Settings → API copy the project URL, the `anon`
   key, and the `service_role` key.
2. **The Odds API**: get a free key at the-odds-api.com. Confirm the World Cup sport
   key by opening `https://api.the-odds-api.com/v4/sports?apiKey=YOURKEY` and finding
   the soccer World Cup entry (set `ODDS_SPORT_KEY` to its `key`).
3. **index.html**: set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ROOM_CODE` (`WC26` from
   the seed). Leave `FUNCTIONS_BASE` as `/.netlify/functions`.
4. **Netlify**: connect the repo (or drag-drop the folder). Site settings →
   Environment variables → add everything from `.env.example` (service key, odds key,
   pool id, `CRON_SECRET`, `ADMIN_SECRET`). Deploy.
5. **GitHub Actions**: repo → Settings → Secrets → Actions → add `SITE_URL`
   (your netlify URL) and `CRON_SECRET` (same value). The cron now runs on schedule;
   hit "Run workflow" once to seed odds immediately.
6. Open the site, pick your name, share the link in WhatsApp.

## Credit budget (free tier = 500/month)
- `sync-odds` = h2h + totals × 1 region = **2 credits/call**, twice a day → ~120/mo.
- `settle` = **2 credits/call**, four times a day → ~240/mo.
- Total ≈ **360/month**, inside the free 500. Each function logs
  `credits_remaining`; watch it. If you want fresher data, paid is ~$25/mo for 20k.

## Honest caveats
- **No real auth.** Players are names within a pool, so a determined friend could
  pick someone else's name. Fine for banter; not built for adversaries.
- **The kickoff lock is server-side** (checked in `place_bet` against the database
  clock), so it isn't bypassable from the browser — but it depends on the fixture's
  `commence_time` being correct from the odds feed.
- [Unverified] Netlify scheduled-function availability on the free tier is disputed,
  which is why scheduling runs through GitHub Actions instead.
- **Auto-settlement** covers anything derivable from the final score (result, totals,
  both-teams-to-score, correct score). First-scorer / cards / "who busts first" are
  created and settled by hand in the Admin panel.
