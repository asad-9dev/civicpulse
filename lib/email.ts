import { createTransport, type Transporter } from "nodemailer";
import { formatMeetingDate, urgencyLevel } from "./format";
import type { Meeting } from "./types";

/**
 * Outgoing email over SMTP, so any provider works: Gmail (app password), Resend
 * (smtp.resend.com), Brevo, SendGrid... Configure with SMTP_HOST, SMTP_PORT, SMTP_USER,
 * SMTP_PASS and EMAIL_FROM. When they're missing, emails are skipped (and logged), and
 * sign-ups still succeed.
 */
type Mailer = { transport: Transporter; from: string } | { problem: string };

/** `pool` keeps one SMTP connection open for many messages (the meeting digest). */
export function getMailer({ pool = false }: { pool?: boolean } = {}): Mailer {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const port = Number(process.env.SMTP_PORT?.trim() || 465);
  const from = process.env.EMAIL_FROM?.trim() || (user ? `CivicPulse <${user}>` : "");
  if (!host || !user || !pass) return { problem: "SMTP_HOST, SMTP_USER and SMTP_PASS must all be set" };
  if (!Number.isInteger(port) || port <= 0) return { problem: `SMTP_PORT must be a number, got ${JSON.stringify(process.env.SMTP_PORT)}` };
  return {
    // Port 465 speaks TLS from the start; 587 (and others) upgrade with STARTTLS.
    transport: createTransport({ host, port, secure: port === 465, auth: { user, pass }, pool, maxConnections: 1 }),
    from,
  };
}

/** True when SMTP settings are present (doesn't contact the server). */
export function isEmailConfigured(): boolean {
  return !("problem" in getMailer());
}

export type SendResult = { sent: true } | { sent: false; reason: string };

