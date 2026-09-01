// Catdome Cup -- NFL Game Lines grading Edge Function
//
// Deploy exactly like nfl-props-grade: Edge Functions -> Deploy a new
// function -> Via Editor, name it "nfl-lines-grade", paste this in, Deploy.
// No new secret needed -- this only talks to Supabase and to ESPN's public
// (free, unofficial, no key required) site API, the same one nfl-props-grade
// uses, never The Odds API, so it costs zero odds-provider credits and can
// run as often as you like.
//
// Why this function exists: nfl-odds-sync writes the spread/total/moneyline
// LINES into nfl_games, but it only guesses each game's status from time
// elapsed since kickoff (see statusForKickoff in nfl-odds-sync) -- it never
// checks a real score. Nothing was actually settling "NFL Game Lines" bets
// (bet type 'nfl': spread, total, moneyline wagers on real NFL games). This
// function closes that gap using the same free ESPN scoreboard endpoint
// nfl-props-grade already uses for player props, just reading each game's
// real final score instead of a full box score.
//
// What it does on every run:
//   1. Finds every open bet of type 'nfl'.
//   2. Matches each one to its nfl_games row by (week, home team, away team)
//      -- an exact string match, since bet.team_a/team_b were captured
//      directly off that same nfl_games row's home_team/away_team at bet
//      placement time.
//   3. Resolves ESPN's own event id for that game the same way
//      nfl-props-grade does (a one-time lookup per game by kickoff date +
//      team nickname, cached onto nfl_games.espn_event_id -- shared with
//      nfl-props-grade, whichever function runs first for a game does the
//      lookup and the other reuses it), then reads that event's real status
//      and final score straight off ESPN's scoreboard response. No separate
//      box-score call needed for this -- the score is right there per
//      competitor on the scoreboard itself.
//   4. For games ESPN calls STATUS_FINAL, settles the bet by checking the
//      real score against the bet's market (spread / moneyline / total) and
//      stored line, pays out winners via catpoints_ledger, same convention
//      as gradeBets() in espn-sync and the grading in nfl-props-grade.
//   5. Anything it can't confidently resolve (game not found, score missing
//      even though ESPN says final, an unrecognized market) gets
//      needs_review = true instead of a guess.
//   6. Logs one row to sync_log every run.
//
// Caveat: ESPN's site API is real but unofficial and undocumented, same
// caveat as nfl-props-grade -- the scoreboard shape below
// (competitions[0].competitors[].score / .homeAway, status.type.name) is
// based on how it's long been observed to work, not a guarantee. The first
// real test is whichever game finishes first after this is deployed --
// check `select * from sync_log order by ran_at desc limit 10;` after a
// Sunday/Monday slate wraps to see real grading results, and check
// needs_review counts for anything that isn't matching correctly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Turns "Kansas City Chiefs" -> "chiefs", same helper as nfl-props-grade, so
// this can be matched against whatever form ESPN's scoreboard uses.
function teamNickname(fullName: string): string {
  const words = (fullName || "").trim().split(/\s+/);
  return (words[words.length - 1] || "").toLowerCase();
}

function fmt1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

type EspnResult = { status: string; homeScore: number; awayScore: number };

