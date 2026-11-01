package grafana

import "encoding/json"

// The schema v2 dashboard spec as ConvertV2 writes it: the field names, and
// which fields an empty value leaves out, of dashboard.grafana.app/v2
// (Grafana 13.3.0, dashboard_spec.cue). A union is held as any: the one kind
// it is.

type v2Spec struct {
	Annotations  []v2AnnotationKind `json:"annotations"`
	CursorSync   string             `json:"cursorSync"`
	Description  *string            `json:"description,omitempty"`
	Editable     *bool              `json:"editable,omitempty"`
	Elements     map[string]any     `json:"elements"`
	Layout       any                `json:"layout"`
	Links        []v2DashboardLink  `json:"links"`
	LiveNow      *bool              `json:"liveNow,omitempty"`
	Preload      bool               `json:"preload"`
	Revision     *uint16            `json:"revision,omitempty"`
	Tags         []string           `json:"tags"`
	TimeSettings v2TimeSettings     `json:"timeSettings"`
	Title        string             `json:"title"`
	Variables    []any              `json:"variables"`
	Preferences  *v2Preferences     `json:"preferences,omitempty"`
}

type v2Preferences struct {
	Layout any `json:"layout,omitempty"`
}

type v2TimeSettings struct {
	Timezone             *string       `json:"timezone,omitempty"`
	From                 string        `json:"from"`
	To                   string        `json:"to"`
	AutoRefresh          string        `json:"autoRefresh"`
	AutoRefreshIntervals []string      `json:"autoRefreshIntervals"`
	QuickRanges          []v2TimeRange `json:"quickRanges,omitempty"`
	HideTimepicker       bool          `json:"hideTimepicker"`
	WeekStart            *string       `json:"weekStart,omitempty"`
	FiscalYearStartMonth int64         `json:"fiscalYearStartMonth"`
	NowDelay             *string       `json:"nowDelay,omitempty"`
}

type v2TimeRange struct {
	Display string `json:"display"`
	From    string `json:"from"`
	To      string `json:"to"`
}

type v2DashboardLink struct {
	Title       string   `json:"title"`
	Type        string   `json:"type"`
	Icon        string   `json:"icon"`
	Tooltip     string   `json:"tooltip"`
	URL         *string  `json:"url,omitempty"`
	Tags        []string `json:"tags"`
	AsDropdown  bool     `json:"asDropdown"`
	TargetBlank bool     `json:"targetBlank"`
	IncludeVars bool     `json:"includeVars"`
	KeepTime    bool     `json:"keepTime"`
	Placement   *string  `json:"placement,omitempty"`
}

type v2Kind[S any] struct {
	Kind string `json:"kind"`
	Spec S      `json:"spec"`
}

type v2AnnotationKind = v2Kind[v2AnnotationSpec]

type v2AnnotationSpec struct {
	Query         v2DataQuery               `json:"query"`
	Enable        bool                      `json:"enable"`
	Hide          bool                      `json:"hide"`
	IconColor     string                    `json:"iconColor"`
	Name          string                    `json:"name"`
	BuiltIn       *bool                     `json:"builtIn,omitempty"`
	Filter        *v2AnnotationFilter       `json:"filter,omitempty"`
	Mappings      map[string]v2EventMapping `json:"mappings,omitempty"`
	LegacyOptions map[string]any            `json:"legacyOptions,omitempty"`
}

type v2AnnotationFilter struct {
	Exclude *bool     `json:"exclude,omitempty"`
	IDs     []float64 `json:"ids"`
}

type v2EventMapping struct {
	Source *string `json:"source,omitempty"`
	Value  *string `json:"value,omitempty"`
	Regex  *string `json:"regex,omitempty"`
}

type v2DataQuery struct {
	Kind       string         `json:"kind"`
	Group      string         `json:"group"`
	Version    string         `json:"version"`
	Datasource *v2DSName      `json:"datasource,omitempty"`
	Spec       map[string]any `json:"spec"`
}

