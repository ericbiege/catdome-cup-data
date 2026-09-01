// Catdome Cup — ESPN sync Edge Function
//
// Deploy this in Supabase: Edge Functions -> Deploy a new function -> Via Editor,
// name it "espn-sync", paste this in, Deploy.
//
// What it does on every run:
//   1. Reads your ESPN_S2 / ESPN_SWID secrets and the team_espn_map table.
//   2. Calls ESPN's (unofficial, but widely used) fantasy football API for your
//      league.
//   3. Writes standings, rosters, and weekly matchups into Supabase, skipping
//      any ESPN team not present in team_espn_map (Team Saxon, on purpose).
//   4. Calls ESPN's separate "recent activity" feed for waiver adds and
//      trades and upserts them into espn_transactions (see
//      fetchRecentTransactions below) -- used to auto-grade Trade Deadline
//      Chaos bets, since there's no other way to know a real trade happened.
//   5. Grades every open bet it can (see gradeBets below) using the data just
//      synced, and pays out Catpoints automatically.
//   6. Logs one row to sync_log every run, success or failure, so you can see
//      in the SQL Editor whether the scheduled job is actually working:
//        select * from sync_log order by ran_at desc limit 5;
//
// Before step 4 can write anything you need espn_transactions_schema.sql run
// in the SQL Editor (creates the espn_transactions table).
//
// This talks to ESPN's endpoints, which aren't officially documented or
// supported by ESPN -- the same ones the community's fantasy tools use, but
// the exact shape of some fields (especially roster stats, and the
// transactions feed in particular) was built from documentation and a
// widely-used open-source API wrapper rather than a live test against your
// league, since this environment can't reach ESPN's servers directly. The
// first few real runs are the real test -- if sync_log shows errors, a bet
// settles wrong, or something looks off on the site, send me what sync_log
// (and espn_transactions, for a trade bet) says and I'll adjust.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Your league. Not sensitive -- fine to hardcode.
const LEAGUE_ID = 1730449;

// ESPN's internal numeric codes for player position and roster slot.
// Community-documented, stable across seasons.
const POSITION_MAP: Record<number, string> = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE",
  7: "OP", 8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S",
  14: "DB", 15: "DP", 16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BENCH",
  21: "IR", 23: "FLEX",
};

const SLOT_MAP: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K",
  20: "BENCH", 21: "IR", 23: "FLEX", 24: "IR",
};

