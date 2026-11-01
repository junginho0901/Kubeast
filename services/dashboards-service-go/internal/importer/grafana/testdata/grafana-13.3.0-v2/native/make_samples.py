"""투세션: Grafana 13.3.0에 직접 넣을 schema v2 대시보드(배치 경우·v2 전용 기능)를 만든다. 출력 = <out>/<name>.json."""
import json, sys, os

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

def q(expr, ref="A", group="prometheus", ds="prometheus", hidden=False, legend=None):
    spec = {"expr": expr}
    if legend:
        spec["legendFormat"] = legend
    return {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": group, "version": "v0",
            "datasource": {"name": ds}, "spec": spec}, "refId": ref, "hidden": hidden}}

def panel(pid, title, viz="timeseries", queries=None, transformations=None, query_options=None, **extra):
    spec = {"id": pid, "title": title, "links": [],
            "data": {"kind": "QueryGroup", "spec": {"queries": queries or [q("up")],
                     "transformations": transformations or [], "queryOptions": query_options or {}}},
            "vizConfig": {"kind": "VizConfig", "group": viz, "version": "13.3.0",
                          "spec": {"options": {}, "fieldConfig": {"defaults": {}, "overrides": []}}}}
    spec.update(extra)
    return {"kind": "Panel", "spec": spec}

def item(name, x, y, w, h, repeat=None):
    s = {"x": x, "y": y, "width": w, "height": h, "element": {"kind": "ElementReference", "name": name}}
    if repeat:
        s["repeat"] = repeat
    return {"kind": "GridLayoutItem", "spec": s}

def grid(*items):
    return {"kind": "GridLayout", "spec": {"items": list(items)}}

def auto(names, **opts):
    items = []
    for n in names:
        if isinstance(n, dict):
            items.append(n)
        else:
            items.append({"kind": "AutoGridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": n}}})
    spec = {"columnWidthMode": "standard", "rowHeightMode": "standard", "items": items}
    spec.update(opts)
    return {"kind": "AutoGridLayout", "spec": spec}

def row(title, layout, **opts):
    s = {"title": title, "layout": layout}
    s.update(opts)
    return {"kind": "RowsLayoutRow", "spec": s}

def rows(*rs):
    return {"kind": "RowsLayout", "spec": {"rows": list(rs)}}

def tab(title, layout, **opts):
    s = {"title": title, "layout": layout}
    s.update(opts)
    return {"kind": "TabsLayoutTab", "spec": s}

def tabs(*ts):
    return {"kind": "TabsLayout", "spec": {"tabs": list(ts)}}

def var_query(name, expr, **opts):
    s = {"name": name, "current": {"text": "", "value": ""}, "hide": "dontHide", "refresh": "onTimeRangeChanged",
         "skipUrlSync": False, "query": {"kind": "DataQuery", "group": "prometheus", "version": "v0",
         "datasource": {"name": "prometheus"}, "spec": {"__legacyStringValue": expr}},
         "regex": "", "sort": "alphabeticalAsc", "options": [], "multi": False, "includeAll": False, "allowCustomValue": True}
    s.update(opts)
    return {"kind": "QueryVariable", "spec": s}

def dash(name, title, elements, layout, variables=None, annotations=None, **spec_extra):
    spec = {"title": title, "annotations": annotations or [], "cursorSync": "Off", "editable": True,
            "elements": elements, "layout": layout, "links": [], "preload": False, "tags": ["kubeast-v2-sample"],
            "timeSettings": {"from": "now-6h", "to": "now", "autoRefresh": "", "timezone": "browser",
                             "autoRefreshIntervals": ["10s", "30s", "1m"], "hideTimepicker": False, "fiscalYearStartMonth": 0},
            "variables": variables or []}
    spec.update(spec_extra)
    d = {"apiVersion": "dashboard.grafana.app/v2", "kind": "Dashboard", "metadata": {"name": name}, "spec": spec}
    json.dump(d, open(os.path.join(out, name + ".json"), "w"), indent=2)

E = lambda n: {f"panel-{i}": panel(i, f"Panel {i}") for i in range(1, n + 1)}

# 1. 탭 두 개
dash("v2-tabs", "Tabs", E(4), tabs(
    tab("Overview", grid(item("panel-1", 0, 0, 12, 8), item("panel-2", 12, 0, 12, 8))),
    tab("Detail", grid(item("panel-3", 0, 0, 24, 6), item("panel-4", 0, 6, 8, 4)))))

# 2. 자동 격자 — 4칸·낮은 행 / 5칸(24/5=4)·직접 높이 / 기본값·반복
dash("v2-autogrid-4-short", "Auto grid 4 short", E(6), auto([f"panel-{i}" for i in range(1, 7)], maxColumnCount=4, rowHeightMode="short"))
dash("v2-autogrid-5-custom", "Auto grid 5 custom", E(7), auto([f"panel-{i}" for i in range(1, 8)], maxColumnCount=5, rowHeightMode="custom", rowHeight=200))
dash("v2-autogrid-repeat", "Auto grid repeat", E(3),
     auto(["panel-1", {"kind": "AutoGridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": "panel-2"},
           "repeat": {"mode": "variable", "value": "instance"}}}, "panel-3"], rowHeightMode="tall"),
     variables=[var_query("instance", "label_values(up, instance)", multi=True, includeAll=True)])

