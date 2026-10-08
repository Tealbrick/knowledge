/**
 * CSP `frame-ancestors` source list for the pages Knowledge serves to a browser.
 *
 * The manifest declares `frontend.embed.frameAncestors: "portal-origins"`: Portal frames the app's own standalone
 * settings page, so the registered Portal origin (and this origin) may frame it and no other site may. The Portal
 * origin comes from the configured Portal URL (`TEALBRICK_PORTAL_URL`), origin only, no path. Without a usable
 * http(s) Portal URL the answer is `'self'`. It is never `*`.
 */
// A CSP source must be a plain http(s) origin: no wildcard, no userinfo, no path (the URL parser would accept `*` in a host).
const PLAIN_ORIGIN = /^https?:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/u;

export function portalFrameOrigin(portalUrl: string | undefined | null): string | null {
  const raw = portalUrl?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return PLAIN_ORIGIN.test(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

export function frameAncestorsDirective(portalUrl: string | undefined | null): string {
  const origin = portalFrameOrigin(portalUrl);
  return `frame-ancestors 'self'${origin ? ` ${origin}` : ""}`;
}
