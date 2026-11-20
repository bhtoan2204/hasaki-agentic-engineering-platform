// Package analytics serves the read-only engineering analytics dashboards (usage, performance, workflows,
// production health, filter options) for the TypeScript API behind ANALYTICS_ENGINE=go.
//
// TypeScript keeps routing, authentication, authorization, support-mode auditing, caching and every mutation. It
// sends filters it has already parsed and a scope it derived from the authenticated actor; this package validates
// both again (it never widens a scope) and only reads.
package analytics

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"time"
)

// Dashboards served by POST /internal/v1/analytics/{dashboard}.
var Dashboards = []string{"usage", "performance", "workflows", "health", "health-service", "options"}

// Scope is derived by the caller from the authenticated actor: All is true only for an audited admin support read.
type Scope struct {
	OwnerID int64 `json:"owner_id"`
	All     bool  `json:"all"`
}

// Filters mirrors the TypeScript AnalyticsFilters (src/api/analytics/filters.ts) after parsing.
type Filters struct {
	From           string  `json:"from"`
	To             string  `json:"to"`
	Timezone       string  `json:"timezone"`
	Bucket         string  `json:"bucket"`
	Provider       *string `json:"provider"`
	Model          *string `json:"model"`
	User           *int64  `json:"user"`
	Workflow       *string `json:"workflow"`
	Repository     *string `json:"repository"`
	Project        *string `json:"project"`
	Service        *string `json:"service"`
	Namespace      *string `json:"namespace"`
	Severity       *string `json:"severity"`
	IncidentStatus *string `json:"incident_status"`
	Environment    *string `json:"environment"`
	GroupBy        string  `json:"group_by"`
	Page           int     `json:"page"`
	PageSize       int     `json:"page_size"`
}

// ProdNamespace maps a configured production namespace to its project (config.prodErrors.namespaces).
type ProdNamespace struct {
	Namespace string `json:"namespace"`
	Project   string `json:"project"`
}

type Request struct {
	Scope          Scope           `json:"scope"`
	Filters        Filters         `json:"filters"`
	ProdNamespaces []ProdNamespace `json:"prod_namespaces"`
}

var (
	errInvalid    = errors.New("invalid request")
	boundaryRe    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$`)
	providerRe    = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	dimensions    = []string{"provider", "model", "user", "workflow", "repository", "project"}
	severities    = []string{"critical", "high", "medium", "low", "unknown"}
	incidentState = []string{"open", "acknowledged", "resolved", "recurring"}
)

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", errInvalid, fmt.Sprintf(format, a...))
}

// parseBoundary accepts what the TypeScript parser accepts: a date, or an ISO timestamp with an explicit offset.
func parseBoundary(v string) (time.Time, bool) {
	if !boundaryRe.MatchString(v) {
		return time.Time{}, false
	}
	if len(v) == 10 {
		t, err := time.Parse(time.DateOnly, v)
		return t, err == nil
	}
	for _, layout := range []string{"2006-01-02T15:04Z07:00", "2006-01-02T15:04:05Z07:00", time.RFC3339Nano} {
		if t, err := time.Parse(layout, v); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// Validate re-checks the parsed filters and scope. TypeScript already rejected bad user input with a 400, so a
// failure here means a caller bug or a forged internal request: it is reported, never repaired.
func (r *Request) Validate(dashboard string) error {
	f := &r.Filters
	if !slices.Contains(Dashboards, dashboard) {
		return invalid("unknown dashboard")
	}
	if r.Scope.OwnerID <= 0 {
		return invalid("scope.owner_id is required")
	}
	from, ok1 := parseBoundary(f.From)
	to, ok2 := parseBoundary(f.To)
	if !ok1 || !ok2 {
		return invalid("from and to must be dates or ISO timestamps with offset")
	}
	// Date.parse semantics, as in TypeScript: a date-only value is UTC midnight here.
	span := to.Sub(from)
	if span <= 0 || span > 366*24*time.Hour+2*time.Hour {
		return invalid("date range must be positive and at most 366 days")
	}
	if _, err := time.LoadLocation(f.Timezone); err != nil || f.Timezone == "" || f.Timezone == "Local" {
		return invalid("invalid timezone")
	}
	if f.Bucket != "hour" && f.Bucket != "day" {
		return invalid("invalid bucket")
	}
	if f.Bucket == "hour" && span > 31*24*time.Hour {
		return invalid("hourly ranges are limited to 31 days")
	}
	if !slices.Contains(dimensions, f.GroupBy) {
		return invalid("invalid group_by")
	}
	if f.Page < 1 || f.Page > 10000 || f.PageSize < 1 || f.PageSize > 100 {
		return invalid("invalid pagination")
	}
	if f.User != nil && *f.User < 1 {
		return invalid("invalid user")
	}
	if f.Provider != nil && !providerRe.MatchString(*f.Provider) {
		return invalid("invalid provider")
	}
	for name, v := range map[string]*string{"model": f.Model, "workflow": f.Workflow, "repository": f.Repository,
		"project": f.Project, "service": f.Service, "namespace": f.Namespace} {
		if v != nil && (*v == "" || len([]rune(*v)) > 160) {
			return invalid("invalid %s", name)
		}
	}
	if f.Severity != nil && !slices.Contains(severities, *f.Severity) {
		return invalid("invalid severity")
	}
	if f.IncidentStatus != nil && !slices.Contains(incidentState, *f.IncidentStatus) {
		return invalid("invalid incident_status")
	}
	if f.Environment != nil && *f.Environment != "production" {
		return invalid("invalid environment")
	}
	if dashboard == "health-service" && (f.Service == nil || f.Namespace == nil) {
		return invalid("service and namespace are required")
	}
	if len(r.ProdNamespaces) > 1000 {
		return invalid("too many production namespaces")
	}
	return nil
}

// boundaryInstant is the instant a range boundary denotes: a date-only value is local midnight in the requested
// timezone, a timestamp keeps its explicit offset (TypeScript boundaryInstant, SQL bounds CTE).
func boundaryInstant(raw string, loc *time.Location, parsed time.Time) time.Time {
	if len(raw) != 10 {
		return parsed
	}
	return time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 0, 0, 0, 0, loc)
}