# 3. 행 — 펼침·접힘·머리 숨김·자동 격자·안에 행·안에 탭·반복 + 안에 행
dash("v2-rows-mixed", "Rows mixed", E(12), rows(
    row("Expanded", grid(item("panel-1", 0, 0, 12, 8), item("panel-2", 12, 0, 12, 8))),
    row("Collapsed", grid(item("panel-3", 0, 0, 24, 6)), collapse=True),
    row("Hidden header", grid(item("panel-4", 0, 0, 12, 5), item("panel-5", 12, 3, 12, 5)), hideHeader=True),
    row("Auto grid inside", auto(["panel-6", "panel-7"], maxColumnCount=2)),
    row("Rows inside", rows(row("Child A", grid(item("panel-8", 0, 0, 24, 4))), row("Child B", grid(item("panel-9", 0, 0, 24, 4)), collapse=True))),
    row("Tabs inside", tabs(tab("T1", grid(item("panel-10", 0, 0, 24, 4))), tab("T2", grid(item("panel-11", 0, 0, 24, 4))))),
    row("Repeated parent", rows(row("Child C", grid(item("panel-12", 0, 0, 24, 4)), collapse=True)), repeat={"mode": "variable", "value": "instance"})),
    variables=[var_query("instance", "label_values(up, instance)", multi=True)])

# 4. 탭 안의 행·탭 안의 탭·탭 안 자동 격자·반복 탭
dash("v2-tabs-nested", "Tabs nested", E(6), tabs(
    tab("With rows", rows(row("R1", grid(item("panel-1", 0, 0, 24, 5))), row("R2", grid(item("panel-2", 0, 0, 24, 5)), collapse=True))),
    tab("With tabs", tabs(tab("Inner 1", grid(item("panel-3", 0, 0, 24, 5))), tab("Inner 2", grid(item("panel-4", 0, 0, 24, 5))))),
    tab("Auto", auto(["panel-5"], maxColumnCount=1)),
    tab("Repeated", grid(item("panel-6", 0, 0, 24, 5)), repeat={"mode": "variable", "value": "instance"})),
    variables=[var_query("instance", "label_values(up, instance)")])

# 5. v2 전용 기능 — 구역 변수·주석, 조건부 표시, 라이브러리 패널, 배치 안 된 요소, 부제, 투명, 직접 지은 요소 이름,
#    변환 filter·topic·disabled, 질의 옵션, 숨긴 질의, Loki, 여러 데이터소스, 반복 격자 항목, 변수 종류들, 시간 설정, 링크
els = {
    "panel-1": panel(1, "Subtitle and transparent", subtitle="a subtitle", transparent=True, description="desc"),
    "my-custom-name": panel(2, "Custom element name", viz="stat",
        queries=[q("sum(rate(http_requests_total[5m]))", legend="rps"), q("up", ref="B", hidden=True)],
        transformations=[{"kind": "Transformation", "group": "reduce", "spec": {"options": {"reducers": ["last"]}, "disabled": True,
                          "topic": "series", "filter": {"id": "byRefId", "options": "A"}}}],
        query_options={"interval": "1m", "maxDataPoints": 500, "timeFrom": "1h", "timeShift": "1d", "hideTimeOverride": True}),
    "panel-3": panel(3, "Loki logs", viz="logs", queries=[q('{app="web"} |= "error"', group="loki", ds="loki")]),
    "panel-4": panel(4, "Mixed sources", queries=[q("up"), q('count_over_time({app="web"}[5m])', ref="B", group="loki", ds="loki")]),
    "panel-5": panel(5, "Repeated item"),
    "panel-6": panel(6, "Conditional"),
    "lib": {"kind": "LibraryPanel", "spec": {"id": 7, "title": "Library", "libraryPanel": {"uid": "lib-uid-1", "name": "Shared CPU"}}},
    "panel-8": panel(8, "Not placed anywhere"),
}
cond = {"kind": "ConditionalRenderingGroup", "spec": {"visibility": "show", "condition": "and",
        "items": [{"kind": "ConditionalRenderingVariable", "spec": {"variable": "env", "operator": "equals", "value": "prod"}}]}}
section_var = {"kind": "TextVariable", "spec": {"name": "section_note", "current": {"text": "x", "value": "x"}, "query": "x", "hide": "dontHide", "skipUrlSync": False}}
section_ann = {"kind": "AnnotationQuery", "spec": {"query": {"kind": "DataQuery", "group": "prometheus", "version": "v0", "datasource": {"name": "prometheus"},
               "spec": {"expr": "changes(up[5m]) > 0"}}, "enable": True, "hide": False, "iconColor": "red", "name": "Section deploys"}}
