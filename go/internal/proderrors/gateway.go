package proderrors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"hasaki-orbit/go/internal/worker"
)

// Gateway calls the TypeScript provider gateway (src/prodErrors/gateway.ts). It never sees provider credentials:
// TypeScript performs each Splunk/SigNoz read as the scan's requesting user after re-checking the fence and that
// user's permission. Only the internal bearer token travels; no request or response body is logged.
type Gateway struct {
	URL     string // the supervising platform server, e.g. http://127.0.0.1:3000
	Token   string
	Client  *http.Client
	Limiter *worker.Limiter
}

// GatewayError is a non-2xx answer: Code is the contract's error code.
type GatewayError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *GatewayError) Error() string { return e.Message }

// Permanent errors end the scan without retrying: the lease moved on, or the user may no longer scan.
func permanent(err error) bool {
	var g *GatewayError
	return errors.As(err, &g) && (g.Code == "lease_lost" || g.Code == "revoked" || g.Status == http.StatusUnauthorized)
}

var gwTracer = otel.Tracer("platform-go/proderrors")

// call posts one operation for scan sc and decodes the answer into out. Transient failures come back as
// *worker.Retryable (with the provider's Retry-After, which also pauses every caller of that provider).
func (g *Gateway) call(ctx context.Context, sc *Scan, op, provider string, in map[string]any, out any) error {
	if provider != "" {
		if err := g.Limiter.Wait(ctx, provider); err != nil {
			return err
		}
	}
	ctx, span := gwTracer.Start(ctx, "gateway."+op, trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.Int64("scan.id", sc.ID), attribute.String("provider", provider)))
	defer span.End()
	if in == nil {
		in = map[string]any{}
	}
	in["fence"] = sc.Fence
	body, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/internal/v1/prod-errors/scans/%d/%s", g.URL, sc.ID, op), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header.Set("Content-Type", "application/json")
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(req.Header))
	res, err := g.Client.Do(req)
	if err != nil {
		span.SetStatus(codes.Error, "transport")
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &worker.Retryable{Err: fmt.Errorf("platform gateway unreachable: %w", err)}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return &worker.Retryable{Err: fmt.Errorf("platform gateway read: %w", err)}
	}
	span.SetAttributes(attribute.Int("http.response.status_code", res.StatusCode))
	if res.StatusCode/100 == 2 {
		return json.Unmarshal(raw, out)
	}
	var e struct {
		Error        string `json:"error"`
		Code         string `json:"code"`
		Retryable    bool   `json:"retryable"`
		RetryAfterMs *int64 `json:"retry_after_ms"`
	}
	_ = json.Unmarshal(raw, &e)
	if e.Error == "" {
		e.Error = fmt.Sprintf("platform gateway HTTP %d", res.StatusCode)
	}
	span.SetStatus(codes.Error, e.Code)
	gerr := &GatewayError{Status: res.StatusCode, Code: e.Code, Message: e.Error, Retryable: e.Retryable}
	if !e.Retryable && res.StatusCode < 500 {
		return gerr
	}
	var wait time.Duration
	if e.RetryAfterMs != nil {
		wait = time.Duration(*e.RetryAfterMs) * time.Millisecond
	} else if s, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil {
		wait = time.Duration(s) * time.Second
	}
	if wait > 0 && provider != "" {
		g.Limiter.Pause(provider, wait)
	}
	return &worker.Retryable{Err: gerr, RetryAfter: wait}
}
