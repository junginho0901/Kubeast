// Package model is the dashboard document the dashboards module stores and
// serves: a small, typed shape (apiVersion kubeast.io/dashboards/v1alpha1)
// that an LLM can fill and a validator can check. Panels are a map keyed by
// name and placed by the layout, so one panel can change without touching the
// grid. Values the model has no field for are kept in the Ext map of the
// object they came from, so an imported dashboard loses nothing.
package model

import "encoding/json"

const (
	APIVersion = "kubeast.io/dashboards/v1alpha1"
	Kind       = "Dashboard"

	// GridColumns and RowPixels are Grafana's grid units, kept so an imported
	// layout lands on the same cells.
	GridColumns = 24
	RowPixels   = 30

	// MinRefreshSeconds is the shortest auto refresh a dashboard may ask for.
	MinRefreshSeconds = 10
)

// Dashboard is one stored dashboard.
type Dashboard struct {
	APIVersion string   `json:"apiVersion"`
	Kind       string   `json:"kind"`
	Metadata   Metadata `json:"metadata"`
	Spec       Spec     `json:"spec"`
	Source     *Source  `json:"source,omitempty"`
}

type Metadata struct {
	ID          string   `json:"id,omitempty"`
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Folder      string   `json:"folder,omitempty"`
	Scope       Scope    `json:"scope"`
	Version     int      `json:"version,omitempty"`
}

// Scope says where the dashboard's queries run. Cluster "*" means the viewer
// picks the cluster through a cluster variable; Namespaces empty means the
// whole cluster.
type Scope struct {
	Cluster    string   `json:"cluster"`
	Namespaces []string `json:"namespaces,omitempty"`
}

type Spec struct {
	Time     TimeRange `json:"time"`
	Refresh  string    `json:"refresh,omitempty"`
	Timezone string    `json:"timezone,omitempty"` // "" = the viewer's default

	CursorSync  string                     `json:"cursorSync,omitempty"`
	Variables   []Variable                 `json:"variables,omitempty"`
	Panels      map[string]Panel           `json:"panels"`
	Layout      Layout                     `json:"layout"`
	Links       []Link                     `json:"links,omitempty"`
	Annotations []Annotation               `json:"annotations,omitempty"`
	Ext         map[string]json.RawMessage `json:"ext,omitempty"`
}

type TimeRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Cursor sync modes (Grafana graphTooltip 0, 1, 2).
const (
	CursorSyncNone          = "none"
	CursorSyncShared        = "shared"
	CursorSyncSharedTooltip = "sharedTooltip"
)

type Panel struct {
	Title         string                     `json:"title,omitempty"`
	Description   string                     `json:"description,omitempty"`
	Kind          string                     `json:"kind"`
	Queries       []Query                    `json:"queries,omitempty"`
	FieldDefaults FieldConfig                `json:"fieldDefaults,omitempty"`
	Overrides     []Override                 `json:"overrides,omitempty"`
	Transforms    []Transform                `json:"transforms,omitempty"`
	Options       json.RawMessage            `json:"options,omitempty"`
	Repeat        *Repeat                    `json:"repeat,omitempty"`
	Ext           map[string]json.RawMessage `json:"ext,omitempty"`
}

// Query is one query of a panel. Store names the kind of store; which cluster
// it runs on comes from the dashboard scope or its cluster variable.
type Query struct {
	RefID   string                     `json:"refId"`
	Store   string                     `json:"store,omitempty"`
	Expr    string                     `json:"expr,omitempty"`
	Legend  string                     `json:"legend,omitempty"`
	Instant bool                       `json:"instant,omitempty"`
	MinStep string                     `json:"minStep,omitempty"`
	Hide    bool                       `json:"hide,omitempty"`
	Ext     map[string]json.RawMessage `json:"ext,omitempty"`
}

// Stores a query can name.
const (
	StorePrometheus   = "prometheus"
	StoreLoki         = "loki"
	StoreTempo        = "tempo"
	StoreAlertmanager = "alertmanager"
)

type FieldConfig struct {
	Unit        string            `json:"unit,omitempty"`
	Min         *float64          `json:"min,omitempty"`
	Max         *float64          `json:"max,omitempty"`
	Decimals    *int              `json:"decimals,omitempty"`
	DisplayName string            `json:"displayName,omitempty"`
	Color       *Color            `json:"color,omitempty"`
	Thresholds  *Thresholds       `json:"thresholds,omitempty"`
	Mappings    []json.RawMessage `json:"mappings,omitempty"`
	NoValue     string            `json:"noValue,omitempty"`
	Links       []Link            `json:"links,omitempty"`
}

// Color is a theme token, never a fixed colour: each of the console's colour
// modes resolves the token, so a dashboard reads in all of them.
type Color struct {
	Mode  string `json:"mode"`
	Token string `json:"token,omitempty"`
}

