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
	"strings"
	"sync"
	"time"

	"claude-task-platform/go/internal/worker"
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
		SlowThresholdMs int `json:"slow_threshold_ms"`
	}
	if err := policy.Do(ctx, "sources", func(ctx context.Context) error {
		return sc.gw.call(ctx, sc, "sources", "", nil, &src)
	}); err != nil {
		return outcome{}, err
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
	var splunk *struct {
		Results  []Row    `json:"results"`
		Messages []string `json:"messages"`
	}
	var splunkErr error
	var signozErrs, signozSlow []Row
	var signozOK bool
	var signozNotes []string
	var signozFatal error
	if useSplunk {
		wg.Go(func() {
			var r struct {
				Results  []Row    `json:"results"`
				Messages []string `json:"messages"`
			}
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
			signozErrs, signozSlow, signozNotes, signozOK, signozFatal = sc.collectSignoz(ctx, policy, src.SlowThresholdMs)
		})
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return outcome{}, err
	}
	// A lost lease or a revoked permission ends the scan whatever the other source returned.
	for _, err := range []error{splunkErr, signozFatal} {
		if permanent(err) {
			return outcome{}, err
		}
	}
	notes = append(notes, signozNotes...)
	if splunkErr != nil {
		if !useSignoz {
			return outcome{}, splunkErr
		}
		notes = append(notes, splunkNotePrefix+splunkErr.Error())
	}
	if splunk == nil && !signozOK {
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
	if signozOK {
		sources = append(sources, Source{Name: "signoz", Rows: signozErrs}, Source{Name: "signoz", Rows: signozSlow})
	}
	groups, err := ToGroups(MergeSourceRows(sources...), sc.Request.Day)
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
	if err := sc.store.publish(ctx, sc, groups, w); err != nil {
		return outcome{}, err
	}
	var events int64
	for _, g := range groups {
		events += int64(g.TodayCount)
	}
	return outcome{groups: int64(len(groups)), events: events, warnings: w}, nil
}

// collectSignoz reads error traces, then latency groups, then the slowest groups' trace gaps (bounded fan-out).
// Like TypeScript, a failed error query drops SigNoz, a failed latency query or gap read only adds a note or an
// empty gap list.
func (sc *Scan) collectSignoz(ctx context.Context, policy worker.Policy, threshold int) (errs, slow []Row, notes []string, ok bool, fatal error) {
	var e struct {
		Rows        []Row    `json:"rows"`
		HasBaseline bool     `json:"has_baseline"`
		Notes       []string `json:"notes"`
	}
	if err := policy.Do(ctx, "signoz-errors", func(ctx context.Context) error {
		return sc.gw.call(ctx, sc, "signoz-errors", signozProvider, nil, &e)
	}); err != nil {
		if permanent(err) {
			return nil, nil, nil, false, err
		}
		return nil, nil, []string{signozNotePrefix + err.Error()}, false, nil
	}
	notes = append(notes, e.Notes...)
	if threshold == 0 {
		return e.Rows, nil, notes, true, nil
	}
	var s struct {
		Rows []Row `json:"rows"`
	}
	if err := policy.Do(ctx, "signoz-slow", func(ctx context.Context) error {
		return sc.gw.call(ctx, sc, "signoz-slow", signozProvider, map[string]any{"has_baseline": e.HasBaseline}, &s)
	}); err != nil {
		if permanent(err) {
			return nil, nil, nil, false, err
		}
		return e.Rows, nil, append(notes, slowNotePrefix+err.Error()), true, nil
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
	return e.Rows, s.Rows, notes, true, nil
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
