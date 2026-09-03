// Catdome Cup -- NFL Player Props sync Edge Function
//
// Deploy exactly like nfl-odds-sync: Edge Functions -> Deploy a new function
// -> Via Editor, name it "nfl-props-sync", paste this in, Deploy. Uses the
// same ODDS_API_KEY secret as nfl-odds-sync -- no new secret needed.
//
// Before it can do anything you also need:
//   1. nfl_props_schema.sql run in the SQL Editor (creates nfl_player_props).
//   2. nfl_props_sync_schedule.sql run in the SQL Editor (puts this on a
//      daily cron -- see that file for the credit-budget math).
//
// What it does on every run:
//   1. Reads this week's games from nfl_games (already populated by
//      nfl-odds-sync) that haven't kicked off yet.
//   2. For each one, calls The Odds API's per-event odds endpoint for the
//      full PROP_MARKETS list below (TD scorer variants, passing, rushing,
//      receiving, and defense markets).
//   3. Upserts one row per priced outcome into nfl_player_props.
//   4. Logs one row to sync_log every run, same as the other syncs.
//
// Credits: the event-odds endpoint costs [markets returned] x [regions] PER
// GAME (unlike the bulk odds endpoint nfl-odds-sync uses, which is a flat
// rate for the whole week). On the 20,000-credit/month plan this runs daily
// against the full 12-market list below -- see nfl_props_sync_schedule.sql
// for the actual monthly credit projection. Check
// `select * from sync_log order by ran_at desc limit 10;` after a run to see
// real credit usage (logged same as nfl-odds-sync) and adjust PROP_MARKETS
// below if you want more/fewer prop types.
//
// NOTE on market keys: player_anytime_td, player_pass_yds_alternate,
// player_rush_yds_alternate, and player_reception_yds_alternate are
// confirmed working (live since the original 4-market version of this
// function). The other eight keys below (first/last TD, 2+ TDs,
// interceptions, longest rush/reception, receptions, sacks) are best-effort
// guesses at The Odds API's naming convention, not yet verified against a
// live response -- the 2026 season hadn't started as of this rewrite. This
// function's design makes wrong guesses low-risk: a market key that doesn't
// match anything in the bookmaker's response is silently skipped (see the
// `if (!marketData) continue;` below), so a bad guess just means that one
// prop type stays empty on the site rather than anything breaking. Check
// sync_log's `credits_used_total` / rows-written detail after the first real
// sync of the season and fix any key that isn't returning data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SPORT_KEY = "americanfootball_nfl";

// Markets with exactly one priced outcome per player (no line, no Over/Under
// side) -- rendered as a single chip and stored as the bare market name.
// Everything else flows through the generic Over/Under/line path below.
const SINGLE_SIDED_MARKETS = new Set(["anytime_td", "first_td", "last_td"]);

// One entry per market this function fetches. `category` is the site's
// sub-tab; `market` is the site's own short name for it (used as the
// nfl_player_props.market value and in bet records).
const PROP_MARKETS: { key: string; category: string; market: string }[] = [
  { key: "player_anytime_td", category: "td", market: "anytime_td" },
  { key: "player_1st_td", category: "td", market: "first_td" },
  { key: "player_last_td", category: "td", market: "last_td" },
  { key: "player_tds_over", category: "td", market: "multi_td" },
  { key: "player_pass_yds_alternate", category: "passing", market: "pass_yds" },
  { key: "player_pass_interceptions", category: "passing", market: "pass_int" },
  { key: "player_rush_yds_alternate", category: "rushing", market: "rush_yds" },
  { key: "player_rush_longest", category: "rushing", market: "rush_long" },
  { key: "player_reception_yds_alternate", category: "receiving", market: "reception_yds" },
  { key: "player_receptions_alternate", category: "receiving", market: "receptions" },
  { key: "player_reception_longest", category: "receiving", market: "reception_long" },
  { key: "player_sacks", category: "defense", market: "sacks" },
];

// Cap how many upcoming games get fetched per run. Before the season starts
// (or any time everything is still marked "scheduled"), nfl_games can have
// 200+ rows all technically eligible -- without a cap this function tries to
// hit The Odds API once per game for every game left in the season in a
// single run, which (a) blows the credit budget math in
// nfl_props_sync_schedule.sql by 10-20x and (b) takes long enough that the
// pg_net trigger's default 5-second HTTP timeout gives up on it before it
// ever reaches its own logging code -- which is why sync_log showed zero
// entries for this function even though it was deployed and "running" on a
// cron schedule. Ordering by kickoff and capping at GAMES_PER_RUN keeps each
// run to (at most) the very next slate of games, matching the weekly-games
// assumption the credit math was built on.
const GAMES_PER_RUN = 20;

