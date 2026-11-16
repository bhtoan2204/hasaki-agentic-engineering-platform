/**
 * Read what a browser's "Copy as cURL" put on the clipboard: Chrome/Edge offer a bash flavour ('…', \ line breaks)
 * and, on Windows, a cmd flavour where every special character is caret-escaped (^" ^^ ^\^" and ^ line breaks).
 * Only the cookie and request headers are extracted; nothing is executed.
 */

export interface CurlParts {
  cookie?: string;
  headers: Record<string, string>;
  url?: string;
}

export const looksLikeCurl = (s: string) => /^\s*curl(\.exe)?\s/i.test(s);

/** cmd.exe escaping: `^` makes the next character literal; `^` at the end of a line continues it. */
function uncmd(s: string): string {
  return s.replace(/\^\r?\n/g, " ").replace(/\^(.)/g, "$1");
}

/** Shell-like word splitting with '…' (literal), "…" (\" and \\ escapes) and backslash-newline continuations. */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && (s[i + 1] === "\n" || (s[i + 1] === "\r" && s[i + 2] === "\n"))) {
      i += s[i + 1] === "\r" ? 2 : 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur), (cur = ""), (has = false);
      continue;
    }
    has = true;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) i++;
        cur += s[i++];
      }
    } else if (c === "$" && s[i + 1] === "'") {
      // bash ANSI-C quoting: $'…'
      const end = s.indexOf("'", i + 2);
      cur += s.slice(i + 2, end < 0 ? s.length : end).replace(/\\'/g, "'");
      i = end < 0 ? s.length : end;
    } else cur += c;
  }
  if (has) out.push(cur);
  return out;
}

export function parseCurl(raw: string): CurlParts | null {
  if (!looksLikeCurl(raw)) return null;
  const windows = /\^"|\^\r?\n/.test(raw);
  const words = shellWords(windows ? uncmd(raw) : raw);
  const parts: CurlParts = { headers: {} };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = () => words[++i] ?? "";
    if (w === "-H" || w === "--header") {
      const h = next();
      const k = h.indexOf(":");
      if (k > 0) parts.headers[h.slice(0, k).trim().toLowerCase()] = h.slice(k + 1).trim();
    } else if (w === "-b" || w === "--cookie") parts.cookie = next();
    else if (w === "--url") parts.url = next();
    else if (/^https?:\/\//.test(w) && !parts.url) parts.url = w;
  }
  parts.cookie ??= parts.headers.cookie;
  return parts;
}

/**
 * Cookie text from a pasted Cookie header, `Cookie: …` line, or cURL command → `name=value` pairs.
 * Also returns the request headers when a cURL command was pasted (e.g. x-splunk-form-key).
 */
export function cookiePairs(raw: string): { pairs: string[]; headers: Record<string, string> } {
  const curl = parseCurl(raw);
  if (curl && !curl.cookie) throw new Error("lệnh cURL không có cookie (-b hoặc -H 'cookie: …') — copy một request tới đúng trang khi đang đăng nhập");
  const text = (curl ? curl.cookie! : raw.trim()).replace(/^cookie:\s*/i, "").trim();
  if (/[\r\n]/.test(text)) throw new Error("không đọc được cookie: hãy dán header Cookie, hoặc nguyên lệnh Copy as cURL (cmd hoặc bash)");
  const pairs = text
    .split(/;\s*/)
    .map((p) => p.trim())
    .filter((p) => /^[^=\s]+=/.test(p));
  const bad = pairs.find((p) => /[^\x21-\x7e]/.test(p.slice(p.indexOf("=") + 1)));
  if (bad) throw new Error(`cookie ${bad.slice(0, bad.indexOf("="))} có ký tự không hợp lệ — copy lại (nên dùng Copy as cURL)`);
  return { pairs, headers: curl?.headers ?? {} };
}
