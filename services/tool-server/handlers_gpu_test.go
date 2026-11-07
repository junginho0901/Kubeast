package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type gpuFake struct {
	status int
	body   string
	header map[string]string
}

const (
	gpuDashboardPath = "/api/v1/gpu/dashboard"
	gpuMetricsPath   = "/api/v1/gpu/metrics"
	gpuClassesPath   = "/api/v1/deviceclasses"
	gpuTemplatesPath = "/api/v1/resourceclaimtemplates/all"
)

// fakeGPUService answers the paths the GPU screens read; a path it is not given is a test failure.
func fakeGPUService(t *testing.T, answers map[string]gpuFake) *sync.Map {
	t.Helper()
	seen := &sync.Map{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.URL.Path, r)
		a, ok := answers[r.URL.Path]
		if !ok {
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(http.StatusTeapot)
			return
		}
		for k, v := range a.header {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		if a.status == 0 {
			a.status = http.StatusOK
		}
		w.WriteHeader(a.status)
		_, _ = w.Write([]byte(a.body))
	}))
	orig := k8sServiceURL
	k8sServiceURL = srv.URL
	t.Cleanup(func() { k8sServiceURL = orig; srv.Close() })
	return seen
}

func gpuJSON(t *testing.T, v interface{}) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

type jsonMap = map[string]interface{}

func gpuPodRow(ns, name string, requested int, status, phase, node string, vendors ...jsonMap) jsonMap {
	row := jsonMap{"name": name, "namespace": ns, "gpu_requested": requested, "gpu_vendors": vendors, "status": status, "phase": phase, "created_at": "2026-11-06T00:00:00Z"}
	if node != "" {
		row["node_name"] = node
	}
	return row
}

func vendorAsk(vendor string, n int) jsonMap { return jsonMap{"vendor": vendor, "requested": n} }

func gpuDashboardFixture() jsonMap {
	return jsonMap{
		"total_gpu_capacity": 16, "total_gpu_allocatable": 15, "total_gpu_used": 9, "total_gpu_waiting": 2,
		"vendors": []jsonMap{
			{"vendor": "NVIDIA", "capacity": 12, "allocatable": 11, "used": 8, "waiting": 2},
			{"vendor": "AMD", "capacity": 4, "allocatable": 4, "used": 1, "waiting": 0},
		},
		"gpu_nodes": []jsonMap{
			{"name": "n-small", "gpu_capacity": 4, "gpu_allocatable": 4, "gpu_used": 1, "status": "Ready,SchedulingDisabled", "gpu_model": "AMD_Instinct_MI300X",
				"gpu_vendors": []jsonMap{{"vendor": "AMD", "capacity": 4, "allocatable": 4, "used": 1, "model": "AMD_Instinct_MI300X", "memory": "192G"}}},
			{"name": "n-big", "gpu_capacity": 8, "gpu_allocatable": 8, "gpu_used": 8, "status": "Ready", "gpu_model": "NVIDIA-A100",
				"gpu_vendors": []jsonMap{{"vendor": "NVIDIA", "capacity": 8, "allocatable": 8, "used": 8, "model": "NVIDIA-A100"}}},
			{"name": "n-down", "gpu_capacity": 4, "gpu_allocatable": 3, "gpu_used": 0, "status": "NotReady", "gpu_model": "NVIDIA-A100",
				"gpu_vendors": []jsonMap{{"vendor": "NVIDIA", "capacity": 4, "allocatable": 3, "used": 0, "model": "NVIDIA-A100"}}},
		},
		"gpu_pods": []jsonMap{
			gpuPodRow("batch", "done", 1, "Completed", "Succeeded", "n-big", vendorAsk("NVIDIA", 1)),
			gpuPodRow("serve", "api-0", 2, "Running", "Running", "n-big", vendorAsk("NVIDIA", 1), vendorAsk("AMD", 1)),
			gpuPodRow("training", "job-a", 4, "Running", "Running", "n-big", vendorAsk("NVIDIA", 4)),
			gpuPodRow("training", "job-b", 2, "Running", "Running", "n-big", vendorAsk("NVIDIA", 2)),
			gpuPodRow("serve", "api-1", 1, "CrashLoopBackOff", "Running", "n-big", vendorAsk("NVIDIA", 1)),
			gpuPodRow("batch", "oom", 1, "OOMKilled", "Failed", "n-down", vendorAsk("NVIDIA", 1)),
			gpuPodRow("training", "wait", 2, "Pending", "Pending", "", vendorAsk("NVIDIA", 2)),
		},
		"device_plugins": []jsonMap{
			{"vendor": "NVIDIA", "found": true, "name": "nvdp", "namespace": "kube-system", "desired": 3, "ready": 3, "available": 3},
			{"vendor": "AMD", "found": true, "name": "amdgpu", "namespace": "kube-system", "desired": 2, "ready": 1, "available": 1},
			{"vendor": "Intel", "found": false},
		},
		"mig_enabled": true, "time_slicing_enabled": false, "time_slicing_config": nil,
		"dra_pods": []jsonMap{{"namespace": "ml", "name": "dra-pod"}},
	}
}

