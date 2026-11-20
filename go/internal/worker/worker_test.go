package worker

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBackoffIsCappedFullJitter(t *testing.T) {
	for attempt := range 40 {
		for range 50 {
			d := Backoff(attempt, 100*time.Millisecond, time.Second)
			if d < 0 || d >= time.Second || (attempt == 0 && d >= 100*time.Millisecond) {
				t.Fatalf("attempt %d: %v", attempt, d)
			}
		}
	}
}

func TestPolicyRetriesTransientErrorsWithinBudgetAndHonoursRetryAfter(t *testing.T) {
	budget := NewBudget(3)
	p := Policy{MaxAttempts: 5, Base: time.Millisecond, Cap: 2 * time.Millisecond, MaxRetryAfter: time.Second, Budget: budget}
	calls := 0
	start := time.Now()
	err := p.Do(context.Background(), "op", func(context.Context) error {
		calls++
		if calls == 1 {
			return &Retryable{Err: errors.New("429"), RetryAfter: 150 * time.Millisecond}
		}
		if calls < 3 {
			return &Retryable{Err: errors.New("503")}
		}
		return nil
	})
	if err != nil || calls != 3 || time.Since(start) < 150*time.Millisecond {
		t.Fatalf("err=%v calls=%d after %v", err, calls, time.Since(start))
	}
	// One retry left in the job's budget: a second call fails after two attempts.
	calls = 0
	err = p.Do(context.Background(), "op", func(context.Context) error { calls++; return &Retryable{Err: errors.New("503")} })
	if err == nil || calls != 2 {
		t.Fatalf("budget: err=%v calls=%d", err, calls)
	}
	// Permanent errors and a Retry-After longer than allowed are not retried.
	calls = 0
	_ = Policy{MaxAttempts: 5}.Do(context.Background(), "op", func(context.Context) error { calls++; return errors.New("403") })
	if calls != 1 {
		t.Fatalf("permanent retried %d times", calls)
	}
	calls = 0
	_ = Policy{MaxAttempts: 5, MaxRetryAfter: time.Second}.Do(context.Background(), "op", func(context.Context) error {
		calls++
		return &Retryable{Err: errors.New("429"), RetryAfter: time.Hour}
	})
	if calls != 1 {
		t.Fatalf("hour-long Retry-After retried %d times", calls)
	}
}

func TestLimiterRateAndPause(t *testing.T) {
	l := NewLimiter(20, 2)
	ctx := context.Background()
	start := time.Now()
	for range 4 { // burst 2, then 2 more at 20/s ≈ 100 ms
		if err := l.Wait(ctx, "p"); err != nil {
			t.Fatal(err)
		}
	}
	if d := time.Since(start); d < 80*time.Millisecond {
		t.Fatalf("4 tokens in %v", d)
	}
	l.Pause("p", 200*time.Millisecond)
	start = time.Now()
	_ = l.Wait(ctx, "p")
	if d := time.Since(start); d < 180*time.Millisecond {
		t.Fatalf("Retry-After pause ignored: %v", d)
	}
	if err := l.Wait(ctx, "other"); err != nil { // keys are independent
		t.Fatal(err)
	}
}

func TestKeepCancelsOnLostLeaseAndOnCancellation(t *testing.T) {
	lost := atomic.Bool{}
	ctx, stop := Keep(context.Background(), 10*time.Millisecond, time.Second, func(context.Context) (bool, error) {
		if lost.Load() {
			return false, ErrLeaseLost
		}
		return false, nil
	})
	defer stop()
	time.Sleep(30 * time.Millisecond)
	if ctx.Err() != nil {
		t.Fatal("canceled while the lease holds")
	}
	lost.Store(true)
	<-ctx.Done()
	if !errors.Is(context.Cause(ctx), ErrLeaseLost) {
		t.Fatal(context.Cause(ctx))
	}
	ctx2, stop2 := Keep(context.Background(), 10*time.Millisecond, time.Second, func(context.Context) (bool, error) { return true, nil })
	defer stop2()
	<-ctx2.Done()
	if !errors.Is(context.Cause(ctx2), ErrCancelRequested) {
		t.Fatal(context.Cause(ctx2))
	}
	// Heartbeats failing for longer than the lease: assume it was recovered elsewhere.
	ctx3, stop3 := Keep(context.Background(), 10*time.Millisecond, 50*time.Millisecond, func(context.Context) (bool, error) {
		return false, errors.New("database unreachable")
	})
	defer stop3()
	<-ctx3.Done()
	if !errors.Is(context.Cause(ctx3), ErrLeaseLost) {
		t.Fatal(context.Cause(ctx3))
	}
}

type fakeJob struct {
	run func(ctx context.Context) error
}

func (j fakeJob) QueuedFor() time.Duration      { return 0 }
func (j fakeJob) Run(ctx context.Context) error { return j.run(ctx) }

type fakeQueue struct {
	mu      sync.Mutex
	pending int
	running atomic.Int32
	peak    atomic.Int32
	done    atomic.Int32
	block   chan struct{}
}

func (q *fakeQueue) Kind() string { return "fake" }
func (q *fakeQueue) Claim(context.Context) (Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.pending == 0 {
		return nil, nil
	}
	q.pending--
	return fakeJob{run: func(ctx context.Context) error {
		n := q.running.Add(1)
		for p := q.peak.Load(); n > p && !q.peak.CompareAndSwap(p, n); p = q.peak.Load() {
		}
		defer q.running.Add(-1)
		select {
		case <-q.block:
		case <-ctx.Done():
			return ctx.Err()
		}
		q.done.Add(1)
		return nil
	}}, nil
}

func TestRunnerBoundsConcurrencyAndShutsDownGracefully(t *testing.T) {
	q := &fakeQueue{pending: 7, block: make(chan struct{})}
	r := &Runner{Queue: q, Size: 2, PollInterval: time.Hour, Log: slog.New(slog.DiscardHandler)}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() { r.Run(ctx); close(stopped) }()
	time.Sleep(50 * time.Millisecond)
	if q.running.Load() != 2 {
		t.Fatalf("running %d, want the pool size 2 (the rest stays queued)", q.running.Load())
	}
	for range 5 { // finishing jobs frees slots that claim at once, without waiting for the poll
		q.block <- struct{}{}
	}
	time.Sleep(50 * time.Millisecond)
	if q.done.Load() != 5 || q.peak.Load() > 2 {
		t.Fatalf("done %d peak %d", q.done.Load(), q.peak.Load())
	}
	cancel() // shutdown cancels the two running jobs and waits for them
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("runner did not stop")
	}
	if q.running.Load() != 0 {
		t.Fatal("jobs still running after shutdown")
	}
	// An idle runner claims when woken.
	q2 := &fakeQueue{block: make(chan struct{})}
	r2 := &Runner{Queue: q2, Size: 1, PollInterval: time.Hour, Log: slog.New(slog.DiscardHandler)}
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	go r2.Run(ctx2)
	time.Sleep(20 * time.Millisecond)
	q2.mu.Lock()
	q2.pending = 1
	q2.mu.Unlock()
	r2.Wake()
	time.Sleep(50 * time.Millisecond)
	if q2.running.Load() != 1 {
		t.Fatal("wake did not claim")
	}
}
