-- Catdome Cup: live database schema snapshot
-- Captured from the production Supabase project (snpnapngocinzpkjeyyn) via
-- introspection of pg_catalog/information_schema. This is a point-in-time
-- DOCUMENTATION snapshot, not a migration -- re-running it against the live
-- database is not the intent. See db/README.md for how it was generated and
-- how to refresh it.
--
-- Column types/defaults/constraints/indexes are reconstructed from catalog
-- data (pg_get_constraintdef / pg_get_indexdef), so they are accurate as of
-- capture time, but formatting/ordering may differ slightly from how the
-- tables were originally created.

-- ============================================================
-- Table: bets
-- Row-level security: ENABLED
-- ============================================================
create table public.bets (
    id text not null,
    type text not null,
    summary text not null,
    bet_text text,
    status text not null default 'open'::text,
    placed_by text,
    accepted_by text,
    declined_by text,
    team_a text,
    team_b text,
    winner_team_id text,
    result text,
    created_at timestamp with time zone default now(),
    accepted_at timestamp with time zone,
    settled_at timestamp with time zone,
    stake numeric,
    odds integer,
    payout_multiplier numeric,
    potential_payout numeric,
    settled_by text,
    week integer,
    market text,
    threshold numeric,
    player_a text,
    player_b text,
    needs_review boolean not null default false,
    settle_detail text
  );
alter table public.bets add constraint bets_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX bets_pkey ON public.bets USING btree (id);

-- ============================================================
-- Table: catpoints_balances
-- Row-level security: ENABLED
-- ============================================================
create table public.catpoints_balances (
    team_id text not null,
    balance numeric not null default 0,
    updated_at timestamp with time zone default now()
  );
alter table public.catpoints_balances add constraint catpoints_balances_pkey PRIMARY KEY (team_id);
CREATE UNIQUE INDEX catpoints_balances_pkey ON public.catpoints_balances USING btree (team_id);

-- ============================================================
-- Table: catpoints_ledger
-- Row-level security: ENABLED
-- ============================================================
create table public.catpoints_ledger (
    id uuid not null default gen_random_uuid(),
    team_id text not null,
    delta numeric not null,
    reason text not null,
    bet_id text,
    note text,
    created_by uuid,
    created_at timestamp with time zone default now()
  );
alter table public.catpoints_ledger add constraint catpoints_ledger_bet_id_fkey FOREIGN KEY (bet_id) REFERENCES bets(id) ON DELETE SET NULL;
alter table public.catpoints_ledger add constraint catpoints_ledger_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.catpoints_ledger add constraint catpoints_ledger_pkey PRIMARY KEY (id);
alter table public.catpoints_ledger add constraint catpoints_ledger_reason_check CHECK ((reason = ANY (ARRAY['starting_balance'::text, 'bet_stake'::text, 'bet_win'::text, 'bet_push'::text, 'waiver'::text, 'trade'::text, 'manual_issue'::text])));
CREATE UNIQUE INDEX catpoints_ledger_pkey ON public.catpoints_ledger USING btree (id);

-- ============================================================
-- Table: espn_transactions
-- Row-level security: ENABLED
-- ============================================================
create table public.espn_transactions (
    id text not null,
    year integer not null,
    message_type_id integer not null,
    action text not null,
    from_team_id text,
    to_team_id text,
    target_player_id bigint,
    occurred_at timestamp with time zone not null,
    synced_at timestamp with time zone not null default now()
  );
alter table public.espn_transactions add constraint espn_transactions_from_team_id_fkey FOREIGN KEY (from_team_id) REFERENCES team_espn_map(team_id);
alter table public.espn_transactions add constraint espn_transactions_pkey PRIMARY KEY (id);
alter table public.espn_transactions add constraint espn_transactions_to_team_id_fkey FOREIGN KEY (to_team_id) REFERENCES team_espn_map(team_id);
CREATE UNIQUE INDEX espn_transactions_pkey ON public.espn_transactions USING btree (id);
CREATE INDEX espn_transactions_year_action_idx ON public.espn_transactions USING btree (year, action);
CREATE INDEX espn_transactions_teams_idx ON public.espn_transactions USING btree (from_team_id, to_team_id);

