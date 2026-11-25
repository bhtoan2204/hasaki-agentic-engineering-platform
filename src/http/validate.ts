import type { ZodType, z } from "zod";
import { HttpError } from "./error.ts";

/**
 * A request body that does not match its schema: 400 with the same envelope as every other HttpError, plus the
 * field-level reasons in `details` (errorResponse() in app.ts reads `errors`).
 */
export class ValidationError extends HttpError {
  errors: string[];
  constructor(errors: string[]) {
    super(400, "Invalid request body");
    this.errors = errors;
  }
}

/** Parses `body` against `schema`; throws ValidationError listing each failing field (at most 20). */
export function parseBody<S extends ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new ValidationError(
    result.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "(body)"}: ${issue.message}`),
  );
}
