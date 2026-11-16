/** A model the worker's CLI reported for the signed-in account. */
export type CatalogModel = string | { slug: string; name?: string };

function asModel(model: CatalogModel): { slug: string; name?: string } {
  return typeof model === "string" ? { slug: model } : model;
}

/** Account-default option plus the models this provider can actually run. */
export function ModelSelect({
  value,
  models,
  onChange,
  emptyLabel,
  ariaLabel,
  disabled,
}: {
  value: string;
  models?: CatalogModel[] | null;
  onChange: (slug: string) => void;
  emptyLabel: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const known = (models ?? []).map(asModel).filter((m) => m.slug);
  const extra = value && !known.some((m) => m.slug === value) ? value : "";
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {extra && <option value={extra}>{extra}</option>}
      {known.map((m) => (
        <option key={m.slug} value={m.slug}>
          {m.name && m.name !== m.slug ? `${m.slug} — ${m.name}` : m.slug}
        </option>
      ))}
    </select>
  );
}
