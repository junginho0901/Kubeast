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
)

type ToolCallRequest struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments"`
}

type ToolCallResponse struct {
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

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

	output, err := tool.Handler(ctx, req.Arguments, r.Header)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errBadRequest) {
			status = http.StatusBadRequest
		}
		respondJSON(w, status, ToolCallResponse{Error: err.Error()})
		return
	}

	respondJSON(w, http.StatusOK, ToolCallResponse{Content: output})
}