// ---- Catpoints bet grading -------------------------------------------------
// Runs after every sync. Only grades the NEW staked/structured bets (the ones
// placed through the Catdome Sportsbook bet slip -- they have `stake` and
// `week` set); the 8 legacy peer-challenge bets from before the sportsbook
// rework have stake=null and are simply never touched here.
//
// Grading convention: `team_a` on a bet is always "Your Team" from the builder
// form (the bettor's own team), and `placed_by` is the wallet that gets
// credited or debited. For weekly/bench bets team_a IS the bettor's team, so
// those are the same team either way -- but futures bets (graded manually,
// not here) can have team_a be a DIFFERENT team than the bettor, so this
// function always pays out to `placed_by`, never assumes team_a.
//
// Markets handled automatically: weekly (over/under/straight/margin), bench
// (fewer bench points wins), prop (higher actual fantasy points wins, by
// matching the free-typed player name against that week's synced roster row),
// shootout and streak (higher of the two teams' own weekly fantasy score
// wins -- same synced weekly_matchups row used for "weekly", just comparing
// two teams that may not have actually played each other), duel and waiver
// (same free-typed-name-vs-roster matching as prop), and trade (yes/no on
// whether a trade between two specific teams happened by a deadline week,
// using the espn_transactions table populated by fetchRecentTransactions()
// below -- unverified against a real trade as of this writing; see the
// comment on that function). Parlay and futures stay manual -- settle those
// from the Sportsbook admin panel; they don't have a single-event trigger to
// hook auto-grading onto.
async function gradeBets(
  supabase: any,
  year: number,
  currentWeek: number,
  transactionRows: any[],
): Promise<{ graded: number; flagged: number }> {
  const { data: openBets, error: betsErr } = await supabase
    .from("bets")
    .select("*")
    .eq("status", "open")
    .not("stake", "is", null)
    .not("week", "is", null);
  if (betsErr) throw betsErr;
  if (!openBets || !openBets.length) return { graded: 0, flagged: 0 };

  const { data: matchups } = await supabase.from("weekly_matchups").select("*").eq("year", year);
  const { data: rosterRows } = await supabase.from("rosters").select("*").eq("year", year);

  const matchupByKey = new Map<string, any>();
  for (const m of matchups ?? []) matchupByKey.set(`${m.team_id}-${m.week}`, m);

  const rosterByTeamWeek = new Map<string, any[]>();
  const rosterByPlayerWeek = new Map<string, any>();
  for (const r of rosterRows ?? []) {
    const teamKey = `${r.team_id}-${r.week}`;
    if (!rosterByTeamWeek.has(teamKey)) rosterByTeamWeek.set(teamKey, []);
    rosterByTeamWeek.get(teamKey)!.push(r);

    const playerKey = `${(r.player_name || "").toLowerCase()}-${r.week}`;
    if (!rosterByPlayerWeek.has(playerKey)) rosterByPlayerWeek.set(playerKey, r);
  }

  let graded = 0;
  let flagged = 0;

  for (const bet of openBets) {
    let outcome: "win" | "loss" | "push" | null = null;
    let flagForReview = false;

    if (bet.type === "weekly") {
      const m = matchupByKey.get(`${bet.team_a}-${bet.week}`);
      if (!m || m.status !== "STATUS_FINAL" || m.team_score == null || m.opponent_score == null) continue;
      const a = Number(m.team_score), b = Number(m.opponent_score);
      const combined = a + b, margin = a - b, threshold = Number(bet.threshold ?? 0);
      if (bet.market === "over") outcome = combined > threshold ? "win" : combined === threshold ? "push" : "loss";
      else if (bet.market === "under") outcome = combined < threshold ? "win" : combined === threshold ? "push" : "loss";
      else if (bet.market === "straight") outcome = a > b ? "win" : a === b ? "push" : "loss";
      else if (bet.market === "margin") outcome = margin > threshold ? "win" : "loss";
      else flagForReview = true;
    } else if (bet.type === "bench") {
      const aRows = rosterByTeamWeek.get(`${bet.team_a}-${bet.week}`) ?? [];
      const bRows = rosterByTeamWeek.get(`${bet.team_b}-${bet.week}`) ?? [];
      const isFinal = (teamId: string) => matchupByKey.get(`${teamId}-${bet.week}`)?.status === "STATUS_FINAL";
      if (!isFinal(bet.team_a) || !isFinal(bet.team_b)) continue;
      const benchSum = (rows: any[]) =>
        rows.filter((r) => r.lineup_slot === "BENCH").reduce((s, r) => s + (Number(r.actual_points) || 0), 0);
      const aBench = benchSum(aRows), bBench = benchSum(bRows);
      // team_a (the bettor's team) wins by leaving FEWER points stranded on the bench.
      outcome = aBench < bBench ? "win" : aBench === bBench ? "push" : "loss";
    } else if (bet.type === "prop" || bet.type === "duel" || bet.type === "waiver") {
      // Outscore Their Guy / Position Duel / Waiver Wire Wizard: two
      // free-typed player names, higher actual fantasy points that week wins.
      // Identical mechanics for all three -- they only differ in the UI copy
      // around them.
      const weekIsFinal = matchupByKey.get(`${bet.team_a}-${bet.week}`)?.status === "STATUS_FINAL";
      const aRow = rosterByPlayerWeek.get(`${(bet.player_a || "").toLowerCase()}-${bet.week}`);
      const bRow = rosterByPlayerWeek.get(`${(bet.player_b || "").toLowerCase()}-${bet.week}`);
      if (!aRow || !bRow || aRow.actual_points == null || bRow.actual_points == null) {
        // No match yet (or the week isn't final) -- try again next sync. Only flag it
        // for your manual attention once the week's fully over and we STILL can't find
        // both players, since that usually means the typed name didn't match the
        // synced roster exactly.
        if (weekIsFinal && !bet.needs_review) flagForReview = true;
        else continue;
      } else {
        outcome = Number(aRow.actual_points) > Number(bRow.actual_points) ? "win"
          : Number(aRow.actual_points) === Number(bRow.actual_points) ? "push" : "loss";
      }
    } else if (bet.type === "shootout" || bet.type === "streak") {
      // Full Slate Shootout / Streak Survivor: each team's OWN weekly fantasy
      // score (their real ESPN matchup score that week, regardless of who
      // they actually played) -- higher score wins. Streak Survivor's
      // "run it back, double or nothing" continuation is just a new bet row
      // for the next week, so this same branch handles every leg.
      const aM = matchupByKey.get(`${bet.team_a}-${bet.week}`);
      const bM = matchupByKey.get(`${bet.team_b}-${bet.week}`);
      if (
        !aM || !bM || aM.status !== "STATUS_FINAL" || bM.status !== "STATUS_FINAL" ||
        aM.team_score == null || bM.team_score == null
      ) continue;
      const aScore = Number(aM.team_score), bScore = Number(bM.team_score);
      outcome = aScore > bScore ? "win" : aScore === bScore ? "push" : "loss";
    } else if (bet.type === "trade") {
      // Trade Deadline Chaos: yes/no on whether a trade between team_a and
      // team_b happens by the deadline week (bet.week). Needs a real ESPN
      // trade to show up in transactionRows (see fetchRecentTransactions
      // below) -- that parsing hasn't been checked against a live trade yet,
      // so treat the first real trade of the season as the real test and
      // check espn_transactions if a settled trade bet looks wrong.
      const deadlineHasPassed = currentWeek > Number(bet.week);
      const tradeHappened = (transactionRows ?? []).some((t: any) =>
        t.action === "TRADED" &&
        ((t.from_team_id === bet.team_a && t.to_team_id === bet.team_b) ||
          (t.from_team_id === bet.team_b && t.to_team_id === bet.team_a))
      );
      if (bet.market !== "yes" && bet.market !== "no") {
        // Placed before the yes/no call was captured as structured data (an
        // older bet) -- there's nothing to grade against, so this always
        // needs a human once the deadline's passed.
        if (deadlineHasPassed && !bet.needs_review) flagForReview = true;
        else continue;
      } else if (tradeHappened) {
        outcome = bet.market === "yes" ? "win" : "loss";
      } else if (deadlineHasPassed) {
        outcome = bet.market === "no" ? "win" : "loss";
      } else {
        continue; // still waiting -- deadline hasn't passed and no trade seen yet
      }
    } else {
      continue; // parlay / futures -- settled manually via the admin panel
    }

    if (flagForReview) {
      await supabase.from("bets").update({ needs_review: true }).eq("id", bet.id);
      flagged++;
      continue;
    }
    if (!outcome) continue;

    const stake = Number(bet.stake) || 0;
    const payout = outcome === "win" ? Number(bet.potential_payout ?? stake) : stake; // push refunds the stake
    const winnerTeamId = outcome === "loss" ? bet.team_b : outcome === "win" ? bet.team_a : null;
    const walletTeamId = bet.placed_by || bet.team_a;

    // Guard against a race with a manual settle (admin panel) by only updating rows
    // still 'open'.
    const { data: updated, error: updateErr } = await supabase
      .from("bets")
      .update({ status: "settled", result: outcome, winner_team_id: winnerTeamId, settled_by: "system", settled_at: new Date().toISOString() })
      .eq("id", bet.id)
      .eq("status", "open")
      .select("id");
    if (updateErr || !updated || !updated.length) continue;

    if ((outcome === "win" || outcome === "push") && walletTeamId) {
      await supabase.from("catpoints_ledger").insert({
        team_id: walletTeamId,
        delta: payout,
        reason: outcome === "win" ? "bet_win" : "bet_push",
        bet_id: bet.id,
        note: `${bet.type} bet settled: ${outcome}`,
      });
    }
    // On a loss, the stake was already debited at placement -- nothing more to do.

    graded++;
  }

  return { graded, flagged };
}