type Thresholds struct {
	Mode  string          `json:"mode"`
	Steps []ThresholdStep `json:"steps"`
}

// ThresholdStep starts at Value; the first step has no value (from minus infinity).
type ThresholdStep struct {
	Value *float64 `json:"value,omitempty"`
	Color string   `json:"color"`
}

type Override struct {
	Matcher Matcher                    `json:"matcher"`
	Set     map[string]json.RawMessage `json:"set"`
}

type Matcher struct {
	Kind  string          `json:"kind"`
	Value json.RawMessage `json:"value,omitempty"`
}

// Matcher kinds.
const (
	MatchByName   = "byName"
	MatchByRegexp = "byRegexp"
	MatchByType   = "byType"
	MatchByRefID  = "byRefId"
	MatchByValue  = "byValue"
)

type Transform struct {
	ID       string                     `json:"id"`
	Options  json.RawMessage            `json:"options,omitempty"`
	Disabled bool                       `json:"disabled,omitempty"`
	Ext      map[string]json.RawMessage `json:"ext,omitempty"`
}

type Repeat struct {
	Variable  string `json:"variable"`
	Direction string `json:"direction,omitempty"`
	MaxPerRow int    `json:"maxPerRow,omitempty"`
}

type Variable struct {
	Name       string                     `json:"name"`
	Label      string                     `json:"label,omitempty"`
	Kind       string                     `json:"kind"`
	Store      string                     `json:"store,omitempty"`
	Query      *VariableQuery             `json:"query,omitempty"`
	Regex      string                     `json:"regex,omitempty"`
	Sort       int                        `json:"sort,omitempty"`
	Refresh    string                     `json:"refresh,omitempty"`
	Options    []VariableOption           `json:"options,omitempty"`
	Multi      bool                       `json:"multi,omitempty"`
	IncludeAll bool                       `json:"includeAll,omitempty"`
	AllValue   string                     `json:"allValue,omitempty"`
	Current    json.RawMessage            `json:"current,omitempty"`
	Hide       int                        `json:"hide,omitempty"`
	Ext        map[string]json.RawMessage `json:"ext,omitempty"`
}

// Variable kinds. Cluster is Kubeast's own: the registered clusters that have
// the store, which a Grafana data source variable becomes.
const (
	VarQuery    = "query"
	VarCustom   = "custom"
	VarInterval = "interval"
	VarTextbox  = "textbox"
	VarConstant = "constant"
	VarSwitch   = "switch"
	VarAdhoc    = "adhoc"
	VarCluster  = "cluster"
)

// VariableQuery is a query variable's source. Fn is the Prometheus helper
// (label_values, label_names, metrics, query_result) or "logql"/"raw".
type VariableQuery struct {
	Fn    string `json:"fn"`
	Expr  string `json:"expr,omitempty"`
	Label string `json:"label,omitempty"`
}

// Variable refresh points.
const (
	RefreshOnLoad      = "load"
	RefreshOnTimeRange = "timeRange"
)

type VariableOption struct {
	Text  string `json:"text"`
	Value string `json:"value"`
}

// Layout places panels on a 24-column grid; rows can fold a group of panels.
type Layout struct {
	Items []LayoutItem `json:"items,omitempty"`
	Rows  []LayoutRow  `json:"rows,omitempty"`
}

type LayoutItem struct {
	Panel string `json:"panel"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	W     int    `json:"w"`
	H     int    `json:"h"`
}

type LayoutRow struct {
	Title     string                     `json:"title,omitempty"`
	Y         int                        `json:"y"`
	Collapsed bool                       `json:"collapsed,omitempty"`
	Items     []LayoutItem               `json:"items,omitempty"`
	Repeat    string                     `json:"repeat,omitempty"`
	Ext       map[string]json.RawMessage `json:"ext,omitempty"`
}

type Link struct {
	Title  string `json:"title,omitempty"`
	URL    string `json:"url"`
	NewTab bool   `json:"newTab,omitempty"`
}

type Annotation struct {
	Name   string                     `json:"name"`
	Store  string                     `json:"store,omitempty"`
	Expr   string                     `json:"expr,omitempty"`
	Color  string                     `json:"color,omitempty"`
	Enable bool                       `json:"enable"`
	Ext    map[string]json.RawMessage `json:"ext,omitempty"`
}

// Source records where an imported dashboard came from; Raw is the whole
// original document.
type Source struct {
	Kind          string          `json:"kind"`
	SchemaVersion int             `json:"schemaVersion,omitempty"`
	UID           string          `json:"uid,omitempty"`
	Raw           json.RawMessage `json:"raw,omitempty"`
}

// Source kinds: a Grafana classic/v1 dashboard JSON, or a schema v2 resource
// (Grafana 13's default export).
const (
	SourceGrafanaV1 = "grafana-v1"
	SourceGrafanaV2 = "grafana-v2"
)
