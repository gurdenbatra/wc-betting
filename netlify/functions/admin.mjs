// netlify/functions/admin.mjs
// Token-gated helpers for the fun/novelty bets the odds API doesn't cover
// (e.g. "Red card in the match?", "First scorer", "Who busts first this round?").
// POST { action, token, ... }.
//   action "create_market": { fixture_id, label, key?, point?, auto?, outcomes:[{key,label,odds}] }
//   action "settle_market" : { market_id, result }     // result = winning option key
//   action "add_fixture"   : { home, away, stage?, commence_time }   // for non-API matches/futures

const SB_URL       = process.env.SUPABASE_URL;
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY;
const POOL_ID      = process.env.POOL_ID;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const ODDS_KEY     = process.env.ODDS_API_KEY;
const SPORT        = process.env.ODDS_SPORT_KEY || "soccer_fifa_world_cup";

const sb = (path, opts = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(opts.headers || {}),
    },
  });

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  if (body.token !== ADMIN_SECRET) return new Response("forbidden", { status: 403 });

  try {
    if (body.action === "create_market") {
      const row = {
        fixture_id: body.fixture_id,
        key: body.key || "custom",
        label: body.label,
        point: body.point ?? null,
        auto: body.auto ?? (["btts", "cs"].includes(body.key) ? true : false),
        outcomes: body.outcomes,
      };
      const r = await sb("markets", { method: "POST", body: JSON.stringify(row) });
      return new Response(await r.text(), { status: r.ok ? 200 : 502 });
    }

    if (body.action === "settle_market") {
      await sb(`markets?id=eq.${body.market_id}`, {
        method: "PATCH",
        body: JSON.stringify({ result: body.result, settled: true }),
      });
      await sb(`bets?market_id=eq.${body.market_id}&status=eq.pending&option_key=eq.${body.result}`, {
        method: "PATCH", body: JSON.stringify({ status: "won" }),
      });
      await sb(`bets?market_id=eq.${body.market_id}&status=eq.pending`, {
        method: "PATCH", body: JSON.stringify({ status: "lost" }),
      });
      return Response.json({ ok: true });
    }

    if (body.action === "update_player_token") {
      const token = Math.random().toString(36).slice(2, 10);
      const r = await sb(`players?id=eq.${body.player_id}`, {
        method: "PATCH",
        body: JSON.stringify({ token }),
      });
      if (!r.ok) return new Response(await r.text(), { status: 502 });
      return Response.json({ ok: true, token });
    }

    if (body.action === "sync_wc_winner") {
      // Fetch outright winner odds — costs 2 credits (1 market × eu region)
      const r = await fetch(
        `https://api.the-odds-api.com/v4/sports/${SPORT}/odds?regions=eu&markets=outrights&oddsFormat=decimal&apiKey=${ODDS_KEY}`
      );
      if (!r.ok) return new Response(`odds api: ${r.status} ${await r.text()}`, { status: 502 });
      const remaining = r.headers.get("x-requests-remaining");
      const events = await r.json();

      // Collect outcomes from the first event/bookmaker that has them
      let raw = [];
      outer: for (const ev of events) {
        for (const bk of ev.bookmakers || []) {
          const m = (bk.markets || []).find(m => m.key === "outrights");
          if (m?.outcomes?.length) { raw = m.outcomes; break outer; }
        }
      }
      if (!raw.length) return new Response("no outright outcomes found", { status: 404 });

      // Favourites first (lowest price = shortest odds), top 10
      const top10 = raw
        .slice()
        .sort((a, b) => a.price - b.price)
        .slice(0, 10)
        .map(o => ({
          key: o.name.toLowerCase().replace(/[\s'.-]+/g, "_"),
          label: o.name,
          odds: o.price,
        }));

      // Upsert the special WC winner fixture (ext_id keeps it idempotent)
      // Betting locks at start of Round of 16 (July 2 2026)
      const upsertFx = await sb("fixtures?on_conflict=pool_id,ext_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({
          pool_id: POOL_ID,
          ext_id: "wc2026_winner",
          home: "WC 2026 Winner",
          away: "Outright",
          stage: "Tournament",
          commence_time: "2026-07-02T18:00:00Z",
        }),
      });
      if (!upsertFx.ok) return new Response(`fixture upsert: ${await upsertFx.text()}`, { status: 502 });
      const [fx] = await upsertFx.json();

      // Only create market if it doesn't exist yet (same philosophy as sync-odds)
      const mRes = await sb(`markets?fixture_id=eq.${fx.id}&key=eq.outright`);
      const existing = (await mRes.json())[0];
      if (existing) {
        return Response.json({ ok: true, teams: top10.length, created: false, credits_remaining: remaining });
      }

      const ins = await sb("markets", {
        method: "POST",
        body: JSON.stringify({
          fixture_id: fx.id,
          key: "outright",
          label: "World Cup 2026 Winner",
          point: null,
          auto: false,
          outcomes: top10,
        }),
      });
      if (!ins.ok) return new Response(`market insert: ${await ins.text()}`, { status: 502 });
      return Response.json({ ok: true, teams: top10.length, created: true, credits_remaining: remaining });
    }

    if (body.action === "add_fixture") {
      const r = await sb("fixtures", {
        method: "POST",
        body: JSON.stringify({
          pool_id: POOL_ID, home: body.home, away: body.away,
          stage: body.stage || "Group stage", commence_time: body.commence_time,
        }),
      });
      return new Response(await r.text(), { status: r.ok ? 200 : 502 });
    }

    return new Response("unknown action", { status: 400 });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
};
