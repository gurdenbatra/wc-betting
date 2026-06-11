-- ============================================================
-- MATCHDAY LEDGER — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Model: equal daily spending allowance (resets each matchday);
--        profit/loss accumulates into a season-long net (the leaderboard).
-- Fairness: bets go through place_bet(), which checks the server clock
--           against kickoff and the player's remaining daily allowance.
--           Direct writes to bets/markets/fixtures are blocked by RLS;
--           only the serverless functions (service-role key) may write them.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists pools (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  room_code       text unique not null,
  daily_allowance numeric not null default 1000,
  created_at      timestamptz default now()
);

create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  pool_id    uuid references pools(id) on delete cascade,
  name       text not null,
  created_at timestamptz default now(),
  unique (pool_id, name)
);

create table if not exists fixtures (
  id            uuid primary key default gen_random_uuid(),
  pool_id       uuid references pools(id) on delete cascade,
  ext_id        text,                                   -- The Odds API event id
  home          text not null,
  away          text not null,
  stage         text default 'Group stage',
  commence_time timestamptz not null,
  matchday      date generated always as ((commence_time at time zone 'UTC')::date) stored,
  home_score    int,
  away_score    int,
  settled       boolean default false,
  unique (pool_id, ext_id)
);

create table if not exists markets (
  id         uuid primary key default gen_random_uuid(),
  fixture_id uuid references fixtures(id) on delete cascade,
  key        text not null,            -- h2h | totals | btts | cs | custom
  label      text not null,
  point      numeric,                  -- e.g. 2.5 for totals; null otherwise
  outcomes   jsonb not null,           -- [{ "key","label","odds","point"? }]
  result     text,                     -- winning option key; null = open
  auto       boolean default true,     -- true = settle-able from final score
  settled    boolean default false,
  unique (fixture_id, key, point)
);

create table if not exists bets (
  id          uuid primary key default gen_random_uuid(),
  pool_id     uuid references pools(id) on delete cascade,
  player_id   uuid references players(id) on delete cascade,
  fixture_id  uuid references fixtures(id) on delete cascade,
  market_id   uuid references markets(id) on delete cascade,
  option_key  text not null,
  label       text not null,
  stake       numeric not null check (stake > 0),
  odds        numeric not null,
  matchday    date not null,
  status      text not null default 'pending',   -- pending | won | lost | void
  created_at  timestamptz default now()
);
create index if not exists bets_player_idx on bets(player_id);
create index if not exists bets_market_idx on bets(market_id);
create index if not exists bets_matchday_idx on bets(player_id, matchday);

-- ---------- leaderboard ----------
create or replace view standings as
select
  p.id      as player_id,
  p.pool_id as pool_id,
  p.name    as name,
  coalesce(sum(case b.status
                 when 'won'  then b.stake * (b.odds - 1)
                 when 'lost' then -b.stake
                 else 0 end), 0)::numeric          as net,
  count(b.id) filter (where b.status = 'won')      as wins,
  count(b.id) filter (where b.status = 'lost')     as losses,
  count(b.id) filter (where b.status = 'pending')  as open_bets
from players p
left join bets b on b.player_id = p.id
group by p.id;

-- ---------- the one rule that matters: place a bet safely ----------
create or replace function place_bet(
  p_player uuid, p_market uuid, p_option text, p_stake numeric
) returns bets
language plpgsql security definer set search_path = public as $$
declare
  m markets; f fixtures; o jsonb;
  v_odds numeric; v_label text; v_bet bets;
begin
  select * into m from markets where id = p_market;
  if not found then raise exception 'Market not found'; end if;
  if m.result is not null then raise exception 'This market is already settled'; end if;

  select * into f from fixtures where id = m.fixture_id;
  if now() >= f.commence_time then
    raise exception 'Locked: kickoff has passed';
  end if;

  select value into o
  from jsonb_array_elements(m.outcomes) value
  where value->>'key' = p_option
  limit 1;
  if o is null then raise exception 'That option is not part of this market'; end if;

  if p_stake <= 0 then raise exception 'Stake must be above zero'; end if;
  v_odds  := (o->>'odds')::numeric;
  v_label := o->>'label';

  insert into bets(pool_id, player_id, fixture_id, market_id, option_key, label, stake, odds, matchday)
  values (f.pool_id, p_player, f.id, m.id, p_option, v_label, p_stake, v_odds, f.matchday)
  returning * into v_bet;
  return v_bet;
end $$;

-- ---------- row level security ----------
alter table pools    enable row level security;
alter table players  enable row level security;
alter table fixtures enable row level security;
alter table markets  enable row level security;
alter table bets     enable row level security;

-- everyone can read (the app is public within your friend group)
create policy r_pools    on pools    for select using (true);
create policy r_players  on players  for select using (true);
create policy r_fixtures on fixtures for select using (true);
create policy r_markets  on markets  for select using (true);
create policy r_bets     on bets     for select using (true);

-- players may join a pool (insert themselves); nothing else is writable by anon
create policy ins_players on players for insert with check (true);

-- bets can only be created through place_bet(); fixtures/markets only via service role
grant execute on function place_bet(uuid, uuid, text, numeric) to anon, authenticated;

-- table-level privileges for the API roles (publishable key -> anon).
-- RLS policies above sit on top of these; reads stay governed by the select policies.
grant usage on schema public to anon, authenticated;
grant select on pools, players, fixtures, markets, bets to anon, authenticated;
grant select on standings to anon, authenticated;
grant insert on players to anon, authenticated;   -- joining the pool
alter default privileges in schema public grant select on tables to anon, authenticated;

-- ============================================================
-- SEED a pool. Edit the names, then note the printed pool id +
-- room_code for your .env and the front-end config.
-- ============================================================
insert into pools (name, room_code, daily_allowance)
values ('World Cup 2026', 'WC26', 1000)
on conflict (room_code) do nothing;

-- Gurden runs the pool as bookie (house) — not a player.
-- To remove Gurden from an existing install:
--   delete from players where name='Gurden' and pool_id=(select id from pools where room_code='WC26');
insert into players (pool_id, name)
select id, n from pools, unnest(array['Ganz','Sandy','Ishu','Nabil','Kundra']) n
where pools.room_code = 'WC26'
on conflict do nothing;

select id as pool_id, room_code, daily_allowance from pools where room_code = 'WC26';