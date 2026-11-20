package worker

import (
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Backoff is capped exponential backoff with full jitter: uniform in [0, min(cap, base·2^attempt)).
func Backoff(attempt int, base, cap time.Duration) time.Duration {
	ceiling := cap
	if attempt < 30 {
		ceiling = min(cap, base<<attempt)
	}
	if ceiling <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(ceiling)))
}

// Budget is the number of retries one job may spend across all of its calls, so a degraded provider costs a
// bounded number of extra requests per job however many calls the job makes.
type Budget struct{ left atomic.Int64 }

func NewBudget(n int) *Budget {
	b := &Budget{}
	b.left.Store(int64(n))
	return b
}

// Take spends one retry; false when the budget is exhausted.
func (b *Budget) Take() bool { return b.left.Add(-1) >= 0 }

// Retryable is an error the callee marked as transient, optionally with the provider's Retry-After.
type Retryable struct {
	Err        error
	RetryAfter time.Duration
}

func (e *Retryable) Error() string { return e.Err.Error() }
func (e *Retryable) Unwrap() error { return e.Err }

var retries, _ = meter.Int64Counter("worker.retries", metric.WithDescription("retried calls by operation"))

// Policy retries Retryable errors with Backoff, honouring Retry-After (capped by MaxRetryAfter), within the job's
// Budget and at most MaxAttempts per call.
type Policy struct {
	MaxAttempts   int
	Base, Cap     time.Duration
	MaxRetryAfter time.Duration
	Budget        *Budget
}

// Do runs fn until it succeeds, fails permanently, or the attempts or budget run out (the last error is returned).
func (p Policy) Do(ctx context.Context, op string, fn func(ctx context.Context) error) error {
	for attempt := 0; ; attempt++ {
		err := fn(ctx)
		var r *Retryable
		if err == nil || !errors.As(err, &r) || attempt+1 >= p.MaxAttempts || ctx.Err() != nil {
			return err
		}
		if p.Budget != nil && !p.Budget.Take() {
			return err
		}
		wait := Backoff(attempt, p.Base, p.Cap)
		if r.RetryAfter > 0 {
			if r.RetryAfter > p.MaxRetryAfter {
				return err // the provider asked for longer than this job may wait
			}
			wait = r.RetryAfter
		}
		retries.Add(ctx, 1, metric.WithAttributes(attribute.String("op", op)))
		select {
		case <-ctx.Done():
			return err
		case <-time.After(wait):
		}
	}
}

// Limiter is a token bucket per key (provider): rate per second, burst at once. Wait blocks until a token is free,
// or until the provider's Retry-After has passed (Pause), or ctx ends.
type Limiter struct {
	mu      sync.Mutex
	rate    float64
	burst   float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	at     time.Time
	until  time.Time // paused by Retry-After
}

func NewLimiter(rate float64, burst int) *Limiter {
	return &Limiter{rate: rate, burst: float64(burst), buckets: map[string]*bucket{}}
}

func (l *Limiter) Wait(ctx context.Context, key string) error {
	for {
		l.mu.Lock()
		now := time.Now()
		b := l.buckets[key]
		if b == nil {
			b = &bucket{tokens: l.burst, at: now}
			l.buckets[key] = b
		}
		b.tokens = min(l.burst, b.tokens+now.Sub(b.at).Seconds()*l.rate)
		b.at = now
		var wait time.Duration
		switch {
		case now.Before(b.until):
			wait = b.until.Sub(now)
		case b.tokens >= 1:
			b.tokens--
			l.mu.Unlock()
			return nil
		default:
			wait = time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
		}
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// Pause holds every caller of key until d has passed (a provider's Retry-After applies to all of its callers).
func (l *Limiter) Pause(key string, d time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.burst, at: time.Now()}
		l.buckets[key] = b
	}
	if until := time.Now().Add(d); until.After(b.until) {
		b.until = until
	}
}
