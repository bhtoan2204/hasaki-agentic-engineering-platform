import { BRAND } from "./brand.ts";

/**
 * The official Hasaki logo on a light plate (it is never recoloured). `size` is the plate size in px.
 * `withName` adds the product name/tagline next to it (sidebar, loading screen).
 */
export function BrandLogo({
  size = 38,
  withName = false,
  subtitle = BRAND.tagline,
}: {
  size?: number;
  withName?: boolean;
  subtitle?: string;
}) {
  const plate = (
    <span
      className="brand-plate"
      style={{ width: size, height: size }}
      aria-hidden={withName || undefined}
    >
      <img
        src={BRAND.logoUrl}
        alt={withName ? "" : BRAND.company}
        width={size}
        height={size}
        draggable={false}
      />
    </span>
  );
  if (!withName) return plate;
  return (
    <span className="brand-lockup">
      {plate}
      <span className="brand-text">
        <span className="brand-name">{BRAND.product}</span>
        {subtitle && <span className="brand-sub">{subtitle}</span>}
      </span>
    </span>
  );
}
