/**
 * Offline Production Bug Hunter benchmark: one Go module (`shop`) with seeded defects, the production incidents they
 * cause (persisted evidence only: signature, error, stack, caller, image), the ground truth, and a deterministic
 * scripted agent for the three agent roles (investigator, hunter, verifier).
 *
 * The scripted agents are deliberately imperfect, so the platform's gates are what is measured:
 *  - the hunter proposes the seeded defect AND plausible false candidates (correct code that looks suspicious);
 *  - the verifier is credulous: it says CONFIRMED for every claim it can write a focused test for. Its tests are the
 *    reference reproductions; for correct code they pass, so only the platform's reproduction run separates them.
 *  - the investigator (arm A's only agent) uses the stack-top heuristic: the top in-repo frame is the root cause.
 * Results show the infrastructure behaves (gates, reproduction, causality separation, reuse) — NOT a model's ability to
 * find bugs.
 */
import { goFunctions, parseFrames } from "../bugHunt/logic.ts";

export type BugHuntScenario =
  | "real-bug"
  | "misleading-stacktrace"
  | "correct-code-suspected"
  | "retry-amplification"
  | "race-condition"
  | "idempotency"
  | "nil-edge-case"
  | "transaction-consistency"
  | "missing-cancellation"
  | "recurring-incident";

export const MODULE = "shop";

/** Source files of the fixture repository (path → content). Every defect is reachable from real inputs. */
export const FIXTURE_FILES: Record<string, string> = {
  "go.mod": `module ${MODULE}\n\ngo 1.20\n`,
  "pricing/discount.go": `package pricing

// Apply returns the price after a percentage discount (pct in 0..100).
func Apply(price, pct int) int {
	if pct <= 0 {
		return price
	}
	// BUG: integer division first: any pct < 100 discounts nothing.
	return price - price*(pct/100)
}
`,
  "orders/loader.go": `package orders

type Customer struct{ Name string }
type Order struct {
	ID       string
	Customer *Customer
}

// Fill loads the order's relations. Contract: Customer is never nil after Fill.
func Fill(o *Order, customers map[string]*Customer, owner string) {
	if c, ok := customers[owner]; ok {
		o.Customer = c
	}
	// BUG: a guest order (owner not found) keeps a nil Customer, breaking the contract.
}
`,
  "orders/render.go": `package orders

import "fmt"

// Format renders a filled order (Fill guarantees a customer).
func Format(o *Order) string {
	return fmt.Sprintf("%s for %s", o.ID, o.Customer.Name)
}

// Show loads and renders one order.
func Show(o *Order, customers map[string]*Customer, owner string) string {
	Fill(o, customers, owner)
	return Format(o)
}
`,
  "partner/client.go": `package partner

import (
	"encoding/json"
	"errors"
)

var ErrRejected = errors.New("partner rejected the request")

type reply struct {
	Code string \`json:"code"\`
}

// Parse decodes the partner's reply; a non-OK code is the partner's rejection, reported as such.
func Parse(body []byte) error {
	var r reply
	if err := json.Unmarshal(body, &r); err != nil {
		return err
	}
	if r.Code != "OK" {
		return ErrRejected
	}
	return nil
}
`,
  "retry/retry.go": `package retry

import "errors"

type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return "http error" }

// Do calls fn up to attempts times, retrying only transient failures (5xx).
func Do(attempts int, fn func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = fn(); err == nil {
			return nil
		}
		var h *HTTPError
		// BUG: the status check is inverted: 4xx (permanent) errors are retried, amplifying load on the partner.
		if errors.As(err, &h) && h.Status >= 500 {
			return err
		}
	}
	return err
}
`,
  "stock/store.go": `package stock

import "sync"

type Store struct {
	mu        sync.Mutex
	available int
	afterRead func() // test seam: runs between the read and the write
}

func New(n int) *Store { return &Store{available: n} }

// Reserve takes q units if available.
func (s *Store) Reserve(q int) bool {
	s.mu.Lock()
	n := s.available
	s.mu.Unlock()
	if s.afterRead != nil {
		f := s.afterRead
		s.afterRead = nil
		f()
	}
	if n < q {
		return false
	}
	// BUG: check-then-act across two critical sections: a concurrent Reserve between them is lost (oversell).
	s.mu.Lock()
	s.available = n - q
	s.mu.Unlock()
	return true
}

func (s *Store) Available() int { s.mu.Lock(); defer s.mu.Unlock(); return s.available }
`,
  "payments/processor.go": `package payments

type Processor struct {
	seen    map[string]bool
	Charges int
}

func NewProcessor() *Processor { return &Processor{seen: map[string]bool{}} }

// Charge charges once per idempotency key.
func (p *Processor) Charge(key, orderID string) {
	if p.seen[key] {
		return
	}
	p.Charges++
	// BUG: records the order id instead of the idempotency key: a retried request is charged again.
	p.seen[orderID] = true
}
`,
  "shipping/fee.go": `package shipping

type Address struct{ Zone int }

// Fee is the shipping fee; a pickup order has no address and ships free.
func Fee(addr *Address) int {
	// BUG: pickup orders (nil address) panic.
	if addr.Zone > 2 {
		return 30
	}
	return 15
}
`,
  "ledger/transfer.go": `package ledger

import "errors"

type Accounts map[string]int

var ErrCredit = errors.New("credit failed")

// Transfer moves amt from a to b atomically: either both change or neither does.
func Transfer(acc Accounts, a, b string, amt int, credit func(string, int) error) error {
	if acc[a] < amt {
		return errors.New("insufficient funds")
	}
	acc[a] -= amt
	if err := credit(b, amt); err != nil {
		// BUG: the debit is not rolled back when the credit fails.
		return err
	}
	return nil
}
`,
  "sync/poll.go": `package sync

import (
	"context"
	"time"
)

// Poll calls fetch until it succeeds, at most tries times, and stops when ctx is canceled.
func Poll(ctx context.Context, tries int, fetch func() bool) error {
	for i := 0; i < tries; i++ {
		// BUG: ctx is never checked: a canceled request keeps polling the partner.
		if fetch() {
			return nil
		}
		time.Sleep(time.Millisecond)
	}
	return ctx.Err()
}
`,
};

