import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const UNIQUE_VIOLATION = "23505"; // Postgres error code: email already in the table

const NOT_OPEN = "Sign-ups aren't open on this site yet. Please check back soon.";
const TRY_AGAIN = "We couldn't save your email just now. Please try again.";

type SupabaseConfig = { url: string; key: string } | { problem: string };

/**
 * Reads the Supabase settings and says exactly what's wrong if they're unusable, so a bad
 * value shows up as one clear log line instead of an exception inside createClient().
 */
function readSupabaseConfig(): SupabaseConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url) return { problem: "NEXT_PUBLIC_SUPABASE_URL is not set" };
  if (!key) return { problem: "SUPABASE_SERVICE_ROLE_KEY is not set" };
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // fall through to the message below
  }
  if (!parsed || parsed.protocol !== "https:") {
    // The project URL isn't secret, so it's safe to log what was actually configured.
    return { problem: `NEXT_PUBLIC_SUPABASE_URL must be a plain https URL, got ${JSON.stringify(url.slice(0, 120))}` };
  }
  return { url, key };
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

  const config = readSupabaseConfig();
  if ("problem" in config) {
    console.error(`[subscribe] Supabase is misconfigured: ${config.problem}`);
    return NextResponse.json({ error: NOT_OPEN }, { status: 503 });
  }

  try {
    // The secret (service role) key bypasses the table's Row Level Security; it never leaves the server.
    const supabase = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // id and created_at are filled in by the database (see backend/schema.sql).
    const { error } = await supabase.from("subscribers").insert({ email });
    // An address that's already subscribed gets the same reply as a new one,
    // so the form can't be used to probe who has signed up.
    if (error && error.code !== UNIQUE_VIOLATION) {
      console.error("[subscribe] Supabase insert failed:", error.code, error.message, error.details ?? "", error.hint ?? "");
      return NextResponse.json({ error: TRY_AGAIN }, { status: 500 });
    }
  } catch (error) {
    console.error("[subscribe] Unexpected error while saving subscriber:", error);
    return NextResponse.json({ error: TRY_AGAIN }, { status: 500 });
  }

  return NextResponse.json({ message: "You're subscribed!" }, { status: 201 });
}
