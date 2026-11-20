package platform

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// RequiredSchemaVersion is the last TypeScript migration this binary depends on (084_semantic_retrieval).
const RequiredSchemaVersion = 84

func OpenPool(ctx context.Context, databaseURL string, maxConns int32) (*pgxpool.Pool, error) {
	pc, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	pc.MaxConns = maxConns
	pc.ConnConfig.Tracer = queryTracer{tracer: otel.Tracer("platform-go/db")}
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	return pool, nil
}

func SchemaVersion(ctx context.Context, db *pgxpool.Pool) (int, error) {
	var v int
	err := db.QueryRow(ctx, "SELECT coalesce(max(version), 0) FROM schema_migrations").Scan(&v)
	if err != nil {
		return 0, fmt.Errorf("read schema_migrations: %w", err)
	}
	return v, nil
}

func CheckSchema(ctx context.Context, db *pgxpool.Pool) error {
	v, err := SchemaVersion(ctx, db)
	if err != nil {
		return err
	}
	if v < RequiredSchemaVersion {
		return fmt.Errorf("schema version %d < required %d: run the TypeScript migrations first", v, RequiredSchemaVersion)
	}
	return nil
}

type queryTracer struct{ tracer trace.Tracer }

type spanKey struct{}

func (t queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !trace.SpanFromContext(ctx).IsRecording() {
		return ctx
	}
	ctx, span := t.tracer.Start(ctx, "db.query", trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(attribute.String("db.system", "postgresql"), attribute.String("db.query.text", data.SQL)))
	return context.WithValue(ctx, spanKey{}, span)
}

func (t queryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	span, ok := ctx.Value(spanKey{}).(trace.Span)
	if !ok {
		return
	}
	if data.Err != nil {
		span.SetStatus(codes.Error, data.Err.Error())
	}
	span.End()
}
