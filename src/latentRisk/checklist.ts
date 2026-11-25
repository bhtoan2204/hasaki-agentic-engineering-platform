/**
 * Prompt text for the latent-defect sweep, shared by the assessment (find them) and the review (stop them landing).
 * Latent defects raise no error, log or failing test until concurrent traffic reaches them, so the signal-first
 * assessment never points at them. The deterministic probe (detectors.ts) lists candidates of two shapes; this text
 * makes the agent look for the rest.
 */

/** Added to the assessment instructions (Go repositories). */
export const LATENT_SWEEP =
  "(4) Sweep for LATENT defects: bugs that raise no error, log or failing test until concurrent traffic hits them, so the signals above never point at them and reading only hotspots misses them. " +
  "For Go repositories do a targeted pattern sweep with search_code / find_dependencies over the whole repository: " +
  "(a) every function that returns a func() T (factory, provider, prototype, handler or event constructor): does each call produce a FRESH value? A closure that returns a captured pointer, map, slice or interface{} gives every caller the same instance, a data race as soon as two requests mutate it; " +
  "(b) registries and maps of constructors, and package-level singletons that are written after init; " +
  "(c) getters that take a lock and then return an internal map or slice (the lock protects nothing once the caller holds the value); " +
  "(d) structs holding a mutex or map that are copied by value; " +
  "(e) decode / unmarshal targets, bytes.Buffer or sync.Pool objects reused across requests without a reset; " +
  "(f) goroutines started in a loop that capture the loop variable or write one shared result. " +
  "The platform runs a deterministic probe for (a) and (c) and lists its candidates in your context as 'latent-risk probe': confirm or drop each one against the code, report the true ones as kind CONCURRENCY (or DATA_INTEGRITY) with the symbol, and do not stop at its list, it knows only those two shapes. " +
  "Such a finding is implementable when a test can demonstrate it under go test -race (see the CONCURRENCY recipe). ";

/** Added to the review instructions: the same shapes, judged on the diff. */
export const LATENT_REVIEW_RULE =
  "Latent-defect rule (Go): for every added or changed function that returns a closure (func() T), a constructor or factory, or hands out internal state, check that each call returns a FRESH value. " +
  "A closure that returns a captured pointer, map, slice or interface{} to every caller shares one instance (for example func eventToFunc(e interface{}) eventFunc { return func() interface{} { return e } }; the fix allocates per call, e.g. reflect.New(typ).Interface()), " +
  "and a getter that locks and then returns an internal map or slice leaks the guarded state: both are data races under concurrent use, report them as high even though every test passes. " +
  "The platform's latent-risk probe lists candidates in your context: confirm or drop each one, and say which call path lets two goroutines reach the shared value. ";