dash("v2-features", "Features", els, rows(
    row("Section", grid(item("panel-1", 0, 0, 12, 6), item("my-custom-name", 12, 0, 12, 6),
                        item("panel-5", 0, 6, 24, 4, repeat={"mode": "variable", "value": "env", "direction": "v", "maxPerRow": 2})),
        variables=[section_var], annotations=[section_ann], conditionalRendering=cond, fillScreen=True),
    row("More", auto(["panel-3", "panel-4", "lib",
        {"kind": "AutoGridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": "panel-6"}, "conditionalRendering": cond}}],
        maxColumnCount=2, fillScreen=True, matchRowHeights=False))),
    variables=[
        {"kind": "CustomVariable", "spec": {"name": "env", "query": "prod,stage", "current": {"text": "prod", "value": "prod"},
         "options": [{"text": "prod", "value": "prod", "selected": True}, {"text": "stage", "value": "stage", "selected": False}],
         "multi": False, "includeAll": False, "hide": "dontHide", "skipUrlSync": False, "allowCustomValue": True}},
        var_query("job", "label_values(up, job)", sort="numericalDesc", refresh="onDashboardLoad", hide="hideLabel", definition="label_values(up, job)", regex="/(.*)/"),
        {"kind": "DatasourceVariable", "spec": {"name": "ds", "pluginId": "prometheus", "refresh": "onDashboardLoad", "regex": "",
         "current": {"text": "prometheus", "value": "prometheus"}, "options": [], "multi": False, "includeAll": False, "hide": "dontHide", "skipUrlSync": False, "allowCustomValue": True}},
        {"kind": "IntervalVariable", "spec": {"name": "interval", "query": "1m,5m,10m", "current": {"text": "5m", "value": "5m"},
         "options": [{"text": "1m", "value": "1m"}, {"text": "5m", "value": "5m", "selected": True}, {"text": "10m", "value": "10m"}],
         "auto": True, "auto_min": "10s", "auto_count": 30, "refresh": "onTimeRangeChanged", "hide": "dontHide", "skipUrlSync": False}},
        {"kind": "ConstantVariable", "spec": {"name": "region", "query": "ap-northeast-2", "current": {"text": "ap-northeast-2", "value": "ap-northeast-2"}, "hide": "hideVariable", "skipUrlSync": False}},
        {"kind": "TextVariable", "spec": {"name": "search", "query": "", "current": {"text": "", "value": ""}, "hide": "dontHide", "skipUrlSync": False}},
        {"kind": "SwitchVariable", "spec": {"name": "debug", "current": "false", "enabledValue": "true", "disabledValue": "false", "hide": "dontHide", "skipUrlSync": False}},
        {"kind": "AdhocVariable", "group": "prometheus", "datasource": {"name": "prometheus"}, "spec": {"name": "filters", "baseFilters": [],
         "filters": [{"key": "namespace", "operator": "=", "value": "web"}], "defaultKeys": [], "hide": "dontHide", "skipUrlSync": False, "allowCustomValue": True}},
        {"kind": "GroupByVariable", "group": "prometheus", "datasource": {"name": "prometheus"}, "spec": {"name": "groupby",
         "current": {"text": "job", "value": "job"}, "options": [], "multi": True, "hide": "dontHide", "skipUrlSync": False}},
    ],
    annotations=[{"kind": "AnnotationQuery", "spec": {"query": {"kind": "DataQuery", "group": "grafana", "version": "v0", "datasource": {"name": "-- Grafana --"}, "spec": {}},
                  "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "builtIn": True, "legacyOptions": {"type": "dashboard"}}},
                 {"kind": "AnnotationQuery", "spec": {"query": {"kind": "DataQuery", "group": "prometheus", "version": "v0", "datasource": {"name": "prometheus"},
                  "spec": {"expr": "changes(kube_deployment_status_observed_generation[2m]) > 0"}}, "enable": True, "hide": False, "iconColor": "blue",
                  "name": "Rollouts", "filter": {"exclude": False, "ids": [2, 3]}, "legacyOptions": {"titleFormat": "rollout", "step": "60s"}}}],
    cursorSync="Tooltip", description="every v2-only feature", liveNow=True,
    links=[{"title": "Runbook", "type": "link", "icon": "doc", "tooltip": "rb", "url": "https://example.invalid/runbook", "tags": [], "asDropdown": False,
            "targetBlank": True, "includeVars": True, "keepTime": True, "placement": "inControlsMenu"},
           {"title": "Related", "type": "dashboards", "icon": "external link", "tooltip": "", "tags": ["kubeast-v2-sample"], "asDropdown": True,
            "targetBlank": False, "includeVars": False, "keepTime": False}],
)
# 시간 설정 확장은 별도 파일로(위 dash()의 timeSettings를 덮음)
d = json.load(open(os.path.join(out, "v2-features.json")))
d["spec"]["timeSettings"].update({"autoRefresh": "30s", "weekStart": "monday", "nowDelay": "1m", "hideTimepicker": True,
    "quickRanges": [{"display": "Last 2 hours", "from": "now-2h", "to": "now"}], "fiscalYearStartMonth": 3, "timezone": "utc"})
json.dump(d, open(os.path.join(out, "v2-features.json"), "w"), indent=2)
print(sorted(os.listdir(out)))
