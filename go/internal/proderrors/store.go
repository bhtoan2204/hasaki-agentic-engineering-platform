package proderrors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hasaki-orbit/go/internal/worker"
)

// RequiredSchemaVersion is the migration whose columns this module writes (114_prod_errors_hardening: partial, sources).
const RequiredSchemaVersion = 114

// Lease is how long a claim holds without a heartbeat; heartbeats run at a third of it.
const Lease = 30 * time.Second

// Request is the window fixed when the scan was queued (src/prodErrors/jobs.ts ScanRequest).
type Request struct {
	Preset     string   `json:"preset"`
	Namespaces []string `json:"namespaces"`
	Day        string   `json:"day"`
	HM         string   `json:"hm"`
	Start      int64    `json:"start"`
	End        int64    `json:"end"`
	BaseStart  int64    `json:"baseStart"`
	BaseEnd    int64    `json:"baseEnd"`
}

// Scan is a claimed job row.
type Scan struct {
	ID       int64
	Trigger  string
	Fence    int64
	Stage    string
	Request  Request
	Attempts int
	queued   time.Duration
	store    *Store
	gw       *Gateway
	cfg      Config
}

// Store is the job table, prod_error_scans (rows with engine = 'go').
type Store struct {
	DB    *pgxpool.Pool
	Owner string
}

// claim takes the oldest due Go scan: attempt + 1, a new fencing token, a lease to this process.
func (s *Store) claim(ctx context.Context) (*Scan, error) {
	var sc Scan
	var req []byte
	var queued float64
	err := s.DB.QueryRow(ctx, `
		UPDATE prod_error_scans SET status='running', attempts=attempts+1, fencing_token=fencing_token+1,
		  lease_owner=$1, lease_expires_at=now()+make_interval(secs => $2), heartbeat_at=now(),
		  started_at=CASE WHEN attempts=0 THEN now() ELSE started_at END,
		  progress=COALESCE(progress, jsonb_build_object('phase','connect','pct',2,'searchPct',0,'scanned',0,'matched',0,
		    'startedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
		WHERE id=(SELECT id FROM prod_error_scans WHERE engine='go' AND status='queued' AND available_at<=now()
		            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
		RETURNING id, trigger, fencing_token, stage, request, attempts, extract(epoch FROM now()-queued_at)`,
		s.Owner, Lease.Seconds()).Scan(&sc.ID, &sc.Trigger, &sc.Fence, &sc.Stage, &req, &sc.Attempts, &queued)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(req, &sc.Request); err != nil {
		return nil, fmt.Errorf("scan %d request: %w", sc.ID, err)
	}
	sc.queued = time.Duration(queued * float64(time.Second))
	return &sc, nil
}

// heartbeat extends the lease and stores progress (nil keeps it). ErrLeaseLost when the fence no longer holds.
func (s *Store) heartbeat(ctx context.Context, sc *Scan, progress map[string]any) (bool, error) {
	var p []byte
	if progress != nil {
		p, _ = json.Marshal(progress)
	}
	var cancel bool
	err := s.DB.QueryRow(ctx, `
		UPDATE prod_error_scans SET lease_expires_at=now()+make_interval(secs => $3), heartbeat_at=now(),
		  progress=CASE WHEN $4::jsonb IS NULL THEN progress ELSE COALESCE(progress,'{}'::jsonb) || $4::jsonb END
		WHERE id=$1 AND fencing_token=$2 AND status='running' RETURNING cancel_requested`,
		sc.ID, sc.Fence, Lease.Seconds(), p).Scan(&cancel)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, worker.ErrLeaseLost
	}
	return cancel, err
}

// publish writes the scan's groups and observations and marks it published, in one transaction under the fence.
// A group a newer scan already wrote keeps the newer values (last_scan_id), so a slow older scan never wins.
func (s *Store) publish(ctx context.Context, sc *Scan, groups []Group, warnings *string, partial bool, reports map[string]*sourceReport) error {
	rows, err := json.Marshal(groups)
	if err != nil {
		return err
	}
	sources, err := json.Marshal(reports)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
		var one int
		err := tx.QueryRow(ctx, `SELECT 1 FROM prod_error_scans WHERE id=$1 AND fencing_token=$2 AND status='running' FOR UPDATE`,
			sc.ID, sc.Fence).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return worker.ErrLeaseLost
		}
		if err != nil {
			return err
		}
		if len(groups) > 0 {
			if _, err := tx.Exec(ctx, upsertGroups, rows, sc.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, insertObservations, rows, sc.ID); err != nil {
				return err
			}
		}
		// The warnings are kept with the stage, so a resumed finalize reports them too.
		_, err = tx.Exec(ctx, `UPDATE prod_error_scans SET stage='published', error=$2, partial=$3, sources=$4 WHERE id=$1`,
			sc.ID, warnings, partial, sources)
		return err
	})
}

