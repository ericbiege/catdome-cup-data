// Catdome Cup -- NFL odds sync Edge Function
//
// Deploy this in Supabase exactly like espn-sync: Edge Functions -> Deploy a
// new function -> Via Editor, name it "nfl-odds-sync", paste this in, Deploy.
//
// Before it can run you also need to:
//   1. Sign up for a free API key at https://the-odds-api.com (500 free
//      credits/month, no card required for the free tier).
//   2. Add it as a secret: Edge Functions -> nfl-odds-sync -> Secrets ->
//      add ODDS_API_KEY = <your key>.
//   3. Run nfl_odds_schema.sql in the SQL Editor (creates the nfl_games
//      table this function writes to) if you haven't already.
//   4. Run nfl_odds_sync_schedule.sql to put it on a cron schedule (see that
//      file for why the schedule is much sparser than the ESPN sync's).
//
// What it does on every run:
//   1. Calls The Odds API for this week's NFL game lines (moneyline, spread,
//      total), from DraftKings' board when available (falls back to whatever
//      bookmaker the response has for a game, so an early line still shows
//      even before DK posts one).
//   2. Upserts one row per game into nfl_games, keyed by the odds provider's
//      own game id (stable across polls).
//   3. Locks a game (status 'live', then 'final') once kickoff has passed,
//      without spending extra API credits on a separate scores lookup --
//      see the status heuristic below.
//   4. Logs one row to sync_log every run (ok=true/false + detail), same as
//      espn-sync, so `select * from sync_log order by ran_at desc limit 5;`
//      shows both syncs interleaved.
//
// Credits: this calls the bulk /odds endpoint once per run (regions=us,
// markets=h2h,spreads,totals -> 3 credits/run). It does NOT call /scores --
// see the status heuristic comment below for why that's fine for now. Stay
// on the schedule in nfl_odds_sync_schedule.sql (or sparser) to comfortably
// fit the free tier's 500 credits/month, including manual "Test" clicks
// while you're setting this up.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SPORT_KEY = "americanfootball_nfl";
const PREFERRED_BOOKMAKER = "draftkings"; // matches the site's own DraftKings-style bet chips

// Same anchor/formula as SEASON_WEEK1_START / currentLeagueWeek() in
// site/index.html, so an NFL game lands in the same "week" number the
// fantasy side of the site already uses. Keep these two in sync if the
// season start date ever changes.
const SEASON_WEEK1_START = new Date("2026-09-09T00:00:00Z");
function weekForDate(d: Date): number {
  if (d < SEASON_WEEK1_START) return 1;
  const diffDays = Math.floor((d.getTime() - SEASON_WEEK1_START.getTime()) / 86400000);
  return Math.min(Math.max(Math.floor(diffDays / 7) + 1, 1), 17);
}

function currentSeasonYear(now: Date): number {
  const month = now.getUTCMonth() + 1;
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

// No separate call to /scores (that costs extra credits) -- instead: not
// kicked off yet -> scheduled; kicked off within the last ~4.5 hours ->
// live; older than that -> final. NFL games run ~3-3.5 hours, so this pads
// enough for overtime without needing the real score. Worst case a game
// stays "live" (still locked, just mislabeled) a little past the final
// whistle -- never the other way around.
function statusForKickoff(kickoff: Date, now: Date): string {
  if (now < kickoff) return "scheduled";
  const hoursSinceKickoff = (now.getTime() - kickoff.getTime()) / 3600000;
  return hoursSinceKickoff > 4.5 ? "final" : "live";
}

function pickBookmaker(bookmakers: any[]): any | null {
  if (!bookmakers?.length) return null;
  return bookmakers.find((b) => b.key === PREFERRED_BOOKMAKER) ?? bookmakers[0];
}
function findMarket(bookmaker: any, key: string): any | null {
  return bookmaker?.markets?.find((m: any) => m.key === key) ?? null;
}
function outcomeFor(market: any, name: string): any | null {
  return market?.outcomes?.find((o: any) => o.name === name) ?? null;
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
      const msg = "Missing ODDS_API_KEY secret -- add it under Edge Functions -> nfl-odds-sync -> Secrets.";
      await log(false, msg);
      return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
    }

    const now = new Date();
    const year = currentSeasonYear(now);

    const url =
      `https://api.the-odds-api.com/v4/sports/${SPORT_KEY}/odds/` +
      `?apiKey=${oddsApiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;

    const resp = await fetch(url);
    const rawBody = await resp.text();
    if (!resp.ok) {
      throw new Error(`The Odds API request failed: ${resp.status} ${rawBody.slice(0, 300)}`);
    }
    // The Odds API returns remaining/used credits on these response headers --
    // worth surfacing in the log so you can see usage without leaving the SQL Editor.
    const creditsRemaining = resp.headers.get("x-requests-remaining");
    const creditsUsed = resp.headers.get("x-requests-used");

    let games: any[];
    try {
      games = JSON.parse(rawBody);
    } catch {
      throw new Error(`The Odds API returned non-JSON (status ${resp.status}): ${rawBody.slice(0, 300)}`);
    }

    let written = 0;
    const skipped: string[] = [];

    for (const game of games ?? []) {
      try {
        const bookmaker = pickBookmaker(game.bookmakers);
        if (!bookmaker) { skipped.push(`${game.away_team} @ ${game.home_team}: no bookmaker odds yet`); continue; }

        const h2h = findMarket(bookmaker, "h2h");
        const spreads = findMarket(bookmaker, "spreads");
        const totals = findMarket(bookmaker, "totals");

        const homeSpread = outcomeFor(spreads, game.home_team);
        const awaySpread = outcomeFor(spreads, game.away_team);
        const homeMoneyline = outcomeFor(h2h, game.home_team);
        const awayMoneyline = outcomeFor(h2h, game.away_team);
        const overOutcome = outcomeFor(totals, "Over");
        const underOutcome = outcomeFor(totals, "Under");

        const kickoff = new Date(game.commence_time);

        const { error } = await supabase.from("nfl_games").upsert({
          id: game.id,
          year,
          week: weekForDate(kickoff),
          kickoff: kickoff.toISOString(),
          home_team: game.home_team,
          away_team: game.away_team,
          spread_home: homeSpread?.point ?? null,
          spread_price_home: homeSpread?.price ?? null,
          spread_price_away: awaySpread?.price ?? null,
          total: overOutcome?.point ?? underOutcome?.point ?? null,
          over_price: overOutcome?.price ?? null,
          under_price: underOutcome?.price ?? null,
          moneyline_home: homeMoneyline?.price ?? null,
          moneyline_away: awayMoneyline?.price ?? null,
          status: statusForKickoff(kickoff, now),
          updated_at: now.toISOString(),
        });
        if (error) skipped.push(`${game.away_team} @ ${game.home_team}: ${error.message}`);
        else written++;
      } catch (e) {
        skipped.push(`${game?.away_team ?? "?"} @ ${game?.home_team ?? "?"}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const detail =
      `games=${games?.length ?? 0} written=${written} credits_used=${creditsUsed ?? "?"} credits_remaining=${creditsRemaining ?? "?"}` +
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
