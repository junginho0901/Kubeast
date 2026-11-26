package auditsink

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// lockedBucket is an S3-compatible bucket that refuses to replace an object,
// as a GCS bucket with a retention policy (403) or an R2 bucket lock (409) does.
type lockedBucket struct {
	mu         sync.Mutex
	refuse     int    // status for a write of a key that exists
	refuseCode string // its error code
	putStatus  int    // when set, every write answers this
	getStatus  int    // when set, every read answers this
	objects    map[string][]byte
	methods    []string
}

func (b *lockedBucket) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.methods = append(b.methods, r.Method)
	fail := func(status int, code string) {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(status)
		fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>refused</Message></Error>`, code)
	}
	switch r.Method {
	case http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		if b.putStatus != 0 {
			fail(b.putStatus, "InvalidArgument")
			return
		}
		if _, ok := b.objects[r.URL.Path]; ok {
			fail(b.refuse, b.refuseCode)
			return
		}
		b.objects[r.URL.Path] = body
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		if b.getStatus != 0 {
			fail(b.getStatus, "AccessDenied")
			return
		}
		body, ok := b.objects[r.URL.Path]
		if !ok {
			fail(http.StatusNotFound, "NoSuchKey")
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	default:
		fail(http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

func (b *lockedBucket) count(method string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, m := range b.methods {
		if m == method {
			n++
		}
	}
	return n
}

func lockedBucketSink(t *testing.T, b *lockedBucket) (*sinkRun, *memStore, *Dispatcher) {
	t.Helper()
	isolateAWSConfig(t)
	srv := httptest.NewServer(b)
	t.Cleanup(srv.Close)
	sc := SinkConfig{Name: "archive", Type: "s3", S3: S3Config{Bucket: "audit", Prefix: "kubeast", Endpoint: srv.URL, ForcePathStyle: true},
		secrets: map[string]string{"accessKeyId": "AK", "secretAccessKey": "SK"}}
	sink, err := sc.build()
	if err != nil {
		t.Fatal(err)
	}
	store := newMemStore(5)
	return run(sc, sink), store, &Dispatcher{store: store}
}

// The cursor did not move after a write that went through, so the batch goes
// out again; the bucket refuses to replace the object it already holds, and
// the sink counts the batch as sent instead of stopping on it.
func TestS3SinkResentBatchALockedBucketAlreadyHolds(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		code   string
	}{
		{"gcs retention policy", http.StatusForbidden, "retentionPolicyNotMet"},
		{"r2 bucket lock", http.StatusConflict, "ObjectLocked"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &lockedBucket{refuse: tc.status, refuseCode: tc.code, objects: map[string][]byte{}}
			s, store, d := lockedBucketSink(t, b)
			if next, _, err := d.step(context.Background(), s, 0); err != nil || next != 5 {
				t.Fatalf("first send: next %d err %v", next, err)
			}
			store.cursors["archive"] = 0 // the move after the write was lost
			next, _, err := d.step(context.Background(), s, 0)
			if err != nil || next != 5 || store.cursors["archive"] != 5 {
				t.Fatalf("resend: next %d cursor %d err %v", next, store.cursors["archive"], err)
			}
			if s.sent.Load() != 10 || s.failures.Load() != 0 || store.fails["archive"] != 0 {
				t.Fatalf("sent %d failures %d stored fails %d", s.sent.Load(), s.failures.Load(), store.fails["archive"])
			}
			b.mu.Lock()
			objects, methods := len(b.objects), strings.Join(b.methods, " ")
			b.mu.Unlock()
			if objects != 1 || methods != "PUT PUT GET" {
				t.Fatalf("objects %d, requests %s", objects, methods)
			}
		})
	}
}

func TestS3SinkRefusedWriteStaysAFailureUnlessTheKeyHoldsTheBatch(t *testing.T) {
	t.Run("the object under the key differs", func(t *testing.T) {
		b := &lockedBucket{refuse: http.StatusForbidden, refuseCode: "retentionPolicyNotMet", objects: map[string][]byte{}}
		s, store, d := lockedBucketSink(t, b)
		if _, _, err := d.step(context.Background(), s, 0); err != nil {
			t.Fatal(err)
		}
		b.mu.Lock()
		for _, obj := range b.objects {
			obj[len(obj)-1] ^= 0xff // same length, other bytes
		}
		b.mu.Unlock()
		store.cursors["archive"] = 0
		next, _, err := d.step(context.Background(), s, 0)
		if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "differs") {
			t.Fatalf("want the refusal and that the object differs, got %v", err)
		}
		if next != 0 || s.failures.Load() != 1 || store.fails["archive"] != 1 {
			t.Fatalf("next %d failures %d stored fails %d", next, s.failures.Load(), store.fails["archive"])
		}
	})
	t.Run("the key cannot be read back", func(t *testing.T) {
		b := &lockedBucket{refuse: http.StatusConflict, refuseCode: "ObjectLocked", objects: map[string][]byte{}}
		s, store, d := lockedBucketSink(t, b)
		if _, _, err := d.step(context.Background(), s, 0); err != nil {
			t.Fatal(err)
		}
		b.mu.Lock()
		b.getStatus = http.StatusForbidden
		b.mu.Unlock()
		store.cursors["archive"] = 0
		_, _, err := d.step(context.Background(), s, 0)
		if err == nil || !strings.Contains(err.Error(), "409") || !strings.Contains(err.Error(), "reading the key back") || !strings.Contains(err.Error(), "AccessDenied") {
			t.Fatalf("want the refusal and the failed read, got %v", err)
		}
	})
	t.Run("another refusal is not read back", func(t *testing.T) {
		b := &lockedBucket{putStatus: http.StatusBadRequest, objects: map[string][]byte{}}
		s, _, d := lockedBucketSink(t, b)
		_, _, err := d.step(context.Background(), s, 0)
		if err == nil || !strings.Contains(err.Error(), "400") || strings.Contains(err.Error(), "reading the key back") {
			t.Fatalf("want the 400 as it was, got %v", err)
		}
		if b.count(http.MethodGet) != 0 {
			t.Fatalf("a 400 must not read the key: %v", b.methods)
		}
	})
}
