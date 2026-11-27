// Package proderrors runs production error scans claimed from prod_error_scans (engine = 'go', ADR 0004): it
// collects from Splunk and SigNoz through the TypeScript provider gateway with bounded fan-out, provider rate
// limits, Retry-After and a per-job retry budget; groups the rows exactly like src/prodErrors/scan.ts; publishes
// groups and observations in one fenced transaction; and has TypeScript notify and ingest (finalize).
package proderrors

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"hasaki-orbit/go/internal/worker"
)

type Config struct {
	// Per gateway call; MaxAttempts includes the first.
	MaxAttempts int
	// Retries one scan may spend across all of its calls.
	RetryBudget int
	// Longest provider Retry-After a scan waits for; longer ones fail the call.
	MaxRetryAfter time.Duration
	// Concurrent trace-gap reads per scan.
	GapFanOut int
}

func DefaultConfig() Config {
	return Config{MaxAttempts: 3, RetryBudget: 6, MaxRetryAfter: 2 * time.Minute, GapFanOut: 3}
}

// Queue is the worker.Queue of production error scans.
type Queue struct {
	Store   *Store
	Gateway *Gateway
	Config  Config
	Log     *slog.Logger
}

func (q *Queue) Kind() string { return "prod_error_scan" }

func (q *Queue) Claim(ctx context.Context) (worker.Job, error) {
	sc, err := q.Store.claim(ctx)
	if sc == nil || err != nil {
		return nil, err
	}
	sc.store, sc.gw, sc.cfg = q.Store, q.Gateway, q.Config
	return sc, nil
}

func (sc *Scan) QueuedFor() time.Duration { return sc.queued }

// progress is what the page shows; written with the next heartbeat when it changed (the Splunk phase's detail is
// written by the gateway itself, so it is not overwritten from here).
type progress struct {
	mu    sync.Mutex
	pct   int
	dirty map[string]any
}

func (p *progress) phase(name string, pct int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pct = max(p.pct, pct)
	p.dirty = map[string]any{"phase": name, "pct": p.pct}
}

func (p *progress) take() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	d := p.dirty
	p.dirty = nil
	return d
}

const (
	notConnected        = "chưa kết nối Splunk hay SigNoz — kết nối ít nhất một nguồn ở trang Integrations"
	expiredNoSignoz     = "phiên Splunk hết hạn và chưa kết nối SigNoz — dán cookie Splunk mới hoặc kết nối SigNoz ở trang Integrations"
	noteSplunkExpired   = "Splunk: phiên hết hạn, chỉ quét SigNoz"
	noteSplunkMissing   = "Splunk: chưa kết nối, chỉ quét SigNoz"
	nothingScanned      = "không quét được nguồn log nào"
	canceledMessage     = "canceled"
	slowNotePrefix      = "SigNoz (request chậm): "
	signozNotePrefix    = "SigNoz: "
	splunkNotePrefix    = "Splunk: "
	maxGapGroups        = 5
	splunkProvider      = "splunk"
	signozProvider      = "signoz"
	failureNoticeLength = 2000
)