function slugify(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const oddsApiKey = Deno.env.get("ODDS_API_KEY");

  const supabase = createClient(supabaseUrl, serviceKey);

  const log = async (ok: boolean, detail: string) => {
    try {
      await supabase.from("sync_log").insert({ ok, detail });
    } catch {
      // If logging itself fails there's nothing more we can do here.
    }
  };

  try {
    if (!oddsApiKey) {
      const msg = "Missing ODDS_API_KEY secret -- add it under Edge Functions -> nfl-props-sync -> Secrets (same key as nfl-odds-sync).";
      await log(false, msg);
      return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
    }

    const now = new Date();

    // Only pull props for games that haven't kicked off yet -- once a game
    // is live/final there's nothing left to bet, and re-fetching would just
    // burn credits.
    const { data: games, error: gamesErr } = await supabase
      .from("nfl_games")
      .select("id, year, week, home_team, away_team, kickoff, status")
      .eq("status", "scheduled")
      .order("kickoff", { ascending: true })
      .limit(GAMES_PER_RUN);
    if (gamesErr) throw gamesErr;

    if (!games || !games.length) {
      const msg = "No scheduled games in nfl_games yet -- run nfl-odds-sync first.";
      await log(true, msg);
      return new Response(JSON.stringify({ ok: true, detail: msg }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    let written = 0;
    let creditsUsedTotal = 0;
    let creditsRemaining: string | null = null;
    const skipped: string[] = [];
    // Collected across every game/market/outcome and written in one bulk
    // upsert at the end, instead of one awaited upsert() per outcome. With
    // the full 12-market list a single game can have 50-100+ priced
    // outcomes -- doing that as individual sequential round-trips (which is
    // what this loop originally did) is what made even a handful of games
    // slow enough to blow past pg_net's 5-second trigger timeout on top of
    // the GAMES_PER_RUN fix above.
    const rowsToUpsert: Record<string, unknown>[] = [];

    for (const game of games) {
      try {
        const marketKeys = PROP_MARKETS.map((m) => m.key).join(",");
        const url =
          `https://api.the-odds-api.com/v4/sports/${SPORT_KEY}/events/${game.id}/odds` +
          `?apiKey=${oddsApiKey}&regions=us&markets=${marketKeys}&oddsFormat=american&dateFormat=iso`;

        const resp = await fetch(url);
        const rawBody = await resp.text();
        const usedHeader = resp.headers.get("x-requests-used");
        creditsRemaining = resp.headers.get("x-requests-remaining") ?? creditsRemaining;

        if (!resp.ok) {
          skipped.push(`${game.away_team} @ ${game.home_team}: request failed ${resp.status} ${rawBody.slice(0, 150)}`);
          continue;
        }

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          skipped.push(`${game.away_team} @ ${game.home_team}: non-JSON response`);
          continue;
        }

        const bookmaker = (payload.bookmakers ?? []).find((b: any) => b.key === "draftkings") ?? (payload.bookmakers ?? [])[0];
        if (!bookmaker) { skipped.push(`${game.away_team} @ ${game.home_team}: no bookmaker props yet`); continue; }

        const seenIdsThisGame = new Set<string>();
        for (const marketDef of PROP_MARKETS) {
          const marketData = (bookmaker.markets ?? []).find((m: any) => m.key === marketDef.key);
          if (!marketData) continue;

          for (const outcome of marketData.outcomes ?? []) {
            const playerName: string = outcome.description || outcome.name;
            if (!playerName) continue;
            // Single-sided markets (anytime/first/last TD) have the player
            // name AS outcome.description with name = "Yes" (varies by book
            // -- DraftKings uses description = player, name = "Yes"). Every
            // other market is a line + Over/Under: name = "Over"/"Under",
            // description = player.
            const isSingleSided = SINGLE_SIDED_MARKETS.has(marketDef.market);
            const side = isSingleSided ? null : (outcome.name === "Over" ? "over" : outcome.name === "Under" ? "under" : null);
            if (!isSingleSided && !side) continue; // unrecognized outcome shape -- skip rather than guess
            const line = isSingleSided ? null : (outcome.point ?? null);
            const price = Number(outcome.price);
            if (!Number.isFinite(price)) continue;

            const rowId = `${game.id}::${marketDef.market}::${slugify(playerName)}::${line ?? "na"}::${side ?? "na"}`;
            seenIdsThisGame.add(rowId);

            rowsToUpsert.push({
              id: rowId,
              event_id: game.id,
              year: game.year,
              week: game.week,
              player_name: playerName,
              team: null, // The Odds API doesn't tag player props with a team; the UI groups by game instead
              category: marketDef.category,
              market: marketDef.market,
              line,
              side,
              price,
              updated_at: now.toISOString(),
            });
          }
        }

        if (usedHeader) creditsUsedTotal = Number(usedHeader);
      } catch (e) {
        skipped.push(`${game.away_team} @ ${game.home_team}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // One bulk upsert (chunked defensively) instead of one call per outcome.
    const UPSERT_CHUNK_SIZE = 500;
    for (let i = 0; i < rowsToUpsert.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = rowsToUpsert.slice(i, i + UPSERT_CHUNK_SIZE);
      const { error } = await supabase.from("nfl_player_props").upsert(chunk);
      if (error) skipped.push(`bulk upsert rows ${i}-${i + chunk.length}: ${error.message}`);
      else written += chunk.length;
    }

    const detail =
      `games_checked=${games.length} rows_written=${written} credits_used_total=${creditsUsedTotal || "?"} credits_remaining=${creditsRemaining ?? "?"}` +
      (skipped.length ? ` | ${skipped.length} skipped: ${skipped.slice(0, 5).join("; ")}` : "");
    await log(true, detail);

    return new Response(JSON.stringify({ ok: true, detail }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(false, message);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