type v2DSName struct {
	Name *string `json:"name,omitempty"`
}

type v2PanelSpec struct {
	ID          float64                  `json:"id"`
	Title       string                   `json:"title"`
	Description *string                  `json:"description,omitempty"`
	Links       []v2DataLink             `json:"links"`
	Data        v2Kind[v2QueryGroupSpec] `json:"data"`
	VizConfig   v2VizConfig              `json:"vizConfig"`
	Transparent *bool                    `json:"transparent,omitempty"`
}

type v2LibraryPanelSpec struct {
	ID           float64           `json:"id"`
	Title        string            `json:"title"`
	LibraryPanel v2LibraryPanelRef `json:"libraryPanel"`
}

type v2LibraryPanelRef struct {
	Name string `json:"name"`
	UID  string `json:"uid"`
}

type v2DataLink struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	TargetBlank *bool  `json:"targetBlank,omitempty"`
}

type v2QueryGroupSpec struct {
	Queries         []v2Kind[v2PanelQuerySpec] `json:"queries"`
	Transformations []v2Transformation         `json:"transformations"`
	QueryOptions    v2QueryOptions             `json:"queryOptions"`
}

type v2PanelQuerySpec struct {
	Query  v2DataQuery `json:"query"`
	RefID  string      `json:"refId"`
	Hidden bool        `json:"hidden"`
}

type v2Transformation struct {
	Kind  string               `json:"kind"`
	Group string               `json:"group"`
	Spec  v2TransformationSpec `json:"spec"`
}

type v2TransformationSpec struct {
	RefID    *string          `json:"refId,omitempty"`
	Disabled *bool            `json:"disabled,omitempty"`
	Filter   *v2MatcherConfig `json:"filter,omitempty"`
	Options  any              `json:"options"`
}

type v2MatcherConfig struct {
	ID      string  `json:"id"`
	Scope   *string `json:"scope,omitempty"`
	Options any     `json:"options,omitempty"`
}

type v2QueryOptions struct {
	TimeFrom         *string `json:"timeFrom,omitempty"`
	MaxDataPoints    *int64  `json:"maxDataPoints,omitempty"`
	TimeShift        *string `json:"timeShift,omitempty"`
	QueryCachingTTL  *int64  `json:"queryCachingTTL,omitempty"`
	Interval         *string `json:"interval,omitempty"`
	CacheTimeout     *string `json:"cacheTimeout,omitempty"`
	HideTimeOverride *bool   `json:"hideTimeOverride,omitempty"`
	TimeCompare      *string `json:"timeCompare,omitempty"`
}

type v2VizConfig struct {
	Kind    string          `json:"kind"`
	Group   string          `json:"group"`
	Version string          `json:"version"`
	Spec    v2VizConfigSpec `json:"spec"`
}

type v2VizConfigSpec struct {
	Options     map[string]any      `json:"options"`
	FieldConfig v2FieldConfigSource `json:"fieldConfig"`
}

type v2FieldConfigSource struct {
	Defaults  v2FieldConfig `json:"defaults"`
	Overrides []v2Override  `json:"overrides"`
}

type v2FieldConfig struct {
	DisplayName       *string        `json:"displayName,omitempty"`
	DisplayNameFromDS *string        `json:"displayNameFromDS,omitempty"`
	Description       *string        `json:"description,omitempty"`
	Path              *string        `json:"path,omitempty"`
	Writeable         *bool          `json:"writeable,omitempty"`
	Filterable        *bool          `json:"filterable,omitempty"`
	Unit              *string        `json:"unit,omitempty"`
	Decimals          *float64       `json:"decimals,omitempty"`
	Min               *float64       `json:"min,omitempty"`
	Max               *float64       `json:"max,omitempty"`
	Mappings          []any          `json:"mappings,omitempty"`
	Thresholds        *v2Thresholds  `json:"thresholds,omitempty"`
	Color             *v2FieldColor  `json:"color,omitempty"`
	Links             []any          `json:"links,omitempty"`
	Actions           []v2Action     `json:"actions,omitempty"`
	NoValue           *string        `json:"noValue,omitempty"`
	Custom            map[string]any `json:"custom,omitempty"`
	FieldMinMax       *bool          `json:"fieldMinMax,omitempty"`
	NullValueMode     *string        `json:"nullValueMode,omitempty"`
}

