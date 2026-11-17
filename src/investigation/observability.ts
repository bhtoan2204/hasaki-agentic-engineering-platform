import { splunkConnected } from "../integrations/splunk.ts";
import { signozEnabled } from "../integrations/signoz.ts";

export type ObservabilityProvider = "splunk" | "signoz";

/**
 * Production telemetry sources for an investigation (inputs.observability): splunk | signoz | both | auto (default:
 * every source the run owner has connected). With nothing connected, auto keeps Splunk, whose manual mode still works.
 * `missing` = selected sources the owner has not connected.
 */
export function selectProviders(choice: unknown) {
  const connected = { splunk: splunkConnected(), signoz: signozEnabled() };
  const value = String(choice ?? "auto").trim().toLowerCase();
  const wanted: ObservabilityProvider[] =
    value === "splunk" || value === "signoz"
      ? [value]
      : value === "both"
        ? ["splunk", "signoz"]
        : (["splunk", "signoz"] as const).filter((p) => connected[p]);
  const providers: ObservabilityProvider[] = wanted.length ? wanted : ["splunk"];
  return { providers, missing: providers.filter((p) => !connected[p]) };
}
