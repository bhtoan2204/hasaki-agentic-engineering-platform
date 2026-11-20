// Package worker runs durable background jobs whose queue is a PostgreSQL table owned by the job's module (ADR
// 0004). It is deliberately small: a module supplies Claim (an atomic UPDATE … FOR UPDATE SKIP LOCKED that bumps a
// fencing token and sets a lease) and Run; the package supplies the loop around them:
//
//   - a bounded pool (Size jobs at once): a full pool does not claim, so excess work waits in the table
//     (backpressure) instead of in memory;
//   - wake-ups from TypeScript (Wake) plus a slow fallback poll, so an idle instance costs one indexed query per
//     PollInterval and no extra database connection (no LISTEN);
//   - a lease keeper per job (Keep) that heartbeats, and cancels the job's context when the lease is lost or a
//     cancellation was requested;
//   - graceful shutdown: stop claiming, cancel running jobs, wait for them to release their leases;
//   - OpenTelemetry: claim/run spans, queue wait, duration, outcomes and saturation.
package worker

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// Job is one claimed unit of work.
type Job interface {
	// QueuedFor is how long the job waited between being queued and being claimed.
	QueuedFor() time.Duration
	// Run executes the job. The context ends on shutdown, lost lease or requested cancellation.
	Run(ctx context.Context) error
}

// Queue is a module's job table.
type Queue interface {
	Kind() string
	// Claim takes the next due job or returns (nil, nil) when there is none.
	Claim(ctx context.Context) (Job, error)
}

// Runner claims and runs a Queue's jobs on a bounded pool.
type Runner struct {
	Queue        Queue
	Size         int
	PollInterval time.Duration
	Log          *slog.Logger

	wake chan struct{}
	once sync.Once
}

func (r *Runner) init() {
	r.once.Do(func() { r.wake = make(chan struct{}, 1) })
}

// Wake asks the runner to claim now (TypeScript queued a job). Never blocks.
func (r *Runner) Wake() {
	r.init()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

var (
	tracer = otel.Tracer("platform-go/worker")
	meter  = otel.Meter("platform-go/worker")

	jobsTotal, _   = meter.Int64Counter("worker.jobs", metric.WithDescription("finished jobs by kind and outcome"))
	queueWait, _   = meter.Float64Histogram("worker.queue_wait", metric.WithUnit("s"), metric.WithDescription("time from queued to claimed"))
	jobDuration, _ = meter.Float64Histogram("worker.job.duration", metric.WithUnit("s"))
	busyJobs, _    = meter.Int64UpDownCounter("worker.busy", metric.WithDescription("jobs running (saturation = busy / size)"))
	claimErrors, _ = meter.Int64Counter("worker.claim.errors")
)

// Run claims and runs jobs until ctx ends, then cancels the running jobs and waits for them.
func (r *Runner) Run(ctx context.Context) {
	r.init()
	size := max(1, r.Size)
	slots := make(chan struct{}, size)
	var wg sync.WaitGroup
	kind := attribute.String("job.kind", r.Queue.Kind())
	tick := time.NewTicker(max(time.Second, r.PollInterval))
	defer tick.Stop()
	defer wg.Wait()
	for {
		// Fill free slots; stop at the first empty claim.
		for len(slots) < size && ctx.Err() == nil {
			job, err := r.claim(ctx, kind)
			if err != nil {
				claimErrors.Add(ctx, 1, metric.WithAttributes(kind))
				r.Log.Warn("job claim failed", "kind", r.Queue.Kind(), "error", err)
				break
			}
			if job == nil {
				break
			}
			slots <- struct{}{}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-slots; r.Wake() }() // a freed slot may take the next job at once
				r.run(ctx, kind, job)
			}()
		}
		select {
		case <-ctx.Done():
			return
		case <-r.wake:
		case <-tick.C:
		}
	}
}

func (r *Runner) claim(ctx context.Context, kind attribute.KeyValue) (Job, error) {
	ctx, span := tracer.Start(ctx, "job.claim", trace.WithAttributes(kind))
	defer span.End()
	job, err := r.Queue.Claim(ctx)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
	}
	return job, err
}

func (r *Runner) run(ctx context.Context, kind attribute.KeyValue, job Job) {
	queueWait.Record(ctx, job.QueuedFor().Seconds(), metric.WithAttributes(kind))
	busyJobs.Add(ctx, 1, metric.WithAttributes(kind))
	defer busyJobs.Add(context.WithoutCancel(ctx), -1, metric.WithAttributes(kind))
	ctx, span := tracer.Start(ctx, "job.run", trace.WithAttributes(kind))
	defer span.End()
	start := time.Now()
	err := job.Run(ctx)
	outcome := "succeeded"
	switch {
	case errors.Is(err, ErrLeaseLost):
		outcome = "lease_lost"
	case errors.Is(err, context.Canceled):
		outcome = "canceled"
	case err != nil:
		outcome = "failed"
		span.SetStatus(codes.Error, err.Error())
	}
	done := context.WithoutCancel(ctx)
	jobDuration.Record(done, time.Since(start).Seconds(), metric.WithAttributes(kind, attribute.String("outcome", outcome)))
	jobsTotal.Add(done, 1, metric.WithAttributes(kind, attribute.String("outcome", outcome)))
	if err != nil && outcome != "succeeded" {
		r.Log.Info("job ended", "kind", r.Queue.Kind(), "outcome", outcome, "error", err)
	}
}

// ErrLeaseLost: another owner holds the job now; the worker must stop and write nothing.
var ErrLeaseLost = errors.New("job lease lost")

// Heartbeat extends a lease. It reports whether cancellation was requested, and ErrLeaseLost when the lease is gone.
type Heartbeat func(ctx context.Context) (cancelRequested bool, err error)

// Keep heartbeats every interval until the returned stop is called. The returned context is canceled when the lease
// is lost (Cause: ErrLeaseLost) or a cancellation is requested (Cause: ErrCancelRequested). Transient heartbeat
// errors are tolerated until the lease would have expired.
func Keep(ctx context.Context, interval, lease time.Duration, beat Heartbeat) (context.Context, func()) {
	ctx, cancel := context.WithCancelCause(ctx)
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		lastOK := time.Now()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
			}
			hctx, hcancel := context.WithTimeout(context.WithoutCancel(ctx), interval)
			cancelRequested, err := beat(hctx)
			hcancel()
			switch {
			case errors.Is(err, ErrLeaseLost):
				cancel(ErrLeaseLost)
				return
			case err != nil:
				if time.Since(lastOK) > lease {
					cancel(ErrLeaseLost) // could not renew in time: assume someone else recovered it
					return
				}
			default:
				lastOK = time.Now()
				if cancelRequested {
					cancel(ErrCancelRequested)
					return
				}
			}
		}
	}()
	return ctx, func() { close(done); cancel(nil) }
}

// ErrCancelRequested: an operator asked for the job to stop.
var ErrCancelRequested = errors.New("cancellation requested")