// ---- ESPN transaction feed (waiver adds / trades) --------------------------
// This is a second, separate call to ESPN's (also unofficial) league
// "communication" feed -- the same one every third-party ESPN fantasy tool
// uses for "recent activity" -- filtered to just the transaction message
// types. It's used today only to grade "trade" bets (there's no other way to
// know a real trade happened between two specific teams), and isn't yet
// checked against a live response: the message shapes below (msg.from /
// msg.to / msg.for / msg.targetId per messageTypeId) come from a
// widely-used, actively-maintained open-source ESPN API wrapper
// (cwendt94/espn-api on GitHub), not a live test against this league, since
// this environment can't reach ESPN directly. The first real waiver
// Wednesday or approved trade of the season is the real test -- check
// `select * from espn_transactions order by occurred_at desc limit 20;`
// afterward and adjust the parsing here if a row looks wrong or missing.
//
// messageTypeId meanings (community-documented, stable across seasons):
//   178 = free agent add (no waiver bid)      179/181/239 = dropped
//   180 = waiver-claim add (msg.from is the winning bid amount, not a team)
//   244 = traded (msg.from = sending team, msg.to = receiving team; a
//         multi-player trade sends one message per player moved)
const TRANSACTION_MESSAGE_TYPE_IDS = [178, 179, 180, 181, 239, 244];