// Run executes the scan under its lease. A lost lease returns worker.ErrLeaseLost and writes nothing; a requested
// cancellation ends it as canceled; shutdown releases it for another instance.
func (sc *Scan) Run(parent context.Context) error {
	prog := &progress{pct: 2}
	ctx, stop := worker.Keep(parent, Lease/3, Lease, func(ctx context.Context) (bool, error) {
		return sc.store.heartbeat(ctx, sc, prog.take())
	})
	defer stop()
	policy := worker.Policy{MaxAttempts: sc.cfg.MaxAttempts, Base: 500 * time.Millisecond, Cap: 30 * time.Second,
		MaxRetryAfter: sc.cfg.MaxRetryAfter, Budget: worker.NewBudget(sc.cfg.RetryBudget)}
	result, err := sc.collectAndPublish(ctx, policy, prog)
	db := context.WithoutCancel(parent)
	switch cause := context.Cause(ctx); {
	case errors.Is(err, worker.ErrLeaseLost) || errors.Is(cause, worker.ErrLeaseLost) || permanentCode(err, "lease_lost"):
		return worker.ErrLeaseLost
	case errors.Is(cause, worker.ErrCancelRequested):
		msg := canceledMessage
		return errors.Join(context.Canceled, sc.store.finish(db, sc, "canceled", &msg, nil, nil, nil))
	case parent.Err() != nil:
		// Shutdown: hand the scan back unless it is already published (then the next owner only finalizes).
		return errors.Join(context.Canceled, sc.store.release(db, sc))
	case err != nil:
		msg := err.Error()
		var out struct{}
		_ = sc.gw.call(db, sc, "finalize", "", map[string]any{"outcome": "failed", "error": truncate(msg, failureNoticeLength)}, &out)
		return errors.Join(err, sc.store.finish(db, sc, "failed", &msg, nil, nil, nil))
	}
	prog.phase("notify", 98)
	var fin struct {
		Notified int64 `json:"notified"`
	}
	if err := policy.Do(ctx, "finalize", func(ctx context.Context) error {
		return sc.gw.call(ctx, sc, "finalize", "", map[string]any{"outcome": "succeeded"}, &fin)
	}); err != nil {
		if errors.Is(context.Cause(ctx), worker.ErrLeaseLost) || permanentCode(err, "lease_lost") {
			return worker.ErrLeaseLost
		}
		if permanentCode(err, "revoked") {
			msg := err.Error()
			return errors.Join(err, sc.store.finish(db, sc, "failed", &msg, &result.groups, &result.events, nil))
		}
		// Published but not finalized: the lease expiry hands it to the next attempt, which only finalizes.
		return err
	}
	return sc.store.finish(db, sc, "succeeded", result.warnings, &result.groups, &result.events, &fin.Notified)
}

