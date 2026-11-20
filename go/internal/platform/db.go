package platform

import (
	"context"
	"fmt"
	"time"

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

// OpenReadOnlyPool opens the analytics pool: every transaction is read-only (writes fail in PostgreSQL itself),
// statements are always planned for their actual parameters (catch-all filters such as "$7 IS NULL OR provider=$7"
// make a generic plan scan everything), JIT is off (compiling large CTE statements costs more than it saves on
// dashboard-sized data), and the server cancels a statement that outlives the request deadline even if the
// client is gone. Connections are opened on demand and closed after a minute idle.
func OpenReadOnlyPool(ctx context.Context, databaseURL string, maxConns int32, statementTimeout time.Duration) (*pgxpool.Pool, error) {
	pc, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	pc.MaxConns, pc.MinConns, pc.MaxConnIdleTime = maxConns, 0, time.Minute
	pc.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe
	for k, v := range map[string]string{
		"default_transaction_read_only": "on",
		"plan_cache_mode":               "force_custom_plan",
		"jit":                           "off",
		"statement_timeout":             fmt.Sprint(statementTimeout.Milliseconds()),
		"application_name":              "platform-go-analytics",
	} {
		pc.ConnConfig.RuntimeParams[k] = v
	}
	pc.ConnConfig.Tracer = queryTracer{tracer: otel.Tracer("platform-go/db")}
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("open analytics pool: %w", err)
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