type TransactionRow = {
  id: string;
  messageTypeId: number;
  action: "FA_ADDED" | "WAIVER_ADDED" | "DROPPED" | "TRADED";
  fromEspnTeamId: number | null;
  toEspnTeamId: number | null;
  targetPlayerId: number | null;
  occurredAt: string;
};

async function fetchRecentTransactions(
  espnS2: string,
  espnSwid: string,
  year: number,
): Promise<any[]> {
  const filters = {
    topics: {
      filterType: { value: ["ACTIVITY_TRANSACTIONS"] },
      limit: 200,
      limitPerMessageSet: { value: 50 },
      offset: 0,
      sortMessageDate: { sortPriority: 1, sortAsc: false },
      sortFor: { sortPriority: 2, sortAsc: false },
      filterIncludeMessageTypeIds: { value: TRANSACTION_MESSAGE_TYPE_IDS },
    },
  };
  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${LEAGUE_ID}` +
    `/communication/?view=kona_league_communication`;
  const resp = await fetch(url, {
    headers: {
      Cookie: `espn_s2=${espnS2}; SWID=${espnSwid}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "x-fantasy-filter": JSON.stringify(filters),
    },
  });
  const rawBody = await resp.text();
  if (!resp.ok) throw new Error(`ESPN transactions request failed: ${resp.status} ${rawBody.slice(0, 300)}`);
  let data: any;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`ESPN transactions returned non-JSON (status ${resp.status}): ${rawBody.slice(0, 300)}`);
  }
  return data?.topics ?? [];
}

function parseTransactionTopics(topics: any[]): TransactionRow[] {
  const rows: TransactionRow[] = [];
  for (const topic of topics ?? []) {
    const dateMs = topic.date;
    const occurredAt = new Date(dateMs).toISOString();
    for (const msg of topic.messages ?? []) {
      const msgId = msg.messageTypeId;
      if (!TRANSACTION_MESSAGE_TYPE_IDS.includes(msgId)) continue;
      if (msgId === 244) {
        rows.push({
          id: `${dateMs}-244-${msg.targetId}-${msg.from}-${msg.to}`,
          messageTypeId: 244,
          action: "TRADED",
          fromEspnTeamId: msg.from ?? null,
          toEspnTeamId: msg.to ?? null,
          targetPlayerId: msg.targetId ?? null,
          occurredAt,
        });
      } else {
        const toEspnTeamId = msgId === 239 ? (msg.for ?? null) : (msg.to ?? null);
        const action = msgId === 180 ? "WAIVER_ADDED" : msgId === 178 ? "FA_ADDED" : "DROPPED";
        rows.push({
          id: `${dateMs}-${msgId}-${msg.targetId}-${toEspnTeamId}`,
          messageTypeId: msgId,
          action,
          fromEspnTeamId: null,
          toEspnTeamId,
          targetPlayerId: msg.targetId ?? null,
          occurredAt,
        });
      }
    }
  }
  return rows;
}

