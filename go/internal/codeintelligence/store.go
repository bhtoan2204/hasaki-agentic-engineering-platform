package codeintelligence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// dbtx is what both the pool and a transaction offer.
type dbtx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

var errLeaseLost = errors.New("Index lease lost")

type store struct {
	db         *pgxpool.Pool
	version    string
	statements *atomic.Int64
}

// snapshot returns the snapshot as the JSON row the TypeScript callers receive, and its id; nil when absent.
func (s store) snapshot(ctx context.Context, q dbtx, repositoryID int64, identity string) (json.RawMessage, int64, error) {
	var row json.RawMessage
	var id int64
	err := q.QueryRow(ctx, `SELECT row_to_json(s), s.id FROM code_intelligence.snapshots s
		WHERE repository_id=$1 AND identity=$2 AND index_version=$3`, repositoryID, identity, s.version).Scan(&row, &id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, nil
	}
	s.statements.Add(1)
	return row, id, err
}

// priorExtractions maps "language:blob" of the newest base snapshot of this index version to its extraction.
func (s store) priorExtractions(ctx context.Context, repositoryID int64) (map[string]*int64, error) {
	s.statements.Add(1)
	rows, err := s.db.Query(ctx, `SELECT f.file_path, f.blob_hash, f.extraction_id FROM code_intelligence.files f
		WHERE f.snapshot_id = (SELECT id FROM code_intelligence.snapshots WHERE repository_id=$1 AND base_snapshot_id IS NULL
		  AND index_version=$2 ORDER BY id DESC LIMIT 1)`, repositoryID, s.version)
	if err != nil {
		return nil, err
	}
	out := map[string]*int64{}
	for rows.Next() {
		var p, blob string
		var id *int64
		if err := rows.Scan(&p, &blob, &id); err != nil {
			return nil, err
		}
		out[languageOf(p)+":"+blob] = id
	}
	return out, rows.Err()
}

type extractionKey struct{ language, hash string }

// cached returns the extraction ids already stored for these keys.
func (s store) cached(ctx context.Context, q dbtx, keys []extractionKey) (map[extractionKey]int64, error) {
	out := map[extractionKey]int64{}
	if len(keys) == 0 {
		return out, nil
	}
	langs, hashes := make([]string, len(keys)), make([]string, len(keys))
	for i, k := range keys {
		langs[i], hashes[i] = k.language, k.hash
	}
	s.statements.Add(1)
	rows, err := q.Query(ctx, `SELECT e.id, e.language, e.content_hash FROM code_intelligence.extractions e
		JOIN unnest($1::text[], $2::text[]) x(language, content_hash) ON x.language=e.language AND x.content_hash=e.content_hash
		WHERE e.parser_version=$3`, langs, hashes, s.version)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var k extractionKey
		if err := rows.Scan(&id, &k.language, &k.hash); err != nil {
			return nil, err
		}
		out[k] = id
	}
	return out, rows.Err()
}

// persist stores extractions with their symbols and relations in one transaction (an extraction row is never
// visible without its rows) and returns the ids of all of them, including ones another writer stored first.
func (s store) persist(ctx context.Context, parsed []*Extraction) (map[extractionKey]int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	langs, hashes, errs := make([]string, len(parsed)), make([]string, len(parsed)), make([]int32, len(parsed))
	for i, e := range parsed {
		langs[i], hashes[i], errs[i] = e.Language, e.ContentHash, int32(e.ParseErrors)
	}
	s.statements.Add(1)
	rows, err := tx.Query(ctx, `INSERT INTO code_intelligence.extractions(language,parser_version,content_hash,parse_errors)
		SELECT l, $4, h, e FROM unnest($1::text[], $2::text[], $3::int[]) x(l, h, e)
		ON CONFLICT DO NOTHING RETURNING id, language, content_hash`, langs, hashes, errs, s.version)
	if err != nil {
		return nil, err
	}
	fresh := map[extractionKey]int64{}
	for rows.Next() {
		var id int64
		var k extractionKey
		if err := rows.Scan(&id, &k.language, &k.hash); err != nil {
			return nil, err
		}
		fresh[k] = id
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var symbols, relations [][]any
	keys := make([]extractionKey, 0, len(parsed))
	for _, e := range parsed {
		k := extractionKey{e.Language, e.ContentHash}
		keys = append(keys, k)
		id, ok := fresh[k]
		if !ok {
			continue
		}
		for _, sy := range e.Symbols {
			symbols = append(symbols, []any{id, sy.Name, sy.Qualified, sy.Kind, sy.StartLine, sy.EndLine, sy.StartByte, sy.EndByte, sy.ParentSymbol, sy.Signature})
		}
		for _, r := range e.Relations {
			relations = append(relations, []any{id, r.Source, r.Target, r.Type, r.Resolution, r.Line})
		}
	}
	if len(symbols) > 0 {
		s.statements.Add(1)
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"code_intelligence", "symbols"},
			[]string{"extraction_id", "symbol_name", "qualified_name", "symbol_kind", "start_line", "end_line", "start_byte", "end_byte", "parent_symbol", "signature"},
			pgx.CopyFromRows(symbols)); err != nil {
			return nil, err
		}
	}
	if len(relations) > 0 {
		s.statements.Add(1)
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"code_intelligence", "relations"},
			[]string{"extraction_id", "source_name", "target_name", "relation_type", "resolution", "line"},
			pgx.CopyFromRows(relations)); err != nil {
			return nil, err
		}
	}
	ids, err := s.cached(ctx, tx, keys)
	if err != nil {
		return nil, err
	}
	s.statements.Add(1)
	return ids, tx.Commit(ctx)
}

