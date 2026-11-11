/** Full names wrap; the same hierarchy is used in chart labels and service tables. */
export function ServiceIdentityCell({
  service,
  namespace,
  onSelect,
}: {
  service: string;
  namespace: string;
  onSelect?: () => void;
}) {
  const name = onSelect ? (
    <button type="button" className="link-button service-identity-name" onClick={onSelect}>
      {service}
    </button>
  ) : (
    <span className="service-identity-name">{service}</span>
  );
  return (
    <span className="service-identity">
      {name}
      <small>{namespace}</small>
    </span>
  );
}
