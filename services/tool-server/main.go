package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

type ToolCallRequest struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments"`
}

type ToolCallResponse struct {
	Content string `json:"content"`
	Error   string `json:"error,omitempty"`
}

type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type ToolListResponse struct {
	Tools []ToolInfo `json:"tools"`
}

func main() {
	port := envOrDefault("PORT", "8086")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/tools/list", handleList)
	mux.HandleFunc("/tools/call", handleCall)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("tool-server listening on :%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func handleList(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, ToolListResponse{Tools: []ToolInfo{}})
}

func handleCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var req ToolCallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, ToolCallResponse{Error: "invalid json"})
		return
	}
	if req.Name == "" {
		respondJSON(w, http.StatusBadRequest, ToolCallResponse{Error: "name is required"})
		return
	}

	// TODO: Implement MCP-backed tool execution.
	respondJSON(w, http.StatusNotImplemented, ToolCallResponse{Error: "tool execution not implemented"})
}

func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