type v2FieldColor struct {
	Mode       string  `json:"mode"`
	FixedColor *string `json:"fixedColor,omitempty"`
	SeriesBy   *string `json:"seriesBy,omitempty"`
}

type v2Thresholds struct {
	Mode  string        `json:"mode"`
	Steps []v2Threshold `json:"steps"`
}

type v2Threshold struct {
	Value     *float64 `json:"value"`
	ValueExpr *string  `json:"valueExpr,omitempty"`
	Color     string   `json:"color"`
}

type v2MappingResult struct {
	Text  *string `json:"text,omitempty"`
	Color *string `json:"color,omitempty"`
	Icon  *string `json:"icon,omitempty"`
	Index *int32  `json:"index,omitempty"`
}

type v2ValueMap struct {
	Type    string                     `json:"type"`
	Options map[string]v2MappingResult `json:"options"`
}

type v2RangeMap struct {
	Type    string `json:"type"`
	Options struct {
		From   *float64        `json:"from"`
		To     *float64        `json:"to"`
		Result v2MappingResult `json:"result"`
	} `json:"options"`
}

type v2RegexMap struct {
	Type    string `json:"type"`
	Options struct {
		Pattern string          `json:"pattern"`
		Result  v2MappingResult `json:"result"`
	} `json:"options"`
}

type v2SpecialMap struct {
	Type    string `json:"type"`
	Options struct {
		Match  string          `json:"match"`
		Result v2MappingResult `json:"result"`
	} `json:"options"`
}

type v2Override struct {
	SystemRef  *string          `json:"__systemRef,omitempty"`
	Matcher    v2MatcherConfig  `json:"matcher"`
	Properties []v2DynamicValue `json:"properties"`
}

type v2DynamicValue struct {
	ID    string `json:"id"`
	Value any    `json:"value,omitempty"`
}

type v2Action struct {
	Type         string             `json:"type"`
	Title        string             `json:"title"`
	Fetch        *v2FetchOptions    `json:"fetch,omitempty"`
	Infinity     *v2InfinityOptions `json:"infinity,omitempty"`
	Confirmation *string            `json:"confirmation,omitempty"`
	OneClick     *bool              `json:"oneClick,omitempty"`
	Variables    []v2ActionVariable `json:"variables,omitempty"`
	Style        *v2ActionStyle     `json:"style,omitempty"`
}

type v2FetchOptions struct {
	Method      string     `json:"method"`
	URL         string     `json:"url"`
	Body        *string    `json:"body,omitempty"`
	QueryParams [][]string `json:"queryParams,omitempty"`
	Headers     [][]string `json:"headers,omitempty"`
}

type v2InfinityOptions struct {
	Method        string     `json:"method"`
	URL           string     `json:"url"`
	Body          *string    `json:"body,omitempty"`
	QueryParams   [][]string `json:"queryParams,omitempty"`
	DatasourceUID string     `json:"datasourceUid"`
	Headers       [][]string `json:"headers,omitempty"`
}

type v2ActionVariable struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type v2ActionStyle struct {
	BackgroundColor *string `json:"backgroundColor,omitempty"`
}

type v2GridLayoutSpec struct {
	Items []v2Kind[v2GridItemSpec] `json:"items"`
}

type v2GridItemSpec struct {
	X       int64            `json:"x"`
	Y       int64            `json:"y"`
	Width   int64            `json:"width"`
	Height  int64            `json:"height"`
	Element v2ElementRef     `json:"element"`
	Repeat  *v2RepeatOptions `json:"repeat,omitempty"`
}

