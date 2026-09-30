// HTTP layer. main.go 에서 추출 (Phase 3.6.e).
//
// 3개 endpoint 의 handler — health (liveness), tools/list (registry 의 name +
// description 만 노출), tools/call (registry 에서 lookup → handler 실행 →
// errBadRequest 분기). registry 는 main 이 만들어 closure 로 주입.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/redact"
)

type ToolCallRequest struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments"`
}

type ToolCallResponse struct {
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
	// Redacted says what was masked in Content before it leaves for the model
	// (services/pkg/redact); ai-service copies it into the audit row.
	Redacted *redact.Stats `json:"redacted,omitempty"`
}

// redactOpts is read once from the environment (REDACTION_ENABLED, REDACTION_PII,
// REDACTION_DISABLE). Secret objects are stripped regardless of these.
var redactOpts = redact.FromEnv()

type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type ToolListResponse struct {
	Tools []ToolInfo `json:"tools"`
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func handleList(w http.ResponseWriter, r *http.Request, tools map[string]ToolDefinition) {
	list := make([]ToolInfo, 0, len(tools))
	for _, tool := range tools {
		list = append(list, ToolInfo{Name: tool.Name, Description: tool.Description})
	}
	respondJSON(w, http.StatusOK, ToolListResponse{Tools: list})
}

func handleCall(w http.ResponseWriter, r *http.Request, tools map[string]ToolDefinition) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()

	var req ToolCallRequest
	if err := decoder.Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, ToolCallResponse{Error: "invalid json"})
		return
	}
	if req.Name == "" {
		respondJSON(w, http.StatusBadRequest, ToolCallResponse{Error: "name is required"})
		return
	}

	tool, ok := tools[req.Name]
	if !ok {
		respondJSON(w, http.StatusNotFound, ToolCallResponse{Error: "unknown tool"})
		return
	}
	log.Printf("tool call: %s", req.Name)

	ctx, cancel := context.WithTimeout(r.Context(), defaultTimeout)
	defer cancel()

	// step 14: route this call to the selected cluster — resolve its kubeconfig
	// and stash it in ctx for runKubectl. "cluster" is routing metadata, not a
	// tool parameter, so drop it from the args passed to the handler.
	clusterID, _ := req.Arguments["cluster"].(string)
	delete(req.Arguments, "cluster")

	// The arguments are the model's: refuse anything that kubectl would read
	// as a flag instead of a name (argcheck.go) before touching the cluster.
	if err := validateToolArgs(req.Arguments); err != nil {
		respondJSON(w, http.StatusBadRequest, ToolCallResponse{Error: err.Error()})
		return
	}

	// The caller must hold ai.tool.<name> in the routed cluster; ai-service's
	// tool filtering is not trusted on its own.
	payload, status, err := authorizeToolCall(toolAuth, r.Header, req.Name, clusterID)
	if err != nil {
		respondJSON(w, status, ToolCallResponse{Error: err.Error()})
		return
	}
	if status, err := approvalGate(r.Header, req.Name, clusterID, payload, req.Arguments); err != nil {
		respondJSON(w, status, ToolCallResponse{Error: err.Error()})
		return
	}

	kcPath, err := resolveClusterKubeconfig(ctx, clusterID, r.Header)
	if err != nil {
		respondJSON(w, http.StatusBadGateway, ToolCallResponse{Error: "cluster kubeconfig: " + err.Error()})
		return
	}
	// kubectl runs as the validated user in the routed cluster.
	ctx = withKubeconfigPath(ctx, kcPath)
	ctx = withClusterID(ctx, clusterID)
	ctx = auth.WithPayload(ctx, payload)

	output, err := tool.Handler(ctx, req.Arguments, r.Header)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errBadRequest) {
			status = http.StatusBadRequest
		}
		respondJSON(w, status, ToolCallResponse{Error: err.Error()})
		return
	}

	// Everything a tool returns is bound for the model: mask credentials
	// (and Secret data) here, once, for every tool.
	content, stats := redactToolOutput(output)
	respondJSON(w, http.StatusOK, ToolCallResponse{Content: content, Redacted: stats})
}

func redactToolOutput(output string) (string, *redact.Stats) {
	content, stats := redact.Text(output, redactOpts)
	if stats.Count == 0 {
		return content, nil
	}
	return content, &stats
}
