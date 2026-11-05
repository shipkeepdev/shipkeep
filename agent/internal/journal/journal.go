// Package journal persists operation intent and checkpoints before agent side effects.
package journal

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite" // register the pure-Go SQLite driver (ADR 0003)

	"github.com/samuelmbabhazi/shipkeep/lib/agentproto"
)

// State is a durable operation lifecycle state.
type State string

// Operation states mirror SPEC 3.4.
const (
	Pending      State = "pending"
	Running      State = "running"
	Succeeded    State = "succeeded"
	Failed       State = "failed"
	Cancelled    State = "cancelled"
	Compensating State = "compensating"
	Compensated  State = "compensated"
)

// ErrConflict rejects incompatible idempotency replays and stale checkpoint writers.
var ErrConflict = errors.New("journal operation conflicts with recorded intent")

// Request contains only stable metadata and a payload hash, never the action payload or secrets.
type Request struct {
	ID, Key, Kind string
	PayloadHash   [sha256.Size]byte
}

// Outcome is bounded non-sensitive result metadata. Logs and arbitrary process output are excluded.
type Outcome struct {
	ResourceID string
	Digest     string
	ExitCode   int32
}

// Operation is an immutable snapshot; Advance compares Revision before recording its successor.
type Operation struct {
	Request
	State                         State
	Step                          string
	Completed, Attempts, Revision int
	Result                        Outcome
}

// Store owns one SQLite connection and an exclusive agent-process lock.
type Store struct {
	db        *sql.DB
	lock      *os.File
	executing chan struct{}
}

const schema = `CREATE TABLE IF NOT EXISTS operations (
 action_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','cancelled','compensating','compensated')),
 step TEXT NOT NULL DEFAULT '', completed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0, result_json TEXT NOT NULL DEFAULT '{}', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 last_error TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS operation_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, step TEXT NOT NULL, updated_at INTEGER NOT NULL);
`

// Open opens private local state in dir. One process may own it; WAL and FULL sync protect checkpoints.
func Open(ctx context.Context, dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create journal directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil { //nolint:gosec // private agent state directory
		return nil, fmt.Errorf("restrict journal directory: %w", err)
	}
	lock, err := os.OpenFile(filepath.Join(dir, "agent.sqlite.lock"), os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW, 0o600) //nolint:gosec // operator-owned directory; links rejected
	if err != nil {
		return nil, fmt.Errorf("open journal lock: %w", err)
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, errors.New("agent state is already in use")
	}
	store := &Store{lock: lock, executing: make(chan struct{}, 1)}
	success := false
	defer func() {
		if !success {
			_ = store.Close()
		}
	}()
	path := filepath.Join(dir, "agent.sqlite")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW, 0o600) //nolint:gosec // private state path, never remote input; links rejected
	if err != nil {
		return nil, fmt.Errorf("create journal: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("restrict journal: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close journal file: %w", err)
	}
	location := url.URL{Scheme: "file", Path: path, RawQuery: "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"}
	db, err := sql.Open("sqlite", location.String())
	if err != nil {
		return nil, fmt.Errorf("open SQLite: %w", err)
	}
	store.db = db
	db.SetMaxOpenConns(1)
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return nil, fmt.Errorf("read journal schema: %w", err)
	}
	if version > 2 {
		return nil, errors.New("journal schema is newer than this agent")
	}
	if _, err := db.ExecContext(ctx, "BEGIN IMMEDIATE;"+schema+localSchema+"PRAGMA user_version=2;COMMIT;"); err != nil {
		return nil, fmt.Errorf("initialize journal: %w", err)
	}
	success = true
	return store, nil
}

