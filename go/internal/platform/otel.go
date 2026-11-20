package platform

import (
	"context"
	"errors"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
)

// SetupTelemetry installs OTLP/HTTP trace and metric exporters (configured by the standard OTEL_* env vars).
// When disabled the global no-op providers stay in place.
func SetupTelemetry(ctx context.Context, enabled bool) (func(context.Context) error, error) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	if !enabled {
		return func(context.Context) error { return nil }, nil
	}
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(semconv.ServiceName("platform-go")))
	if err != nil {
		return nil, err
	}
	te, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	me, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(te), sdktrace.WithResource(res))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewPeriodicReader(me)), sdkmetric.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	return func(ctx context.Context) error {
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx))
	}, nil
}
