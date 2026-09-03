// Catdome Cup -- NFL Player Props grading Edge Function
//
// Deploy exactly like the other syncs: Edge Functions -> Deploy a new
// function -> Via Editor, name it "nfl-props-grade", paste this in, Deploy.
// No new secret needed -- this only talks to Supabase and to ESPN's public
// (free, unofficial, no key required) site API, never The Odds API, so it
// costs zero odds-provider credits and can run as often as you like.
//
// Before it can do anything you need nfl_props_schema.sql run (adds
// nfl_games.espn_event_id) and nfl_props_grade_schedule.sql for the cron.
//
// What it does on every run:
//   1. Finds every open bet of type 'nfl_prop'.
//   2. For each one, figures out which real NFL game it's tied to by
//      matching (week, player, market) against nfl_player_props, then
//      checks that game's status in nfl_games.
//   3. For games that are 'final', resolves ESPN's own event id for that
//      game (a one-time lookup per game, cached onto nfl_games.espn_event_id)
//      and pulls the real box score from ESPN's public summary endpoint.
//   4. Settles each bet by comparing the real stat (passing/rushing/
//      receiving yards, interceptions, receptions, longest rush/reception,
//      sacks, or anytime-TD/2+ TDs) against the bet's line, pays out
//      winners/pushes via catpoints_ledger, same convention as
//      gradeBets() in espn-sync.
//   5. Anything it can't confidently resolve (player not found in the box
//      score -- inactive, name mismatch, etc.) gets needs_review = true
//      instead of a guess, same as the fantasy prop grading already does.
//
// Known limitation: "First TD Scorer" and "Last TD Scorer" bets can NEVER be
// auto-graded by this function -- box-score totals don't carry the order
// touchdowns were scored in, and ESPN's free summary endpoint doesn't expose
// a play-by-play scoring sequence this function fetches. Those bets always
// get needs_review = true and need manual settlement via the Book admin
// panel once the game is final.
//
// Caveat: ESPN's site API is real but unofficial and undocumented -- the
// box-score shape below (boxscore.players[].statistics[].athletes[]) is
// based on how it's long been observed to work, not a guarantee, and the new
// stat extractions added for interceptions/receptions/longest-rush/longest-
// reception/sacks are unverified against a live game (the 2026 season hadn't
// started as of this rewrite). The first real test is whichever game
// finishes first after this is deployed -- check
// `select * from sync_log order by ran_at desc limit 10;` after a
// Sunday/Monday slate wraps to see real grading results, and check
// needs_review counts for any stat that isn't extracting correctly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function fmt1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

// Human-readable unit for a "missed by X" / "went over by X" note (see
// index.html's bet-ledger-margin-note) -- only the threshold-based markets
// below get one; anytime_td/first_td/last_td are binary (scored or didn't)
// and don't have a meaningful numeric margin.
const PROP_UNIT_LABELS: Record<string, string> = {
  multi_td: "TDs", pass_yds: "pass yds", pass_int: "INTs", rush_yds: "rush yds",
  rush_long: "yds", reception_yds: "rec yds", receptions: "receptions",
  reception_long: "yds", sacks: "sacks",
};