func gpuMetricsFixture() jsonMap {
	row := func(uuid, host, gpu string, util, used, free, total, percent float64, pod, ns string) jsonMap {
		return jsonMap{"uuid": uuid, "gpu": gpu, "hostname": host, "model_name": "A100", "gpu_util": util, "memory_used_mb": used, "memory_free_mb": free,
			"memory_total_mb": total, "memory_util_percent": percent, "memory_temp": 40.0, "exported_pod": pod, "exported_namespace": ns}
	}
	return jsonMap{
		"available": true, "gpu_count": 4, "avg_gpu_util": 50.0, "avg_memory_util": 25.0, "total_memory_used_mb": 4000.0, "total_memory_free_mb": 12000.0, "total_memory_mb": 16000.0,
		"gpus": []jsonMap{
			row("u1", "n-big", "0", 80, 2000, 2000, 4000, 50, "job-a", "training"),
			row("u2", "n-big", "1", 40, 1000, 3000, 4000, 25, "job-a", "training"),
			row("u3", "n-down", "0", 30, 0, 4000, 4000, 0, "dcgm-exporter-x", "monitoring"),
			row("u4", "n-down", "1", 50, 1000, 3000, 4000, 25, "dra-pod", "ml"),
		},
	}
}

func gpuFullAnswers(t *testing.T) map[string]gpuFake {
	t.Helper()
	return map[string]gpuFake{
		gpuDashboardPath: {body: gpuJSON(t, gpuDashboardFixture())},
		gpuMetricsPath:   {body: gpuJSON(t, gpuMetricsFixture())},
		gpuClassesPath:   {body: `[{"name":"gpu.example.com","selector_count":1}]`},
		gpuTemplatesPath: {body: `[{"name":"one-gpu","namespace":"ml","request_count":1}]`},
	}
}

func askGPU(t *testing.T, ctxCluster string) jsonMap {
	t.Helper()
	out, err := handleGPU(ctxFor(ctxCluster), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	return decode(t, out)
}

func rowsByName(t *testing.T, v interface{}) map[string]jsonMap {
	t.Helper()
	list, ok := v.([]interface{})
	if !ok {
		t.Fatalf("not a list: %#v", v)
	}
	out := map[string]jsonMap{}
	for _, r := range list {
		m, ok := r.(jsonMap)
		if !ok {
			t.Fatalf("row %#v is not an object", r)
		}
		key := fmt.Sprint(m["name"])
		if key == "<nil>" {
			key = fmt.Sprint(m["vendor"])
		}
		if key == "<nil>" {
			key = fmt.Sprint(m["model"])
		}
		if ns, ok := m["namespace"].(string); ok {
			key = ns + "/" + key
		}
		out[key] = m
	}
	return out
}

func TestGPU_AsksWhatTheScreensAskAsTheCaller(t *testing.T) {
	seen := fakeGPUService(t, gpuFullAnswers(t))
	askGPU(t, "c1")
	for _, path := range []string{gpuDashboardPath, gpuMetricsPath, gpuClassesPath, gpuTemplatesPath} {
		v, ok := seen.Load(path)
		if !ok {
			t.Errorf("%s was not asked", path)
			continue
		}
		r := v.(*http.Request)
		if r.URL.Query().Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
			t.Errorf("%s: %s auth=%q", path, r.URL.RawQuery, r.Header.Get("Authorization"))
		}
	}
}