// The same statements as src/prodErrors/scan.ts publishGroups (both engines publish identically).
const upsertGroups = `
INSERT INTO prod_error_groups (fingerprint, namespace, service, level, caller, signature, sample, detail, day,
  today_count, yesterday_count, first_at, last_at, severity, score, reasons, last_scan_id)
SELECT g.fingerprint, g.namespace, g.service, g.level, g.caller, g.signature, g.sample, g.detail, g.day,
  g.today_count, g.yesterday_count, g.first_at, g.last_at, g.severity, g.score, g.reasons, $2
FROM jsonb_to_recordset($1::jsonb) AS g(fingerprint text, namespace text, service text, level text, caller text,
  signature text, sample text, detail jsonb, day date, today_count int, yesterday_count int, first_at timestamptz,
  last_at timestamptz, severity text, score int, reasons jsonb)
ON CONFLICT (fingerprint) DO UPDATE SET last_scan_id = excluded.last_scan_id, caller = excluded.caller,
  sample = excluded.sample, detail = excluded.detail, day = excluded.day, today_count = excluded.today_count,
  yesterday_count = excluded.yesterday_count, first_at = excluded.first_at, last_at = excluded.last_at,
  severity = excluded.severity, score = excluded.score, reasons = excluded.reasons, updated_at = now()
WHERE prod_error_groups.last_scan_id IS NULL OR prod_error_groups.last_scan_id <= excluded.last_scan_id`

const insertObservations = `
INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,first_at,last_at,severity,hourly)
SELECT $2, g.fingerprint, g.today_count, g.yesterday_count, g.first_at, g.last_at, g.severity, g.hourly
FROM jsonb_to_recordset($1::jsonb) AS g(fingerprint text, today_count int, yesterday_count int,
  first_at timestamptz, last_at timestamptz, severity text, hourly jsonb)
ON CONFLICT(scan_id,fingerprint) DO NOTHING`

// firstSeen is when each fingerprint was first stored (epoch seconds); a fingerprint never stored is absent.
func (s *Store) firstSeen(ctx context.Context, fingerprints []string) (map[string]float64, error) {
	out := map[string]float64{}
	if len(fingerprints) == 0 {
		return out, nil
	}
	rows, err := s.DB.Query(ctx,
		`SELECT fingerprint, extract(epoch FROM first_seen_at)::float8 FROM prod_error_groups WHERE fingerprint = ANY($1)`,
		fingerprints)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var fp string
		var at float64
		if err := rows.Scan(&fp, &at); err != nil {
			return nil, err
		}
		out[fp] = at
	}
	return out, rows.Err()
}

// finish ends the job (fenced). ok/status/finished_at mirror the TypeScript engine's final update.
func (s *Store) finish(ctx context.Context, sc *Scan, status string, errText *string, groups, events, notified *int64) error {
	tag, err := s.DB.Exec(ctx, `
		UPDATE prod_error_scans SET status=$3, ok=($3='succeeded'), finished_at=now(), error=$4,
		  groups=COALESCE($5, groups), events=COALESCE($6, events), notified=COALESCE($7, notified),
		  lease_owner=NULL, lease_expires_at=NULL, progress=NULL
		WHERE id=$1 AND fencing_token=$2 AND status='running'`,
		sc.ID, sc.Fence, status, errText, groups, events, notified)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return worker.ErrLeaseLost
	}
	return nil
}

// release gives a job back on shutdown (no attempt is charged twice: the next claim counts its own).
func (s *Store) release(ctx context.Context, sc *Scan) error {
	_, err := s.DB.Exec(ctx, `
		UPDATE prod_error_scans SET status='queued', available_at=now(), lease_owner=NULL, lease_expires_at=NULL,
		  fencing_token=fencing_token+1, attempts=GREATEST(attempts-1, 0)
		WHERE id=$1 AND fencing_token=$2 AND status='running'`, sc.ID, sc.Fence)
	return err
}

// SchemaReady reports whether the TypeScript migrations this module needs have run.
func (s *Store) SchemaReady(ctx context.Context) error {
	var v int
	if err := s.DB.QueryRow(ctx, "SELECT coalesce(max(version),0) FROM schema_migrations").Scan(&v); err != nil {
		return err
	}
	if v < RequiredSchemaVersion {
		return fmt.Errorf("schema version %d < %d: production error scans stay with TypeScript", v, RequiredSchemaVersion)
	}
	return nil
}
