/**
 * Recall benchmark for LATENT Go defects (bugs that raise no error until concurrent traffic hits them), built from
 * real defects that slipped through reviews. Every case has the buggy source, its fixed form and the ground truth.
 *
 * Two things are measured against the same fixture module (latentFixtureFiles()):
 *  - the deterministic probe (src/latentRisk): recall on the seeded cases, and precision on LATENT_DECOYS, correct code
 *    that looks similar. test/latent-risk.test.ts asserts both offline;
 *  - a codebase-assessment run on that module, live: scoreLatentFindings(findings) over the assess step's findings tells
 *    how many of the seeded defects the agent reported. It is the number to watch when the assessment prompt changes.
 *
 * Add a case whenever a latent defect is found in production that an assessment should have caught.
 */
import { bareName } from "../bugHunt/logic.ts";

export interface LatentCase {
  id: string;
  /** Probe rule expected to report it. */
  rule: "shared-instance-closure" | "exposed-guarded-state";
  confidence: "high" | "medium";
  /** The file and symbol (pkg.Receiver.name) a correct finding names. */
  file: string;
  symbol: string;
  why: string;
  buggy: Record<string, string>;
  fixed: Record<string, string>;
}

export const LATENT_CASES: LatentCase[] = [
  {
    id: "event-factory-shared-instance",
    rule: "shared-instance-closure",
    confidence: "high",
    file: "events/events.go",
    symbol: "events.eventToFunc",
    why: "the returned func hands the same prototype to every caller; two goroutines decoding into it race",
    buggy: {
      "events/events.go": `package events

type eventFunc func() interface{}

type OrderPlaced struct{ ID string }

var registry = map[string]eventFunc{
	"order.placed": eventToFunc(&OrderPlaced{}),
}

func eventToFunc(e interface{}) eventFunc {
	return func() interface{} {
		return e
	}
}
`,
    },
    fixed: {
      "events/events.go": `package events

import "reflect"

type eventFunc func() interface{}

type OrderPlaced struct{ ID string }

var registry = map[string]eventFunc{
	"order.placed": eventToFunc(&OrderPlaced{}),
}

func eventToFunc(e interface{}) eventFunc {
	typ := reflect.TypeOf(e).Elem()

	return func() interface{} {
		return reflect.New(typ).Interface()
	}
}
`,
    },
  },
  {
    id: "settings-snapshot-shared-map",
    rule: "shared-instance-closure",
    confidence: "medium",
    file: "settings/snapshot.go",
    symbol: "settings.snapshotOf",
    why: "every caller receives the same map; a caller that edits its snapshot corrupts everyone else's",
    buggy: {
      "settings/snapshot.go": `package settings

func snapshotOf(values map[string]string) func() map[string]string {
	return func() map[string]string {
		return values
	}
}
`,
    },
    fixed: {
      "settings/snapshot.go": `package settings

func snapshotOf(values map[string]string) func() map[string]string {
	return func() map[string]string {
		out := make(map[string]string, len(values))
		for k, v := range values {
			out[k] = v
		}
		return out
	}
}
`,
    },
  },
  {
    id: "registry-items-escape-lock",
    rule: "exposed-guarded-state",
    confidence: "high",
    file: "registry/registry.go",
    symbol: "registry.Registry.Items",
    why: "Items locks and then returns the guarded map: the lock protects nothing once the caller iterates it",
    buggy: {
      "registry/registry.go": `package registry

import "sync"

type Registry struct {
	mu    sync.RWMutex
	items map[string]int
}

func (r *Registry) Set(key string, v int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[key] = v
}

func (r *Registry) Items() map[string]int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.items
}
`,
    },
    fixed: {
      "registry/registry.go": `package registry

import "sync"

type Registry struct {
	mu    sync.RWMutex
	items map[string]int
}

func (r *Registry) Set(key string, v int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[key] = v
}

func (r *Registry) Items() map[string]int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]int, len(r.items))
	for k, v := range r.items {
		out[k] = v
	}
	return out
}
`,
    },
  },
  {
    id: "cache-entries-escape-embedded-lock",
    rule: "exposed-guarded-state",
    confidence: "high",
    file: "cache/accessors.go",
    symbol: "cache.Store.Entries",
    why: "the struct (embedded mutex) and the method live in different files; the returned slice aliases the guarded one",
    buggy: {
      "cache/cache.go": `package cache

import "sync"

type Store struct {
	sync.Mutex
	entries []string
}

func (s *Store) Add(entry string) {
	s.Lock()
	defer s.Unlock()
	s.entries = append(s.entries, entry)
}
`,
      "cache/accessors.go": `package cache

func (s *Store) Entries() []string {
	s.Lock()
	defer s.Unlock()
	return s.entries
}
`,
    },
    fixed: {
      "cache/cache.go": `package cache

import "sync"

type Store struct {
	sync.Mutex
	entries []string
}

func (s *Store) Add(entry string) {
	s.Lock()
	defer s.Unlock()
	s.entries = append(s.entries, entry)
}
`,
      "cache/accessors.go": `package cache

func (s *Store) Entries() []string {
	s.Lock()
	defer s.Unlock()
	return append([]string(nil), s.entries...)
}
`,
    },
  },
];

