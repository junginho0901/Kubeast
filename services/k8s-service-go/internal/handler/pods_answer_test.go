package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/flight"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// A pods/page or pods/nodes answer goes out as response.JSON wrote the same value: status, Content-Type and the other
// headers, length or chunking, and the body, for a small page and one past the big write size; a build that panicked
// is a 500 with the generic words, not the panic's.
func TestAPodAnswerGoesOutAsResponseJSONWritesIt(t *testing.T) {
	small := &k8s.PodPage{Items: []k8s.PodListItem{{Name: "web-1", Namespace: "shop", Status: "Running"}}, Total: 1, Revision: "e-1.all", Source: "index"}
	big := &k8s.PodPage{Revision: "e-1.all", Source: "index"}
	for i := 0; i < 3000; i++ {
		big.Items = append(big.Items, k8s.PodListItem{Name: fmt.Sprintf("bulk-%05d-6d8f9c7b5d-x7k2p", i), Namespace: "bulk", Status: "Running", Ready: "1/1", NodeName: "node-001", PodIP: "10.0.1.2", CreatedAt: "2026-11-01T02:03:04Z"})
	}
	get := func(h http.HandlerFunc) (*http.Response, []byte) {
		t.Helper()
		srv := httptest.NewServer(h)
		defer srv.Close()
		resp, err := http.Get(srv.URL + "/api/v1/pods/page")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp, body
	}
	for name, page := range map[string]*k8s.PodPage{"small": small, "big": big} {
		raw, err := json.Marshal(page)
		if err != nil {
			t.Fatal(err)
		}
		raw = append(raw, '\n')
		if name == "big" && len(raw) <= bigSharedBody {
			t.Fatalf("the big page is %d bytes, not past %d", len(raw), bigSharedBody)
		}
		one, oneBody := get(func(w http.ResponseWriter, _ *http.Request) { response.JSON(w, http.StatusOK, page) })
		shared, sharedBody := get(func(w http.ResponseWriter, r *http.Request) { (&Handler{}).writePodAnswer(w, r, raw, nil) })
		if !bytes.Equal(sharedBody, oneBody) {
			t.Errorf("%s: a body of %d bytes, response.JSON's of %d", name, len(sharedBody), len(oneBody))
		}
		if shared.StatusCode != one.StatusCode || shared.ContentLength != one.ContentLength || !slices.Equal(shared.TransferEncoding, one.TransferEncoding) {
			t.Errorf("%s: %d, length %d, %v; response.JSON: %d, length %d, %v", name, shared.StatusCode, shared.ContentLength, shared.TransferEncoding,
				one.StatusCode, one.ContentLength, one.TransferEncoding)
		}
		one.Header.Del("Date")
		shared.Header.Del("Date")
		if !reflect.DeepEqual(shared.Header, one.Header) {
			t.Errorf("%s: headers %v, response.JSON's %v", name, shared.Header, one.Header)
		}
	}
	rec := httptest.NewRecorder()
	(&Handler{}).writePodAnswer(rec, httptest.NewRequest(http.MethodGet, "/api/v1/pods/page", nil), nil, fmt.Errorf("%w: pods not found", flight.ErrPanicked))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "internal server error") || strings.Contains(rec.Body.String(), "not found") {
		t.Errorf("a panicked build: %d %s", rec.Code, rec.Body.String())
	}
}
