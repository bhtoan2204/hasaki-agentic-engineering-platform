import { log } from "./logging.ts";
import { redactSecrets } from "./integrations/redact.ts";
import { countIgnoredError } from "./runtimeMetrics.ts";

/**
 * For an error that is deliberately and harmlessly swallowed: `promise.catch(ignoreError("telegram.queue"))`.
 * Behaviour is the same as `.catch(() => {})`, but the error is counted (runtime metrics `ignored_errors`) and logged at
 * debug level, so a swallowed failure that starts happening a lot is visible. `context` is a short fixed label for the
 * call site (no ids, no user data): it becomes a metric key.
 */
export function ignoreError(context: string): (error: unknown) => void {
  return (error) => {
    countIgnoredError(context);
    log.debug(
      `ignored error (${context}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
  };
}
