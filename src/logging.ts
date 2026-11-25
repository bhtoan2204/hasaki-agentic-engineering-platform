import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import { redactSecrets } from "./integrations/redact.ts";

/**
 * Leveled logger. Two output modes, chosen per call:
 * - NODE_ENV=production (or LOG_FORMAT=json): one JSON object per line, secrets redacted, with the request's
 *   correlation id when the call runs inside an HTTP request (runWithLogContext).
 * - otherwise: the message and details go to console.log/warn/error unchanged, so developer terminals, and tests that
 *   assert on console output, see exactly what a bare console call printed.
 * LOG_LEVEL (debug|info|warn|error, default info) drops quieter messages in both modes.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SINK: Record<LogLevel, "debug" | "log" | "warn" | "error"> = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

export interface LogContext {
  request_id?: string;
  correlation_id?: string;
}
const context = new AsyncLocalStorage<LogContext>();

/** Runs `fn` so every log call inside it (also across awaits) carries these ids. */
export function runWithLogContext<T>(ids: LogContext, fn: () => T): T {
  return context.run(ids, fn);
}
export const currentLogContext = (): LogContext => context.getStore() ?? {};

const jsonMode = () => process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json";

function threshold(): number {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return raw && raw in ORDER ? ORDER[raw as LogLevel] : ORDER.info;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return inspect(value, { customInspect: false, depth: 4 });
}

function emitJson(level: LogLevel, message: string, details: unknown[]) {
  const fields = details.map((d) => redactSecrets(describe(d)));
  console[SINK[level]](
    JSON.stringify({
      ...currentLogContext(),
      time: new Date().toISOString(),
      level: level.toUpperCase(),
      msg: redactSecrets(message),
      ...(fields.length && { details: fields }),
    }),
  );
}

function write(level: LogLevel, message: string, details: unknown[]) {
  if (ORDER[level] < threshold()) return;
  if (jsonMode()) emitJson(level, message, details);
  else console[SINK[level]](message, ...details);
}

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export const log: Logger = {
  debug: (message, ...details) => write("debug", message, details),
  info: (message, ...details) => write("info", message, details),
  warn: (message, ...details) => write("warn", message, details),
  error: (message, ...details) => write("error", message, details),
};

/** A structured error record (always JSON, also outside production). Fields must not hold secrets or personal data. */
export function logError(
  event: string,
  msg: string,
  error: unknown,
  fields: Record<string, string | number | null | undefined> = {},
) {
  const message = describe(error);
  console.error(
    JSON.stringify({
      ...currentLogContext(),
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
