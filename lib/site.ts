/** Public address for links in emails: SITE_URL when set (e.g. https://ddsb-civicpulse.vercel.app), else the request's origin. */
export function siteUrl(request: Request): string {
  return process.env.SITE_URL?.trim() || new URL(request.url).origin;
}
