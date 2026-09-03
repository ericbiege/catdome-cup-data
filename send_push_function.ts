// Catdome Cup -- send a Web Push notification to one team, or to every
// subscribed team at once.
//
// Deploy like every other function here: Edge Functions -> Deploy a new
// function -> Via Editor, name it exactly "send-push", paste this in,
// Deploy.
//
// Needs push_subscriptions_schema.sql run first, and TWO new secrets added
// under Edge Functions -> Secrets before this can send anything real:
//   VAPID_PUBLIC_KEY   BHDN4NrAieJhJFrwPpvfm5qYOTvaaAxHSTRlrdXJI6N8Rq10fTK5HSmP4jQFH8AAwR-zcbEXnPsamURt1RDt0k0
//   VAPID_PRIVATE_KEY  (given to you separately in chat -- never put this one in a file or a repo)
// The public half is also baked into index.html's client-side subscribe
// call, so the two have to be this exact matching pair -- don't regenerate
// one without the other.
//
// Called two ways:
//   1. Directly from the browser (supabaseClient.functions.invoke('send-push', ...))
//      right after an H2H challenge is sent -- this is the only trigger
//      wired up so far. See placeSlip() in index.html.
//   2. Not yet wired from anywhere else. A bet settling (nfl-lines-grade,
//      nfl-props-grade) and a weekly recap posting (weekly-recap-post) are
//      obvious next candidates -- each would just need a small inlined
//      "send a push after settling/posting" step added to that function,
//      the same way this one calls webpush.sendNotification directly rather
//      than hopping through another function call.
//
// Body: { teamId: string | 'all', title: string, body?: string, url?: string, tag?: string }
// A subscription the push service reports as dead (404/410 -- uninstalled,
// permission revoked, browser data cleared) gets deleted right here, so
// push_subscriptions stays self-cleaning without a separate prune job.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const supabase = createClient(supabaseUrl, serviceKey);

  const log = async (ok: boolean, detail: string) => {
    try {
      await supabase.from("sync_log").insert({ ok, detail });
    } catch {
      // nothing more we can do if logging itself fails
    }
  };

  if (!vapidPublic || !vapidPrivate) {
    const detail = "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets aren't set yet.";
    await log(false, detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  webpush.setVapidDetails("mailto:eric@ericbiege.com", vapidPublic, vapidPrivate);

  try {
    const payload = await req.json().catch(() => ({}));
    const { teamId, title, body, url, tag } = payload ?? {};
    if (!teamId || !title) {
      return new Response(JSON.stringify({ ok: false, error: "teamId and title are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let query = supabase.from("push_subscriptions").select("*");
    if (teamId !== "all") query = query.eq("team_id", teamId);
    const { data: subs, error } = await query;
    if (error) throw error;

    if (!subs || !subs.length) {
      const detail = `No push subscriptions for ${teamId}.`;
      await log(true, detail);
      return new Response(JSON.stringify({ ok: true, detail }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const message = JSON.stringify({ title, body: body || "", url: url || "/", tag });
    let sent = 0, failed = 0, removedDead = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message,
        );
        sent++;
      } catch (e) {
        failed++;
        const status = (e as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          removedDead++;
        }
        // any other error (a transient network blip, etc.) -- leave the
        // subscription in place and just skip this one send
      }
    }

    const detail = `teamId=${teamId} subs=${subs.length} sent=${sent} failed=${failed} removed_dead=${removedDead}`;
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