function currentSeasonYear(now: Date): number {
  const month = now.getUTCMonth() + 1;
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

// Turns "Kansas City Chiefs" -> "chiefs" so it can be matched against
// whatever form ESPN's scoreboard uses for the same team.
function teamNickname(fullName: string): string {
  const words = (fullName || "").trim().split(/\s+/);
  return (words[words.length - 1] || "").toLowerCase();
}

// Pulls a numeric stat out of one ESPN boxscore "statistics" category
// (e.g. the "passing" block for a team) for one athlete, trying several
// candidate key names since the exact key naming isn't guaranteed.
function statValue(category: any, athleteIndex: number, candidates: string[]): number | null {
  if (!category) return null;
  const athlete = (category.athletes ?? [])[athleteIndex];
  if (!athlete || !Array.isArray(athlete.stats)) return null;
  const keys: string[] = (category.keys ?? category.labels ?? []).map((k: string) => String(k).toLowerCase());
  for (const cand of candidates) {
    const idx = keys.findIndex((k) => k.includes(cand));
    if (idx >= 0 && athlete.stats[idx] != null) {
      const n = parseFloat(String(athlete.stats[idx]).replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

type PlayerLine = {
  passYds?: number; passInt?: number;
  rushYds?: number; rushLong?: number;
  recYds?: number; receptions?: number; recLong?: number;
  anytimeTd?: number;
  sacks?: number;
};

function parseBoxscore(boxscore: any): Map<string, PlayerLine> {
  const out = new Map<string, PlayerLine>();
  for (const teamBlock of boxscore?.players ?? []) {
    for (const category of teamBlock.statistics ?? []) {
      const name = String(category.name || "").toLowerCase();
      const athletes = category.athletes ?? [];
      athletes.forEach((a: any, idx: number) => {
        const displayName: string = a.athlete?.displayName || a.athlete?.shortName || "";
        if (!displayName) return;
        const key = displayName.toLowerCase();
        const line: PlayerLine = out.get(key) || {};
        if (name === "passing") {
          const yds = statValue(category, idx, ["passingyards", "yards"]);
          if (yds != null) line.passYds = yds;
          const ints = statValue(category, idx, ["interceptions"]);
          if (ints != null) line.passInt = ints;
        } else if (name === "rushing") {
          const yds = statValue(category, idx, ["rushingyards", "yards"]);
          if (yds != null) line.rushYds = yds;
          const tds = statValue(category, idx, ["rushingtouchdowns", "touchdowns", "td"]);
          if (tds != null) line.anytimeTd = (line.anytimeTd || 0) + tds;
          const long = statValue(category, idx, ["longrushing", "long"]);
          if (long != null) line.rushLong = long;
        } else if (name === "receiving") {
          const yds = statValue(category, idx, ["receivingyards", "yards"]);
          if (yds != null) line.recYds = yds;
          const tds = statValue(category, idx, ["receivingtouchdowns", "touchdowns", "td"]);
          if (tds != null) line.anytimeTd = (line.anytimeTd || 0) + tds;
          const rec = statValue(category, idx, ["receptions"]);
          if (rec != null) line.receptions = rec;
          const long = statValue(category, idx, ["longreception", "long"]);
          if (long != null) line.recLong = long;
        } else if (name === "defensive") {
          const sacks = statValue(category, idx, ["sacks"]);
          if (sacks != null) line.sacks = sacks;
        }
        out.set(key, line);
      });
    }
  }
  return out;
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const log = async (ok: boolean, detail: string) => {
    try {
      await supabase.from("sync_log").insert({ ok, detail });
    } catch {
      // nothing more we can do if logging itself fails
    }
  };

  try {
    const now = new Date();
    const year = currentSeasonYear(now);

    const { data: openBets, error: betsErr } = await supabase
      .from("bets")
      .select("*")
      .eq("type", "nfl_prop")
      .eq("status", "open");
    if (betsErr) throw betsErr;

    if (!openBets || !openBets.length) {
      await log(true, "No open nfl_prop bets to grade.");
      return new Response(JSON.stringify({ ok: true, detail: "No open nfl_prop bets to grade." }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Resolve each bet to a game (event_id) via nfl_player_props, since the
    // bet row itself only knows week/player/market -- not which game.
    const eventIdForBet = new Map<string, string>();
    for (const bet of openBets) {
      const baseMarket = String(bet.market || "").replace(/_(over|under)$/, "");
      const { data: propRows } = await supabase
        .from("nfl_player_props")
        .select("event_id")
        .eq("week", bet.week)
        .eq("year", year)
        .eq("market", baseMarket)
        .ilike("player_name", bet.player_a || "")
        .limit(1);
      if (propRows && propRows.length) eventIdForBet.set(bet.id, propRows[0].event_id);
    }

    const eventIds = [...new Set(eventIdForBet.values())];
    let gamesById = new Map<string, any>();
    if (eventIds.length) {
      const { data: gameRows } = await supabase.from("nfl_games").select("*").in("id", eventIds);
      for (const g of gameRows ?? []) gamesById.set(g.id, g);
    }

    let graded = 0;
    let flagged = 0;
    let notYetFinal = 0;
    const skipped: string[] = [];
    const boxscoreCache = new Map<string, Map<string, PlayerLine> | null>();

    for (const bet of openBets) {
      const eventId = eventIdForBet.get(bet.id);
      if (!eventId) { skipped.push(`${bet.id}: couldn't map to a game`); continue; }
      const game = gamesById.get(eventId);
      if (!game) { skipped.push(`${bet.id}: game ${eventId} not found`); continue; }
      if (game.status !== "final") { notYetFinal++; continue; }

      let stats = boxscoreCache.get(eventId);
      if (stats === undefined) {
        try {
          stats = await fetchBoxscore(game);
        } catch (e) {
          stats = null;
          skipped.push(`box score for ${game.away_team} @ ${game.home_team}: ${e instanceof Error ? e.message : String(e)}`);
        }
        boxscoreCache.set(eventId, stats ?? null);
      }
      if (!stats) continue; // logged above; leave these bets open for the next run

      const playerLine = stats.get((bet.player_a || "").toLowerCase());
      if (!playerLine) {
        await supabase.from("bets").update({ needs_review: true }).eq("id", bet.id).eq("status", "open");
        flagged++;
        continue;
      }

      let actual: number | null = null;
      let outcome: "win" | "loss" | "push" | null = null;
      let settleDetail: string | null = null;
      const market = String(bet.market || "");
      if (market === "anytime_td") {
        actual = playerLine.anytimeTd ?? 0;
        outcome = actual > 0 ? "win" : "loss";
      } else if (market === "first_td" || market === "last_td") {
        // Box-score totals don't carry scoring order -- telling first/last
        // TD scorer apart would need the game's scoring-play sequence, which
        // this function doesn't fetch. Always flag for manual settlement via
        // the Book admin panel rather than guess.
        await supabase.from("bets").update({ needs_review: true }).eq("id", bet.id).eq("status", "open");
        flagged++;
        continue;
      } else {
        const threshold = Number(bet.threshold);
        const baseMarket = market.replace(/_(over|under)$/, "");
        if (baseMarket === "multi_td") actual = playerLine.anytimeTd ?? null;
        else if (baseMarket === "pass_yds") actual = playerLine.passYds ?? null;
        else if (baseMarket === "pass_int") actual = playerLine.passInt ?? null;
        else if (baseMarket === "rush_yds") actual = playerLine.rushYds ?? null;
        else if (baseMarket === "rush_long") actual = playerLine.rushLong ?? null;
        else if (baseMarket === "reception_yds") actual = playerLine.recYds ?? null;
        else if (baseMarket === "receptions") actual = playerLine.receptions ?? null;
        else if (baseMarket === "reception_long") actual = playerLine.recLong ?? null;
        else if (baseMarket === "sacks") actual = playerLine.sacks ?? null;
        if (actual == null || !Number.isFinite(threshold)) {
          await supabase.from("bets").update({ needs_review: true }).eq("id", bet.id).eq("status", "open");
          flagged++;
          continue;
        }
        const isOver = market.endsWith("_over");
        outcome = actual === threshold ? "push" : (isOver ? actual > threshold : actual < threshold) ? "win" : "loss";
        if (outcome === "loss") {
          const unit = PROP_UNIT_LABELS[baseMarket] || "";
          settleDetail = isOver
            ? `missed by ${fmt1(threshold - actual)}${unit ? " " + unit : ""}`
            : `went over by ${fmt1(actual - threshold)}${unit ? " " + unit : ""}`;
        }
      }

      const stake = Number(bet.stake) || 0;
      const payout = outcome === "win" ? Number(bet.potential_payout ?? stake) : stake; // push refunds the stake
      const winnerTeamId = outcome === "win" ? bet.placed_by : null;

      const { data: updated } = await supabase
        .from("bets")
        .update({
          status: "settled", result: outcome, winner_team_id: winnerTeamId,
          settled_by: "system", settled_at: now.toISOString(), settle_detail: settleDetail,
        })
        .eq("id", bet.id).eq("status", "open")
        .select("id");
      if (!updated || !updated.length) continue; // raced with a manual settle -- skip

      if ((outcome === "win" || outcome === "push") && bet.placed_by) {
        await supabase.from("catpoints_ledger").insert({
          team_id: bet.placed_by, delta: payout,
          reason: outcome === "win" ? "bet_win" : "bet_push",
          bet_id: bet.id, note: `${bet.summary} settled: ${outcome} (actual ${actual})`,
        });
      }
      graded++;
    }

    const detail =
      `open_bets=${openBets.length} graded=${graded} flagged=${flagged} not_yet_final=${notYetFinal}` +
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

  // ---- ESPN lookups (defined inside Deno.serve's closure so it shares `supabase`) ----
  async function fetchBoxscore(game: any): Promise<Map<string, PlayerLine> | null> {
    let espnEventId: string | null = game.espn_event_id ?? null;

    if (!espnEventId) {
      const kickoff = new Date(game.kickoff);
      // ESPN's scoreboard takes a single UTC calendar date -- games rarely
      // straddle midnight UTC oddly enough for NFL kickoff times, but check
      // the kickoff date itself.
      const dateStr = `${kickoff.getUTCFullYear()}${String(kickoff.getUTCMonth() + 1).padStart(2, "0")}${String(kickoff.getUTCDate()).padStart(2, "0")}`;
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dateStr}`);
      if (!resp.ok) throw new Error(`ESPN scoreboard ${resp.status}`);
      const board = await resp.json();
      const homeNick = teamNickname(game.home_team);
      const awayNick = teamNickname(game.away_team);
      const match = (board.events ?? []).find((ev: any) => {
        const names = (ev.competitions?.[0]?.competitors ?? []).map((c: any) =>
          (c.team?.displayName || c.team?.name || "").toLowerCase(),
        );
        return names.some((n: string) => n.includes(homeNick)) && names.some((n: string) => n.includes(awayNick));
      });
      if (!match) return null;
      espnEventId = match.id;
      await supabase.from("nfl_games").update({ espn_event_id: espnEventId }).eq("id", game.id);
    }

    const summaryResp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${espnEventId}`);
    if (!summaryResp.ok) throw new Error(`ESPN summary ${summaryResp.status}`);
    const summary = await summaryResp.json();
    if (!summary.boxscore) return null;
    return parseBoxscore(summary.boxscore);
  }
});