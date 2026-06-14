// netlify/functions/admin.mjs
// Token-gated helpers for the fun/novelty bets the odds API doesn't cover
// (e.g. "Red card in the match?", "First scorer", "Who busts first this round?").
// POST { action, token, ... }.
//   action "create_market": { fixture_id, label, key?, point?, auto?, outcomes:[{key,label,odds}] }
//   action "settle_market" : { market_id, result }     // result = winning option key
//   action "add_fixture"   : { home, away, stage?, commence_time }   // for non-API matches/futures

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const POOL_ID = process.env.POOL_ID;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

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