func TestGPU_TheCardsAreTheScreens(t *testing.T) {
	fakeGPUService(t, gpuFullAnswers(t))
	m := askGPU(t, "c1")
	for key, want := range map[string]float64{
		"total_gpu_capacity": 16, "total_gpu_allocatable": 15, "total_gpu_used": 9, "total_gpu_waiting": 2,
		"allocation_rate": 60, // Math.round(used / allocatable * 100)
		"total_gpu_free":  6,  // what each node has left, per company
	} {
		if m[key] != want {
			t.Errorf("%s = %v, want %v", key, m[key], want)
		}
	}
	if got, want := m["node_counts"], (jsonMap{"total": 3.0, "ready": 2.0, "not_ready": 1.0}); !reflect.DeepEqual(got, want) {
		t.Errorf("node_counts = %v, want %v (a cordoned node is Ready, as gpuNodeCounts reads it)", got, want)
	}
	// gpuPodCounts: failed = phase Failed or a status naming an error; requested leaves out the pods that ended
	if got, want := m["pod_counts"], (jsonMap{"total": 7.0, "running": 4.0, "pending": 1.0, "failed": 2.0, "requested": 11.0, "namespaces": 3.0}); !reflect.DeepEqual(got, want) {
		t.Errorf("pod_counts = %v, want %v", got, want)
	}
	if m["mig_enabled"] != true || m["time_slicing_enabled"] != false {
		t.Errorf("mig %v, time slicing %v", m["mig_enabled"], m["time_slicing_enabled"])
	}
	if _, has := m["hint"]; has {
		t.Errorf("a cluster with GPUs got a hint: %v", m["hint"])
	}
}

func TestGPU_EachCompanysNumbersAreSplitAsTheScreensSplitThem(t *testing.T) {
	fakeGPUService(t, gpuFullAnswers(t))
	m := askGPU(t, "c1")
	vendors := rowsByName(t, m["vendors"])
	if got, want := vendors["NVIDIA"], (jsonMap{"vendor": "NVIDIA", "capacity": 12.0, "allocatable": 11.0, "used": 8.0, "waiting": 2.0, "free": 3.0, "nodes": 2.0}); !reflect.DeepEqual(got, want) {
		t.Errorf("NVIDIA = %v, want %v", got, want)
	}
	if got, want := vendors["AMD"], (jsonMap{"vendor": "AMD", "capacity": 4.0, "allocatable": 4.0, "used": 1.0, "waiting": 0.0, "free": 3.0, "nodes": 1.0}); !reflect.DeepEqual(got, want) {
		t.Errorf("AMD = %v, want %v", got, want)
	}
	// gpuPodVendorCounts: every pod asking, the GPUs of those not ended
	podVendors := rowsByName(t, m["pod_vendors"])
	if got, want := podVendors["NVIDIA"], (jsonMap{"vendor": "NVIDIA", "pods": 7.0, "requested": 10.0}); !reflect.DeepEqual(got, want) {
		t.Errorf("pods of NVIDIA = %v, want %v", got, want)
	}
	if got, want := podVendors["AMD"], (jsonMap{"vendor": "AMD", "pods": 1.0, "requested": 1.0}); !reflect.DeepEqual(got, want) {
		t.Errorf("pods of AMD = %v, want %v", got, want)
	}
	// gpuModels: each company's GPUs of a node under its own model, most GPUs first
	models := subList(t, m, "models")
	if len(models) != 2 {
		t.Fatalf("models = %v", models)
	}
	if got, want := models[0], (jsonMap{"model": "NVIDIA-A100", "nodes": 2.0, "capacity": 12.0, "allocatable": 11.0, "used": 8.0}); !reflect.DeepEqual(got, want) {
		t.Errorf("first model = %v, want %v", got, want)
	}
	if got := models[1].(jsonMap)["model"]; got != "AMD_Instinct_MI300X" {
		t.Errorf("second model = %v", got)
	}
	plugins := rowsByName(t, m["device_plugins"])
	for name, want := range map[string]string{"kube-system/nvdp": "healthy", "kube-system/amdgpu": "unhealthy", "Intel": "missing"} {
		if got := plugins[name]["state"]; got != want {
			t.Errorf("plugin %s = %v, want %v (%v)", name, got, want, plugins)
		}
	}
	if plugins["kube-system/amdgpu"]["vendor"] != "AMD" {
		t.Errorf("plugin row keeps its company: %v", plugins["kube-system/amdgpu"])
	}
}

