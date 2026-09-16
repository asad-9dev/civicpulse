import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isValidUnsubscribeToken } from "@/lib/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Outcome = "done" | "invalid" | "error";

/**
 * Removes a subscriber. Two callers:
 *  - the confirm button on /unsubscribe (form fields id, token, source=page) -> redirect back to the page
 *  - a mail client's one-click unsubscribe (RFC 8058: POST to the List-Unsubscribe URL, id and
 *    token in the query string, body "List-Unsubscribe=One-Click") -> plain response
 * Deliberately POST-only: link scanners that open every URL in an email can't unsubscribe anyone.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  let id = url.searchParams.get("id") ?? "";
  let token = url.searchParams.get("token") ?? "";
  let fromPage = false;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    id = String(form.get("id") ?? id);
    token = String(form.get("token") ?? token);
    fromPage = form.get("source") === "page";
  }

  const respond = (outcome: Outcome) => {
    if (fromPage) return NextResponse.redirect(new URL(`/unsubscribe?status=${outcome}`, url.origin), 303);
    const status = outcome === "done" ? 200 : outcome === "invalid" ? 400 : 500;
    return NextResponse.json({ status: outcome }, { status });
  };

  if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_-]{32}$/.test(token)) return respond("invalid");
  // The token is signed over the id as it appears in the link; the column is a bigint.
  const subscriberId = Number(id);

  const supabase = getSupabaseAdmin();
  if ("problem" in supabase) {
    console.error(`[unsubscribe] Supabase is misconfigured: ${supabase.problem}`);
    return respond("error");
  }

  try {
    const { data, error } = await supabase.client.from("subscribers").select("email").eq("id", subscriberId).maybeSingle();
    if (error) throw error;
    // Already removed (e.g. the link was used twice): the end state is what they asked for.
    if (!data) return respond("done");
    if (!isValidUnsubscribeToken(id, data.email, token)) return respond("invalid");

    const { error: deleteError } = await supabase.client.from("subscribers").delete().eq("id", subscriberId);
    if (deleteError) throw deleteError;
    return respond("done");
  } catch (error) {
    console.error("[unsubscribe] Could not remove subscriber:", error);
    return respond("error");
  }
}