// Resolves a game to ESPN's real status + final score by kickoff date + team
// name. Caches the resolved espn_event_id onto nfl_games so a game only
// needs this lookup once, ever, shared with nfl-props-grade.
async function fetchEspnResult(supabase: any, game: any): Promise<EspnResult | null> {
  const homeNick = teamNickname(game.home_team);
  const awayNick = teamNickname(game.away_team);

  const kickoff = new Date(game.kickoff);
  const dateStr = `${kickoff.getUTCFullYear()}${String(kickoff.getUTCMonth() + 1).padStart(2, "0")}${
    String(kickoff.getUTCDate()).padStart(2, "0")
  }`;
  const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dateStr}`);
  if (!resp.ok) throw new Error(`ESPN scoreboard ${resp.status}`);
  const board = await resp.json();
  const events: any[] = board.events ?? [];

  let event = game.espn_event_id ? events.find((ev: any) => ev.id === game.espn_event_id) : null;
  if (!event) {
    event = events.find((ev: any) => {
      const names = (ev.competitions?.[0]?.competitors ?? []).map((c: any) =>
        (c.team?.displayName || c.team?.name || "").toLowerCase()
      );
      return names.some((n: string) => n.includes(homeNick)) && names.some((n: string) => n.includes(awayNick));
    });
    if (event) await supabase.from("nfl_games").update({ espn_event_id: event.id }).eq("id", game.id);
  }
  if (!event) return null;

  const status: string = event.status?.type?.name ?? "STATUS_SCHEDULED";
  const competitors: any[] = event.competitions?.[0]?.competitors ?? [];
  const homeC = competitors.find((c: any) => c.homeAway === "home");
  const awayC = competitors.find((c: any) => c.homeAway === "away");
  const homeScore = homeC?.score != null ? Number(homeC.score) : NaN;
  const awayScore = awayC?.score != null ? Number(awayC.score) : NaN;
  return { status, homeScore, awayScore };
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
    const { data: openBets, error: betsErr } = await supabase
      .from("bets")
      .select("*")
      .eq("type", "nfl")
      .eq("status", "open");
    if (betsErr) throw betsErr;
    if (!openBets || !openBets.length) {
      const detail = "No open nfl (game line) bets to grade.";
      await log(true, detail);
      return new Response(JSON.stringify({ ok: true, detail }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const weeks = [...new Set(openBets.map((b: any) => b.week))];
    const { data: gameRows } = await supabase.from("nfl_games").select("*").in("week", weeks);
    const gameByTeamsWeek = new Map<string, any>();
    for (const g of gameRows ?? []) {
      gameByTeamsWeek.set(`${g.week}-${g.home_team}-${g.away_team}`, g);
      gameByTeamsWeek.set(`${g.week}-${g.away_team}-${g.home_team}`, g);
    }

    let graded = 0;
    let flagged = 0;
    let notYetFinal = 0;
    const skipped: string[] = [];
    const resultCache = new Map<string, EspnResult | null>();

    for (const bet of openBets) {
      const game = gameByTeamsWeek.get(`${bet.week}-${bet.team_a}-${bet.team_b}`);
      if (!game) {
        skipped.push(`${bet.id}: no nfl_games row for ${bet.team_a} vs ${bet.team_b} wk${bet.week}`);
        continue;
      }

      let result = resultCache.get(game.id);
      if (result === undefined) {
        try {
          result = await fetchEspnResult(supabase, game);
        } catch (e) {
          result = null;
          skipped.push(`score for ${game.away_team} @ ${game.home_team}: ${e instanceof Error ? e.message : String(e)}`);
        }
        resultCache.set(game.id, result ?? null);
      }
      if (!result || result.status !== "STATUS_FINAL") {
        notYetFinal++;
        continue;
      }
      if (!Number.isFinite(result.homeScore) || !Number.isFinite(result.awayScore)) {
        await supabase.from("bets").update({ needs_review: true }).eq("id", bet.id).eq("status", "open");
        flagged++;
        continue;
      }

      const isHome = bet.team_a === game.home_team;
      const backScore = isHome ? result.homeScore : result.awayScore;
      const oppScore = isHome ? result.awayScore : result.homeScore;
      const market = String(bet.market || "");
      let outcome: "win" | "loss" | "push" | null = null;

      if (market === "spread") {
        const threshold = Number(bet.threshold) || 0;
        const adjusted = backScore + threshold - oppScore;
        outcome = adjusted > 0 ? "win" : adjusted === 0 ? "push" : "loss";
      } else if (market === "moneyline") {
        outcome = backScore > oppScore ? "win" : backScore === oppScore ? "push" : "loss";
      } else if (market === "total_over" || market === "total_under") {
        const threshold = Number(bet.threshold);
        if (!Number.isFinite(threshold)) {
          await supabase.from("bets").update({ needs_review: true }).eq("id", bet.id).eq("status", "open");
          flagged++;
          continue;
        }
        const combined = result.homeScore + result.awayScore;
        outcome = combined === threshold ? "push" : (market === "total_over" ? combined > threshold : combined < threshold) ? "win" : "loss";
      } else {
        await supabase.from("bets").update({ needs_review: true }).eq("id", bet.id).eq("status", "open");
        flagged++;
        continue;
      }

      const stake = Number(bet.stake) || 0;
      const payout = outcome === "win" ? Number(bet.potential_payout ?? stake) : stake; // push refunds the stake
      const winnerTeamId = outcome === "win" ? bet.placed_by : null;

      // A human-readable "how close was it" note, shown next to a loss in
      // the UI instead of a bare "Lost" (see index.html's bet-ledger-margin-note).
      // Only meaningful on a loss -- a win or push doesn't need a margin.
      let settleDetail: string | null = null;
      if (outcome === "loss") {
        const threshold = Number(bet.threshold) || 0;
        const combined = result.homeScore + result.awayScore;
        if (market === "spread") settleDetail = `missed the cover by ${fmt1(Math.abs(backScore + threshold - oppScore))}`;
        else if (market === "moneyline") settleDetail = `lost by ${fmt1(oppScore - backScore)}`;
        else if (market === "total_over") settleDetail = `missed by ${fmt1(threshold - combined)}`;
        else if (market === "total_under") settleDetail = `went over by ${fmt1(combined - threshold)}`;
      }

      // Guard against a race with a manual settle (admin panel) by only
      // updating rows still 'open'.
      const { data: updated } = await supabase
        .from("bets")
        .update({
          status: "settled", result: outcome, winner_team_id: winnerTeamId,
          settled_by: "system", settled_at: new Date().toISOString(), settle_detail: settleDetail,
        })
        .eq("id", bet.id).eq("status", "open")
        .select("id");
      if (!updated || !updated.length) continue; // raced with a manual settle -- skip

      if ((outcome === "win" || outcome === "push") && bet.placed_by) {
        await supabase.from("catpoints_ledger").insert({
          team_id: bet.placed_by, delta: payout,
          reason: outcome === "win" ? "bet_win" : "bet_push",
          bet_id: bet.id, note: `${bet.summary} settled: ${outcome} (final ${result.awayScore}-${result.homeScore})`,
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
});