func TestGPU_EachNodeSaysWhatItHasLeft(t *testing.T) {
	fakeGPUService(t, gpuFullAnswers(t))
	m := askGPU(t, "c1")
	nodes := rowsByName(t, m["gpu_nodes"])
	for name, want := range map[string][2]float64{"n-big": {0, 100}, "n-small": {3, 25}, "n-down": {3, 0}} {
		if nodes[name]["gpu_free"] != want[0] || nodes[name]["used_percent"] != want[1] {
			t.Errorf("%s: free %v, percent %v, want %v", name, nodes[name]["gpu_free"], nodes[name]["used_percent"], want)
		}
	}
	if nodes["n-small"]["status"] != "Ready,SchedulingDisabled" || nodes["n-small"]["gpu_allocatable"] != 4.0 || nodes["n-small"]["gpu_used"] != 1.0 {
		t.Errorf("row: %v", nodes["n-small"])
	}
	if got := subList(t, m, "gpu_nodes")[0].(jsonMap)["name"]; got != "n-big" {
		t.Errorf("first node = %v, want the most GPUs first as the screen", got)
	}
}

// A node may hold more than it advertises now; nothing is left on it, and another company's GPUs there do not fill the gap.
func TestGPU_ANodeHoldingMoreThanItAdvertisesHasNoneLeft(t *testing.T) {
	d := gpuDashboardFixture()
	d["gpu_nodes"] = []jsonMap{{"name": "over", "gpu_capacity": 6, "gpu_allocatable": 6, "gpu_used": 3, "status": "Ready",
		"gpu_vendors": []jsonMap{{"vendor": "NVIDIA", "capacity": 2, "allocatable": 2, "used": 3}, {"vendor": "AMD", "capacity": 4, "allocatable": 4, "used": 0}}}}
	answers := gpuFullAnswers(t)
	answers[gpuDashboardPath] = gpuFake{body: gpuJSON(t, d)}
	fakeGPUService(t, answers)
	m := askGPU(t, "c1")
	if got := rowsByName(t, m["gpu_nodes"])["over"]["gpu_free"]; got != 4.0 {
		t.Errorf("node free = %v, want 4", got)
	}
	if m["total_gpu_free"] != 4.0 {
		t.Errorf("total free = %v, want 4", m["total_gpu_free"])
	}
	vendors := rowsByName(t, m["vendors"])
	if vendors["NVIDIA"]["free"] != 0.0 || vendors["AMD"]["free"] != 4.0 {
		t.Errorf("vendors = %v", vendors)
	}
}