/** Per-recipient links every CivicPulse email carries. */
export interface RecipientLinks {
  to: string;
  siteUrl: string;
  /** Page with a confirm button: safe for link scanners that open every URL. */
  unsubscribePageUrl: string;
  /** Endpoint for mail clients' built-in one-click unsubscribe (RFC 8058). */
  oneClickUnsubscribeUrl: string;
}

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function deliver(mailer: Exclude<Mailer, { problem: string }>, links: RecipientLinks, content: EmailContent): Promise<SendResult> {
  try {
    await mailer.transport.sendMail({
      from: mailer.from,
      to: links.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      list: { unsubscribe: { url: links.oneClickUnsubscribeUrl, comment: "Unsubscribe" } },
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ----------------------------------------------------------------------------------------------
// Shared layout (table-based, inline styles, web-safe fonts: renders in Gmail, Outlook, Apple Mail)
// ----------------------------------------------------------------------------------------------

const MONO = "Consolas,'Courier New',monospace";
const SERIF = "Georgia,'Times New Roman',serif";

function sectionLabel(text: string): string {
  return `<p style="margin:0 0 12px;font-family:${MONO};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#3B4658;">${escapeHtml(text)}</p>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 32px;"><tr><td style="background:#FFE27A;border-radius:10px;">
            <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:bold;color:#0F1B2D;text-decoration:none;">${escapeHtml(label)} &rarr;</a>
          </td></tr></table>`;
}

function emailShell({ title, preheader, body, links, reason }: {
  title: string;
  preheader: string;
  body: string;
  links: RecipientLinks;
  /** Why this person is getting the email. */
  reason: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#F6F4EE;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F4EE;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DDD8CC;border-radius:14px;">
        <tr><td style="padding:24px 28px;background:#0F1B2D;border-radius:14px 14px 0 0;">
          <span style="font-family:${SERIF};font-size:22px;font-weight:bold;color:#FFFFFF;">CivicPulse</span>
          <span style="font-family:${MONO};font-size:11px;font-weight:bold;letter-spacing:1px;color:#FFE27A;border:1px solid #FFE27A;border-radius:4px;padding:2px 6px;margin-left:8px;">DDSB</span>
        </td></tr>
        <tr><td style="padding:32px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
          ${body}
        </td></tr>
        <tr><td style="padding:20px 28px 26px;border-top:1px solid #E8E4DA;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#5B6474;">
          CivicPulse is an independent civic project, not affiliated with or endorsed by the DDSB.<br>
          ${escapeHtml(reason)}<br>
          <a href="${escapeHtml(links.unsubscribePageUrl)}" style="color:#1E48C7;">Unsubscribe</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function textFooter(links: RecipientLinks, reason: string): string {
  return [
    "--",
    "CivicPulse is an independent civic project, not affiliated with or endorsed by the DDSB.",
    reason,
    `Unsubscribe: ${links.unsubscribePageUrl}`,
  ].join("\n");
}

// ----------------------------------------------------------------------------------------------
// Welcome email
// ----------------------------------------------------------------------------------------------

const WHAT_YOU_GET = [
  "The three decisions that matter, in plain language",
  "Which towns they affect: Ajax, Pickering, Whitby, Oshawa or Uxbridge",
  "Any deadline to have your say, like a consultation or an upcoming vote",
  "A link to the original agenda, so you can check the details",
];

export function welcomeEmailContent(links: RecipientLinks): EmailContent {
  const subject = "You're subscribed to CivicPulse";
  const reason = `You're receiving this because ${links.to} signed up at ${new URL(links.siteUrl).host}. Didn't sign up, or changed your mind? Unsubscribe below.`;

  const text = [
    "You're subscribed to CivicPulse!",
    "",
    "Thanks for signing up for DDSB meeting alerts. Here's what to expect.",
    "",
    "WHAT YOU'LL GET",
    "One short email after each Durham District School Board trustee meeting, with:",
    ...WHAT_YOU_GET.map((line) => `  - ${line}`),
    "",
    "HOW OFTEN",
    "Only when the board meets, usually a few times a month. No ads, no other mailing lists,",
    "and we never share your email.",
    "",
    `Catch up on the latest decisions now: ${links.siteUrl}`,
    "",
    textFooter(links, reason),
  ].join("\n");

  const items = WHAT_YOU_GET.map(
    (line) =>
      `<tr><td style="padding:0 0 10px;vertical-align:top;width:22px;color:#1E48C7;font-weight:bold;">&#10003;</td><td style="padding:0 0 10px;font-size:16px;line-height:1.5;color:#1F2A3C;">${escapeHtml(line)}</td></tr>`,
  ).join("");

  const body = `
          <h1 style="margin:0 0 12px;font-family:${SERIF};font-size:28px;line-height:1.2;color:#0F1B2D;">You're subscribed!</h1>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#3B4658;">Thanks for signing up for DDSB meeting alerts. Here's what to expect.</p>
          ${sectionLabel("What you'll get")}
          <p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#1F2A3C;">One short email after each Durham District School Board trustee meeting, with:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">${items}</table>
          ${sectionLabel("How often")}
          <p style="margin:0 0 28px;font-size:16px;line-height:1.6;color:#1F2A3C;">Only when the board meets, usually a few times a month. No ads, no other mailing lists, and we never share your email.</p>
          ${button(links.siteUrl, "See the latest decisions")}`;

  return {
    subject,
    text,
    html: emailShell({ title: subject, preheader: "One short email after each DDSB trustee meeting. Here's what to expect.", body, links, reason }),
  };
}

export async function sendWelcomeEmail(links: RecipientLinks): Promise<SendResult> {
  const mailer = getMailer();
  if ("problem" in mailer) return { sent: false, reason: `email not configured: ${mailer.problem}` };
  return deliver(mailer, links, welcomeEmailContent(links));
}

// ----------------------------------------------------------------------------------------------
// Meeting digest
// ----------------------------------------------------------------------------------------------

const URGENCY_STYLE = {
  high: { label: "High", color: "#A4161A", background: "#FCE8E6" },
  medium: { label: "Medium", color: "#8A4B00", background: "#FDF0D5" },
  low: { label: "Low", color: "#1B6B3A", background: "#E3F3E8" },
} as const;

function breakdownUrl(siteUrl: string, meeting: Meeting): string {
  const url = new URL("/", siteUrl);
  url.searchParams.set("meeting", meeting.id);
  return url.toString();
}

/** Most urgent first, then newest. */
export function orderForDigest(meetings: Meeting[]): Meeting[] {
  return [...meetings].sort((a, b) => b.urgencyScore - a.urgencyScore || b.meetingDate.localeCompare(a.meetingDate));
}

/** The built-in summarizer pads short agendas with a repeated filler line; show each point once. */
function uniquePoints(meeting: Meeting): string[] {
  return [...new Set(meeting.executiveSummary.map((point) => point.trim()).filter(Boolean))];
}

export function digestEmailContent(meetings: Meeting[], links: RecipientLinks): EmailContent {
  const ordered = orderForDigest(meetings);
  const lead = ordered[0];
  const subject =
    ordered.length === 1 ? `DDSB decoded: ${lead.title}` : `DDSB decoded: ${lead.title} (+${ordered.length - 1} more)`;
  const intro =
    ordered.length === 1
      ? "Here's what was on the table at the latest Durham District School Board meeting."
      : `Here's what was on the table at ${ordered.length} recent Durham District School Board meetings, most urgent first.`;
  const reason = `You're receiving this because ${links.to} subscribed to CivicPulse meeting alerts.`;

  const text = [
    "New from the DDSB, decoded",
    "",
    intro,
    ...ordered.flatMap((m) => {
      const urgency = URGENCY_STYLE[urgencyLevel(m.urgencyScore)];
      return [
        "",
        "============================================================",
        `${formatMeetingDate(m.meetingDate)} · ${m.committeeName}`,
        m.title.toUpperCase(),
        `Urgency ${m.urgencyScore}/5 (${urgency.label}) · ${m.category} · ${m.townsAffected.join(", ")}`,
        "",
        ...uniquePoints(m).map((point, i) => `${i + 1}. ${point}`),
        "",
        `Full breakdown: ${breakdownUrl(links.siteUrl, m)}`,
        `Original agenda: ${m.originalPdfUrl}`,
      ];
    }),
    "",
    textFooter(links, reason),
  ].join("\n");

  const blocks = ordered
    .map((m) => {
      const urgency = URGENCY_STYLE[urgencyLevel(m.urgencyScore)];
      const points = uniquePoints(m)
        .map(
          (point, i) =>
            `<tr><td style="padding:0 0 8px;vertical-align:top;width:26px;"><span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:4px;background:#0F1B2D;color:#FFE27A;font-family:${MONO};font-size:12px;font-weight:bold;">${i + 1}</span></td><td style="padding:0 0 8px;font-size:15px;line-height:1.5;color:#1F2A3C;">${escapeHtml(point)}</td></tr>`,
        )
        .join("");
      return `
          <tr><td style="padding:22px 0;border-top:1px solid #E8E4DA;">
            <p style="margin:0 0 8px;font-family:${MONO};font-size:12px;letter-spacing:0.5px;text-transform:uppercase;color:#5B6474;">${escapeHtml(formatMeetingDate(m.meetingDate))} &middot; ${escapeHtml(m.committeeName)}</p>
            <h2 style="margin:0 0 10px;font-family:${SERIF};font-size:21px;line-height:1.25;"><a href="${escapeHtml(breakdownUrl(links.siteUrl, m))}" style="color:#0F1B2D;text-decoration:none;">${escapeHtml(m.title)}</a></h2>
            <p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#3B4658;">
              <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${urgency.background};color:${urgency.color};font-weight:bold;">Urgency ${m.urgencyScore}/5 &middot; ${urgency.label}</span>
              &nbsp;${escapeHtml(m.category)} &middot; ${escapeHtml(m.townsAffected.join(", "))}
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px;">${points}</table>
            <p style="margin:0;font-size:14px;"><a href="${escapeHtml(breakdownUrl(links.siteUrl, m))}" style="color:#1E48C7;font-weight:bold;">Full breakdown &rarr;</a> &nbsp;&middot;&nbsp; <a href="${escapeHtml(m.originalPdfUrl)}" style="color:#1E48C7;">Original agenda</a></p>
          </td></tr>`;
    })
    .join("");

  const body = `
          <h1 style="margin:0 0 12px;font-family:${SERIF};font-size:28px;line-height:1.2;color:#0F1B2D;">New from the DDSB, decoded</h1>
          <p style="margin:0 0 8px;font-size:16px;line-height:1.6;color:#3B4658;">${escapeHtml(intro)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">${blocks}</table>
          ${button(links.siteUrl, "See every decision")}`;

  return { subject, text, html: emailShell({ title: subject, preheader: lead.executiveSummary[0] ?? lead.title, body, links, reason }) };
}

/** Sends one digest over an already-open (pooled) mailer, so a whole run reuses one connection. */
export function sendDigestEmail(
  mailer: Exclude<Mailer, { problem: string }>,
  meetings: Meeting[],
  links: RecipientLinks,
): Promise<SendResult> {
  return deliver(mailer, links, digestEmailContent(meetings, links));
}
