// Where to send someone after a link in an email: a path on this site only,
// never another origin (open redirect). Returns null if unusable.
export function safeNextPath(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\s\p{Cc}]/u.test(value)) return null;
  return value;
}