func TestGPU_TheUtilizationIsDCGMsAndAGPUsPodIsNamedOnlyWhenItHoldsOne(t *testing.T) {
	fakeGPUService(t, gpuFullAnswers(t))
	m := askGPU(t, "c1")
	u := subMap(t, m, "utilization")
	for key, want := range map[string]interface{}{"available": true, "gpu_count": 4.0, "avg_gpu_util": 50.0, "avg_memory_util": 25.0,
		"total_memory_used_mb": 4000.0, "total_memory_free_mb": 12000.0, "total_memory_mb": 16000.0} {
		if u[key] != want {
			t.Errorf("utilization.%s = %v, want %v", key, u[key], want)
		}
	}
	gpus := map[string]jsonMap{}
	for _, g := range subList(t, m, "gpus") {
		gpus[g.(jsonMap)["uuid"].(string)] = g.(jsonMap)
	}
	if gpus["u1"]["pod"] != "training/job-a" || gpus["u1"]["gpu_util"] != 80.0 || gpus["u1"]["memory_util_percent"] != 50.0 || gpus["u1"]["hostname"] != "n-big" {
		t.Errorf("u1 = %v", gpus["u1"])
	}
	if pod, named := gpus["u3"]["pod"]; named {
		t.Errorf("the exporter's own pod is named: %v", pod)
	}
	if gpus["u4"]["pod"] != "ml/dra-pod" {
		t.Errorf("a pod holding a DRA claim: %v", gpus["u4"])
	}
	for _, g := range gpus {
		if _, raw := g["exported_pod"]; raw {
			t.Errorf("the series' label stays out of the row: %v", g)
		}
	}
	// podGpuUsage: the mean of the pod's GPUs, the used of their total memory
	pods := rowsByName(t, m["gpu_pods"])
	if got, want := pods["training/job-a"]["gpu_usage"], (jsonMap{"gpus": 2.0, "gpu_util": 60.0, "memory_util_percent": 37.5}); !reflect.DeepEqual(got, want) {
		t.Errorf("job-a usage = %v, want %v", got, want)
	}
	if usage, has := pods["training/job-b"]["gpu_usage"]; has {
		t.Errorf("a pod no series names has no usage: %v", usage)
	}
}

func TestGPU_NoPrometheusIsNotZeroUtilization(t *testing.T) {
	answers := gpuFullAnswers(t)
	answers[gpuMetricsPath] = gpuFake{body: `{"available":false,"gpus":[]}`}
	fakeGPUService(t, answers)
	m := askGPU(t, "c1")
	u := subMap(t, m, "utilization")
	if u["available"] != false {
		t.Fatalf("available = %v", u["available"])
	}
	for _, key := range []string{"gpu_count", "avg_gpu_util", "avg_memory_util", "total_memory_used_mb", "total_memory_free_mb", "total_memory_mb"} {
		wantNull(t, u, key)
	}
	if note, _ := u["note"].(string); !strings.Contains(note, "not zero") {
		t.Errorf("note = %q", note)
	}
	wantNull(t, m, "gpus")
	if m["total_gpu_used"] != 9.0 {
		t.Errorf("the allocation does not need Prometheus: %v", m["total_gpu_used"])
	}
}

