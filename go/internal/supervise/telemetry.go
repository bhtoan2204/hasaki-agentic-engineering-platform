package supervise

import (
	"context"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

var (
	tracer = otel.Tracer("platform-go/supervise")
	meter  = otel.Meter("platform-go/supervise")
)

// record exports one span per supervised process and its metrics (no-ops unless OpenTelemetry is configured).
// Run and attempt ids are span attributes for trace correlation; metric attributes are bounded (class, outcome,
// isolation) so per-run labels never create series.
func record(o Options, r *Report) {
	ctx := context.Background()
	end := time.Now()
	start := end.Add(-time.Duration(r.DurationMs) * time.Millisecond)
	_, span := tracer.Start(ctx, "process.supervise", trace.WithTimestamp(start), trace.WithAttributes(
		attribute.String("run.id", o.RunID), attribute.String("attempt.id", o.AttemptID),
		attribute.String("process.class", o.Class), attribute.String("process.outcome", r.Outcome),
		attribute.String("process.isolation", r.Isolation), attribute.Int("process.orphans", r.Orphans),
		attribute.Int("process.killed", r.Killed), attribute.Int64("process.memory_peak_bytes", r.Usage.MemoryPeakBytes),
	))
	span.End(trace.WithTimestamp(end))
	attrs := metric.WithAttributes(attribute.String("class", o.Class), attribute.String("outcome", r.Outcome),
		attribute.String("isolation", r.Isolation))
	h := func(name, unit string, v float64) {
		if m, err := meter.Float64Histogram(name, metric.WithUnit(unit)); err == nil {
			m.Record(ctx, v, attrs)
		}
	}
	c := func(name string, v int64) {
		if m, err := meter.Int64Counter(name); err == nil && v > 0 {
			m.Add(ctx, v, attrs)
		}
	}
	h("process.start_latency", "ms", r.StartLatencyMs)
	h("process.admission_wait", "ms", float64(r.AdmissionWaitMs))
	h("process.duration", "ms", float64(r.DurationMs))
	h("process.cleanup_duration", "ms", r.CleanupMs)
	h("process.memory_peak", "By", float64(r.Usage.MemoryPeakBytes))
	h("process.cpu_time", "ms", float64(r.Usage.CPUMs))
	h("process.cpu_throttled", "ms", float64(r.Usage.CPUThrottledMs))
	h("process.io_pressure", "ms", float64(r.Usage.PSI.IOSomeMs))
	c("process.runs", 1)
	c("process.orphans", int64(r.Orphans))
	c("process.oom_kills", r.Usage.OOMKills)
	c("process.limit_events", r.Usage.MemoryMaxEvents+r.Usage.PidsMaxEvents)
}