-- ============================================================
-- Table: news_posts
-- Row-level security: ENABLED
-- ============================================================
create table public.news_posts (
    id text not null,
    category text not null default 'general'::text,
    team_id text,
    author text not null,
    body text not null,
    auto boolean not null default false,
    heat integer not null default 0,
    created_at timestamp with time zone default now(),
    reactions jsonb not null default '{}'::jsonb,
    bet_id text
  );
alter table public.news_posts add constraint news_posts_category_check CHECK ((category = ANY (ARRAY['bet_result'::text, 'waiver'::text, 'trade'::text, 'game_result'::text, 'general'::text, 'weekly_recap'::text])));
alter table public.news_posts add constraint news_posts_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX news_posts_pkey ON public.news_posts USING btree (id);

-- ============================================================
-- Table: nfl_games
-- Row-level security: ENABLED
-- ============================================================
create table public.nfl_games (
    id text not null,
    year integer not null,
    week integer not null,
    kickoff timestamp with time zone,
    home_team text not null,
    away_team text not null,
    spread_home numeric,
    spread_price_home integer,
    spread_price_away integer,
    total numeric,
    over_price integer,
    under_price integer,
    moneyline_home integer,
    moneyline_away integer,
    status text not null default 'scheduled'::text,
    updated_at timestamp with time zone default now(),
    espn_event_id text
  );
alter table public.nfl_games add constraint nfl_games_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX nfl_games_pkey ON public.nfl_games USING btree (id);

-- ============================================================
-- Table: nfl_player_props
-- Row-level security: ENABLED
-- ============================================================
create table public.nfl_player_props (
    id text not null,
    event_id text not null,
    year integer not null,
    week integer not null,
    player_name text not null,
    team text,
    category text not null,
    market text not null,
    line numeric,
    side text,
    price integer not null,
    updated_at timestamp with time zone default now()
  );
alter table public.nfl_player_props add constraint nfl_player_props_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX nfl_player_props_pkey ON public.nfl_player_props USING btree (id);
CREATE INDEX nfl_player_props_event_idx ON public.nfl_player_props USING btree (event_id);
CREATE INDEX nfl_player_props_week_idx ON public.nfl_player_props USING btree (year, week, category);

-- ============================================================
-- Table: pass_the_leg
-- Row-level security: ENABLED
-- ============================================================
create table public.pass_the_leg (
    id text not null,
    created_at timestamp with time zone not null default now(),
    initiator_team_id text not null,
    current_holder_team_id text,
    stake numeric not null,
    status text not null default 'open'::text,
    result text,
    week integer not null,
    locks_at timestamp with time zone not null,
    settled_at timestamp with time zone,
    settled_by text
  );
alter table public.pass_the_leg add constraint pass_the_leg_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX pass_the_leg_pkey ON public.pass_the_leg USING btree (id);

-- ============================================================
-- Table: pass_the_leg_legs
-- Row-level security: ENABLED
-- ============================================================
create table public.pass_the_leg_legs (
    id text not null,
    parlay_id text not null,
    seq integer not null,
    team_id text not null,
    week integer not null,
    pick_text text not null,
    odds integer not null default '-110'::integer,
    created_at timestamp with time zone not null default now()
  );
alter table public.pass_the_leg_legs add constraint pass_the_leg_legs_parlay_id_fkey FOREIGN KEY (parlay_id) REFERENCES pass_the_leg(id) ON DELETE CASCADE;
alter table public.pass_the_leg_legs add constraint pass_the_leg_legs_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX pass_the_leg_legs_pkey ON public.pass_the_leg_legs USING btree (id);

-- ============================================================
-- Table: profiles
-- Row-level security: ENABLED
-- ============================================================
create table public.profiles (
    id uuid not null,
    email text,
    team_id text not null,
    display_name text,
    created_at timestamp with time zone default now()
  );
alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.profiles add constraint profiles_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);

-- ============================================================
-- Table: push_subscriptions
-- Row-level security: ENABLED
-- ============================================================
create table public.push_subscriptions (
    id uuid not null default gen_random_uuid(),
    team_id text not null,
    endpoint text not null,
    p256dh text not null,
    auth text not null,
    created_at timestamp with time zone not null default now()
  );
