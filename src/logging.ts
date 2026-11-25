import { inspect } from "node:util";
import { redactSecrets } from "./integrations/redact.ts";

export function logError(
  event: string,
  msg: string,
  error: unknown,
  fields: Record<string, string | number | null | undefined> = {},
) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : inspect(error, { customInspect: false });
  console.error(
    JSON.stringify({
      ...fields,
      time: new Date().toISOString(),
      level: "ERROR",
      event,
      msg,
      error: redactSecrets(message),
      ...(error instanceof Error && {
        error_name: error.name,
        ...(error.stack && { stack: redactSecrets(error.stack) }),
        ...("code" in error && typeof error.code === "string" && { error_code: error.code }),
        ...(error.cause !== undefined && {
          cause: redactSecrets(inspect(error.cause, { customInspect: false })),
        }),
      }),
    }),
  );
}
