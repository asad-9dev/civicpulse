import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getMailer, orderForDigest, sendDigestEmail } from "@/lib/email";
import { getMeetings } from "@/lib/meetings";
import { siteUrl } from "@/lib/site";
import { getSupabaseAdmin } from "@/lib/supabase";
import { oneClickUnsubscribeUrl, unsubscribeToken, unsubscribeUrl } from "@/lib/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds; the most Vercel's Hobby plan allows

/** Only meetings this recent are emailed, so a backfill of old agendas never blasts old news. */
const WINDOW_DAYS = 45;
/** Stop sending a little before the function's time limit so the run can still record what it did. */
const SEND_BUDGET_MS = 50_000;
const TABLE_MISSING = new Set(["42P01", "PGRST205"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** r***@example.com: enough to spot a pattern in logs without storing addresses there. */
function mask(email: string): string {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}

/**
 * Emails every subscriber one digest of recent meetings that haven't been emailed yet.
 *
 * Runs daily from Vercel Cron (vercel.json), which sends `Authorization: Bearer $CRON_SECRET`;
 * it can also be triggered by hand with the same header. Most days there's nothing new and it
 * sends nothing. Which meetings have gone out is tracked in the digest_log table
 * (backend/schema.sql); meetings are claimed there before sending, so overlapping runs can't
 * double-send.
 *
 *   ?dryRun=1              report what would be sent; sends and records nothing
 *   ?previewTo=you@x.com   send the digest to that one address only; records nothing
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error("[digest] CRON_SECRET is not set; refusing to run");
    return NextResponse.json({ error: "Digest isn't configured." }, { status: 503 });
  }
  if (!authorized(request, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const dryRun = params.get("dryRun") === "1";
  const previewTo = params.get("previewTo")?.trim().toLowerCase() || null;
  if (previewTo && !EMAIL_PATTERN.test(previewTo)) {
    return NextResponse.json({ error: "previewTo must be an email address" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  if ("problem" in supabase) {
    console.error(`[digest] Supabase is misconfigured: ${supabase.problem}`);
    return NextResponse.json({ error: "Supabase isn't configured." }, { status: 503 });
  }
  const db = supabase.client;

  let claimedIds: string[] = [];
  let sent = 0;
  try {
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const recent = (await getMeetings()).filter((m) => m.meetingDate >= cutoff);
    if (recent.length === 0) return NextResponse.json({ status: "nothing-new", reason: `no meetings in the last ${WINDOW_DAYS} days` });

    const { data: logged, error: logError } = await db.from("digest_log").select("meeting_id").in("meeting_id", recent.map((m) => m.id));
    if (logError) {
      if (TABLE_MISSING.has(logError.code)) {
        console.error("[digest] The digest_log table doesn't exist yet. Run backend/schema.sql in the Supabase SQL Editor.");
        return NextResponse.json({ error: "digest_log table missing" }, { status: 503 });
      }
      throw logError;
    }
    const alreadySent = new Set((logged ?? []).map((row) => row.meeting_id as string));
    const fresh = orderForDigest(recent.filter((m) => !alreadySent.has(m.id)));
    if (fresh.length === 0) return NextResponse.json({ status: "nothing-new", reason: "every recent meeting was already emailed" });

    const site = siteUrl(request);

    if (dryRun) {
      const { count } = await db.from("subscribers").select("id", { count: "exact", head: true });
      return NextResponse.json({ status: "dry-run", meetings: fresh.map((m) => m.id), subscribers: count ?? 0 });
    }

    const mailer = getMailer({ pool: true });
    if ("problem" in mailer) {
      console.error(`[digest] Email isn't configured: ${mailer.problem}`);
      return NextResponse.json({ error: "Email isn't configured." }, { status: 503 });
    }

    if (previewTo) {
      // id 0 matches no subscriber, so the preview's unsubscribe link changes nothing.
      const token = unsubscribeToken(0, previewTo)!;
      const result = await sendDigestEmail(mailer, fresh, {
        to: previewTo,
        siteUrl: site,
        unsubscribePageUrl: unsubscribeUrl(site, 0, token),
        oneClickUnsubscribeUrl: oneClickUnsubscribeUrl(site, 0, token),
      });
      mailer.transport.close();
      if (!result.sent) console.error(`[digest] Preview to ${mask(previewTo)} failed: ${result.reason}`);
      return NextResponse.json({ status: result.sent ? "preview-sent" : "preview-failed", meetings: fresh.map((m) => m.id) });
    }

    // Claim the meetings first: a second, overlapping run gets nothing back here and stops.
    const { data: claimed, error: claimError } = await db
      .from("digest_log")
      .upsert(fresh.map((m) => ({ meeting_id: m.id })), { onConflict: "meeting_id", ignoreDuplicates: true })
      .select("meeting_id");
    if (claimError) throw claimError;
    claimedIds = (claimed ?? []).map((row) => row.meeting_id as string);
    const meetings = fresh.filter((m) => claimedIds.includes(m.id));
    if (meetings.length === 0) return NextResponse.json({ status: "nothing-new", reason: "another run is already sending these" });

    const subscribers: { id: number; email: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("subscribers").select("id, email").order("id").range(from, from + 999);
      if (error) throw error;
      subscribers.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }

    const started = Date.now();
    let failed = 0;
    let skipped = 0;
    for (const subscriber of subscribers) {
      if (Date.now() - started > SEND_BUDGET_MS) {
        skipped = subscribers.length - sent - failed;
        console.error(`[digest] Out of time: ${skipped} subscriber(s) not emailed this run`);
        break;
      }
      const token = unsubscribeToken(subscriber.id, subscriber.email);
      if (!token) {
        failed++;
        continue;
      }
      const result = await sendDigestEmail(mailer, meetings, {
        to: subscriber.email,
        siteUrl: site,
        unsubscribePageUrl: unsubscribeUrl(site, subscriber.id, token),
        oneClickUnsubscribeUrl: oneClickUnsubscribeUrl(site, subscriber.id, token),
      });
      if (result.sent) sent++;
      else {
        failed++;
        console.error(`[digest] Send to ${mask(subscriber.email)} failed: ${result.reason}`);
      }
    }
    mailer.transport.close();

    // Nothing got through (e.g. the mail server rejected the login): release the claim so the
    // next run retries instead of silently skipping these meetings forever.
    if (subscribers.length > 0 && sent === 0) {
      await db.from("digest_log").delete().in("meeting_id", claimedIds);
      return NextResponse.json({ status: "failed", meetings: claimedIds, failures: failed }, { status: 500 });
    }

    await db
      .from("digest_log")
      .update({ sent_at: new Date().toISOString(), recipients: sent, failures: failed + skipped })
      .in("meeting_id", claimedIds);
    console.log(`[digest] Sent ${meetings.length} meeting(s) to ${sent} subscriber(s); ${failed} failed, ${skipped} skipped`);
    return NextResponse.json({ status: "sent", meetings: claimedIds, recipients: sent, failures: failed, skipped });
  } catch (error) {
    console.error("[digest] Run failed:", error);
    if (claimedIds.length > 0 && sent === 0) {
      await db.from("digest_log").delete().in("meeting_id", claimedIds);
    }
    return NextResponse.json({ status: "failed" }, { status: 500 });
  }
}

export const GET = handle; // Vercel Cron calls with GET
export const POST = handle;
