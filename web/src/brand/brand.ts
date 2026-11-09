/**
 * Single source of truth for Hasaki AI Workspace branding.
 *
 * Logo: the official Hasaki logo as used by the company's internal OMS frontend
 * (oms-frontend/public/hasaki-logo.png, 200×200 PNG), copied unmodified to web/public/brand/hasaki-logo.png.
 * The official mark is dark green; it is never recoloured — it is always shown on a light plate. The UI palette is
 * built from the same green plus black, so the product matches the logo. To replace the logo, overwrite
 * web/public/brand/hasaki-logo.png (keep it square) — nothing else references the file directly.
 */
export const BRAND = {
  product: "Hasaki AI Workspace",
  tagline: "Your Intelligent Engineering Headquarters",
  company: "Hasaki",
  logoUrl: "/brand/hasaki-logo.png",
  logoSource:
    "Official Hasaki logo from the internal oms-frontend repository (public/hasaki-logo.png), unmodified",
  /** UI accent = logo green. */
  green: "#2f6b4f",
  black: "#111513",
  /** Colour of the official logo mark, for places that must match it (e.g. pixel signage). */
  logoGreen: "#2f6b4f",
} as const;
