import { Marked } from "marked";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]!);
function safeUrl(value: string, image = false): boolean {
  if (/[\s\\]/.test(value) || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (!image && /^mailto:/i.test(value)) return true;
  // Check decoded relative references for disguised schemes, but retain the original URL in HTML.
  // Decoding also catches nested encodings without rejecting ordinary encoded filenames.
  let decoded = value;
  try {
    for (let i = 0; i < 5 && decoded.includes("%"); i++) decoded = decodeURIComponent(decoded);
  } catch {
    return false;
  }
  if (decoded.includes("%") || decoded.includes("\\") || [...decoded].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
  return !decoded.startsWith("//") && /^[^:/?#&]*(?:[/?#].*)?$/.test(decoded);
}
const markdown = new Marked({
  renderer: {
    html: (token) => escapeHtml(token.text ?? token.raw ?? ""),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!safeUrl(href)) return label;
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`;
    },
    image({ href, title, text }) {
      if (!safeUrl(href, true)) return escapeHtml(text);
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
    },
  },
  gfm: true,
  breaks: true,
});

export function renderMarkdownSafe(text: string): string {
  return markdown.parse(text ?? "", { async: false });
}
