package analytics

import (
	"context"
	"fmt"
	"slices"
	"strings"
)

// options lists the filter choices visible in the scope (TypeScript optionsAnalytics), as one statement instead of
// two: run dimensions and production services come back together.
func (s *Service) options(ctx context.Context, r *Request) (Object, error) {
	rows, err := s.oneIn(ctx, s.light, `WITH dims AS (
  SELECT r.owner_id,u.username,r.definition_key,r.selected_repositories,
    COALESCE(NULLIF(w.project,''),NULLIF(r.inputs->>'project',''),'unknown') AS project FROM workflow_runs r
  JOIN users u ON u.id=r.owner_id LEFT JOIN work_items w ON w.id=r.work_item_id
  WHERE r.owner_id IS NOT NULL AND ($2::boolean OR r.owner_id=$1) GROUP BY 1,2,3,4,5 ORDER BY 3 LIMIT 1000
), services AS (
  SELECT DISTINCT COALESCE(NULLIF(namespace,''),'unknown') AS namespace,
    COALESCE(NULLIF(service,''),'unknown') AS service FROM prod_error_groups ORDER BY 1,2 LIMIT 500
)
SELECT
  COALESCE((SELECT array_agg(DISTINCT definition_key) FROM dims),'{}') AS workflows,
  COALESCE((SELECT array_agg(DISTINCT repo) FROM dims, unnest(selected_repositories) repo),'{}')
    || CASE WHEN EXISTS(SELECT 1 FROM dims WHERE selected_repositories IS NULL) THEN ARRAY[NULL::text] END AS repositories,
  COALESCE((SELECT array_agg(DISTINCT project) FROM dims),'{}') AS projects,
  COALESCE((SELECT json_agg(json_build_object('namespace',namespace,'service',service) ORDER BY namespace,service) FROM services),'[]') AS services,
  COALESCE((SELECT json_agg(json_build_object('id',owner_id,'username',username) ORDER BY first) FROM (
    SELECT owner_id,min(username) AS username,min(n) AS first FROM (SELECT owner_id,username,row_number() OVER() AS n FROM dims) d GROUP BY owner_id) u),'[]') AS users`,
		r.Scope.OwnerID, r.Scope.All)
	if err != nil {
		return nil, err
	}
	// Set + Array.prototype.sort(): JavaScript compares String(x) by UTF-16 code units, so a null sorts as "null".
	// Go orders UTF-8 bytes, which agrees except for supplementary-plane characters these identifiers do not use.
	union := func(base any, extra ...string) []any {
		var vals []any
		if b, ok := base.([]any); ok {
			vals = append(vals, b...)
		}
		for _, e := range extra {
			vals = append(vals, e)
		}
		key := func(v any) string {
			if v == nil {
				return "null"
			}
			return fmt.Sprint(v)
		}
		slices.SortStableFunc(vals, func(a, b any) int { return strings.Compare(key(a), key(b)) })
		return slices.CompactFunc(vals, func(a, b any) bool { return a == b })
	}
	var nsProjects, nsNames []string
	for _, n := range r.ProdNamespaces {
		nsProjects, nsNames = append(nsProjects, n.Project), append(nsNames, n.Namespace)
	}
	var services []struct {
		Namespace string `json:"namespace"`
	}
	if err := decode(rows.Get("services"), &services); err != nil {
		return nil, err
	}
	for _, sv := range services {
		nsNames = append(nsNames, sv.Namespace)
	}
	return Object{
		{"workflows", union(rows.Get("workflows"))},
		{"repositories", union(rows.Get("repositories"))},
		{"projects", union(rows.Get("projects"), nsProjects...)},
		{"namespaces", union(nil, nsNames...)},
		{"services", rows.Get("services")},
		{"environments", []string{"production"}},
		{"users", rows.Get("users")},
	}, nil
}
