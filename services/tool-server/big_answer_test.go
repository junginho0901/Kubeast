package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// kubectlListJSON is a kubectl get -o json list of ConfigMaps of about size bytes, indented as kubectl prints it.
func kubectlListJSON(size int) string {
	var b strings.Builder
	b.WriteString("{\n    \"apiVersion\": \"v1\",\n    \"items\": [\n")
	for i := 0; b.Len() < size; i++ {
		if i > 0 {
			b.WriteString(",\n")
		}
		fmt.Fprintf(&b, `        {
            "apiVersion": "v1",
            "data": {
                "app.properties": "server.port=8080\nlog.level=info\nfeature.flags=a,b,c\n",
                "endpoint": "https://api-%04d.example.com/v1"
            },
            "kind": "ConfigMap",
            "metadata": {
                "creationTimestamp": "2026-11-01T02:03:04Z",
                "labels": {
                    "app": "bulk-%03d"
                },
                "name": "bulk-config-%05d",
                "namespace": "bulk",
                "resourceVersion": "%d",
                "uid": "3f0c8a3e-6a55-4d0e-9a4b-1f2d3c4b5a69"
            }
        }`, i%10000, i%100, i, 100000+i)
	}
	b.WriteString("\n    ],\n    \"kind\": \"List\",\n    \"metadata\": {\n        \"resourceVersion\": \"\"\n    }\n}\n")
	return b.String()
}

// podLogText is a container log of about size bytes.
func podLogText(size int) string {
	var b strings.Builder
	for i := 0; b.Len() < size; i++ {
		fmt.Fprintf(&b, "2026-11-08T03:%02d:%02d.%03dZ INFO request id=%06d path=/api/v1/items/%d status=200 took=%dms user=user-%03d\n", i/60%60, i%60, i%1000, i, i%5000, i%300, i%500)
	}
	return b.String()
}

// heldResponse is a reader that takes nothing until release closes: an answer stays at its write.
type heldResponse struct {
	header  http.Header
	inWrite chan<- struct{}
	release <-chan struct{}
	mu      sync.Mutex
	body    bytes.Buffer
	once    sync.Once
}

func (h *heldResponse) Header() http.Header { return h.header }
func (h *heldResponse) WriteHeader(int)     {}
func (h *heldResponse) Write(p []byte) (int, error) {
	h.once.Do(func() { h.inWrite <- struct{}{} })
	<-h.release
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.body.Write(p)
}

func (h *heldResponse) bytes() []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.body.Bytes()
}

// answerCalls calls a reader's tool whose answer is big, or small when resource_name is "small".
func answerCalls(t *testing.T, big string) func(ctx context.Context, w http.ResponseWriter, name string) {
	t.Helper()
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	t.Cleanup(restore)
	prev := toolAuth
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Email: "reader@example.com",
		Perms: auth.PermissionMatrix{"prod": {"ai.tool.*", "resource.objects.read"}}, Roles: map[string]string{"prod": "Read"}}}
	t.Cleanup(func() { toolAuth = prev })
	tools := map[string]ToolDefinition{"k8s_get_resources": {
		Name: "k8s_get_resources",
		Handler: func(_ context.Context, args map[string]interface{}, _ http.Header) (string, error) {
			if args["resource_name"] == "small" {
				return `{"kind":"ConfigMap","metadata":{"name":"small"}}`, nil
			}
			return big, nil
		},
	}}
	return func(ctx context.Context, w http.ResponseWriter, name string) {
		body := fmt.Sprintf(`{"name":"k8s_get_resources","arguments":{"cluster":"prod","resource_type":"configmaps","namespace":"shop","resource_name":%q}}`, name)
		req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Authorization", "Bearer t")
		handleCall(w, req, tools)
	}
}

// aloneAnswer is the answer one call gets with nothing else under way.
func aloneAnswer(t *testing.T, call func(context.Context, http.ResponseWriter, string), name string) []byte {
	t.Helper()
	rec := httptest.NewRecorder()
	call(context.Background(), rec, name)
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("a call alone: status %d, %d bytes", rec.Code, rec.Body.Len())
	}
	return rec.Body.Bytes()
}

