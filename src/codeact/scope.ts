/**
 * Per-execution-scope CodeAct switch. `config.codeAct.enabled` is the installation default; an evaluation variant runs
 * its sample inside `withCodeActScope(enabled, …)` instead of flipping the process-wide flag, so concurrent samples and
 * ordinary conversations keep their own setting (the scope follows the async context into the chat turn it starts).
 * Only evaluation code opens a scope; no request or user input can. Every reader of the switch goes through
 * `codeActEnabled()`; the sandbox, broker and authorization checks are unchanged.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.ts";

const scope = new AsyncLocalStorage<{ enabled: boolean }>();

export function withCodeActScope<T>(enabled: boolean, fn: () => T): T {
  return scope.run({ enabled }, fn);
}
/** The scope's own setting, or undefined outside any scope (then the installation default applies). */
export const codeActScopeValue = (): boolean | undefined => scope.getStore()?.enabled;
export function codeActEnabled(): boolean {
  return scope.getStore()?.enabled ?? config.codeAct.enabled;
}