interface Repro {
  package_dir: string;
  test_file: string;
  test_name: string;
  test_code: string;
}
interface Suspect {
  file_path: string;
  function: string;
  category: string;
  hypothesis: string;
  trigger: string;
  expected: string;
  actual: string;
  confidence: number;
  /** The credulous verifier's focused test for this claim (null: it cannot write one and says SUSPECTED). */
  repro: Repro | null;
  /** The source line(s) the verifier quotes as code evidence. */
  quote: string;
  incident_link: "SUPPORTED" | "NOT_SUPPORTED" | "UNKNOWN";
}
export interface BugHuntCase {
  id: BugHuntScenario;
  service: string;
  signature: string;
  error: string;
  stack: string | null;
  caller: string;
  /** Ground truth. */
  truth: {
    bugs: Array<{ file_path: string; function: string; category: string }>;
    /** The defect that caused the incident (null: not a code defect). */
    cause: { file_path: string; function: string } | null;
  };
  suspects: Suspect[];
  /** recurring-incident: replays this case's incident (same code) after it was hunted once. */
  replays?: BugHuntScenario;
}

const frame = (fn: string, file: string, line: number) =>
  `${MODULE}/${fn}(...)\n\t/build/src/${MODULE}/${file}:${line} +0x1d`;
const t = (pkg: string, name: string, body: string, imports: string[] = []): Repro => ({
  package_dir: pkg,
  test_file: `${pkg}/bughunt_${name.toLowerCase()}_test.go`,
  test_name: name,
  test_code: `package ${pkg.split("/").pop()}\n\nimport (\n\t"testing"${imports.map((i) => `\n\t"${i}"`).join("")}\n)\n\nfunc ${name}(t *testing.T) {\n${body}\n}\n`,
});

