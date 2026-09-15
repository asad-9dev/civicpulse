import { NextResponse } from "next/server";
import { isEmailConfigured, sendWelcomeEmail } from "@/lib/email";
import { getSupabaseAdmin } from "@/lib/supabase";
import { oneClickUnsubscribeUrl, unsubscribeToken, unsubscribeUrl } from "@/lib/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const UNIQUE_VIOLATION = "23505"; // Postgres error code: email already in the table

const NOT_OPEN = "Sign-ups aren't open on this site yet. Please check back soon.";
const TRY_AGAIN = "We couldn't save your email just now. Please try again.";

/** Links in emails point here: SITE_URL when set (e.g. https://ddsb-civicpulse.vercel.app), else this request's origin. */
function siteUrl(request: Request): string {
  return process.env.SITE_URL?.trim() || new URL(request.url).origin;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send JSON like {"email": "you@example.com"}.' }, { status: 400 });
  }

  const rawEmail = (body as { email?: unknown } | null)?.email;
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: "Enter an email address like name@example.com." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  if ("problem" in supabase) {
    console.error(`[subscribe] Supabase is misconfigured: ${supabase.problem}`);
    return NextResponse.json({ error: NOT_OPEN }, { status: 503 });
  }

  let newSubscriberId: number | null = null;
  try {
    // id and created_at are filled in by the database (see backend/schema.sql).
    const { data, error } = await supabase.client.from("subscribers").insert({ email }).select("id").single();
    if (error && error.code !== UNIQUE_VIOLATION) {
      console.error("[subscribe] Supabase insert failed:", error.code, error.message, error.details ?? "", error.hint ?? "");
      return NextResponse.json({ error: TRY_AGAIN }, { status: 500 });
    }
    newSubscriberId = data?.id ?? null;
  } catch (error) {
    console.error("[subscribe] Unexpected error while saving subscriber:", error);
    return NextResponse.json({ error: TRY_AGAIN }, { status: 500 });
  }

  // Only a brand-new sign-up gets the welcome email, so re-submitting an address can't be used
  // to flood someone's inbox. A failed email never fails the sign-up itself.
  if (newSubscriberId !== null) {
    const token = unsubscribeToken(newSubscriberId, email);
    const site = siteUrl(request);
    if (token) {
      const result = await sendWelcomeEmail({
        to: email,
        siteUrl: site,
        unsubscribePageUrl: unsubscribeUrl(site, newSubscriberId, token),
        oneClickUnsubscribeUrl: oneClickUnsubscribeUrl(site, newSubscriberId, token),
      });
      if (!result.sent) console.error(`[subscribe] Welcome email not sent: ${result.reason}`);
    }
  }

  // Existing and new addresses get the same reply, so the form can't reveal who has signed up.
  // (An existing address simply doesn't get a second welcome email.) emailsEnabled describes the
  // site's setup, not this address, so it's safe to return.
  return NextResponse.json({ message: "You're subscribed!", emailsEnabled: isEmailConfigured() }, { status: 201 });
}
