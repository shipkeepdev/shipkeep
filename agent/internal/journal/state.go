package journal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const localSchema = `CREATE TABLE IF NOT EXISTS desired(resource_id TEXT PRIMARY KEY,spec_json TEXT NOT NULL,version INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS actual(resource_id TEXT PRIMARY KEY,status_json TEXT NOT NULL,observed_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS routing(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,table_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS used_confirmations(jti TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS intent(container TEXT PRIMARY KEY,running INTEGER NOT NULL CHECK(running IN (0,1)),updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS stop_reason(container TEXT PRIMARY KEY,reason TEXT NOT NULL,stopped_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS route_upstreams(route_id TEXT PRIMARY KEY,upstreams_json TEXT NOT NULL,updated_at INTEGER NOT NULL);`

// RouteUpstream is a managed container a route proxies to (ADR 0017): its place among the
// route's upstreams, its name and port, and the address the agent last resolved it to.
type RouteUpstream struct {
	Index     int    `json:"index"`
	Container string `json:"container"`
	Port      uint16 `json:"port"`
	Dial      string `json:"dial"`
}

// maxRouteUpstreams bounds a record as UpsertRoute bounds a route.
const maxRouteUpstreams = 64

// SetRouteUpstreams records the containers a route proxies to, so that reconciliation can follow a
// container that comes back at another address. A route without one (addresses only, or the
// maintenance page) has no record.
func (s *Store) SetRouteUpstreams(ctx context.Context, route string, upstreams []RouteUpstream, now time.Time) error {
	if !identifier.MatchString(route) || len(upstreams) > maxRouteUpstreams {
		return errors.New("invalid route upstreams")
	}
	if len(upstreams) == 0 {
		return s.ClearRouteUpstreams(ctx, route)
	}
	for _, upstream := range upstreams {
		if upstream.Index < 0 || upstream.Index >= maxRouteUpstreams || !identifier.MatchString(upstream.Container) || upstream.Port == 0 || len(upstream.Dial) > 64 {
			return errors.New("invalid route upstreams")
		}
	}
	data, err := json.Marshal(upstreams)
	if err != nil {
		return fmt.Errorf("encode route upstreams: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "INSERT INTO route_upstreams(route_id,upstreams_json,updated_at) VALUES(?,?,?) ON CONFLICT(route_id) DO UPDATE SET upstreams_json=excluded.upstreams_json,updated_at=excluded.updated_at", route, string(data), now.UnixMilli()); err != nil {
		return fmt.Errorf("record route upstreams: %w", err)
	}
	return nil
}

// ClearRouteUpstreams forgets a route's containers: removed, or no longer proxying to any.
func (s *Store) ClearRouteUpstreams(ctx context.Context, route string) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM route_upstreams WHERE route_id=?", route); err != nil {
		return fmt.Errorf("forget route upstreams: %w", err)
	}
	return nil
}