func permanentCode(err error, code string) bool {
	var g *GatewayError
	return errors.As(err, &g) && g.Code == code
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

type outcome struct {
	groups, events int64
	warnings       *string
}

// sourceReport is what one source gave this scan (prod_error_scans.sources): a failed source makes the scan partial,
// a cut one is only shown.
type sourceReport struct {
	Status         string   `json:"status"` // ok | failed | skipped
	Error          string   `json:"error,omitempty"`
	Truncated      bool     `json:"truncated,omitempty"`
	Rows           int      `json:"rows"`
	PartialReasons []string `json:"partial_reasons,omitempty"`
	Slow           string   `json:"slow,omitempty"` // SigNoz latency groups: ok | failed | off
}

// partial: some source that should have answered did not (or its latency groups did not).
func partial(reports map[string]*sourceReport) bool {
	for _, r := range reports {
		if r.Status == "failed" || r.Slow == "failed" {
			return true
		}
	}
	return false
}

func (sc *Scan) collectAndPublish(ctx context.Context, policy worker.Policy, prog *progress) (outcome, error) {
	if sc.Stage == "published" {
		return sc.store.published(ctx, sc)
	}
	var src struct {
		Splunk struct {
			Connected bool `json:"connected"`
			Expired   bool `json:"expired"`
		} `json:"splunk"`
		Signoz struct {
			Enabled bool `json:"enabled"`
		} `json:"signoz"`
		SlowThresholdMs int        `json:"slow_threshold_ms"`
		SeverityV2      bool       `json:"severity_v2"`
		Thresholds      Thresholds `json:"thresholds"`
	}
	if err := policy.Do(ctx, "sources", func(ctx context.Context) error {
		return sc.gw.call(ctx, sc, "sources", "", nil, &src)
	}); err != nil {
		return outcome{}, err
	}
	if src.Thresholds == (Thresholds{}) {
		src.Thresholds = DefaultThresholds()
	}
	useSplunk, useSignoz := src.Splunk.Connected, src.Signoz.Enabled
	if !useSplunk && !useSignoz {
		if src.Splunk.Expired {
			return outcome{}, errors.New(expiredNoSignoz)
		}
		return outcome{}, errors.New(notConnected)
	}
	var notes []string
	if !useSplunk {
		if src.Splunk.Expired {
			notes = append(notes, noteSplunkExpired)
		} else {
			notes = append(notes, noteSplunkMissing)
		}
		prog.phase("search", 30)
	}

	var wg sync.WaitGroup
	type splunkReply struct {
		Results        []Row    `json:"results"`
		Messages       []string `json:"messages"`
		Truncated      bool     `json:"truncated"`
		PartialReasons []string `json:"partial_reasons"`
	}
	var splunk *splunkReply
	var splunkErr error
	var sz signozResult
	if useSplunk {
		wg.Go(func() {
			var r splunkReply
			splunkErr = policy.Do(ctx, "splunk", func(ctx context.Context) error {
				return sc.gw.call(ctx, sc, "splunk", splunkProvider, nil, &r)
			})
			if splunkErr == nil {
				splunk = &r
			}
		})
	}
	if useSignoz {
		wg.Go(func() {
			sz = sc.collectSignoz(ctx, policy, src.SlowThresholdMs)
		})
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return outcome{}, err
	}
	// A lost lease or a revoked permission ends the scan whatever the other source returned.
	for _, err := range []error{splunkErr, sz.fatal} {
		if permanent(err) {
			return outcome{}, err
		}
	}
	notes = append(notes, sz.notes...)
	if splunkErr != nil {
		if !useSignoz {
			return outcome{}, splunkErr
		}
		notes = append(notes, splunkNotePrefix+splunkErr.Error())
	}
	if splunk == nil && !sz.ok {
		if len(notes) > 0 {
			return outcome{}, errors.New(strings.Join(notes, "; "))
		}
		return outcome{}, errors.New(nothingScanned)
	}

	prog.phase("group", 92)
	var sources []Source
	if splunk != nil {
		sources = append(sources, Source{Name: "splunk", Rows: splunk.Results})
	}
	if sz.ok {
		sources = append(sources, Source{Name: "signoz", Rows: sz.errs}, Source{Name: "signoz", Rows: sz.slow})
	}
	merged := MergeSourceRows(sources...)
	known, err := sc.store.firstSeen(ctx, Fingerprints(merged))
	if err != nil {
		return outcome{}, err
	}
	groups, err := ToGroups(merged, sc.Request.Day, &Context{
		WindowHours:   float64(sc.Request.End-sc.Request.Start) / 3600,
		BaselineHours: float64(sc.Request.BaseEnd-sc.Request.BaseStart) / 3600,
		WindowEnd:     float64(sc.Request.End),
		Known:         known,
		Thresholds:    src.Thresholds,
		V2:            src.SeverityV2,
	})
	if err != nil {
		return outcome{}, err
	}
	prog.phase("save", 95)
	var warnings []string
	if splunk != nil {
		for _, m := range splunk.Messages {
			if !strings.HasPrefix(m, "INFO") {
				warnings = append(warnings, m)
			}
		}
	}
	warnings = append(warnings, notes...)
	var w *string
	if len(warnings) > 0 {
		s := strings.Join(warnings, "; ")
		w = &s
	}
	reports := map[string]*sourceReport{
		"splunk": {Status: "skipped", Error: skipReason(src.Splunk.Expired, noteSplunkExpired, noteSplunkMissing)},
		"signoz": {Status: "skipped"},
	}
	if useSplunk {
		reports["splunk"] = &sourceReport{Status: "failed", Error: truncate(errText(splunkErr), 500)}
		if splunk != nil {
			reports["splunk"] = &sourceReport{Status: "ok", Rows: len(splunk.Results), Truncated: splunk.Truncated, PartialReasons: splunk.PartialReasons}
		}
	} else if src.Splunk.Expired {
		// A session that ran out is a failure of a source that used to answer: its groups stay on the page as stale.
		reports["splunk"].Status = "failed"
	}
	if useSignoz {
		reports["signoz"] = &sourceReport{Status: "failed", Error: truncate(strings.Join(sz.notes, "; "), 500)}
		if sz.ok {
			status := "ok"
			if sz.degraded {
				// Answered, but its namespace values match nothing configured: a warning, not a missing source.
				status = "degraded"
			}
			reports["signoz"] = &sourceReport{Status: status, Rows: len(sz.errs), Truncated: sz.truncated, Slow: sz.slowState}
		}
	}
	if err := sc.store.publish(ctx, sc, groups, w, partial(reports), reports); err != nil {
		return outcome{}, err
	}
	var events int64
	for _, g := range groups {
		events += int64(g.TodayCount)
	}
	return outcome{groups: int64(len(groups)), events: events, warnings: w}, nil
}

// signozResult is what collectSignoz found: its rows, why it is partial, and whether SigNoz cut its error groups.
type signozResult struct {
	errs, slow []Row
	notes      []string
	ok         bool
	fatal      error
	truncated  bool
	degraded   bool
	slowState  string // ok | failed | off
}

func skipReason(expired bool, ifExpired, ifMissing string) string {
	if expired {
		return ifExpired
	}
	return ifMissing
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// collectSignoz reads error traces, then latency groups, then the slowest groups' trace gaps (bounded fan-out).
// Like TypeScript, a failed error query drops SigNoz, a failed latency query or gap read only adds a note or an
// empty gap list.
func (sc *Scan) collectSignoz(ctx context.Context, policy worker.Policy, threshold int) signozResult {
	var e struct {
		Rows        []Row    `json:"rows"`
		HasBaseline bool     `json:"has_baseline"`
		Truncated   bool     `json:"truncated"`
		Degraded    bool     `json:"degraded"`
		Notes       []string `json:"notes"`
	}
	if err := policy.Do(ctx, "signoz-errors", func(ctx context.Context) error {
		return sc.gw.call(ctx, sc, "signoz-errors", signozProvider, nil, &e)
	}); err != nil {
		if permanent(err) {
			return signozResult{fatal: err}
		}
		return signozResult{notes: []string{signozNotePrefix + err.Error()}}
	}
	notes := slices.Clone(e.Notes)
	if threshold == 0 {
		return signozResult{errs: e.Rows, notes: notes, ok: true, truncated: e.Truncated, degraded: e.Degraded, slowState: "off"}
	}
	var s struct {
		Rows []Row `json:"rows"`
	}
	if err := policy.Do(ctx, "signoz-slow", func(ctx context.Context) error {
		return sc.gw.call(ctx, sc, "signoz-slow", signozProvider, map[string]any{"has_baseline": e.HasBaseline}, &s)
	}); err != nil {
		if permanent(err) {
			return signozResult{fatal: err}
		}
		return signozResult{errs: e.Rows, notes: append(notes, slowNotePrefix+err.Error()), ok: true, truncated: e.Truncated, degraded: e.Degraded, slowState: "failed"}
	}
	byTodayDesc(s.Rows) // TypeScript sorts the latency rows in place before picking the slowest
	var top []Row
	for _, r := range s.Rows[:min(maxGapGroups, len(s.Rows))] {
		if _, isMap := r["slow"].(map[string]any); isMap && truthy(get(r, "trace_id")) {
			top = append(top, r)
		}
	}
	sem := make(chan struct{}, max(1, sc.cfg.GapFanOut))
	var wg sync.WaitGroup
	for _, r := range top {
		sem <- struct{}{}
		wg.Go(func() {
			defer func() { <-sem }()
			var g struct {
				Gaps []any `json:"gaps"`
			}
			err := policy.Do(ctx, "signoz-trace-gaps", func(ctx context.Context) error {
				return sc.gw.call(ctx, sc, "signoz-trace-gaps", signozProvider, map[string]any{"trace_id": jsString(r["trace_id"])}, &g)
			})
			if err != nil || g.Gaps == nil {
				g.Gaps = []any{}
			}
			r["slow"].(map[string]any)["gaps"] = g.Gaps
		})
	}
	wg.Wait()
	return signozResult{errs: e.Rows, slow: s.Rows, notes: notes, ok: true, truncated: e.Truncated, degraded: e.Degraded, slowState: "ok"}
}

// published resumes a scan whose groups were already written (a crash between publishing and finalizing).
func (s *Store) published(ctx context.Context, sc *Scan) (outcome, error) {
	var o outcome
	err := s.DB.QueryRow(ctx, `
		SELECT count(*), COALESCE(sum(event_count),0), (SELECT error FROM prod_error_scans WHERE id=$1)
		FROM prod_error_observations WHERE scan_id=$1`, sc.ID).Scan(&o.groups, &o.events, &o.warnings)
	if err != nil {
		return o, fmt.Errorf("resume published scan %d: %w", sc.ID, err)
	}
	return o, nil
}
