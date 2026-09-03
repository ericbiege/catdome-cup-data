-- Catdome Cup: live Row-Level-Security snapshot
-- Captured from the production Supabase project (snpnapngocinzpkjeyyn) via
-- pg_policy/pg_class introspection. DOCUMENTATION only -- this is what RLS
-- looks like today, not a migration to re-run. Every table below already has
-- RLS enabled in production.
--
-- NOTE: the post-Week-1 RLS hardening pass (tightening these policies -- most
                                             -- write policies currently just check auth.role() = 'authenticated', not per-team
                                             -- ownership) is tracked separately and intentionally NOT part of this snapshot's
-- scope -- this file only records the current state.

-- ---- bets ----
alter table public.bets enable row level security;
create policy "bets_delete_authenticated"
  on public.bets
  as PERMISSIVE
  for DELETE
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "bets_insert_authenticated"
  on public.bets
  as PERMISSIVE
  for INSERT
  to public
  with check ((auth.role() = 'authenticated'::text));
create policy "bets_select_authenticated"
  on public.bets
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "bets_update_authenticated"
  on public.bets
  as PERMISSIVE
  for UPDATE
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- catpoints_balances ----
alter table public.catpoints_balances enable row level security;
create policy "catpoints_balances_select_authenticated"
  on public.catpoints_balances
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- catpoints_ledger ----
alter table public.catpoints_ledger enable row level security;
create policy "catpoints_ledger_insert_authenticated"
  on public.catpoints_ledger
  as PERMISSIVE
  for INSERT
  to public
  with check (((auth.role() = 'authenticated'::text) AND ((reason <> 'manual_issue'::text) OR ((auth.jwt() ->> 'email'::text) = 'eric@ericbiege.com'::text))));
create policy "catpoints_ledger_select_authenticated"
  on public.catpoints_ledger
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- espn_transactions ----
alter table public.espn_transactions enable row level security;
create policy "espn_transactions_select_authenticated"
  on public.espn_transactions
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- news_posts ----
alter table public.news_posts enable row level security;
create policy "news_posts_insert_authenticated"
  on public.news_posts
  as PERMISSIVE
  for INSERT
  to public
  with check ((auth.role() = 'authenticated'::text));
create policy "news_posts_select_authenticated"
  on public.news_posts
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "news_posts_update_authenticated"
  on public.news_posts
  as PERMISSIVE
  for UPDATE
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- nfl_games ----
alter table public.nfl_games enable row level security;
create policy "nfl_games_select_authenticated"
  on public.nfl_games
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- nfl_player_props ----
alter table public.nfl_player_props enable row level security;
create policy "nfl_player_props_select_authenticated"
  on public.nfl_player_props
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- pass_the_leg ----
alter table public.pass_the_leg enable row level security;
create policy "pass_the_leg_delete_authenticated"
  on public.pass_the_leg
  as PERMISSIVE
  for DELETE
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "pass_the_leg_insert_authenticated"
  on public.pass_the_leg
  as PERMISSIVE
  for INSERT
  to public
  with check ((auth.role() = 'authenticated'::text));
create policy "pass_the_leg_select_authenticated"
  on public.pass_the_leg
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "pass_the_leg_update_authenticated"
  on public.pass_the_leg
  as PERMISSIVE
  for UPDATE
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- pass_the_leg_legs ----
alter table public.pass_the_leg_legs enable row level security;
create policy "pass_the_leg_legs_delete_authenticated"
  on public.pass_the_leg_legs
  as PERMISSIVE
  for DELETE
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "pass_the_leg_legs_insert_authenticated"
  on public.pass_the_leg_legs
  as PERMISSIVE
  for INSERT
  to public
  with check ((auth.role() = 'authenticated'::text));
create policy "pass_the_leg_legs_select_authenticated"
  on public.pass_the_leg_legs
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "pass_the_leg_legs_update_authenticated"
  on public.pass_the_leg_legs
  as PERMISSIVE
  for UPDATE
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- profiles ----
alter table public.profiles enable row level security;
create policy "profiles_insert_own"
  on public.profiles
  as PERMISSIVE
  for INSERT
  to public
  with check ((auth.uid() = id));
create policy "profiles_select_authenticated"
  on public.profiles
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));
create policy "profiles_update_own"
  on public.profiles
  as PERMISSIVE
  for UPDATE
  to public
  using ((auth.uid() = id));

-- ---- push_subscriptions ----
alter table public.push_subscriptions enable row level security;
create policy "push_subscriptions_authenticated"
  on public.push_subscriptions
  as PERMISSIVE
  for ALL
  to authenticated
  using ((auth.role() = 'authenticated'::text))
  with check ((auth.role() = 'authenticated'::text));

-- ---- recaps ----
alter table public.recaps enable row level security;
create policy "recaps_insert_authenticated"
  on public.recaps
  as PERMISSIVE
  for INSERT
  to public
  with check ((auth.role() = 'authenticated'::text));
create policy "recaps_select_authenticated"
  on public.recaps
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- rosters ----
alter table public.rosters enable row level security;
create policy "rosters_select_authenticated"
  on public.rosters
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- standings ----
alter table public.standings enable row level security;
create policy "standings_select_authenticated"
  on public.standings
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- sync_log ----
alter table public.sync_log enable row level security;
create policy "sync_log_select_authenticated"
  on public.sync_log
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- team_espn_map ----
alter table public.team_espn_map enable row level security;
create policy "team_espn_map_select_authenticated"
  on public.team_espn_map
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));

-- ---- weekly_matchups ----
alter table public.weekly_matchups enable row level security;
create policy "weekly_matchups_select_authenticated"
  on public.weekly_matchups
  as PERMISSIVE
  for SELECT
  to public
  using ((auth.role() = 'authenticated'::text));