// holdBigAnswers starts n big calls whose readers take nothing and returns how many reached their write once no more do.
func holdBigAnswers(t *testing.T, call func(context.Context, http.ResponseWriter, string), n int, release <-chan struct{}, wg *sync.WaitGroup) ([]*heldResponse, int) {
	t.Helper()
	inWrite := make(chan struct{}, n)
	held := make([]*heldResponse, n)
	for i := range held {
		held[i] = &heldResponse{header: http.Header{}, inWrite: inWrite, release: release}
		wg.Add(1)
		go func() {
			defer wg.Done()
			call(context.Background(), held[i], "big")
		}()
	}
	writing := 0
	for {
		select {
		case <-inWrite:
			writing++
		case <-time.After(500 * time.Millisecond):
			return held, writing
		}
	}
}

// Twenty people's AI tools answering at the output cap at once are masked and written three at a time, and each gets the
// answer it gets alone.
func TestBigAnswersAreMaskedAndWrittenAFewAtATime(t *testing.T) {
	call := answerCalls(t, kubectlListJSON(1<<20))
	want := aloneAnswer(t, call, "big")
	release := make(chan struct{})
	var wg sync.WaitGroup
	held, writing := holdBigAnswers(t, call, 20, release, &wg)
	close(release)
	wg.Wait()
	t.Logf("20 answers of %d bytes: %d masked and written at once", len(want), writing)
	if writing > 3 {
		t.Errorf("%d big answers masked and written at once, want at most 3", writing)
	}
	for i, h := range held {
		if !bytes.Equal(h.bytes(), want) {
			t.Errorf("answer %d: %d bytes differ from the %d of a call alone", i, len(h.bytes()), len(want))
		}
	}
}

// A small answer is not kept behind big ones being written.
func TestASmallAnswerWaitsForNoBigOne(t *testing.T) {
	call := answerCalls(t, kubectlListJSON(1<<20))
	want := aloneAnswer(t, call, "small")
	release := make(chan struct{})
	var wg sync.WaitGroup
	_, writing := holdBigAnswers(t, call, 6, release, &wg)
	defer func() { close(release); wg.Wait() }()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	rec := httptest.NewRecorder()
	start := time.Now()
	call(ctx, rec, "small")
	if took := time.Since(start); took > time.Second || !bytes.Equal(rec.Body.Bytes(), want) {
		t.Errorf("with %d big answers being written: the small one took %v, %d bytes (alone %d)", writing, took, rec.Body.Len(), len(want))
	}
}

// A big answer whose call has no time left to wait goes out as it would alone.
func TestABigAnswerWithNoTimeLeftStillGoesOutUnchanged(t *testing.T) {
	call := answerCalls(t, kubectlListJSON(1<<20))
	want := aloneAnswer(t, call, "big")
	release := make(chan struct{})
	var wg sync.WaitGroup
	_, writing := holdBigAnswers(t, call, 6, release, &wg)
	defer func() { close(release); wg.Wait() }()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	rec := httptest.NewRecorder()
	start := time.Now()
	call(ctx, rec, "big")
	if took := time.Since(start); took > 2*time.Second || rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), want) {
		t.Errorf("with %d big answers being written: took %v, status %d, %d bytes (alone %d)", writing, took, rec.Code, rec.Body.Len(), len(want))
	}
}

type discardResponse struct{ header http.Header }

func (d *discardResponse) Header() http.Header         { return d.header }
func (d *discardResponse) WriteHeader(int)             {}
func (d *discardResponse) Write(p []byte) (int, error) { return io.Discard.Write(p) }

// What masking and writing one answer of the output cap allocates with no buffer to reuse, as in a crowd: the bound on
// what it holds at its peak.
func BenchmarkMaskingAndWritingABigAnswer(b *testing.B) {
	for _, c := range []struct {
		name, output string
	}{
		{"kubectl json", kubectlListJSON(1 << 20)},
		{"log text", podLogText(1 << 20)},
	} {
		b.Run(c.name, func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(c.output)))
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				runtime.GC() // two collections empty the encoders' pool
				runtime.GC()
				b.StartTimer()
				content, stats := redactToolOutput(c.output)
				respondJSON(&discardResponse{header: http.Header{}}, http.StatusOK, ToolCallResponse{Content: content, Redacted: stats})
			}
		})
	}
}
