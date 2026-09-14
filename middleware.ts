import { NextResponse } from "next/server";

// The spec keeps subscribers in public/data/subscribers.json, and Next.js serves
// everything in public/ as a static file. Refuse that one path so the email list
// is never downloadable from the site.
export function middleware() {
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: "/data/subscribers.json",
};
