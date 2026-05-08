// kubectl 출력 파서 모음. main.go 에서 추출 (Phase 3.6.a).
//
// 모두 string output 을 받아 가공해 돌려주는 순수 함수. kubectl shell 호출은
// kubectl.go, HTTP/arg 가공은 별도 파일이 담당. 같은 패키지(main) 내 파일
// 분할이라 import path 변경 없음.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type listItems struct {
	Items []json.RawMessage `json:"items"`
}

type podList struct {
	Items []struct {
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
	} `json:"items"`
}

type versionInfo struct {
	ServerVersion struct {
		GitVersion string `json:"gitVersion"`
	} `json:"serverVersion"`
}

type serviceInfo struct {
	Type string `json:"type"`
}

type servicePort struct {
	Name     string `json:"name,omitempty"`
	Port     int    `json:"port,omitempty"`
	Protocol string `json:"protocol,omitempty"`
}

type serviceMeta struct {
	Name      string `json:"name,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

type serviceResource struct {
	Metadata serviceMeta `json:"metadata"`
	Spec     struct {
		Type  string        `json:"type"`
		Ports []servicePort `json:"ports"`
	} `json:"spec"`
}

type endpointResource struct {
	Subsets []struct {
		Addresses         []map[string]interface{} `json:"addresses"`
		NotReadyAddresses []map[string]interface{} `json:"notReadyAddresses"`
	} `json:"subsets"`
}

type eventList struct {
	Items []eventItem `json:"items"`
}

type eventItem struct {
	Type           string `json:"type"`
	Reason         string `json:"reason"`
	Message        string `json:"message"`
	FirstTimestamp string `json:"firstTimestamp"`
	LastTimestamp  string `json:"lastTimestamp"`
	EventTime      string `json:"eventTime"`
	Count          int    `json:"count"`
	Series         *struct {
		Count            int    `json:"count"`
		LastObservedTime string `json:"lastObservedTime"`
	} `json:"series"`
	Metadata struct {
		Namespace string `json:"namespace"`
	} `json:"metadata"`
	InvolvedObject struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	} `json:"involvedObject"`
}

func countKubectlItems(ctx context.Context, headers http.Header, args ...string) (int, error) {
	output, err := runKubectl(ctx, headers, args...)
	if err != nil {
		return 0, err
	}
	var list listItems
	if err := json.Unmarshal([]byte(output), &list); err != nil {
		return 0, err
	}
	return len(list.Items), nil
}

func summarizePodStatus(output string) (map[string]int, int) {
	counts := make(map[string]int)
	var list podList
	if err := json.Unmarshal([]byte(output), &list); err != nil {
		return counts, 0
	}
	total := 0
	for _, item := range list.Items {
		phase := strings.TrimSpace(item.Status.Phase)
		if phase == "" {
			phase = "Unknown"
		}
		counts[phase]++
		total++
	}
	return counts, total
}

func parseClusterVersion(output string) string {
	var info versionInfo
	if err := json.Unmarshal([]byte(output), &info); err != nil {
		return ""
	}
	return info.ServerVersion.GitVersion
}

func parseServiceInfo(output string) (serviceInfo, []map[string]interface{}) {
	var svc serviceResource
	if err := json.Unmarshal([]byte(output), &svc); err != nil {
		return serviceInfo{}, nil
	}
	info := serviceInfo{Type: svc.Spec.Type}
	ports := make([]map[string]interface{}, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		ports = append(ports, map[string]interface{}{
			"name":     p.Name,
			"port":     p.Port,
			"protocol": p.Protocol,
		})
	}
	return info, ports
}

func parseEndpoints(output string) (int, int) {
	var eps endpointResource
	if err := json.Unmarshal([]byte(output), &eps); err != nil {
		return 0, 0
	}
	ready := 0
	notReady := 0
	for _, subset := range eps.Subsets {
		ready += len(subset.Addresses)
		notReady += len(subset.NotReadyAddresses)
	}
	return ready, notReady
}

func findMatchingPort(ports []map[string]interface{}, requested string) map[string]interface{} {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return nil
	}
	for _, p := range ports {
		name, _ := p["name"].(string)
		portVal := fmt.Sprint(p["port"])
		if requested == name || requested == portVal {
			return p
		}
	}
	return nil
}

func parseTopNodes(output string) []map[string]interface{} {
	lines := strings.Split(output, "\n")
	results := make([]map[string]interface{}, 0)
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		name := fields[0]
		cpu := fields[1]
		rest := fields[2:]
		metric := map[string]interface{}{
			"name": name,
			"cpu":  cpu,
		}
		applyUsageFields(metric, rest)
		results = append(results, metric)
	}
	return results
}

func parseTopPods(output string, allNamespaces bool) []map[string]interface{} {
	lines := strings.Split(output, "\n")
	results := make([]map[string]interface{}, 0)
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		idx := 0
		metric := map[string]interface{}{}
		if allNamespaces {
			if len(fields) < 4 {
				continue
			}
			metric["namespace"] = fields[0]
			idx++
		}
		metric["name"] = fields[idx]
		idx++
		metric["cpu"] = fields[idx]
		idx++
		rest := fields[idx:]
		applyUsageFields(metric, rest)
		results = append(results, metric)
	}
	return results
}

func applyUsageFields(metric map[string]interface{}, fields []string) {
	if len(fields) == 0 {
		return
	}
	if len(fields) == 1 {
		metric["memory"] = fields[0]
		return
	}
	if len(fields) == 2 {
		if strings.HasSuffix(fields[0], "%") && !strings.HasSuffix(fields[1], "%") {
			metric["cpu_percent"] = fields[0]
			metric["memory"] = fields[1]
			return
		}
		if !strings.HasSuffix(fields[0], "%") && strings.HasSuffix(fields[1], "%") {
			metric["memory"] = fields[0]
			metric["memory_percent"] = fields[1]
			return
		}
		metric["memory"] = fields[1]
		return
	}
	metric["cpu_percent"] = fields[0]
	metric["memory"] = fields[1]
	metric["memory_percent"] = fields[2]
}

func parseEvents(output string) []map[string]interface{} {
	var list eventList
	if err := json.Unmarshal([]byte(output), &list); err != nil {
		return nil
	}
	results := make([]map[string]interface{}, 0, len(list.Items))
	for _, ev := range list.Items {
		first := ev.FirstTimestamp
		last := ev.LastTimestamp
		if last == "" {
			if ev.EventTime != "" {
				last = ev.EventTime
			} else if ev.Series != nil && ev.Series.LastObservedTime != "" {
				last = ev.Series.LastObservedTime
			}
		}
		if first == "" {
			if ev.EventTime != "" {
				first = ev.EventTime
			} else if ev.Series != nil && ev.Series.LastObservedTime != "" {
				first = ev.Series.LastObservedTime
			}
		}
		count := ev.Count
		if count == 0 && ev.Series != nil {
			count = ev.Series.Count
		}
		results = append(results, map[string]interface{}{
			"type":            ev.Type,
			"reason":          ev.Reason,
			"message":         ev.Message,
			"namespace":       ev.Metadata.Namespace,
			"object":          map[string]interface{}{"kind": ev.InvolvedObject.Kind, "name": ev.InvolvedObject.Name},
			"first_timestamp": first,
			"last_timestamp":  last,
			"count":           count,
		})
	}
	return results
}

func parseAPIResources(output string) []map[string]interface{} {
	lines := strings.Split(output, "\n")
	results := make([]map[string]interface{}, 0)
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if i == 0 && strings.HasPrefix(strings.ToUpper(line), "NAME") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		name := fields[0]
		short := ""
		apiVersion := ""
		namespaced := ""
		kind := ""
		if len(fields) == 4 {
			apiVersion = fields[1]
			namespaced = fields[2]
			kind = fields[3]
		} else {
			short = fields[1]
			apiVersion = fields[2]
			namespaced = fields[3]
			kind = fields[4]
		}
		shortNames := []string{}
		if short != "" && short != "<none>" {
			shortNames = strings.Split(short, ",")
		}
		results = append(results, map[string]interface{}{
			"name":       name,
			"shortNames": shortNames,
			"apiVersion": apiVersion,
			"namespaced": strings.EqualFold(namespaced, "true"),
			"kind":       kind,
		})
	}
	return results
}
