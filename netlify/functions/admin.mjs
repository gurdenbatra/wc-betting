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
      // Odds API suspends outright futures once the tournament is live, so we
      // use pre-set odds. Pass body.teams ([{name, odds}]) to override defaults.
      const DEFAULT_TEAMS = [
        { name: "Brazil",          odds: 4.50 },
        { name: "France",          odds: 5.00 },
        { name: "England",         odds: 5.50 },
        { name: "Argentina",       odds: 6.00 },
        { name: "Spain",           odds: 7.00 },
        { name: "Germany",         odds: 8.00 },
        { name: "Portugal",        odds: 9.00 },
        { name: "Netherlands",     odds: 12.00 },
        { name: "United States",   odds: 15.00 },
        { name: "Mexico",          odds: 18.00 },
      ];
      const teams = (body.teams || DEFAULT_TEAMS).map(t => ({
        key: t.name.toLowerCase().replace(/[\s'.-]+/g, "_"),
        label: t.name,
        odds: t.odds,
      }));

      // Upsert the special WC winner fixture — betting locks at Round of 16 (2 Jul)
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

      // Create or update the market (re-running refreshes odds as teams are eliminated)
      const mRes = await sb(`markets?fixture_id=eq.${fx.id}&key=eq.outright`);
      const existing = (await mRes.json())[0];

      if (existing) {
        await sb(`markets?id=eq.${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ outcomes: teams }),
        });
        return Response.json({ ok: true, teams: teams.length, created: false });
      }

      const ins = await sb("markets", {
        method: "POST",
        body: JSON.stringify({
          fixture_id: fx.id,
          key: "outright",
          label: "World Cup 2026 Winner",
          point: null,
          auto: false,
          outcomes: teams,
        }),
      });
      if (!ins.ok) return new Response(`market insert: ${await ins.text()}`, { status: 502 });
      return Response.json({ ok: true, teams: teams.length, created: true });
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