func TestGPU_ASeriesThatIsNotThereIsNotZero(t *testing.T) {
	t.Run("no DCGM series", func(t *testing.T) {
		answers := gpuFullAnswers(t)
		answers[gpuMetricsPath] = gpuFake{body: `{"available":true,"gpu_count":0,"avg_gpu_util":0,"avg_memory_util":0,"total_memory_used_mb":0,"total_memory_free_mb":0,"total_memory_mb":0,"gpus":[]}`}
		fakeGPUService(t, answers)
		u := subMap(t, askGPU(t, "c1"), "utilization")
		if u["available"] != true || u["gpu_count"] != 0.0 {
			t.Fatalf("u = %v", u)
		}
		for _, key := range []string{"avg_gpu_util", "avg_memory_util", "total_memory_used_mb", "total_memory_free_mb", "total_memory_mb"} {
			wantNull(t, u, key)
		}
		if note, _ := u["note"].(string); !strings.Contains(note, "DCGM") {
			t.Errorf("note = %q", note)
		}
	})
	t.Run("no memory series", func(t *testing.T) {
		answers := gpuFullAnswers(t)
		answers[gpuMetricsPath] = gpuFake{body: `{"available":true,"gpu_count":1,"avg_gpu_util":70,"avg_memory_util":0,"total_memory_used_mb":0,"total_memory_free_mb":0,"total_memory_mb":0,"gpus":[]}`}
		fakeGPUService(t, answers)
		u := subMap(t, askGPU(t, "c1"), "utilization")
		if u["avg_gpu_util"] != 70.0 {
			t.Fatalf("u = %v", u)
		}
		for _, key := range []string{"avg_memory_util", "total_memory_used_mb", "total_memory_free_mb", "total_memory_mb"} {
			wantNull(t, u, key)
		}
	})
}

// The API writes 0 for a series a GPU did not report; the screens leave a temperature of 0 out and a memory of 0 of 0 reads as nothing.
func TestGPU_AGPUsMissingSeriesAreNotZero(t *testing.T) {
	metrics := gpuMetricsFixture()
	metrics["gpus"] = []jsonMap{{"uuid": "u1", "gpu": "0", "hostname": "n-big", "model_name": "A100", "gpu_util": 70.0, "memory_used_mb": 0.0, "memory_free_mb": 0.0,
		"memory_total_mb": 0.0, "memory_util_percent": 0.0, "memory_temp": 0.0, "exported_pod": "job-a", "exported_namespace": "training"}}
	answers := gpuFullAnswers(t)
	answers[gpuMetricsPath] = gpuFake{body: gpuJSON(t, metrics)}
	fakeGPUService(t, answers)
	m := askGPU(t, "c1")
	row, _ := subList(t, m, "gpus")[0].(jsonMap)
	for _, key := range []string{"memory_used_mb", "memory_free_mb", "memory_total_mb", "memory_util_percent", "memory_temp"} {
		wantNull(t, row, key)
	}
	if row["gpu_util"] != 70.0 {
		t.Errorf("gpu_util = %v", row["gpu_util"])
	}
	usage := subMap(t, rowsByName(t, m["gpu_pods"])["training/job-a"], "gpu_usage")
	wantNull(t, usage, "memory_util_percent")
	if usage["gpu_util"] != 70.0 || usage["gpus"] != 1.0 {
		t.Errorf("usage = %v", usage)
	}
}

