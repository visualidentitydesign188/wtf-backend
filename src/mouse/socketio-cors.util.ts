/**
 * Socket.IO browser clients send an `Origin` header (e.g. https://allthingswtf.com).
 * Strict string equality fails when some users hit https://www.allthingswtf.com
 * and the allowlist only has the apex (or vice versa). Normalize and expand.
 */
export function normalizeSocketOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * For each allowed origin, also allow the www / non-www variant so both work.
 */
export function expandAllowedSocketOrigins(origins: string[]): Set<string> {
  const set = new Set<string>();
  for (const raw of origins) {
    const n = normalizeSocketOrigin(raw);
    if (!n) continue;
    set.add(n);
    try {
      const u = new URL(n);
      if (u.hostname.startsWith('www.')) {
        const apex = new URL(n);
        apex.hostname = u.hostname.slice(4);
        set.add(normalizeSocketOrigin(apex.origin));
      } else {
        const www = new URL(n);
        www.hostname = 'www.' + u.hostname;
        set.add(normalizeSocketOrigin(www.origin));
      }
    } catch {
      // ignore invalid URL
    }
  }
  return set;
}
