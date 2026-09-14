import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const UNIQUE_VIOLATION = "23505"; // Postgres error code: email already in the table

/**
 * Server-only Supabase client using the secret (service role) key, which bypasses the
 * table's Row Level Security. Returns null when the environment isn't configured.
 */
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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

  const supabase = getSupabase();
  if (!supabase) {
    console.error("[subscribe] NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    return NextResponse.json(
      { error: "Sign-ups aren't open on this site yet. Please check back soon." },
      { status: 503 },
    );
  }

  const { error } = await supabase.from("subscribers").insert({ email });
  // An address that's already subscribed gets the same reply as a new one,
  // so the form can't be used to probe who has signed up.
  if (error && error.code !== UNIQUE_VIOLATION) {
    console.error("[subscribe] Supabase insert failed", error.code, error.message);
    return NextResponse.json({ error: "We couldn't save your email just now. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ message: "You're subscribed!" }, { status: 201 });
}
