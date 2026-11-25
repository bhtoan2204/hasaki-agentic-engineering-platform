import type { Untyped } from "../../untyped.ts";
import { type Actor } from "../../authz/access.ts";

export type Ctx = {
  p: string[];
  body: Untyped;
  url: URL;
  actor: Actor;
  /** Aborts when every client waiting for this response has disconnected. */
  signal?: AbortSignal;
};

export type Route = [method: string, pattern: RegExp, handler: (c: Ctx) => unknown];
