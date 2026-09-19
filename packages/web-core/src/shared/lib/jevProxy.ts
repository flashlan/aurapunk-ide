/**
 * TypeSafe's API sends no `Access-Control-Allow-Origin`, so a browser/webview
 * fetch to it always fails ("Load failed"). Jev calls must go through the local
 * backend proxy (`POST /api/jev/evaluate`), which performs the request server to
 * server. This builds that same-origin URL, forwarding the user's configured
 * endpoint as the upstream target.
 */
export function jevProxyUrl(typesafeUrl?: string): string {
  const base = '/api/jev/evaluate';
  const trimmed = typesafeUrl?.trim();
  if (!trimmed) return base;
  return `${base}?endpoint=${encodeURIComponent(trimmed)}`;
}