// Close releases the database before allowing another agent to acquire the state lock.
func (s *Store) Close() error {
	var dbErr, lockErr error
	if s.db != nil {
		dbErr = s.db.Close()
	}
	if s.lock != nil {
		lockErr = s.lock.Close()
	}
	if err := errors.Join(dbErr, lockErr); err != nil {
		return fmt.Errorf("close journal: %w", err)
	}
	return nil
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)
var stepName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
var digest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Begin durably records pending intent or returns the existing result for the same key/hash/kind.
func (s *Store) Begin(ctx context.Context, request Request) (Operation, error) {
	id, err := uuid.Parse(request.ID)
	if err != nil || id.Version() != 7 || id.Variant() != uuid.RFC4122 || !identifier.MatchString(request.Key) || !slices.Contains(agentproto.ActionKinds(), request.Kind) {
		return Operation{}, errors.New("invalid journal request metadata")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Operation{}, fmt.Errorf("begin journal transaction: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // rollback is a no-op after commit
	now := time.Now().UnixMilli()
	result, err := tx.ExecContext(ctx, `INSERT INTO operations(action_id,idempotency_key,kind,payload_hash,state,started_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, request.ID, request.Key, request.Kind, hex.EncodeToString(request.PayloadHash[:]), Pending, now, now)
	if err != nil {
		return Operation{}, fmt.Errorf("record operation intent: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return Operation{}, fmt.Errorf("count recorded intents: %w", err)
	}
	op, err := scan(tx.QueryRowContext(ctx, "SELECT "+columns+" FROM operations WHERE idempotency_key=?", request.Key))
	if err != nil || op.Kind != request.Kind || op.PayloadHash != request.PayloadHash {
		return Operation{}, ErrConflict
	}
	if inserted == 1 {
		if _, err := tx.ExecContext(ctx, "INSERT INTO operation_history(action_id,revision,state,step,updated_at) VALUES(?,0,?,'',?)", op.ID, Pending, now); err != nil {
			return Operation{}, fmt.Errorf("record pending transition: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return Operation{}, fmt.Errorf("commit operation intent: %w", err)
	}
	return op, nil
}

// Advance records a legal state/checkpoint transition using optimistic concurrency control.
func (s *Store) Advance(ctx context.Context, current, next Operation) (Operation, error) {
	if current.Request != next.Request || !allowed(current.State, next.State) || (next.Step != "" && !stepName.MatchString(next.Step)) || next.Completed < 0 || next.Attempts < current.Attempts || next.Attempts > current.Attempts+1 || !validOutcome(next.Result) {
		return Operation{}, errors.New("invalid operation checkpoint")
	}
	encoded, err := json.Marshal(next.Result)
	if err != nil {
		return Operation{}, fmt.Errorf("encode outcome: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Operation{}, fmt.Errorf("begin checkpoint: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // rollback is a no-op after commit
	now := time.Now().UnixMilli()
	failure := ""
	if next.State == Failed {
		failure = "step_failed"
	}
	result, err := tx.ExecContext(ctx, `UPDATE operations SET state=?,step=?,completed=?,attempts=?,revision=revision+1,result_json=?,last_error=?,updated_at=? WHERE action_id=? AND revision=?`, next.State, next.Step, next.Completed, next.Attempts, string(encoded), failure, now, current.ID, current.Revision)
	if err != nil {
		return Operation{}, fmt.Errorf("record checkpoint: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return Operation{}, fmt.Errorf("count checkpoint: %w", err)
	}
	if count != 1 {
		return Operation{}, ErrConflict
	}
	next.Revision = current.Revision + 1
	if _, err := tx.ExecContext(ctx, "INSERT INTO operation_history(action_id,revision,state,step,updated_at) VALUES(?,?,?,?,?)", next.ID, next.Revision, next.State, next.Step, now); err != nil {
		return Operation{}, fmt.Errorf("record operation transition: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Operation{}, fmt.Errorf("commit checkpoint: %w", err)
	}
	return next, nil
}

// Unfinished returns work requiring resume or compensation after restart.
func (s *Store) Unfinished(ctx context.Context) ([]Operation, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+columns+" FROM operations WHERE state IN ('pending','running','compensating') ORDER BY started_at,action_id")
	if err != nil {
		return nil, fmt.Errorf("read unfinished operations: %w", err)
	}
	defer rows.Close() //nolint:errcheck // rows.Err checked below
	var operations []Operation
	for rows.Next() {
		op, err := scan(rows)
		if err != nil {
			return nil, err
		}
		operations = append(operations, op)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate unfinished operations: %w", err)
	}
	return operations, nil
}

const columns = "action_id,idempotency_key,kind,payload_hash,state,step,completed,attempts,revision,result_json"

func scan(row interface{ Scan(...any) error }) (Operation, error) {
	var op Operation
	var hash, result string
	if err := row.Scan(&op.ID, &op.Key, &op.Kind, &hash, &op.State, &op.Step, &op.Completed, &op.Attempts, &op.Revision, &result); err != nil {
		return Operation{}, fmt.Errorf("read operation: %w", err)
	}
	decoded, err := hex.DecodeString(hash)
	if err != nil || len(decoded) != sha256.Size {
		return Operation{}, errors.New("invalid stored payload hash")
	}
	copy(op.PayloadHash[:], decoded)
	if err := json.Unmarshal([]byte(result), &op.Result); err != nil {
		return Operation{}, errors.New("invalid stored outcome")
	}
	return op, nil
}
func validOutcome(result Outcome) bool {
	return (result.ResourceID == "" || identifier.MatchString(result.ResourceID)) && (result.Digest == "" || digest.MatchString(result.Digest))
}
func allowed(from, to State) bool {
	switch from {
	case Pending:
		return to == Running || to == Cancelled
	case Running:
		return to == Running || to == Succeeded || to == Failed || to == Compensating || to == Cancelled
	case Compensating:
		// Failed only after bounded compensation attempts (see maxCompensationAttempts).
		return to == Compensating || to == Compensated || to == Failed
	case Succeeded, Failed, Cancelled, Compensated:
		return false
	default:
		return false
	}
}