// RouteUpstreams returns every recorded route with its containers. A record that cannot be read is
// skipped rather than trusted.
func (s *Store) RouteUpstreams(ctx context.Context) (map[string][]RouteUpstream, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT route_id,upstreams_json FROM route_upstreams ORDER BY route_id")
	if err != nil {
		return nil, fmt.Errorf("read route upstreams: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read-only cursor
	routes := map[string][]RouteUpstream{}
	for rows.Next() {
		var route, data string
		if err := rows.Scan(&route, &data); err != nil {
			return nil, fmt.Errorf("scan route upstreams: %w", err)
		}
		var upstreams []RouteUpstream
		if json.Unmarshal([]byte(data), &upstreams) == nil && len(upstreams) <= maxRouteUpstreams {
			routes[route] = upstreams
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read route upstreams: %w", err)
	}
	return routes, nil
}

// PutDesired stores a typed container specification, stripping every debug_redact field recursively.
func (s *Store) PutDesired(ctx context.Context, id string, version int64, spec *agentv1.ContainerSpec) error {
	if !identifier.MatchString(id) || version < 1 || spec == nil {
		return errors.New("invalid desired state metadata")
	}
	data, err := publicJSON(spec)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO desired(resource_id,spec_json,version) VALUES(?,?,?) ON CONFLICT(resource_id) DO UPDATE SET spec_json=excluded.spec_json,version=excluded.version WHERE desired.version<excluded.version OR (desired.version=excluded.version AND desired.spec_json=excluded.spec_json)`, id, data, version)
	if err != nil {
		return fmt.Errorf("store desired state: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("count desired state: %w", err)
	}
	if count != 1 {
		return ErrConflict
	}
	return nil
}

// Desired reads a cached specification containing secret names/versions but no secret values.
func (s *Store) Desired(ctx context.Context, id string) (*agentv1.ContainerSpec, int64, error) {
	var data string
	var version int64
	if err := s.db.QueryRowContext(ctx, "SELECT spec_json,version FROM desired WHERE resource_id=?", id).Scan(&data, &version); err != nil {
		return nil, 0, fmt.Errorf("read desired state: %w", err)
	}
	spec := &agentv1.ContainerSpec{}
	if err := protojson.Unmarshal([]byte(data), spec); err != nil {
		return nil, 0, errors.New("invalid cached specification")
	}
	return spec, version, nil
}

// Observe atomically records an observed container state unless the observation is stale.
func (s *Store) Observe(ctx context.Context, id string, status *agentv1.ContainerStatus, at time.Time) error {
	if !identifier.MatchString(id) || status == nil || at.IsZero() {
		return errors.New("invalid observed state")
	}
	data, err := publicJSON(status)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO actual(resource_id,status_json,observed_at) VALUES(?,?,?) ON CONFLICT(resource_id) DO UPDATE SET status_json=excluded.status_json,observed_at=excluded.observed_at WHERE actual.observed_at<excluded.observed_at OR (actual.observed_at=excluded.observed_at AND actual.status_json=excluded.status_json)`, id, data, at.UnixMilli())
	if err != nil {
		return fmt.Errorf("store observed state: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("count observed state: %w", err)
	}
	if count != 1 {
		return ErrConflict
	}
	return nil
}

// Actual reads the most recent observed container status.
func (s *Store) Actual(ctx context.Context, id string) (*agentv1.ContainerStatus, time.Time, error) {
	var data string
	var at int64
	if err := s.db.QueryRowContext(ctx, "SELECT status_json,observed_at FROM actual WHERE resource_id=?", id).Scan(&data, &at); err != nil {
		return nil, time.Time{}, fmt.Errorf("read actual state: %w", err)
	}
	status := &agentv1.ContainerStatus{}
	if err := protojson.Unmarshal([]byte(data), status); err != nil {
		return nil, time.Time{}, errors.New("invalid cached status")
	}
	return status, time.UnixMilli(at), nil
}

// PutRouting caches an entire monotonically versioned routing snapshot for control-plane outages.
func (s *Store) PutRouting(ctx context.Context, table *agentv1.RoutingTable) error {
	if table == nil || table.Version < 1 || table.Version > math.MaxInt64 {
		return errors.New("invalid routing version")
	}
	data, err := publicJSON(table)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO routing(singleton,version,table_json) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,table_json=excluded.table_json WHERE routing.version<excluded.version OR (routing.version=excluded.version AND routing.table_json=excluded.table_json)`, table.Version, data)
	if err != nil {
		return fmt.Errorf("store routing snapshot: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("count routing snapshot: %w", err)
	}
	if count != 1 {
		return ErrConflict
	}
	return nil
}

// Routing returns the latest snapshot without contacting the control plane.
func (s *Store) Routing(ctx context.Context) (*agentv1.RoutingTable, error) {
	var data string
	if err := s.db.QueryRowContext(ctx, "SELECT table_json FROM routing WHERE singleton=1").Scan(&data); err != nil {
		return nil, fmt.Errorf("read routing snapshot: %w", err)
	}
	table := &agentv1.RoutingTable{}
	if err := protojson.Unmarshal([]byte(data), table); err != nil {
		return nil, errors.New("invalid routing snapshot")
	}
	return table, nil
}

// PutLease persists an epoch/expiry without allowing epoch rollback or shortening an existing lease.
// This stores evidence only; lease issuance and fencing remain M4.5.
func (s *Store) PutLease(ctx context.Context, epoch int64, expires time.Time) error {
	if epoch < 1 || expires.IsZero() {
		return errors.New("invalid lease")
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO lease(singleton,epoch,expires_at) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,expires_at=excluded.expires_at WHERE lease.epoch<excluded.epoch OR (lease.epoch=excluded.epoch AND lease.expires_at<=excluded.expires_at)`, epoch, expires.UnixMilli())
	if err != nil {
		return fmt.Errorf("store lease: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("count lease: %w", err)
	}
	if count != 1 {
		return ErrConflict
	}
	return nil
}

// Lease reads the last known lease, even if expired, so later fencing can compare epochs.
func (s *Store) Lease(ctx context.Context) (int64, time.Time, error) {
	var epoch, expires int64
	if err := s.db.QueryRowContext(ctx, "SELECT epoch,expires_at FROM lease WHERE singleton=1").Scan(&epoch, &expires); err != nil {
		return 0, time.Time{}, fmt.Errorf("read lease: %w", err)
	}
	return epoch, time.UnixMilli(expires), nil
}

// confirmationTTL is the lifetime the control plane gives confirmation tokens (SPEC 3.6) and
// confirmationSkew the clock difference tolerated between it and this node: a node running slightly
// behind must not reject a fresh token as "too far in the future".
const (
	confirmationTTL  = 5 * time.Minute
	confirmationSkew = time.Minute
)

// ConsumeConfirmation records a previously signature-verified token ID once within its validity.
func (s *Store) ConsumeConfirmation(ctx context.Context, id string, expires, now time.Time) (bool, error) {
	if !identifier.MatchString(id) || !expires.After(now) || expires.After(now.Add(confirmationTTL+confirmationSkew)) {
		return false, errors.New("invalid confirmation validity")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin confirmation consumption: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op after commit
	if _, err := tx.ExecContext(ctx, "DELETE FROM used_confirmations WHERE expires_at<=?", now.UnixMilli()); err != nil {
		return false, fmt.Errorf("expire confirmations: %w", err)
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO used_confirmations(jti,expires_at) VALUES(?,?) ON CONFLICT DO NOTHING", id, expires.UnixMilli())
	if err != nil {
		return false, fmt.Errorf("consume confirmation: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("count confirmation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit confirmation: %w", err)
	}
	return count == 1, nil
}

func publicJSON(message proto.Message) (string, error) {
	if proto.Size(message) > 1<<20 {
		return "", errors.New("local state exceeds 1 MiB")
	}
	copy := proto.Clone(message)
	clearSecrets(copy.ProtoReflect())
	data, err := protojson.Marshal(copy)
	if err != nil {
		return "", errors.New("invalid local state message")
	}
	if len(data) > 1<<20 {
		return "", errors.New("local state exceeds 1 MiB")
	}
	// Canonicalize JSON before same-version comparisons; protobuf JSON whitespace is not stable.
	var canonical any
	if err := json.Unmarshal(data, &canonical); err != nil {
		return "", errors.New("invalid local state JSON")
	}
	stable, err := json.Marshal(canonical)
	if err != nil {
		return "", errors.New("cannot canonicalize local state")
	}
	return string(stable), nil
}

func clearSecrets(message protoreflect.Message) {
	message.SetUnknown(nil)
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		if options, ok := field.Options().(*descriptorpb.FieldOptions); ok && options.GetDebugRedact() {
			message.Clear(field)
			return true
		}
		switch {
		case field.IsMap():
			if field.MapValue().Kind() == protoreflect.MessageKind {
				value.Map().Range(func(_ protoreflect.MapKey, v protoreflect.Value) bool { clearSecrets(v.Message()); return true })
			}
		case field.IsList():
			if field.Kind() == protoreflect.MessageKind {
				for i := 0; i < value.List().Len(); i++ {
					clearSecrets(value.List().Get(i).Message())
				}
			}
		case field.Kind() == protoreflect.MessageKind:
			clearSecrets(value.Message())
		}
		return true
	})
}

// SetIntent records whether a managed container should be running. The reconciler restores this
// state on its own, even while the control plane is unreachable (PLAN M1.6).
func (s *Store) SetIntent(ctx context.Context, container string, running bool, now time.Time) error {
	if !identifier.MatchString(container) {
		return errors.New("invalid container name")
	}
	value := 0
	if running {
		value = 1
	}
	if _, err := s.db.ExecContext(ctx, "INSERT INTO intent(container,running,updated_at) VALUES(?,?,?) ON CONFLICT(container) DO UPDATE SET running=excluded.running,updated_at=excluded.updated_at", container, value, now.UnixMilli()); err != nil {
		return fmt.Errorf("record intent: %w", err)
	}
	return nil
}

// ClearIntent forgets a removed container, with the reason it was stopped for, if any.
func (s *Store) ClearIntent(ctx context.Context, container string) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM intent WHERE container=?", container); err != nil {
		return fmt.Errorf("clear intent: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "DELETE FROM stop_reason WHERE container=?", container); err != nil {
		return fmt.Errorf("clear stop reason: %w", err)
	}
	return nil
}

// StopReasons the agent may record: why it stopped a container itself (ADR 0022).
var stopReasons = map[string]bool{"disk_limit": true}

// RecordStopReason remembers why the agent stopped a container itself, until it is removed.
func (s *Store) RecordStopReason(ctx context.Context, container, reason string, now time.Time) error {
	if !identifier.MatchString(container) || !stopReasons[reason] {
		return errors.New("invalid stop reason")
	}
	if _, err := s.db.ExecContext(ctx, "INSERT INTO stop_reason(container,reason,stopped_at) VALUES(?,?,?) ON CONFLICT(container) DO UPDATE SET reason=excluded.reason,stopped_at=excluded.stopped_at", container, reason, now.UnixMilli()); err != nil {
		return fmt.Errorf("record stop reason: %w", err)
	}
	return nil
}

// StopReasons returns the recorded reasons by container name.
func (s *Store) StopReasons(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT container,reason FROM stop_reason ORDER BY container")
	if err != nil {
		return nil, fmt.Errorf("read stop reasons: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read-only cursor
	reasons := map[string]string{}
	for rows.Next() {
		var name, reason string
		if err := rows.Scan(&name, &reason); err != nil {
			return nil, fmt.Errorf("scan stop reason: %w", err)
		}
		reasons[name] = reason
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read stop reasons: %w", err)
	}
	return reasons, nil
}

// Intents returns every recorded container intent.
func (s *Store) Intents(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT container,running FROM intent ORDER BY container")
	if err != nil {
		return nil, fmt.Errorf("read intents: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read-only cursor
	intents := map[string]bool{}
	for rows.Next() {
		var name string
		var running int
		if err := rows.Scan(&name, &running); err != nil {
			return nil, fmt.Errorf("scan intent: %w", err)
		}
		intents[name] = running == 1
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read intents: %w", err)
	}
	return intents, nil
}
