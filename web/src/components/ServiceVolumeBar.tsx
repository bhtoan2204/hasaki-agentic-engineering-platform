import "./ServiceVolumeBar.css";
import { ServiceIdentityCell } from "./ServiceIdentityCell.tsx";

/** Receives already-calculated metrics; presentation never changes event/share semantics. */
export function ServiceVolumeBar({
  service,
  namespace,
  value,
  percentage,
  scale,
  color,
  formattedValue,
  formattedPercentage,
  onSelect,
}: {
  service: string;
  namespace: string;
  value: number;
  percentage: number | null;
  scale: number;
  color: string;
  formattedValue: string;
  formattedPercentage: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="service-volume-bar" onClick={onSelect}>
      <ServiceIdentityCell service={service} namespace={namespace} />
      <span className="service-volume-track" aria-hidden="true">
        <span style={{ width: `${scale}%`, background: color }} />
      </span>
      <strong className="service-volume-value" data-value={value}>
        {formattedValue}
      </strong>
      <span className="service-volume-share" data-value={percentage}>
        {formattedPercentage}
      </span>
    </button>
  );
}