type v2ElementRef struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type v2RepeatOptions struct {
	Mode      string  `json:"mode"`
	Value     string  `json:"value"`
	Direction *string `json:"direction,omitempty"`
	MaxPerRow *int64  `json:"maxPerRow,omitempty"`
}

type v2RowsLayoutSpec struct {
	Rows []v2Kind[v2RowSpec] `json:"rows"`
}

type v2RowSpec struct {
	Title      *string                  `json:"title,omitempty"`
	Collapse   *bool                    `json:"collapse,omitempty"`
	HideHeader *bool                    `json:"hideHeader,omitempty"`
	Repeat     *v2RowRepeat             `json:"repeat,omitempty"`
	Layout     v2Kind[v2GridLayoutSpec] `json:"layout"`
}

type v2RowRepeat struct {
	Mode  string `json:"mode"`
	Value string `json:"value"`
}

// v2Text is a string or a list of strings (StringOrArrayOfString).
type v2Text struct {
	s    *string
	list []string
}

func (t v2Text) MarshalJSON() ([]byte, error) {
	if t.s != nil {
		return json.Marshal(*t.s)
	}
	if t.list != nil {
		return json.Marshal(t.list)
	}
	return []byte("null"), nil
}

type v2Option struct {
	Selected *bool  `json:"selected,omitempty"`
	Text     v2Text `json:"text"`
	Value    v2Text `json:"value"`
}

type v2QueryVariableSpec struct {
	Name               string      `json:"name"`
	Current            v2Option    `json:"current"`
	Label              *string     `json:"label,omitempty"`
	Hide               string      `json:"hide"`
	Refresh            string      `json:"refresh"`
	SkipURLSync        bool        `json:"skipUrlSync"`
	Description        *string     `json:"description,omitempty"`
	Query              v2DataQuery `json:"query"`
	Regex              string      `json:"regex"`
	RegexApplyTo       *string     `json:"regexApplyTo,omitempty"`
	Sort               string      `json:"sort"`
	Definition         *string     `json:"definition,omitempty"`
	Options            []v2Option  `json:"options"`
	Multi              bool        `json:"multi"`
	IncludeAll         bool        `json:"includeAll"`
	AllValue           *string     `json:"allValue,omitempty"`
	AllowCustomValue   bool        `json:"allowCustomValue"`
	StaticOptions      []v2Option  `json:"staticOptions,omitempty"`
	StaticOptionsOrder *string     `json:"staticOptionsOrder,omitempty"`
}

type v2TextVariableSpec struct {
	Name        string   `json:"name"`
	Current     v2Option `json:"current"`
	Query       string   `json:"query"`
	Label       *string  `json:"label,omitempty"`
	Hide        string   `json:"hide"`
	SkipURLSync bool     `json:"skipUrlSync"`
	Description *string  `json:"description,omitempty"`
}

type v2ConstantVariableSpec struct {
	Name        string   `json:"name"`
	Query       string   `json:"query"`
	Current     v2Option `json:"current"`
	Label       *string  `json:"label,omitempty"`
	Hide        string   `json:"hide"`
	SkipURLSync bool     `json:"skipUrlSync"`
	Description *string  `json:"description,omitempty"`
}

type v2DatasourceVariableSpec struct {
	Name             string     `json:"name"`
	PluginID         string     `json:"pluginId"`
	Refresh          string     `json:"refresh"`
	Regex            string     `json:"regex"`
	Current          v2Option   `json:"current"`
	Options          []v2Option `json:"options"`
	Multi            bool       `json:"multi"`
	IncludeAll       bool       `json:"includeAll"`
	AllValue         *string    `json:"allValue,omitempty"`
	Label            *string    `json:"label,omitempty"`
	Hide             string     `json:"hide"`
	SkipURLSync      bool       `json:"skipUrlSync"`
	Description      *string    `json:"description,omitempty"`
	AllowCustomValue bool       `json:"allowCustomValue"`
}