func TestGPU_WhatAGrantMayNotReadIsNullAndNamed(t *testing.T) {
	forbidden := func(detail string) gpuFake { return gpuFake{status: 403, body: gpuJSON(t, jsonMap{"detail": detail})} }
	fakeGPUService(t, map[string]gpuFake{
		gpuDashboardPath: forbidden("nodes is forbidden"),
		gpuMetricsPath:   forbidden("the cluster's Prometheus covers the whole cluster"),
		gpuClassesPath:   forbidden("deviceclasses is forbidden"),
		gpuTemplatesPath: {body: `[]`},
	})
	out, err := handleGPU(ctxFor("c1", "shop"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	for _, key := range []string{"total_gpu_capacity", "total_gpu_allocatable", "total_gpu_used", "total_gpu_free", "total_gpu_waiting", "allocation_rate",
		"vendors", "node_counts", "pod_counts", "pod_vendors", "models", "device_plugins", "mig_enabled", "time_slicing_enabled", "gpu_nodes", "gpu_pods", "device_classes", "gpus"} {
		wantNull(t, m, key)
	}
	refused := subMap(t, m, "refused")
	for key, want := range map[string]string{"dashboard": "nodes is forbidden", "metrics": "Prometheus", "device_classes": "deviceclasses"} {
		if got, _ := refused[key].(string); !strings.Contains(got, want) {
			t.Errorf("refused.%s = %q, want %q", key, got, want)
		}
	}
	if _, has := refused["resource_claim_templates"]; has {
		t.Errorf("a list it may read: %v", refused)
	}
	// read and empty is zero, not "not counted"
	if got, ok := m["resource_claim_templates"].([]interface{}); !ok || len(got) != 0 || m["resource_claim_templates_total"] != 0.0 {
		t.Errorf("templates = %#v, total %v", m["resource_claim_templates"], m["resource_claim_templates_total"])
	}
	u := subMap(t, m, "utilization")
	wantNull(t, u, "available")
	wantNull(t, u, "avg_gpu_util")
	if note, _ := m["null_note"].(string); !strings.Contains(note, "not counted, not zero") {
		t.Errorf("null_note = %q", note)
	}
}

func TestGPU_AGrantLimitedToNamespacesPassesTheGate(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	if err := namespaceGate(scoped, "c", "gpu", args{}); err != nil {
		t.Fatalf("k8s-service narrows or refuses each read, as for the screen: %v", err)
	}
	if err := namespaceGate(scoped, "c", "gpu", args{"namespace": "db"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("a namespace outside the grant: %v", err)
	}
}

func TestGPU_DRANotServedIsNotNoClasses(t *testing.T) {
	answers := gpuFullAnswers(t)
	notServed := func(resource string) gpuFake {
		return gpuFake{body: `[]`, header: map[string]string{"X-Kubeast-Not-Installed": resource}}
	}
	answers[gpuClassesPath] = notServed("deviceclasses")
	answers[gpuTemplatesPath] = notServed("resourceclaimtemplates")
	fakeGPUService(t, answers)
	m := askGPU(t, "c1")
	wantNull(t, m, "device_classes")
	wantNull(t, m, "resource_claim_templates")
	if got := m["not_served"]; !reflect.DeepEqual(got, []interface{}{"device_classes", "resource_claim_templates"}) {
		t.Errorf("not_served = %v", got)
	}

	answers = gpuFullAnswers(t)
	answers[gpuClassesPath] = gpuFake{body: `[]`}
	fakeGPUService(t, answers)
	m = askGPU(t, "c1")
	if got, ok := m["device_classes"].([]interface{}); !ok || len(got) != 0 {
		t.Errorf("served and empty: %#v", m["device_classes"])
	}
	if _, has := m["not_served"]; has {
		t.Errorf("not_served = %v", m["not_served"])
	}
	if got := rowsByName(t, m["resource_claim_templates"])["ml/one-gpu"]["request_count"]; got != 1.0 {
		t.Errorf("template row = %v", m["resource_claim_templates"])
	}
}

func TestGPU_APartThatFailsIsNamedAndTheOthersStand(t *testing.T) {
	answers := gpuFullAnswers(t)
	answers[gpuMetricsPath] = gpuFake{status: 502, body: `{"detail":"GPU metric gpu_util: timed out"}`}
	answers[gpuClassesPath] = gpuFake{status: 500, body: `{"detail":"boom"}`}
	fakeGPUService(t, answers)
	m := askGPU(t, "c1")
	notRead := subMap(t, m, "not_read")
	if got, _ := notRead["metrics"].(string); !strings.Contains(got, "timed out") {
		t.Errorf("not_read.metrics = %q", got)
	}
	if got, _ := notRead["device_classes"].(string); !strings.Contains(got, "boom") {
		t.Errorf("not_read.device_classes = %q", got)
	}
	u := subMap(t, m, "utilization")
	wantNull(t, u, "available")
	wantNull(t, u, "avg_gpu_util")
	wantNull(t, m, "device_classes")
	if m["total_gpu_capacity"] != 16.0 {
		t.Errorf("the dashboard stands: %v", m["total_gpu_capacity"])
	}
}

func TestGPU_TheDashboardFailingIsTheToolFailing(t *testing.T) {
	answers := gpuFullAnswers(t)
	answers[gpuDashboardPath] = gpuFake{status: 500, body: `{"detail":"boom"}`}
	fakeGPUService(t, answers)
	if _, err := handleGPU(ctxFor("c1"), args{}, bearer()); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v", err)
	}
	answers[gpuDashboardPath] = gpuFake{status: 429, body: `{"detail":"too many"}`}
	fakeGPUService(t, answers)
	out, err := handleGPU(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "rate_limited" || m["feature"] != "gpu" {
		t.Fatalf("answer: %v", m)
	}
}

func TestGPU_RowsAreCutWithTheirTotalsAndTheCountsSeeThemAll(t *testing.T) {
	d := gpuDashboardFixture()
	var pods []jsonMap
	for i := 0; i < 250; i++ {
		pods = append(pods, gpuPodRow("bulk", fmt.Sprintf("p-%03d", i), 1, "Running", "Running", "n-big", vendorAsk("NVIDIA", 1)))
	}
	pods = append(pods, gpuPodRow("bulk", "biggest", 9, "Running", "Running", "n-big", vendorAsk("NVIDIA", 9)))
	d["gpu_pods"] = pods
	answers := gpuFullAnswers(t)
	answers[gpuDashboardPath] = gpuFake{body: gpuJSON(t, d)}
	fakeGPUService(t, answers)
	out, err := handleGPU(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	rows := subList(t, m, "gpu_pods")
	if len(rows) != rowsCap || m["gpu_pods_total"] != 251.0 || m["truncated"] != true {
		t.Fatalf("rows %d, total %v, truncated %v", len(rows), m["gpu_pods_total"], m["truncated"])
	}
	if rows[0].(jsonMap)["name"] != "biggest" {
		t.Errorf("first pod = %v, want the pod asking for the most", rows[0])
	}
	if got := subMap(t, m, "pod_counts"); got["total"] != 251.0 || got["requested"] != 259.0 {
		t.Errorf("pod_counts = %v", got)
	}
	at := func(key string) int { return strings.Index(out, `"`+key+`":`) }
	for _, pair := range [][2]string{{"total_gpu_capacity", "vendors"}, {"vendors", "utilization"}, {"utilization", "device_classes"}, {"device_classes", "gpu_nodes"}, {"gpu_nodes", "gpu_pods"}, {"gpu_pods", "gpus"}} {
		if at(pair[0]) >= at(pair[1]) || at(pair[0]) < 0 {
			t.Errorf("%s must come before %s: a model's cut keeps the numbers", pair[0], pair[1])
		}
	}
}

func TestGPU_NoGPUsAreCountedNoneAndSaidSo(t *testing.T) {
	answers := gpuFullAnswers(t)
	answers[gpuDashboardPath] = gpuFake{body: `{"total_gpu_capacity":0,"total_gpu_allocatable":0,"total_gpu_used":0,"total_gpu_waiting":0,"vendors":[],"gpu_nodes":[],"gpu_pods":[],"device_plugins":[],"mig_enabled":false,"time_slicing_enabled":false,"time_slicing_config":null,"dra_pods":[]}`}
	fakeGPUService(t, answers)
	m := askGPU(t, "c1")
	for _, key := range []string{"total_gpu_capacity", "total_gpu_used", "total_gpu_free", "allocation_rate"} {
		if m[key] != 0.0 {
			t.Errorf("%s = %#v, want 0", key, m[key])
		}
	}
	if hint, _ := m["hint"].(string); !strings.Contains(hint, "No GPU") {
		t.Errorf("hint = %q", hint)
	}
}
