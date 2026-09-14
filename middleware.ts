import { NextResponse } from "next/server";

// Subscribers now live in Supabase, but earlier versions stored them in
// public/data/subscribers.json, and Next.js serves everything in public/ as a
// static file. Keep refusing that path in case a local copy is still around.
export function middleware() {
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: "/data/subscribers.json",
};