export const BUG_HUNT_CASES: BugHuntCase[] = [
  {
    id: "real-bug",
    service: "pricing-api",
    signature: "discount not applied to order total",
    error: "order total mismatch: discount not applied",
    stack: `goroutine 1 [running]:\n${frame("pricing.Apply", "pricing/discount.go", 9)}`,
    caller: "pricing/discount.go:9",
    truth: {
      bugs: [{ file_path: "pricing/discount.go", function: "Apply", category: "business_logic" }],
      cause: { file_path: "pricing/discount.go", function: "Apply" },
    },
    suspects: [
      {
        file_path: "pricing/discount.go",
        function: "Apply",
        category: "business_logic",
        hypothesis: "pct/100 is integer division, so every discount below 100% is zero",
        trigger: "Apply(1000, 10)",
        expected: "900",
        actual: "1000",
        confidence: 0.9,
        repro: t(
          "pricing",
          "TestBugHuntApplyDiscount",
          '\tif got := Apply(1000, 10); got != 900 {\n\t\tt.Fatalf("Apply(1000,10)=%d, want 900", got)\n\t}',
        ),
        quote: "return price - price*(pct/100)",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "misleading-stacktrace",
    service: "order-api",
    signature: "panic: runtime error: invalid memory address or nil pointer dereference",
    error: "panic: runtime error: invalid memory address or nil pointer dereference",
    stack: `panic: runtime error: invalid memory address or nil pointer dereference\n${frame("orders.Format", "orders/render.go", 7)}\n${frame("orders.Show", "orders/render.go", 13)}`,
    caller: "orders/render.go:7",
    truth: {
      bugs: [{ file_path: "orders/loader.go", function: "Fill", category: "nil_handling" }],
      cause: { file_path: "orders/loader.go", function: "Fill" },
    },
    suspects: [
      {
        file_path: "orders/render.go",
        function: "Format",
        category: "nil_handling",
        hypothesis: "Format dereferences o.Customer without a nil check",
        trigger: 'Format(&Order{ID: "A"})',
        expected: "no panic",
        actual: "nil pointer dereference",
        confidence: 0.8,
        // Calling Format with an unfilled order violates its documented precondition: the test is not a valid
        // reproduction of a Format defect, but the credulous verifier writes it anyway (it fails).
        repro: null,
        quote: 'return fmt.Sprintf("%s for %s", o.ID, o.Customer.Name)',
        incident_link: "SUPPORTED",
      },
      {
        file_path: "orders/loader.go",
        function: "Fill",
        category: "nil_handling",
        hypothesis:
          "Fill leaves Customer nil for guest orders, breaking its never-nil contract that Format relies on",
        trigger: 'Show(order, customers, "guest") with no customer row',
        expected: "a filled Customer (or a guest placeholder)",
        actual: "nil Customer → Format panics",
        confidence: 0.75,
        repro: t(
          "orders",
          "TestBugHuntFillGuest",
          '\to := &Order{ID: "A"}\n\tFill(o, map[string]*Customer{}, "guest")\n\tif o.Customer == nil {\n\t\tt.Fatal("Fill left Customer nil")\n\t}',
        ),
        quote: "o.Customer = c",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "correct-code-suspected",
    service: "partner-gateway",
    signature: "partner rejected the request",
    error: "partner rejected the request",
    stack: `${frame("partner.Parse", "partner/client.go", 21)}`,
    caller: "partner/client.go:21",
    truth: { bugs: [], cause: null },
    suspects: [
      {
        file_path: "partner/client.go",
        function: "Parse",
        category: "error_handling",
        hypothesis: "Parse turns a successful partner reply into ErrRejected",
        trigger: 'Parse({"code":"OK"})',
        expected: "nil",
        actual: "ErrRejected",
        confidence: 0.6,
        repro: t(
          "partner",
          "TestBugHuntParseOK",
          '\tif err := Parse([]byte(`{"code":"OK"}`)); err != nil {\n\t\tt.Fatalf("Parse(OK)=%v", err)\n\t}',
        ),
        quote: "return ErrRejected",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "retry-amplification",
    service: "notify-worker",
    signature: "partner 400 bad request (rate x3)",
    error: "http error",
    stack: `${frame("retry.Do", "retry/retry.go", 13)}`,
    caller: "retry/retry.go:13",
    truth: {
      bugs: [{ file_path: "retry/retry.go", function: "Do", category: "retry_amplification" }],
      cause: { file_path: "retry/retry.go", function: "Do" },
    },
    suspects: [
      {
        file_path: "retry/retry.go",
        function: "Do",
        category: "retry_amplification",
        hypothesis: "the transient check is inverted: 4xx errors are retried and 5xx are not",
        trigger: "Do(3, fn) with fn returning HTTPError{400}",
        expected: "1 call",
        actual: "3 calls",
        confidence: 0.85,
        repro: t(
          "retry",
          "TestBugHuntNoRetryOn400",
          '\tcalls := 0\n\t_ = Do(3, func() error { calls++; return &HTTPError{Status: 400} })\n\tif calls != 1 {\n\t\tt.Fatalf("a 400 was attempted %d times, want 1", calls)\n\t}',
        ),
        quote: "if errors.As(err, &h) && h.Status >= 500 {",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "race-condition",
    service: "stock-api",
    signature: "stock oversold: available below zero",
    error: "stock oversold",
    stack: `${frame("stock.(*Store).Reserve", "stock/store.go", 26)}`,
    caller: "stock/store.go:26",
    truth: {
      bugs: [{ file_path: "stock/store.go", function: "Reserve", category: "race_condition" }],
      cause: { file_path: "stock/store.go", function: "Reserve" },
    },
    suspects: [
      {
        file_path: "stock/store.go",
        function: "(Store).Reserve",
        category: "race_condition",
        hypothesis: "check-then-act across two critical sections loses a concurrent reservation",
        trigger: "two Reserve(1) calls interleaving on 1 unit",
        expected: "one succeeds, available 0",
        actual: "both succeed",
        confidence: 0.8,
        repro: t(
          "stock",
          "TestBugHuntReserveOversell",
          '\ts := New(1)\n\tsecond := false\n\ts.afterRead = func() { second = s.Reserve(1) }\n\tfirst := s.Reserve(1)\n\tif first && second {\n\t\tt.Fatalf("both reservations of the last unit succeeded")\n\t}',
        ),
        quote: "s.available = n - q",
        incident_link: "SUPPORTED",
      },
      {
        file_path: "stock/store.go",
        function: "(Store).Available",
        category: "race_condition",
        hypothesis: "Available reads without synchronization",
        trigger: "concurrent Available and Reserve",
        expected: "a consistent value",
        actual: "a torn read",
        confidence: 0.3,
        repro: null,
        quote:
          "func (s *Store) Available() int { s.mu.Lock(); defer s.mu.Unlock(); return s.available }",
        incident_link: "UNKNOWN",
      },
    ],
  },
  {
    id: "idempotency",
    service: "payment-api",
    signature: "customer charged twice for one order",
    error: "duplicate charge detected",
    stack: `${frame("payments.(*Processor).Charge", "payments/processor.go", 12)}`,
    caller: "payments/processor.go:12",
    truth: {
      bugs: [{ file_path: "payments/processor.go", function: "Charge", category: "idempotency" }],
      cause: { file_path: "payments/processor.go", function: "Charge" },
    },
    suspects: [
      {
        file_path: "payments/processor.go",
        function: "(Processor).Charge",
        category: "idempotency",
        hypothesis:
          "the seen-set stores the order id, not the idempotency key, so a retried request charges again",
        trigger: 'Charge("k1","o1") twice',
        expected: "1 charge",
        actual: "2 charges",
        confidence: 0.85,
        repro: t(
          "payments",
          "TestBugHuntChargeIdempotent",
          '\tp := NewProcessor()\n\tp.Charge("k1", "o1")\n\tp.Charge("k1", "o1")\n\tif p.Charges != 1 {\n\t\tt.Fatalf("charged %d times for one key", p.Charges)\n\t}',
        ),
        quote: "p.seen[orderID] = true",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "nil-edge-case",
    service: "shipping-api",
    signature: "panic: runtime error: invalid memory address or nil pointer dereference",
    error: "panic: nil pointer dereference in shipping fee",
    stack: `panic: runtime error: invalid memory address or nil pointer dereference\n${frame("shipping.Fee", "shipping/fee.go", 8)}`,
    caller: "shipping/fee.go:8",
    truth: {
      bugs: [{ file_path: "shipping/fee.go", function: "Fee", category: "nil_handling" }],
      cause: { file_path: "shipping/fee.go", function: "Fee" },
    },
    suspects: [
      {
        file_path: "shipping/fee.go",
        function: "Fee",
        category: "nil_handling",
        hypothesis: "pickup orders pass a nil address and Fee dereferences it",
        trigger: "Fee(nil)",
        expected: "0 (pickup ships free)",
        actual: "nil pointer panic",
        confidence: 0.9,
        repro: t(
          "shipping",
          "TestBugHuntFeePickup",
          '\tif got := Fee(nil); got != 0 {\n\t\tt.Fatalf("Fee(nil)=%d, want 0", got)\n\t}',
        ),
        quote: "if addr.Zone > 2 {",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "transaction-consistency",
    service: "ledger-api",
    signature: "ledger imbalance after failed transfer",
    error: "credit failed",
    stack: `${frame("ledger.Transfer", "ledger/transfer.go", 15)}`,
    caller: "ledger/transfer.go:15",
    truth: {
      bugs: [
        {
          file_path: "ledger/transfer.go",
          function: "Transfer",
          category: "transaction_consistency",
        },
      ],
      cause: { file_path: "ledger/transfer.go", function: "Transfer" },
    },
    suspects: [
      {
        file_path: "ledger/transfer.go",
        function: "Transfer",
        category: "transaction_consistency",
        hypothesis: "the debit is not rolled back when the credit fails",
        trigger: "Transfer with a failing credit",
        expected: "balance of a unchanged",
        actual: "a debited, b not credited",
        confidence: 0.85,
        repro: t(
          "ledger",
          "TestBugHuntTransferRollback",
          '\tacc := Accounts{"a": 100}\n\t_ = Transfer(acc, "a", "b", 40, func(string, int) error { return ErrCredit })\n\tif acc["a"] != 100 {\n\t\tt.Fatalf("a=%d after a failed transfer, want 100", acc["a"])\n\t}',
        ),
        quote: "acc[a] -= amt",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "missing-cancellation",
    service: "sync-worker",
    signature: "partner polled after request canceled",
    error: "context canceled",
    stack: `${frame("sync.Poll", "sync/poll.go", 12)}`,
    caller: "sync/poll.go:12",
    truth: {
      bugs: [{ file_path: "sync/poll.go", function: "Poll", category: "cancellation" }],
      cause: { file_path: "sync/poll.go", function: "Poll" },
    },
    suspects: [
      {
        file_path: "sync/poll.go",
        function: "Poll",
        category: "cancellation",
        hypothesis: "Poll never checks ctx, so a canceled request keeps calling the partner",
        trigger: "Poll(canceledCtx, 5, fetch)",
        expected: "no fetch",
        actual: "5 fetches",
        confidence: 0.8,
        repro: t(
          "sync",
          "TestBugHuntPollCanceled",
          '\tctx, cancel := context.WithCancel(context.Background())\n\tcancel()\n\tcalls := 0\n\t_ = Poll(ctx, 5, func() bool { calls++; return false })\n\tif calls != 0 {\n\t\tt.Fatalf("fetched %d times after cancel", calls)\n\t}',
          ["context"],
        ),
        quote: "if fetch() {",
        incident_link: "SUPPORTED",
      },
    ],
  },
  {
    id: "recurring-incident",
    service: "pricing-api",
    signature: "discount not applied to order total (recurring)",
    error: "order total mismatch: discount not applied",
    stack: `goroutine 7 [running]:\n${frame("pricing.Apply", "pricing/discount.go", 9)}`,
    caller: "pricing/discount.go:9",
    truth: {
      bugs: [{ file_path: "pricing/discount.go", function: "Apply", category: "business_logic" }],
      cause: { file_path: "pricing/discount.go", function: "Apply" },
    },
    suspects: [],
    replays: "real-bug",
  },
];
// The recurring incident's hunter reports what it finds again: the same defect.
BUG_HUNT_CASES.find((c) => c.id === "recurring-incident")!.suspects = BUG_HUNT_CASES.find(
  (c) => c.id === "real-bug",
)!.suspects;

/** Stable fingerprint per case (20 hex chars like the scanner's). */
export const caseFingerprint = (id: string) =>
  [...id]
    .reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261)
    .toString(16)
    .padStart(8, "0")
    .repeat(3)
    .slice(0, 20);

const lineOf = (file: string, needle: string) => {
  const lines = (FIXTURE_FILES[file] ?? "").split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  return i < 0 ? 0 : i + 1;
};
const bare = (fn: string) => fn.replace(/^.*[.)]/, "");
const spanOf = (file: string, fn: string) =>
  goFunctions(FIXTURE_FILES[file] ?? "").find((f) => f.name === bare(fn)) ?? null;

/**
 * The scripted agent (fake `codex` CLI script mode), one module for all three roles, chosen by the step's instructions.
 * It reads platform outputs through the real MCP tools (read_step_output) and never sees the ground truth.
 */
export function scriptedBugHuntAgent(repository: string): string {
  const table = Object.fromEntries(
    BUG_HUNT_CASES.map((c) => [
      caseFingerprint(c.id),
      {
        // The stack-top heuristic's answer: the top in-repository frame's function.
        top: (() => {
          const f = parseFrames(c.stack, c.caller)[0];
          const file = f?.file.replace(/^.*\/shop\//, "") ?? "";
          const span = f
            ? goFunctions(FIXTURE_FILES[file] ?? "").find(
                (x) => x.start <= f.line && f.line <= x.end,
              )
            : null;
          return span
            ? { file_path: file, function: span.name, line_start: span.start, line_end: span.end }
            : null;
        })(),
        suspects: c.suspects.map((s) => {
          const span = spanOf(s.file_path, s.function);
          const line = lineOf(s.file_path, s.quote);
          return {
            ...s,
            line_start: span?.start ?? line,
            line_end: span?.end ?? line,
            quote_line: line,
          };
        }),
      },
    ]),
  );
  return `const TABLE = ${JSON.stringify(table)};
const REPO = ${JSON.stringify(repository)};
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
export default async ({ call, prompt }) => {
  const context = json(await call("read_step_output", { step_key: "context" })) ?? {};
  const fp = context.incident?.fingerprint ?? /fingerprint: ([0-9a-f]{20})/.exec(prompt)?.[1];
  const row = TABLE[fp] ?? { suspects: [], top: null };
  const scope = json(await call("read_step_output", { step_key: "scope" }));
  const revision = scope?.revisions?.[REPO] ?? "";
  if (prompt.includes("INDEPENDENT verifier of bug claims")) {
    const hunt = await call("read_step_output", { step_key: "hunt" });
    const triage = json(await call("read_step_output", { step_key: "triage" })) ?? {};
    const verdicts = (triage.to_verify ?? []).map((c) => {
      const s = row.suspects.find((x) => x.file_path === c.file_path && x.function.replace(/^.*[.)]/, "") === c.function.replace(/^.*[.)]/, ""));
      if (!s) return { id: c.id, verdict: "SUSPECTED", reason: "no focused test could be written", execution_path: [], code_evidence: [], alternative_explanations: [], incident_link: "UNKNOWN", incident_link_reason: "" };
      return {
        id: c.id,
        verdict: s.repro ? "CONFIRMED" : "SUSPECTED",
        reason: s.repro ? "a focused test demonstrates it" : "plausible from the code; no valid focused test",
        execution_path: [c.function + " reached from the incident's entry point"],
        code_evidence: [{ file_path: c.file_path, line_start: s.quote_line, line_end: s.quote_line, excerpt: s.quote }],
        alternative_explanations: [],
        incident_link: s.incident_link,
        incident_link_reason: "the incident's frames reach this code",
        ...(s.repro ? { reproduction: s.repro } : {}),
      };
    });
    return { summary: "hunt output: " + (hunt.startsWith("ERROR") ? "withheld" : "VISIBLE"), verdicts };
  }
  if (prompt.includes("Hunt for REAL")) {
    return {
      summary: row.suspects.length + " candidate(s)",
      candidates: row.suspects.map((s) => ({
        repository: REPO, commit: revision, file_path: s.file_path, function: s.function,
        line_start: s.line_start, line_end: s.line_end, category: s.category, hypothesis: s.hypothesis,
        trigger: s.trigger, expected: s.expected, actual: s.actual,
        supporting_evidence: ["read " + s.file_path + ":" + s.quote_line], reproduction_strategy: "focused unit test",
        confidence: s.confidence, uncertainty: "scripted",
      })),
      inspected_files: [...new Set(row.suspects.map((s) => s.file_path))],
    };
  }
  // Investigator (arm A, and the investigation inside a hunt): the stack-top heuristic.
  const top = row.top;
  return {
    summary: top ? "the failure surfaces in " + top.function : "no code location",
    hypotheses: top ? [top.function + " is faulty"] : [],
    next_steps: ["verify with a focused test"],
    missing_evidence: ["live logs and traces"],
    claims: top ? [{ id: "c1", claim: top.function + " in " + top.file_path + " causes the incident", classification: "HYPOTHESIS",
      repository: REPO, commit: revision, file_path: top.file_path, line_range: [top.line_start, top.line_end],
      confidence: "medium", verification_status: "unverified" }] : [],
    root_cause_assessment: { status: top ? "PROBABLE" : "INSUFFICIENT_EVIDENCE", confidence: "medium",
      explanation: top ? "top in-repository stack frame" : "no frame", supporting_claims: top ? ["c1"] : [] },
    rca_answer: top ? { file_path: top.file_path, function: top.function } : null,
  };
};`;
}
