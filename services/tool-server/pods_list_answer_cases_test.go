package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"testing"
)

// The AI chat draws its pod table from this answer (ai-service formatters.py), so the rows' format lives twice. Go writes
// the answers with the rows they carry; test_kubectl_table_cases.py draws them. UPDATE_POD_ANSWER_CASES=1 writes the
// file; otherwise this test fails when the file is not what the code answers now.
const podAnswerCasesFile = "../ai-service/tests/fixtures/pods_list_answers.json"

type podAnswerCase struct {
	Name   string                 `json:"name"`
	Args   map[string]interface{} `json:"args"`
	Answer string                 `json:"answer"`
	Rows   []map[string]string    `json:"rows"`
}

const podAnswerCounts = `"top_reasons":[{"reason":"Running","count":290},{"reason":"CrashLoopBackOff","count":7}],"health":{"ok":292,"warn":13,"error":7}},
 "by_namespace":[{"name":"shop","count":40},{"name":"(other)","count":272}],
 "by_node":[{"name":"n1","count":50},{"name":"(other)","count":262}],
 "by_phase":[{"name":"Running","count":300},{"name":"Pending","count":12}]`

func podAnswerCaseSet(t *testing.T) []podAnswerCase {
	t.Helper()
	cases := []struct {
		name string
		args map[string]interface{}
		page string
	}{
		{"the first page of every namespace", map[string]interface{}{"resource_type": "pods", "all_namespaces": true, "output": "wide"},
			`{"items":[
			 {"name":"web-1","namespace":"shop","status":"CrashLoopBackOff","ready":"0/1","restart_count":12,"node_name":"n1"},
			 {"name":"job-1","namespace":"ops","status":"Pending","ready":"0/1","restart_count":0,"node_name":""},
			 {"name":"init-1","namespace":"ops","status":"Init:0/2","ready":"0/1","restart_count":3,"node_name":"n2"},
			 {"name":"odd-1","namespace":"ops","status":"A Reason With Spaces","ready":"1/2","restart_count":0,"node_name":"n2"}],
			 "total":312,"stats":{"total":312,` + podAnswerCounts + `}`},
		{"the last page of one namespace", map[string]interface{}{"resource_type": "po", "namespace": "shop", "offset": 25},
			`{"items":[
			 {"name":"web-26","namespace":"shop","status":"Running","ready":"1/1","restart_count":0,"node_name":"n1"},
			 {"name":"web-27","namespace":"shop","status":"Running","ready":"1/1","restart_count":1,"node_name":"n1"}],
			 "total":27,"stats":{"total":27,` + podAnswerCounts + `}`},
		{"an offset past the end", map[string]interface{}{"resource_type": "pods", "all_namespaces": true, "offset": 400},
			`{"items":[],"total":312,"stats":{"total":312,` + podAnswerCounts + `}`},
	}
	out := make([]podAnswerCase, 0, len(cases))
	for _, c := range cases {
		page := c.page
		fakeK8sService(t, func(*http.Request) (int, string) { return 200, page })
		answer, err := handleGetResources(ctxFor("c1"), c.args, bearer())
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		var reply podPageReply
		if err := json.Unmarshal([]byte(page), &reply); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		rows := make([]map[string]string, 0, len(reply.Items))
		for _, it := range reply.Items {
			node := it.NodeName
			if node == "" {
				node = "<none>"
			}
			rows = append(rows, map[string]string{"NAMESPACE": it.Namespace, "NAME": it.Name, "READY": it.Ready, "STATUS": it.Status, "RESTARTS": strconv.Itoa(it.RestartCount), "NODE": node})
		}
		out = append(out, podAnswerCase{Name: c.name, Args: c.args, Answer: answer, Rows: rows})
	}
	return out
}

func TestPodsListAnswerCases(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	if err := enc.Encode(podAnswerCaseSet(t)); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_POD_ANSWER_CASES") == "1" {
		if err := os.WriteFile(podAnswerCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(podAnswerCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_POD_ANSWER_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("pods_list_answers.json is not what the tool answers now: rerun with UPDATE_POD_ANSWER_CASES=1 and run the ai-service test")
	}
}
