/**
 * Masking applied to log text before it reaches an agent (and so the model provider and run history).
 * redactSecrets: credentials. redactPii: also customer data (e-mail, VN phone numbers, card numbers) — production logs.
 */

const SECRETS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "<jwt>"],
  [
    /((?:password|passwd|secret|api[_-]?key|[a-z_-]*token|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi,
    "$1***",
  ],
];

const PII: Array<[RegExp, string | ((m: string) => string)]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => `${m[0]}***@${m.split("@")[1]}`],
  // card numbers: 13–19 digits, optionally grouped by spaces/dashes; keep the last 4
  [
    /\b(?:\d[ -]?){12,18}\d\b/g,
    (m) => (luhn(m.replace(/\D/g, "")) ? `****${m.replace(/\D/g, "").slice(-4)}` : m),
  ],
  // Vietnamese mobile numbers: 0xxxxxxxxx / 84xxxxxxxxx / +84xxxxxxxxx
  [
    /(?<![\d])(?:\+?84|0)([35789])\d{8}(?![\d])/g,
    (m) => `${m.slice(0, m.length - 7)}****${m.slice(-3)}`,
  ],
];

function luhn(d: string): boolean {
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) ((n *= 2), n > 9 && (n -= 9));
    sum += n;
  }
  return sum % 10 === 0;
}

export function redactSecrets(s: string): string {
  return SECRETS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

export function redactPii(s: string): string {
  return PII.reduce((acc, [re, rep]) => acc.replace(re, rep as any), redactSecrets(s));
}