type fileRecord struct {
	Path         string
	BlobHash     string
	ExtractionID *int64
	Deleted      bool
}

type snapshotInput struct {
	RepositoryID   int64
	CommitSHA      string
	Identity       string
	BaseSnapshotID *int64
	InstanceID     string
	RunID          *int64
	Generation     string
}

// Fence is the code_intelligence.runs lease the request holds; publication requires it to be current.
type Fence struct {
	ID              int64  `json:"id"`
	Token           int64  `json:"token"`
	InstanceID      string `json:"instance_id"`
	InstanceSession string `json:"instance_session"`
}

// publish is publish() of src/codeIntelligence/store.ts: the snapshot and all its files appear in one commit,
// after the repository lock, the lease and (for overlays) the caller's validation.
func (s store) publish(ctx context.Context, in snapshotInput, files []fileRecord, fence *Fence, validate func() error) (json.RawMessage, int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s.statements.Add(1)
	if _, err := tx.Exec(ctx, "SELECT id FROM repositories WHERE id=$1 FOR UPDATE", in.RepositoryID); err != nil {
		return nil, 0, err
	}
	if fence != nil {
		var ok bool
		s.statements.Add(1)
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT id FROM code_intelligence.runs WHERE id=$1 AND fencing_token=$2
			AND status='running' AND lease_expires_at>now() FOR UPDATE)
			AND NOT EXISTS(SELECT 1 FROM (SELECT * FROM platform_instances WHERE instance_id=$3 FOR SHARE) i
			  WHERE i.session_id <> $4 OR i.stopped_at IS NOT NULL)`,
			fence.ID, fence.Token, fence.InstanceID, fence.InstanceSession).Scan(&ok)
		if err != nil {
			return nil, 0, err
		}
		if !ok {
			return nil, 0, errLeaseLost
		}
	}
	if validate != nil {
		if err := validate(); err != nil {
			return nil, 0, err
		}
	}
	if row, id, err := s.snapshot(ctx, tx, in.RepositoryID, in.Identity); err != nil || row != nil {
		return row, id, err
	}
	var id int64
	s.statements.Add(1)
	if err := tx.QueryRow(ctx, `INSERT INTO code_intelligence.snapshots(repository_id,commit_sha,index_version,identity,base_snapshot_id,instance_id,run_id,generation)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		in.RepositoryID, in.CommitSHA, s.version, in.Identity, in.BaseSnapshotID, in.InstanceID, in.RunID, in.Generation).Scan(&id); err != nil {
		return nil, 0, err
	}
	rows := make([][]any, len(files))
	for i, f := range files {
		rows[i] = []any{id, f.Path, f.BlobHash, f.ExtractionID, f.Deleted}
	}
	s.statements.Add(1)
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"code_intelligence", "files"},
		[]string{"snapshot_id", "file_path", "blob_hash", "extraction_id", "deleted"}, pgx.CopyFromRows(rows)); err != nil {
		return nil, 0, err
	}
	s.statements.Add(1)
	if _, err := tx.Exec(ctx, `WITH f AS (`+effectiveSQL+`) UPDATE code_intelligence.snapshots SET
		indexed_files=(SELECT count(*) FROM f WHERE extraction_id IS NOT NULL),
		symbol_count=(SELECT count(*) FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id),
		relation_count=(SELECT count(*) FROM f JOIN code_intelligence.relations r ON r.extraction_id=f.extraction_id) WHERE id=$1`, id); err != nil {
		return nil, 0, err
	}
	row, _, err := s.snapshot(ctx, tx, in.RepositoryID, in.Identity)
	if err != nil {
		return nil, 0, err
	}
	s.statements.Add(1)
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return row, id, nil
}

// effectiveSQL is effectiveSql of src/codeIntelligence/store.ts (an overlay's files over its base).
const effectiveSQL = `SELECT f.* FROM code_intelligence.files f WHERE f.snapshot_id=$1 AND NOT f.deleted
 UNION ALL SELECT b.* FROM code_intelligence.files b JOIN code_intelligence.snapshots s ON s.base_snapshot_id=b.snapshot_id
 WHERE s.id=$1 AND NOT b.deleted AND NOT EXISTS (SELECT 1 FROM code_intelligence.files o WHERE o.snapshot_id=s.id AND o.file_path=b.file_path)`

// progress records the job's progress under its fence; a lost lease stops the job.
func (s store) progress(ctx context.Context, fence *Fence, m Metrics, processed, total int) error {
	if fence == nil {
		return nil
	}
	m.ProcessedFiles, m.TotalFiles = &processed, &total
	body, err := json.Marshal(m)
	if err != nil {
		return err
	}
	s.statements.Add(1)
	tag, err := s.db.Exec(ctx, `UPDATE code_intelligence.runs SET metrics=$3, updated_at=now()
		WHERE id=$1 AND fencing_token=$2 AND status='running'`, fence.ID, fence.Token, body)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errLeaseLost
	}
	return nil
}

func (s store) indexedFiles(ctx context.Context, id int64) (int, error) {
	var n int
	s.statements.Add(1)
	err := s.db.QueryRow(ctx, "SELECT indexed_files FROM code_intelligence.snapshots WHERE id=$1", id).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("snapshot %d: %w", id, err)
	}
	return n, nil
}
