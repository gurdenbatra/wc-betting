// netlify/functions/sync-odds.mjs
// Pulls upcoming fixtures + opening odds from The Odds API and writes them to Supabase.
// Triggered by GitHub Actions cron (see .github/workflows/cron.yml).
// Markets are created once and NOT overwritten — everyone bets against the same posted line.
//
// Cost note: markets(h2h,totals) x regions(eu) = 2 credits per call. The /events
// part is free; only /odds is charged. Watch x-requests-remaining in the response log.

const ODDS_KEY     = process.env.ODDS_API_KEY;
const SPORT        = process.env.ODDS_SPORT_KEY || "soccer_fifa_world_cup"; // verify via /v4/sports
const SB_URL       = process.env.SUPABASE_URL;
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY;
const POOL_ID      = process.env.POOL_ID;
const SECRET       = process.env.CRON_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const sb = (path, opts = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });

export default async (req) => {
  const url = new URL(req.url);
  const tok = url.searchParams.get("token");
  if (SECRET && tok !== SECRET && tok !== ADMIN_SECRET)
    return new Response("forbidden", { status: 403 });

  // refresh=1 also re-prices EXISTING open markets that have no bets yet
  // (lines with bets, or already settled, are never touched).
  const refresh = url.searchParams.get("refresh") === "1";

  // 1) odds (decimal), EU region, two markets
  const oddsUrl =
    `https://api.the-odds-api.com/v4/sports/${SPORT}/odds` +
    `?regions=eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${ODDS_KEY}`;
  const r = await fetch(oddsUrl);
  if (!r.ok) return new Response(`odds api: ${r.status} ${await r.text()}`, { status: 502 });
  const remaining = r.headers.get("x-requests-remaining");
  const events = await r.json();

  // 2) upsert fixtures
  const fixtureRows = events.map((e) => ({
    pool_id: POOL_ID,
    ext_id: e.id,
    home: e.home_team,
    away: e.away_team,
    commence_time: e.commence_time,
  }));
  if (fixtureRows.length) {
    const up = await sb("fixtures?on_conflict=pool_id,ext_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(fixtureRows),
    });
    if (!up.ok) return new Response(`fixtures upsert: ${await up.text()}`, { status: 502 });
  }

  // 3) map ext_id -> fixture uuid
  const fxRes = await sb(`fixtures?pool_id=eq.${POOL_ID}&select=id,ext_id`);
  const fxByExt = Object.fromEntries((await fxRes.json()).map((f) => [f.ext_id, f.id]));

  // 4) existing markets (don't overwrite a posted line) — map "fixtureId:key" -> {id, result}
  const ids = Object.values(fxByExt);
  const existing = {};
  if (ids.length) {
    const mRes = await sb(`markets?fixture_id=in.(${ids.join(",")})&select=id,fixture_id,key,result`);
    for (const m of await mRes.json()) existing[`${m.fixture_id}:${m.key}`] = { id: m.id, result: m.result };
  }

  // which markets already have bets (only relevant in refresh mode)
  let betMktIds = new Set();
  if (refresh && ids.length) {
    const bRes = await sb(`bets?pool_id=eq.${POOL_ID}&select=market_id`);
    betMktIds = new Set((await bRes.json()).map((b) => b.market_id));
  }
  // a market is re-priceable if it's open (no result) and has no bets
  const canReprice = (m) => m && m.result === null && !betMktIds.has(m.id);

  // 5) build new markets (first bookmaker that offers each), and — in refresh
  //    mode — re-price existing open, bet-free markets with the latest odds.
  const newMarkets = [];
  const updates = []; // { id, body }
  for (const e of events) {
    const fid = fxByExt[e.id];
    if (!fid) continue;

    const h2h = pickMarket(e, "h2h");
    if (h2h) {
      const exH = existing[`${fid}:h2h`];
      const o = mapH2H(h2h, e.home_team, e.away_team);
      if (!exH) {
        if (o) newMarkets.push({ fixture_id: fid, key: "h2h", label: "Match result", point: null, outcomes: o });
      } else if (refresh && o && canReprice(exH)) {
        updates.push({ id: exH.id, body: { outcomes: o } });
      }
    }

    const tot = pickMarket(e, "totals");
    if (tot) {
      const exT = existing[`${fid}:totals`];
      const m = mapTotals(tot);
      if (!exT) {
        if (m) newMarkets.push({ fixture_id: fid, key: "totals", label: `Total goals O/U ${m.point}`, point: m.point, outcomes: m.outcomes });
      } else if (refresh && m && canReprice(exT)) {
        updates.push({ id: exT.id, body: { outcomes: m.outcomes, point: m.point, label: `Total goals O/U ${m.point}` } });
      }
    }
  }
  if (newMarkets.length) {
    const ins = await sb("markets", { method: "POST", body: JSON.stringify(newMarkets) });
    if (!ins.ok) return new Response(`markets insert: ${await ins.text()}`, { status: 502 });
  }

  let updated = 0;
  for (const u of updates) {
    const r = await sb(`markets?id=eq.${u.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(u.body),
    });
    if (r.ok) updated++;
  }

  return Response.json({
    events: events.length,
    new_markets: newMarkets.length,
    updated_markets: updated,
    refreshed: refresh,
    credits_remaining: remaining,
  });
};

function pickMarket(event, key) {
  for (const bk of event.bookmakers || []) {
    const m = (bk.markets || []).find((x) => x.key === key);
    if (m) return m;
  }
  return null;
}
function mapH2H(m, home, away) {
  const find = (name) => m.outcomes.find((o) => o.name === name)?.price;
  const h = find(home), d = find("Draw"), a = find(away);
  if (!h || !d || !a) return null;
  return [
    { key: "h", label: home,   odds: h },
    { key: "d", label: "Draw", odds: d },
    { key: "a", label: away,   odds: a },
  ];
}
function mapTotals(m) {
  const over  = m.outcomes.find((o) => o.name === "Over");
  const under = m.outcomes.find((o) => o.name === "Under");
  if (!over || !under) return null;
  const point = over.point;
  return {
    point,
    outcomes: [
      { key: "over",  label: `Over ${point}`,  odds: over.price,  point },
      { key: "under", label: `Under ${point}`, odds: under.price, point },
    ],
  };
}
