// netlify/functions/settle.mjs
// Pulls final scores from The Odds API and auto-settles every market it can
// derive from the scoreline: h2h, totals, btts, correct score (cs).
// Markets flagged auto=false (custom props) are left for manual settlement.
//
// Knockout safeguard: from Round of 32 onward, matches can go to extra time /
// penalties. The 3-way "Match result" market is priced as a 90-minute (full-time)
// market, but the API's score may include extra time — so we DON'T auto-settle
// knockout fixtures. We record the score and leave every market for the bookie to
// settle by hand (after checking the 90' result). Group-stage games auto-settle.
//
// Cost note: /scores costs 2 credits per call.

const ODDS_KEY     = process.env.ODDS_API_KEY;
const SPORT        = process.env.ODDS_SPORT_KEY || "soccer_fifa_world_cup";
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

  const r = await fetch(
    `https://api.the-odds-api.com/v4/sports/${SPORT}/scores?daysFrom=3&apiKey=${ODDS_KEY}`
  );
  if (!r.ok) return new Response(`scores api: ${r.status} ${await r.text()}`, { status: 502 });
  const remaining = r.headers.get("x-requests-remaining");
  const games = await r.json();

  const done = games.filter((g) => g.completed && Array.isArray(g.scores));
  let settledMarkets = 0;
  let knockoutSkipped = 0;

  for (const g of done) {
    const hs = num(g.scores.find((s) => s.name === g.home_team)?.score);
    const as = num(g.scores.find((s) => s.name === g.away_team)?.score);
    if (hs == null || as == null) continue;

    // find the fixture + record the score
    const fxRes = await sb(`fixtures?pool_id=eq.${POOL_ID}&ext_id=eq.${g.id}&select=id,stage`);
    const fx = (await fxRes.json())[0];
    if (!fx) continue;

    // Knockout matches can go to ET/penalties — leave them for manual settlement.
    const isKnockout = KNOCKOUT_STAGES.has(fx.stage);
    await sb(`fixtures?id=eq.${fx.id}`, {
      method: "PATCH",
      body: JSON.stringify({ home_score: hs, away_score: as, settled: !isKnockout }),
    });
    if (isKnockout) { knockoutSkipped++; continue; }

    // open, auto-settleable markets on this fixture
    const mRes = await sb(
      `markets?fixture_id=eq.${fx.id}&result=is.null&auto=eq.true&select=id,key,point,outcomes`
    );
    for (const m of await mRes.json()) {
      const result = resolve(m, hs, as);
      if (result == null) continue;
      await sb(`markets?id=eq.${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ result, settled: true }),
      });
      // winners first, then everything still pending = losers
      await sb(`bets?market_id=eq.${m.id}&status=eq.pending&option_key=eq.${result}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "won" }),
      });
      await sb(`bets?market_id=eq.${m.id}&status=eq.pending`, {
        method: "PATCH",
        body: JSON.stringify({ status: "lost" }),
      });
      settledMarkets++;
    }
  }

  return Response.json({
    completed_games: done.length,
    settled_markets: settledMarkets,
    knockout_manual: knockoutSkipped,
    credits_remaining: remaining,
  });
};

// Stages that can go to extra time / penalties — settled by hand, not auto.
const KNOCKOUT_STAGES = new Set([
  "Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Third place", "Final",
]);

const num = (v) => (v == null || v === "" ? null : Number(v));

function resolve(m, hs, as) {
  const keys = (m.outcomes || []).map((o) => o.key);
  switch (m.key) {
    case "h2h":
      return hs > as ? "h" : hs < as ? "a" : "d";
    case "totals": {
      const total = hs + as, p = Number(m.point);
      return total > p ? "over" : "under";
    }
    case "btts":
      return hs > 0 && as > 0 ? "yes" : "no";
    case "cs": {
      const exact = `${hs}-${as}`;
      return keys.includes(exact) ? exact : keys.includes("other") ? "other" : null;
    }
    default:
      return null; // custom props are settled manually
  }
}
