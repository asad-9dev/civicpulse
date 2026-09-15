import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unsubscribe links carry the subscriber's row id plus an HMAC of id + email, so they need no
 * extra database column, never put the email address itself in a URL, and can't be forged
 * for someone else's id.
 *
 * The signing key is UNSUBSCRIBE_SECRET when set, otherwise one derived from the Supabase
 * secret key (rotating that key therefore invalidates links in emails already sent).
 */
function signingKey(): string | null {
  const base = process.env.UNSUBSCRIBE_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!base) return null;
  return createHmac("sha256", base).update("civicpulse-unsubscribe-v1").digest("hex");
}

export function unsubscribeToken(id: number | string, email: string): string | null {
  const key = signingKey();
  if (!key) return null;
  return createHmac("sha256", key).update(`${id}:${email.toLowerCase()}`).digest("base64url").slice(0, 32);
}

export function isValidUnsubscribeToken(id: number | string, email: string, token: string): boolean {
  const expected = unsubscribeToken(id, email);
  if (!expected || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function unsubscribeUrl(siteUrl: string, id: number | string, token: string): string {
  const url = new URL("/unsubscribe", siteUrl);
  url.searchParams.set("id", String(id));
  url.searchParams.set("token", token);
  return url.toString();
}

/** Where a mail client's one-click unsubscribe button POSTs (RFC 8058). */
export function oneClickUnsubscribeUrl(siteUrl: string, id: number | string, token: string): string {
  const url = new URL("/api/unsubscribe", siteUrl);
  url.searchParams.set("id", String(id));
  url.searchParams.set("token", token);
  return url.toString();
}