/** Correct code that looks like the defects above: the probe must not report any of it. */
export const LATENT_DECOYS: Array<{ id: string; why: string; files: Record<string, string> }> = [
  {
    id: "value-and-fresh-closures",
    why: "value types are copied, closures with parameters are not thunks, a call builds a fresh value each time",
    files: {
      "decoys/values.go": `package decoys

import "reflect"

type Config struct{ Name string }

func counterOf(n int) func() int {
	return func() int { return n }
}

func configOf(c Config) func() Config {
	return func() Config { return c }
}

func scaled(f float64) func(int) float64 {
	return func(x int) float64 { return float64(x) * f }
}

func freshEvent(t reflect.Type) func() interface{} {
	return func() interface{} { return reflect.New(t).Interface() }
}

func singleton() func() *Config {
	inst := &Config{}
	return func() *Config { return inst }
}
`,
    },
  },
  {
    id: "guarded-but-copied-or-unlocked",
    why: "no mutex, a locked copy, a locked scalar read, a getter that never takes the lock (another rule's business): nothing escapes a held lock",
    files: {
      "decoys/store.go": `package decoys

import "sync"

type Plain struct{ items map[string]int }

func (p *Plain) Items() map[string]int { return p.items }

type Guarded struct {
	mu    sync.Mutex
	items map[string]int
}

func (g *Guarded) Snapshot() map[string]int {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[string]int, len(g.items))
	for k, v := range g.items {
		out[k] = v
	}
	return out
}

func (g *Guarded) Len() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.items)
}

func (g *Guarded) Raw() map[string]int {
	return g.items
}
`,
    },
  },
];

/** The module an operator points a real codebase-assessment run at: every buggy case plus the decoys. */
export function latentFixtureFiles(): Record<string, string> {
  return {
    "go.mod": "module latent\n\ngo 1.20\n",
    ...Object.assign({}, ...LATENT_CASES.map((c) => c.buggy), ...LATENT_DECOYS.map((d) => d.files)),
  };
}

/** Lines (1-based, inclusive) of the function a case names, found in its buggy source. */
function rangeOf(c: LatentCase): [number, number] {
  const name = bareName(c.symbol);
  const lines = (c.buggy[c.file] ?? "").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^func\\s+(\\([^)]*\\)\\s*)?${name}\\b`).test(l));
  if (start < 0) return [0, 0];
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return [start + 1, (end < 0 ? start : end) + 1];
}

export interface AssessedFinding {
  file?: string;
  symbol?: string;
  line?: number;
  kind?: string;
}

const KINDS = new Set(["CONCURRENCY", "DATA_INTEGRITY"]);

/**
 * Which seeded defects the findings of an assessment of latentFixtureFiles() report: the right file and either the
 * symbol or a line inside the function, under a concurrency-type kind. extra counts findings that match no seeded case
 * (not necessarily wrong: the decoys and the rest of the module may hold real issues, so no precision is claimed).
 */
export function scoreLatentFindings(
  findings: AssessedFinding[],
  cases: LatentCase[] = LATENT_CASES,
) {
  const matched: string[] = [];
  const used = new Set<number>();
  for (const c of cases) {
    const [from, to] = rangeOf(c);
    const hit = findings.findIndex(
      (f, i) =>
        !used.has(i) &&
        KINDS.has(String(f.kind ?? "").toUpperCase()) &&
        String(f.file ?? "")
          .replace(/^\.\//, "")
          .endsWith(c.file) &&
        ((!!f.symbol && f.symbol.includes(bareName(c.symbol))) ||
          (typeof f.line === "number" && f.line >= from && f.line <= to)),
    );
    if (hit >= 0) {
      used.add(hit);
      matched.push(c.id);
    }
  }
  return {
    recall: cases.length ? matched.length / cases.length : 0,
    matched,
    missed: cases.filter((c) => !matched.includes(c.id)).map((c) => c.id),
    extra: findings.length - used.size,
  };
}