function currentSeasonYear(): number {
  const now = new Date();
  const month = now.getUTCMonth() + 1; // 1-12
  // Fantasy seasons are named for the year they start (September). January
  // and February still belong to the season that started the previous fall.
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

// ---- team logo hotlink resolution ------------------------------------------
// Most managers' logos come back from ESPN as a plain public image URL (the
// default-logo CDN at g.espncdn.com, or wherever they hosted a custom one) --
// those hotlink fine straight into an <img src>. A manager who uploaded a
// custom logo through ESPN's newer app flow instead gets a URL on
// mystique-api.fantasy.espn.com, which is a *private* API that needs the same
// ESPN_S2/SWID auth this function uses to talk to ESPN at all -- a bare <img>
// tag on the site has no way to send that cookie, so it just fails to load
// (the site's onerror fallback quietly shows the team's monogram instead,
// which is correct behavior but not what anyone wants for a team that DOES
// have a real logo). Fix: fetch the image here, where we do have the auth
// cookie, and re-host the bytes in the public `team-logos` Storage bucket, so
// the site links to a URL that doesn't need ESPN auth at all.
const PRIVATE_ESPN_LOGO_HOST = "mystique-api.fantasy.espn.com";
async function resolveLogoUrl(
  supabase: any,
  teamId: string,
  rawUrl: string,
  cookie: string,
  alreadyResolved: string | null,
): Promise<{ url: string | null; error?: string }> {
  let host: string;
  try {
    host = new URL(rawUrl).host;
  } catch {
    return { url: rawUrl }; // not a valid URL -- store as-is, matches prior behavior
  }
  if (host !== PRIVATE_ESPN_LOGO_HOST) return { url: rawUrl }; // already publicly hotlinkable

  // Already re-hosted this exact team's logo in a previous run -- don't
  // re-fetch/re-upload the same bytes on every 15-minute sync.
  if (alreadyResolved && alreadyResolved.includes("/storage/v1/object/public/team-logos/")) {
    return { url: alreadyResolved };
  }

  const imgResp = await fetch(rawUrl, {
    headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!imgResp.ok) return { url: null, error: `fetch ${imgResp.status}` };
  const contentType = imgResp.headers.get("content-type") || "image/png";
  const ext = contentType.includes("svg") ? "svg" : contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
  const bytes = new Uint8Array(await imgResp.arrayBuffer());
  const path = `${teamId}.${ext}`;
  const { error: uploadErr } = await supabase.storage.from("team-logos").upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (uploadErr) return { url: null, error: `upload: ${uploadErr.message}` };
  const { data: pub } = supabase.storage.from("team-logos").getPublicUrl(path);
  if (!pub?.publicUrl) return { url: null, error: "no public URL returned" };
  return { url: pub.publicUrl };
}

Deno.serve(async (_req) => {
  // These three are provided automatically by Supabase -- no setup needed.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // These two you added yourself under Edge Functions -> Secrets.
  const espnS2 = Deno.env.get("ESPN_S2");
  const espnSwid = Deno.env.get("ESPN_SWID");

  const supabase = createClient(supabaseUrl, serviceKey);

  const log = async (ok: boolean, detail: string) => {
    try {
      await supabase.from("sync_log").insert({ ok, detail });
    } catch {
      // If logging itself fails there's nothing more we can do here.
    }
  };

  try {
    if (!espnS2 || !espnSwid) {
      const msg = "Missing ESPN_S2 or ESPN_SWID secret -- add them under Edge Functions -> Secrets.";
      await log(false, msg);
      return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
    }

    const { data: teamMapRows, error: mapErr } = await supabase
      .from("team_espn_map")
      .select("team_id, espn_team_id, logo_url");
    if (mapErr) throw mapErr;
    if (!teamMapRows || teamMapRows.length === 0) {
      throw new Error("team_espn_map is empty -- run espn_sync_schema.sql's seed insert first.");
    }
    const espnToInternal = new Map<number, string>();
    const currentLogoUrl = new Map<string, string | null>();
    for (const row of teamMapRows) {
      espnToInternal.set(row.espn_team_id, row.team_id);
      currentLogoUrl.set(row.team_id, row.logo_url ?? null);
    }

    const year = currentSeasonYear();
    const url =
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${LEAGUE_ID}` +
      `?view=mMatchupScore&view=mTeam&view=mRoster&view=mStandings`;

    const resp = await fetch(url, {
      headers: {
        Cookie: `espn_s2=${espnS2}; SWID=${espnSwid}`,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const rawBody = await resp.text();
    if (!resp.ok) {
      throw new Error(`ESPN request failed: ${resp.status} ${rawBody.slice(0, 300)}`);
    }

    let data: any;
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new Error(`ESPN returned non-JSON (status ${resp.status}): ${rawBody.slice(0, 300)}`);
    }
    const currentWeek: number = data?.status?.currentMatchupPeriod ?? 1;

    let standingsWritten = 0;
    let rostersWritten = 0;
    let matchupsWritten = 0;
    let logosWritten = 0;
    const skipped: string[] = [];

    // ---- standings + rosters ----
    for (const team of data.teams ?? []) {
      const teamId = espnToInternal.get(team.id);
      if (!teamId) continue; // unmapped ESPN team (Saxon) -- intentionally skipped

      const record = team.record?.overall ?? {};
      const { error: standingsErr } = await supabase.from("standings").upsert({
        team_id: teamId,
        year,
        wins: record.wins ?? 0,
        losses: record.losses ?? 0,
        ties: record.ties ?? 0,
        points_for: record.pointsFor ?? 0,
        points_against: record.pointsAgainst ?? 0,
        rank: team.playoffSeed ?? team.rankCalculatedFinal ?? null,
        updated_at: new Date().toISOString(),
      });
      if (standingsErr) skipped.push(`standings ${teamId}: ${standingsErr.message}`);
      else standingsWritten++;

      // ESPN's mTeam view includes each manager's uploaded team logo as a
      // plain image URL on the team object -- stash it on team_espn_map so
      // the site can show real team logos (News feed avatars, etc.) instead
      // of generated monograms. team_espn_map itself is otherwise read-only
      // to regular clients (see espn_sync_schema.sql); this write goes
      // through fine because the sync runs with the service-role key.
      // A private (mystique-api) logo URL gets re-hosted first -- see
      // resolveLogoUrl above -- since it can't be hotlinked as-is.
      if (team.logo) {
        const { url: resolvedLogoUrl, error: resolveErr } = await resolveLogoUrl(
          supabase, teamId, team.logo, `espn_s2=${espnS2}; SWID=${espnSwid}`, currentLogoUrl.get(teamId) ?? null,
        );
        if (resolveErr) skipped.push(`logo ${teamId}: ${resolveErr}`);
        if (resolvedLogoUrl) {
          const { error: logoErr } = await supabase
            .from("team_espn_map")
            .update({ logo_url: resolvedLogoUrl })
            .eq("team_id", teamId);
          if (logoErr) skipped.push(`logo ${teamId}: ${logoErr.message}`);
          else logosWritten++;
        }
      }

      const entries = team.roster?.entries ?? [];
      for (const entry of entries) {
        try {
          const player = entry.playerPoolEntry?.player ?? entry.player;
          if (!player) continue;
          const stats = player.stats ?? [];
          const actualStat = stats.find(
            (s: any) => s.scoringPeriodId === currentWeek && s.statSourceId === 0,
          );
          const projectedStat = stats.find(
            (s: any) => s.scoringPeriodId === currentWeek && s.statSourceId === 1,
          );

          const { error: rosterErr } = await supabase.from("rosters").upsert({
            id: `${teamId}-${player.id}`,
            team_id: teamId,
            player_name: player.fullName ?? "Unknown",
            position: POSITION_MAP[player.defaultPositionId] ?? String(player.defaultPositionId ?? ""),
            lineup_slot: SLOT_MAP[entry.lineupSlotId] ?? String(entry.lineupSlotId ?? ""),
            week: currentWeek,
            year,
            projected_points: projectedStat?.appliedTotal ?? null,
            actual_points: actualStat?.appliedTotal ?? null,
            updated_at: new Date().toISOString(),
          });
          if (rosterErr) skipped.push(`roster ${teamId}-${player?.id}: ${rosterErr.message}`);
          else rostersWritten++;
        } catch (e) {
          skipped.push(`roster entry parse error (team ${teamId}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // ---- matchups ----
    // Same anchor as the site's own SEASON_WEEK1_START (site/index.html) and
    // the NFL odds sync function -- keep all three in sync if the season
    // start date ever changes.
    const SEASON_WEEK1_START = new Date("2026-09-09T00:00:00Z");
    const weekStartDate = (week: number) =>
      new Date(SEASON_WEEK1_START.getTime() + (week - 1) * 7 * 86400000);
    const now = new Date();

    for (const m of data.schedule ?? []) {
      const week = m.matchupPeriodId;
      const home = m.home;
      const away = m.away;
      if (!home) continue;

      // ESPN's `currentMatchupPeriod` points at week 1 as soon as the league
      // year exists -- even in the offseason, weeks before the real kickoff
      // date -- so "week === currentWeek with no winner yet" isn't proof a
      // game is actually being played. Only call it STATUS_IN_PROGRESS once
      // that week's real-world start date has actually arrived; otherwise
      // it's still just scheduled.
      const status =
        week < currentWeek
          ? "STATUS_FINAL"
          : week > currentWeek
          ? "STATUS_SCHEDULED"
          : m.winner && m.winner !== "UNDECIDED"
          ? "STATUS_FINAL"
          : now < weekStartDate(week)
          ? "STATUS_SCHEDULED"
          : "STATUS_IN_PROGRESS";

      const writeSide = async (side: any, otherSide: any) => {
        const teamId = espnToInternal.get(side.teamId);
        if (!teamId) return; // Saxon or otherwise unmapped -- skip
        const opponentTeamId = otherSide ? espnToInternal.get(otherSide.teamId) ?? null : null;
        const { error } = await supabase.from("weekly_matchups").upsert({
          id: `${year}-${week}-${teamId}`,
          year,
          week,
          team_id: teamId,
          opponent_team_id: opponentTeamId,
          team_score: side.totalPoints ?? null,
          opponent_score: otherSide?.totalPoints ?? null,
          status,
          updated_at: new Date().toISOString(),
        });
        if (error) skipped.push(`matchup ${teamId} wk${week}: ${error.message}`);
        else matchupsWritten++;
      };

      await writeSide(home, away);
      if (away) await writeSide(away, home);
    }

    // ---- transactions (waiver adds / trades) -- see fetchRecentTransactions ----
    // Non-fatal on its own: a hiccup here shouldn't take down standings/roster/
    // matchup syncing or the bet grading that depends on them, so it's caught
    // separately and just noted in `skipped`.
    let transactionsSynced = 0;
    let transactionRows: TransactionRow[] = [];
    try {
      const topics = await fetchRecentTransactions(espnS2, espnSwid, year);
      transactionRows = parseTransactionTopics(topics);
      if (transactionRows.length) {
        const txnUpsertRows = transactionRows.map((r) => ({
          id: r.id,
          year,
          message_type_id: r.messageTypeId,
          action: r.action,
          from_team_id: r.fromEspnTeamId != null ? espnToInternal.get(r.fromEspnTeamId) ?? null : null,
          to_team_id: r.toEspnTeamId != null ? espnToInternal.get(r.toEspnTeamId) ?? null : null,
          target_player_id: r.targetPlayerId,
          occurred_at: r.occurredAt,
        }));
        const { error: txnErr } = await supabase.from("espn_transactions").upsert(txnUpsertRows, { onConflict: "id" });
        if (txnErr) skipped.push(`transactions upsert: ${txnErr.message}`);
        else transactionsSynced = txnUpsertRows.length;
      }
    } catch (e) {
      skipped.push(`transactions fetch error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Trade grading needs the FULL season's trade history, not just this
    // run's freshly-fetched page (a trade from 3 weeks ago should still
    // count) -- so read back everything stored so far rather than relying
    // solely on transactionRows above.
    let allTransactionRows: any[] = transactionRows;
    try {
      const { data: storedTxns } = await supabase
        .from("espn_transactions")
        .select("action, from_team_id, to_team_id")
        .eq("year", year)
        .eq("action", "TRADED");
      if (storedTxns) allTransactionRows = storedTxns;
    } catch {
      // Fall back to just this run's rows if the read-back fails.
    }

    let betsGraded = 0;
    let betsFlagged = 0;
    try {
      const gradeResult = await gradeBets(supabase, year, currentWeek, allTransactionRows);
      betsGraded = gradeResult.graded;
      betsFlagged = gradeResult.flagged;
    } catch (e) {
      skipped.push(`bet grading error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const detail =
      `year=${year} week=${currentWeek} standings=${standingsWritten} rosters=${rostersWritten} matchups=${matchupsWritten} logos=${logosWritten}` +
      ` transactions_synced=${transactionsSynced} bets_graded=${betsGraded} bets_flagged=${betsFlagged}` +
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
