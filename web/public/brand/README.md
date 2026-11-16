# Brand assets

| File              | Source                                                                                                                          | Notes                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `hasaki-logo.png` | Official Hasaki logo from the company's internal `oms-frontend` repository (`public/hasaki-logo.png`, used on its login layout) | Copied byte-for-byte (sha256 prefix `7c696229e8e1aad8`). 200×200 RGBA, dark-green mark + "HASAKI" wordmark. |

Rules

- Never recolour or distort the logo. It is always shown on a light plate (`BrandLogo`, office wall sign).
- The UI palette (`--brand*` in `web/src/styles.css`) is built from the logo green plus black; the logo itself is never recoloured.
- The chibi uniforms and pixel signage use a small stylised pixel "H" emblem (`web/src/office/brand.tsx`), because a
  200×200 raster logo cannot be drawn at 5×3 pixels; it is a decorative emblem, not a replacement for the logo.

Replacing: overwrite `hasaki-logo.png` (square, transparent background preferred). All UI reads it through
`web/src/brand/brand.ts` → `BRAND.logoUrl`.