alter table public.push_subscriptions add constraint push_subscriptions_endpoint_key UNIQUE (endpoint);
alter table public.push_subscriptions add constraint push_subscriptions_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX push_subscriptions_pkey ON public.push_subscriptions USING btree (id);
CREATE UNIQUE INDEX push_subscriptions_endpoint_key ON public.push_subscriptions USING btree (endpoint);

-- ============================================================
-- Table: recaps
-- Row-level security: ENABLED
-- ============================================================
create table public.recaps (
    id text not null,
    year integer not null,
    week integer not null,
    title text not null,
    author text not null,
    body text not null,
    created_at timestamp with time zone default now()
  );
alter table public.recaps add constraint recaps_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX recaps_pkey ON public.recaps USING btree (id);

-- ============================================================
-- Table: rosters
-- Row-level security: ENABLED
-- ============================================================
create table public.rosters (
    id text not null,
    team_id text not null,
    player_name text not null,
    position text,
    lineup_slot text,
    week integer not null,
    year integer not null,
    projected_points numeric,
    actual_points numeric,
    updated_at timestamp with time zone default now()
  );
alter table public.rosters add constraint rosters_pkey PRIMARY KEY (id);
alter table public.rosters add constraint rosters_team_id_fkey FOREIGN KEY (team_id) REFERENCES team_espn_map(team_id);
CREATE UNIQUE INDEX rosters_pkey ON public.rosters USING btree (id);

-- ============================================================
-- Table: standings
-- Row-level security: ENABLED
-- ============================================================
create table public.standings (
    team_id text not null,
    year integer not null,
    wins integer not null default 0,
    losses integer not null default 0,
    ties integer not null default 0,
    points_for numeric default 0,
    points_against numeric default 0,
    rank integer,
    updated_at timestamp with time zone default now()
  );
alter table public.standings add constraint standings_pkey PRIMARY KEY (team_id);
alter table public.standings add constraint standings_team_id_fkey FOREIGN KEY (team_id) REFERENCES team_espn_map(team_id);
CREATE UNIQUE INDEX standings_pkey ON public.standings USING btree (team_id);

-- ============================================================
-- Table: sync_log
-- Row-level security: ENABLED
-- ============================================================
create table public.sync_log (
    id bigint not null,
    ran_at timestamp with time zone default now(),
    ok boolean not null,
    detail text
  );
alter table public.sync_log add constraint sync_log_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX sync_log_pkey ON public.sync_log USING btree (id);

-- ============================================================
-- Table: team_espn_map
-- Row-level security: ENABLED
-- ============================================================
create table public.team_espn_map (
    team_id text not null,
    espn_team_id integer not null,
    team_name text,
    logo_url text
  );
alter table public.team_espn_map add constraint team_espn_map_espn_team_id_key UNIQUE (espn_team_id);
alter table public.team_espn_map add constraint team_espn_map_pkey PRIMARY KEY (team_id);
CREATE UNIQUE INDEX team_espn_map_pkey ON public.team_espn_map USING btree (team_id);
CREATE UNIQUE INDEX team_espn_map_espn_team_id_key ON public.team_espn_map USING btree (espn_team_id);

-- ============================================================
-- Table: weekly_matchups
-- Row-level security: ENABLED
-- ============================================================
create table public.weekly_matchups (
    id text not null,
    year integer not null,
    week integer not null,
    team_id text not null,
    opponent_team_id text,
    team_score numeric,
    opponent_score numeric,
    status text,
    updated_at timestamp with time zone default now()
  );
alter table public.weekly_matchups add constraint weekly_matchups_opponent_team_id_fkey FOREIGN KEY (opponent_team_id) REFERENCES team_espn_map(team_id);
alter table public.weekly_matchups add constraint weekly_matchups_pkey PRIMARY KEY (id);
alter table public.weekly_matchups add constraint weekly_matchups_team_id_fkey FOREIGN KEY (team_id) REFERENCES team_espn_map(team_id);
CREATE UNIQUE INDEX weekly_matchups_pkey ON public.weekly_matchups USING btree (id);
