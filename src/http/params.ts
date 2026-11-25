import { HttpError } from "./error.ts";

/** IDs reach PostgreSQL as JavaScript numbers, so reject values that would round to another ID. */
export function positiveId(raw: string, parameter?: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new HttpError(400, parameter ? `invalid ${parameter}` : `invalid id "${raw}"`);
  return value;
}

/** Optional offsets, cursors and limits. An omitted or empty value keeps the endpoint's existing default. */
export function queryInteger(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw == null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `invalid ${name}`);
  return value;
}
