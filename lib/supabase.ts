import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db/types";

/** Typed against backend/schema.sql; see lib/db/types.ts. */
export type AdminClient = SupabaseClient<Database>;

export type AdminClientResult = { client: AdminClient } | { problem: string };

/**
 * Server-only Supabase client using the secret (service role) key, which bypasses the
 * subscribers table's Row Level Security. Never import this from a client component.
 *
 * Reports exactly what's wrong when the settings are unusable, so a bad value shows up as
 * one clear log line instead of an exception inside createClient().
 */
export function getSupabaseAdmin(): AdminClientResult {
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

  return { client: createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) };
}