type v2IntervalVariableSpec struct {
	Name        string     `json:"name"`
	Query       string     `json:"query"`
	Current     v2Option   `json:"current"`
	Options     []v2Option `json:"options"`
	Auto        bool       `json:"auto"`
	AutoMin     string     `json:"auto_min"`
	AutoCount   int64      `json:"auto_count"`
	Refresh     string     `json:"refresh"`
	Label       *string    `json:"label,omitempty"`
	Hide        string     `json:"hide"`
	SkipURLSync bool       `json:"skipUrlSync"`
	Description *string    `json:"description,omitempty"`
}

type v2CustomVariableSpec struct {
	Name             string     `json:"name"`
	Query            string     `json:"query"`
	Current          v2Option   `json:"current"`
	Options          []v2Option `json:"options"`
	Multi            bool       `json:"multi"`
	IncludeAll       bool       `json:"includeAll"`
	AllValue         *string    `json:"allValue,omitempty"`
	Label            *string    `json:"label,omitempty"`
	Hide             string     `json:"hide"`
	SkipURLSync      bool       `json:"skipUrlSync"`
	Description      *string    `json:"description,omitempty"`
	AllowCustomValue bool       `json:"allowCustomValue"`
	ValuesFormat     *string    `json:"valuesFormat,omitempty"`
}

type v2SwitchVariableSpec struct {
	Name          string  `json:"name"`
	Current       string  `json:"current"`
	EnabledValue  string  `json:"enabledValue"`
	DisabledValue string  `json:"disabledValue"`
	Label         *string `json:"label,omitempty"`
	Hide          string  `json:"hide"`
	SkipURLSync   bool    `json:"skipUrlSync"`
	Description   *string `json:"description,omitempty"`
}

// v2DSVariable is the shape of an ad hoc or group by variable: the data
// source beside the spec.
type v2DSVariable[S any] struct {
	Kind       string    `json:"kind"`
	Group      string    `json:"group"`
	Datasource *v2DSName `json:"datasource,omitempty"`
	Spec       S         `json:"spec"`
}

type v2GroupByVariableSpec struct {
	Name         string     `json:"name"`
	DefaultValue *v2Option  `json:"defaultValue,omitempty"`
	Current      v2Option   `json:"current"`
	Options      []v2Option `json:"options"`
	Multi        bool       `json:"multi"`
	Label        *string    `json:"label,omitempty"`
	Hide         string     `json:"hide"`
	SkipURLSync  bool       `json:"skipUrlSync"`
	Description  *string    `json:"description,omitempty"`
}

type v2AdhocVariableSpec struct {
	Name             string          `json:"name"`
	BaseFilters      []v2AdhocFilter `json:"baseFilters"`
	Filters          []v2AdhocFilter `json:"filters"`
	DefaultKeys      []v2MetricValue `json:"defaultKeys"`
	Label            *string         `json:"label,omitempty"`
	Hide             string          `json:"hide"`
	SkipURLSync      bool            `json:"skipUrlSync"`
	Description      *string         `json:"description,omitempty"`
	AllowCustomValue bool            `json:"allowCustomValue"`
	EnableGroupBy    *bool           `json:"enableGroupBy,omitempty"`
}

type v2AdhocFilter struct {
	Key         string   `json:"key"`
	Operator    string   `json:"operator"`
	Value       string   `json:"value"`
	Values      []string `json:"values,omitempty"`
	KeyLabel    *string  `json:"keyLabel,omitempty"`
	ValueLabels []string `json:"valueLabels,omitempty"`
	Origin      *string  `json:"origin,omitempty"`
	Condition   *string  `json:"condition,omitempty"`
}

type v2MetricValue struct {
	Text  string  `json:"text"`
	Value *string `json:"value,omitempty"`
}
