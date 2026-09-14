import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBSCRIBERS_PATH = path.join(process.cwd(), "public", "data", "subscribers.json");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

interface Subscriber {
  email: string;
  subscribedAt: string;
}

// Serialize writes so two simultaneous sign-ups can't clobber each other's read-modify-write.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

async function readSubscribers(): Promise<Subscriber[]> {
  try {
    const data: unknown = JSON.parse(await readFile(SUBSCRIBERS_PATH, "utf8"));
    return Array.isArray(data) ? (data as Subscriber[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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

  try {
    await serialized(async () => {
      const subscribers = await readSubscribers();
      if (subscribers.some((s) => s.email === email)) return;
      subscribers.push({ email, subscribedAt: new Date().toISOString() });
      await mkdir(path.dirname(SUBSCRIBERS_PATH), { recursive: true });
      await writeFile(SUBSCRIBERS_PATH, `${JSON.stringify(subscribers, null, 2)}\n`, "utf8");
    });
  } catch (error) {
    // Hosts like Vercel run server code on a read-only filesystem, so the file store can't work there.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      return NextResponse.json(
        { error: "Sign-ups aren't open on this site yet. Please check back soon." },
        { status: 503 },
      );
    }
    console.error("[subscribe] could not save subscriber", error);
    return NextResponse.json({ error: "We couldn't save your email just now. Please try again." }, { status: 500 });
  }

  // Same reply for new and existing addresses, so the form can't be used to probe who has signed up.
  return NextResponse.json({ message: "You're on the list. Watch for the next meeting summary." }, { status: 201 });
}
