import { createTransport, type Transporter } from "nodemailer";

/**
 * Outgoing email over SMTP, so any provider works: Gmail (app password), Resend
 * (smtp.resend.com), Brevo, SendGrid... Configure with SMTP_HOST, SMTP_PORT, SMTP_USER,
 * SMTP_PASS and EMAIL_FROM. When they're missing, emails are skipped (and logged), and
 * sign-ups still succeed.
 */
type Mailer = { transport: Transporter; from: string } | { problem: string };

function getMailer(): Mailer {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const port = Number(process.env.SMTP_PORT?.trim() || 465);
  const from = process.env.EMAIL_FROM?.trim() || (user ? `CivicPulse <${user}>` : "");
  if (!host || !user || !pass) return { problem: "SMTP_HOST, SMTP_USER and SMTP_PASS must all be set" };
  if (!Number.isInteger(port) || port <= 0) return { problem: `SMTP_PORT must be a number, got ${JSON.stringify(process.env.SMTP_PORT)}` };
  return {
    // Port 465 speaks TLS from the start; 587 (and others) upgrade with STARTTLS.
    transport: createTransport({ host, port, secure: port === 465, auth: { user, pass } }),
    from,
  };
}

/** True when SMTP settings are present (doesn't contact the server). */
export function isEmailConfigured(): boolean {
  return !("problem" in getMailer());
}

export type SendResult = { sent: true } | { sent: false; reason: string };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface WelcomeEmail {
  to: string;
  siteUrl: string;
  /** Page with a confirm button: safe for link scanners that open every URL. */
  unsubscribePageUrl: string;
  /** Endpoint for mail clients' built-in one-click unsubscribe (RFC 8058). */
  oneClickUnsubscribeUrl: string;
}

const WHAT_YOU_GET = [
  "The three decisions that matter, in plain language",
  "Which towns they affect: Ajax, Pickering, Whitby, Oshawa or Uxbridge",
  "Any deadline to have your say, like a consultation or an upcoming vote",
  "A link to the original agenda, so you can check the details",
];

export function welcomeEmailContent({ to, siteUrl, unsubscribePageUrl }: WelcomeEmail) {
  const subject = "You're subscribed to CivicPulse";

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
    `Catch up on the latest decisions now: ${siteUrl}`,
    "",
    "--",
    "CivicPulse is an independent civic project, not affiliated with or endorsed by the DDSB.",
    `You're receiving this because ${to} signed up at ${new URL(siteUrl).host}.`,
    `Didn't sign up, or changed your mind? Unsubscribe: ${unsubscribePageUrl}`,
  ].join("\n");

  const li = WHAT_YOU_GET.map(
    (line) =>
      `<tr><td style="padding:0 0 10px;vertical-align:top;width:22px;color:#1E48C7;font-weight:bold;">&#10003;</td><td style="padding:0 0 10px;font-size:16px;line-height:1.5;color:#1F2A3C;">${escapeHtml(line)}</td></tr>`,
  ).join("");

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#F6F4EE;">
  <div style="display:none;max-height:0;overflow:hidden;">One short email after each DDSB trustee meeting. Here's what to expect.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F4EE;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DDD8CC;border-radius:14px;">
        <tr><td style="padding:24px 28px;background:#0F1B2D;border-radius:14px 14px 0 0;">
          <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;color:#FFFFFF;">CivicPulse</span>
          <span style="font-family:Consolas,'Courier New',monospace;font-size:11px;font-weight:bold;letter-spacing:1px;color:#FFE27A;border:1px solid #FFE27A;border-radius:4px;padding:2px 6px;margin-left:8px;">DDSB</span>
        </td></tr>
        <tr><td style="padding:32px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
          <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;color:#0F1B2D;">You're subscribed!</h1>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#3B4658;">Thanks for signing up for DDSB meeting alerts. Here's what to expect.</p>

          <p style="margin:0 0 12px;font-family:Consolas,'Courier New',monospace;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#3B4658;">What you'll get</p>
          <p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#1F2A3C;">One short email after each Durham District School Board trustee meeting, with:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">${li}</table>

          <p style="margin:0 0 12px;font-family:Consolas,'Courier New',monospace;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#3B4658;">How often</p>
          <p style="margin:0 0 28px;font-size:16px;line-height:1.6;color:#1F2A3C;">Only when the board meets, usually a few times a month. No ads, no other mailing lists, and we never share your email.</p>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 32px;"><tr><td style="background:#FFE27A;border-radius:10px;">
            <a href="${escapeHtml(siteUrl)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:bold;color:#0F1B2D;text-decoration:none;">See the latest decisions &rarr;</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:20px 28px 26px;border-top:1px solid #E8E4DA;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#5B6474;">
          CivicPulse is an independent civic project, not affiliated with or endorsed by the DDSB.<br>
          You're receiving this because ${escapeHtml(to)} signed up at ${escapeHtml(new URL(siteUrl).host)}.<br>
          Didn't sign up, or changed your mind? <a href="${escapeHtml(unsubscribePageUrl)}" style="color:#1E48C7;">Unsubscribe</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

export async function sendWelcomeEmail(email: WelcomeEmail): Promise<SendResult> {
  const mailer = getMailer();
  if ("problem" in mailer) return { sent: false, reason: `email not configured: ${mailer.problem}` };

  const { subject, text, html } = welcomeEmailContent(email);
  try {
    await mailer.transport.sendMail({
      from: mailer.from,
      to: email.to,
      subject,
      text,
      html,
      list: { unsubscribe: { url: email.oneClickUnsubscribeUrl, comment: "Unsubscribe" } },
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
