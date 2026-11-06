package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// A refused Table read keeps the cluster's sentence and stays a Forbidden, through a real client-go request.
func TestTableBody_KeepsTheClustersRefusal(t *testing.T) {
	const sentence = `widgets.example.com is forbidden: User "u" cannot list resource "widgets"`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","message":"` + strings.ReplaceAll(sentence, `"`, `\"`) + `","reason":"Forbidden","code":403}`))
	}))
	defer srv.Close()
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = tableBody(context.Background(), cs.RESTClient().Get().AbsPath("/apis/example.com/v1/widgets").SetHeader("Accept", tableAccept))
	if err == nil || err.Error() != sentence {
		t.Fatalf("err = %v, want the cluster's sentence", err)
	}
	if !apierrors.IsForbidden(err) {
		t.Fatalf("err = %#v, want a Forbidden", err)
	}
}
