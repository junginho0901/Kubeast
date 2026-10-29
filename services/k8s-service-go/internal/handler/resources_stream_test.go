package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Advanced Search's list goes out as it comes, Secret values masked, ending with whether it was cut.
func TestWriteRawListStreamsMasksAndEnds(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRawList(rec, 25, func(head func(string, string) error, item func(map[string]interface{}) error) (bool, int64, error) {
		if err := head("SecretList", "v1"); err != nil {
			return false, 0, err
		}
		for _, o := range []map[string]interface{}{secretObj("a"), {"kind": "Secret", "metadata": map[string]interface{}{"name": "b"}}} {
			if err := item(o); err != nil {
				return false, 0, err
			}
		}
		return true, 7, nil
	}, func(http.ResponseWriter, error) { t.Fatal("no failure expected") })
	var got struct {
		Kind, APIVersion string
		Items            []map[string]interface{}
		Truncated        bool
		Limit, Remaining int
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, rec.Body.String())
	}
	if rec.Code != 200 || got.Kind != "SecretList" || got.APIVersion != "v1" || len(got.Items) != 2 || !got.Truncated || got.Limit != 25 || got.Remaining != 7 {
		t.Fatalf("answer %+v", got)
	}
	if got.Items[0]["data"].(map[string]interface{})["password"] != secretMask {
		t.Fatalf("secret value sent: %v", got.Items[0])
	}
}

func TestWriteRawListErrors(t *testing.T) {
	// before the first page: the error's own status, no list
	rec := httptest.NewRecorder()
	failed := false
	writeRawList(rec, 25, func(func(string, string) error, func(map[string]interface{}) error) (bool, int64, error) {
		return false, 0, errors.New("forbidden")
	}, func(w http.ResponseWriter, err error) { failed = true; w.WriteHeader(http.StatusForbidden) })
	if !failed || rec.Code != http.StatusForbidden {
		t.Fatalf("failed %v, code %d", failed, rec.Code)
	}
	// on a later page: the list so far, marked cut, with the error
	rec = httptest.NewRecorder()
	writeRawList(rec, 25, func(head func(string, string) error, item func(map[string]interface{}) error) (bool, int64, error) {
		_ = head("PodList", "v1")
		_ = item(map[string]interface{}{"kind": "Pod"})
		return false, 0, errors.New("the continue token expired")
	}, func(http.ResponseWriter, error) { t.Fatal("headers were sent") })
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, rec.Body.String())
	}
	if got["truncated"] != true || got["error"] != "the continue token expired" || len(got["items"].([]interface{})) != 1 {
		t.Fatalf("answer %v", got)
	}
}
