import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getBoard } from "@/lib/boards";
import { boardIds, type Db } from "@/lib/db/boards";
import { isSchemaMissing } from "@/lib/db/types";
import { getMailer, orderForDigest, sendDigestEmail } from "@/lib/email";
import { getMeetings } from "@/lib/meetings";
import { siteUrl } from "@/lib/site";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { Meeting } from "@/lib/types";
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
 * Claim meetings in digest_log before sending, tagged with the board they belong to.
 *
 * Retries without board_id when that column isn't there yet, so a deploy that lands before the
 * multi-board migration is applied still sends its digest instead of failing.
 */
async function claimMeetings(db: Db, meetings: Meeting[]): Promise<string[]> {
  const ids = await boardIds(db);
  const withBoard = meetings.map((m) => ({ meeting_id: m.id, board_id: ids.get(m.boardSlug) ?? null }));

  for (const rows of [withBoard, meetings.map((m) => ({ meeting_id: m.id }))]) {
    const { data, error } = await db
      .from("digest_log")
      .upsert(rows, { onConflict: "meeting_id", ignoreDuplicates: true })
      .select("meeting_id");
    if (!error) return (data ?? []).map((row) => row.meeting_id as string);
    if (!isSchemaMissing(error)) throw error;
    console.warn("[digest] digest_log has no board_id column yet; claiming without it");
  }
  return [];
}

/**
 * subscriber id -> the board ids that subscriber follows. A subscriber with no rows follows
 * every board, and so is absent from the map.
 *
 * One query for the whole table rather than one per subscriber: it holds at most a few rows per
 * subscriber, and the run has a hard time budget.
 */
async function followedBoards(db: Db): Promise<Map<number, Set<number>>> {
  const { data, error } = await db.from("subscriber_boards").select("subscriber_id, board_id");
  if (error) {
    // Before the migration nobody has chosen boards, which means everyone gets everything.
    if (isSchemaMissing(error)) return new Map();
    throw error;
  }
  const map = new Map<number, Set<number>>();
  for (const row of data ?? []) {
    const set = map.get(row.subscriber_id) ?? new Set<number>();
    set.add(row.board_id);
    map.set(row.subscriber_id, set);
  }
  return map;
}

/**
 * Emails every subscriber one digest of recent meetings that haven't been emailed yet, limited
 * to the boards that subscriber follows.
 *
 * Runs daily from Vercel Cron (vercel.json), which sends `Authorization: Bearer $CRON_SECRET`;
 * it can also be triggered by hand with the same header. Most days there's nothing new and it
 * sends nothing. Which meetings have gone out is tracked in the digest_log table
 * (backend/schema.sql); meetings are claimed there before sending, so overlapping runs can't
 * double-send.
 *
 *   ?dryRun=1              report what would be sent; sends and records nothing
 *   ?previewTo=you@x.com   send the digest to that one address only; records nothing
 *   ?board=yrdsb           limit the run to one board (with dryRun, handy for checking a new one)
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
  const onlyBoard = getBoard(params.get("board"));
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
    const recent = (await getMeetings(onlyBoard)).filter((m) => m.meetingDate >= cutoff);
    if (recent.length === 0) {
      return NextResponse.json({ status: "nothing-new", reason: `no meetings in the last ${WINDOW_DAYS} days` });
    }

    const { data: logged, error: logError } = await db
      .from("digest_log")
      .select("meeting_id")
      .in("meeting_id", recent.map((m) => m.id));
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
      return NextResponse.json({
        status: "dry-run",
        boards: [...new Set(fresh.map((m) => m.boardSlug))],
        meetings: fresh.map((m) => m.id),
        subscribers: count ?? 0,
      });
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
    claimedIds = await claimMeetings(db, fresh);
    const meetings = fresh.filter((m) => claimedIds.includes(m.id));
    if (meetings.length === 0) return NextResponse.json({ status: "nothing-new", reason: "another run is already sending these" });

    const subscribers: { id: number; email: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("subscribers").select("id, email").order("id").range(from, from + 999);
      if (error) throw error;
      subscribers.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }

    const boardId = await boardIds(db);
    const followed = await followedBoards(db);

    const started = Date.now();
    let failed = 0;
    let skipped = 0;
    let unfollowed = 0;
    /** How many people actually received each meeting, so digest_log records the truth per row. */
    const recipientsPerMeeting = new Map(meetings.map((m) => [m.id, 0]));

    for (const subscriber of subscribers) {
      if (Date.now() - started > SEND_BUDGET_MS) {
        skipped = subscribers.length - sent - failed - unfollowed;
        console.error(`[digest] Out of time: ${skipped} subscriber(s) not emailed this run`);
        break;
      }

      // No rows means they follow every board, which is what everyone had before boards existed.
      const theirBoards = followed.get(subscriber.id);
      const forThem = theirBoards
        ? meetings.filter((m) => {
            const id = boardId.get(m.boardSlug);
            return id !== undefined && theirBoards.has(id);
          })
        : meetings;
      if (forThem.length === 0) {
        unfollowed++;
        continue;
      }

      const token = unsubscribeToken(subscriber.id, subscriber.email);
      if (!token) {
        failed++;
        continue;
      }
      const result = await sendDigestEmail(mailer, forThem, {
        to: subscriber.email,
        siteUrl: site,
        unsubscribePageUrl: unsubscribeUrl(site, subscriber.id, token),
        oneClickUnsubscribeUrl: oneClickUnsubscribeUrl(site, subscriber.id, token),
      });
      if (result.sent) {
        sent++;
        for (const m of forThem) recipientsPerMeeting.set(m.id, (recipientsPerMeeting.get(m.id) ?? 0) + 1);
      } else {
        failed++;
        console.error(`[digest] Send to ${mask(subscriber.email)} failed: ${result.reason}`);
      }
    }
    mailer.transport.close();

    // Every attempt failed (e.g. the mail server rejected the login): release the claim so the
    // next run retries. A run where nobody follows these boards isn't a failure — those meetings
    // stay recorded, the same way a new subscriber doesn't get older meetings backfilled.
    if (failed > 0 && sent === 0) {
      await db.from("digest_log").delete().in("meeting_id", claimedIds);
      return NextResponse.json({ status: "failed", meetings: claimedIds, failures: failed }, { status: 500 });
    }

    const sentAt = new Date().toISOString();
    await Promise.all(
      meetings.map((m) =>
        db
          .from("digest_log")
          .update({ sent_at: sentAt, recipients: recipientsPerMeeting.get(m.id) ?? 0, failures: failed + skipped })
          .eq("meeting_id", m.id),
      ),
    );
    console.log(
      `[digest] Sent ${meetings.length} meeting(s) to ${sent} subscriber(s); ` +
        `${failed} failed, ${skipped} skipped, ${unfollowed} follow other boards`,
    );
    return NextResponse.json({
      status: "sent",
      boards: [...new Set(meetings.map((m) => m.boardSlug))],
      meetings: claimedIds,
      recipients: sent,
      failures: failed,
      skipped,
      unfollowed,
    });
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
