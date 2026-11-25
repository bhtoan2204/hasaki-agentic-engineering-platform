import type { IncomingMessage, ServerResponse } from "node:http";
import { cookieSecure } from "../auth/sessions.ts";

/**
 * CSP for the UI bundle (Vite output: one module script, one stylesheet, self-hosted @fontsource fonts, same-origin
 * fetch/SSE, a data: favicon, blob: previews of images chosen in chat).
 * style-src needs 'unsafe-inline': React and @xyflow/react set element style attributes at runtime, which CSP treats
 * as inline styles. Scripts stay 'self' only: no inline script, eval or remote origin.
 */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Defaults for every response; set before writeHead, so a route that sets the same header itself (artifact and
 * attachment downloads carry a stricter sandbox CSP) overrides them.
 */
export function applySecurityHeaders(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  res.setHeader("Content-Security-Policy", UI_CSP);
  if (cookieSecure(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}
