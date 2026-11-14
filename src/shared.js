// Most rows any read (REST GET or the list_entries tool) will return.
export const MAX_ROWS = 500;

// YYYY-MM-DD for N days ago, used by the `days` filter.
export const cutoffDate = (days) => new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

// True if `given` equals `expected`, compared in constant time so the
// response time does not hint at how many leading characters were right.
// Both are hashed first because timingSafeEqual needs equal-length inputs.
export async function secretsMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
