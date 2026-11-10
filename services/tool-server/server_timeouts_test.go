package main

import (
	"net/http"
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// A tool's answer reaches ai-service: a read of k8s-service ends inside the call's time, the call's time, a big answer's
// wait for its place past it and its write inside the server's write limit, and that inside the time ai-service waits
// (tool_server_client.py).
func TestAToolsAnswerIsWrittenBeforeItsCallerStopsWaiting(t *testing.T) {
	src, err := os.ReadFile("../ai-service/app/services/tool_server_client.py")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`ScopedClient\(resolved, timeout=([0-9.]+)`).FindSubmatch(src)
	if m == nil {
		t.Fatal("ai-service's tool-server timeout is not where this test reads it")
	}
	seconds, err := strconv.ParseFloat(string(m[1]), 64)
	if err != nil {
		t.Fatal(err)
	}
	caller := time.Duration(seconds * float64(time.Second))
	write := newHTTPServer("0", http.NotFoundHandler()).WriteTimeout
	placeBy := write - answerWriteMargin
	if !(featureHTTP.Timeout < defaultTimeout && defaultTimeout < placeBy && placeBy < write && write < caller) {
		t.Errorf("k8s-service read %v, call %v, big answer's place by %v, write limit %v, ai-service waits %v: want each inside the next", featureHTTP.Timeout, defaultTimeout, placeBy, write, caller)
	}
}
