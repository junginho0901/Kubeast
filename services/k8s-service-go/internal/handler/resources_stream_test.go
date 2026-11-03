package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Advanced Search's list goes out as it comes, Secret values masked, ending with whether it was cut.
func TestWriteRawListStreamsMasksAndEnds(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRawList(rec, 25, func(head func(string, string) error, item func(map[string]interface{}, *string) error) (bool, int64, error) {
		if err := head("SecretList", "v1"); err != nil {
			return false, 0, err
		}
		for _, o := range []map[string]interface{}{secretObj("a"), {"kind": "Secret", "metadata": map[string]interface{}{"name": "b"}}} {
			if err := item(o, nil); err != nil {
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
		PrinterStatus    []*string `json:"printer_status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, rec.Body.String())
	}
	if rec.Code != 200 || got.Kind != "SecretList" || got.APIVersion != "v1" || len(got.Items) != 2 || !got.Truncated || got.Limit != 25 || got.Remaining != 7 || got.PrinterStatus != nil {
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
	writeRawList(rec, 25, func(func(string, string) error, func(map[string]interface{}, *string) error) (bool, int64, error) {
		return false, 0, errors.New("forbidden")
	}, func(w http.ResponseWriter, err error) { failed = true; w.WriteHeader(http.StatusForbidden) })
	if !failed || rec.Code != http.StatusForbidden {
		t.Fatalf("failed %v, code %d", failed, rec.Code)
	}
	// on a later page: the list so far, marked cut, with the error
	rec = httptest.NewRecorder()
	writeRawList(rec, 25, func(head func(string, string) error, item func(map[string]interface{}, *string) error) (bool, int64, error) {
		_ = head("PodList", "v1")
		_ = item(map[string]interface{}{"kind": "Pod"}, nil)
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

// Each item's kubectl STATUS goes in printer_status, in the items' order, null where an item has none; a stream that
// never had a page (a scoped caller none of whose namespaces is there) is an empty kubectl List.
func TestWriteRawListPrinterStatus(t *testing.T) {
	rec := httptest.NewRecorder()
	crash, empty := "CrashLoopBackOff", ""
	writeRawList(rec, 25, func(head func(string, string) error, item func(map[string]interface{}, *string) error) (bool, int64, error) {
		_ = head("PodList", "v1")
		for i, st := range []*string{&crash, nil, &empty} {
			if err := item(map[string]interface{}{"kind": "Pod", "metadata": map[string]interface{}{"name": fmt.Sprint(i)}}, st); err != nil {
				return false, 0, err
			}
		}
		return false, 0, nil
	}, func(http.ResponseWriter, error) { t.Fatal("no failure expected") })
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, rec.Body.String())
	}
	if fmt.Sprint(got["printer_status"]) != "[CrashLoopBackOff <nil> ]" || len(got["items"].([]interface{})) != 3 {
		t.Fatalf("answer %v", got)
	}
	rec = httptest.NewRecorder()
	writeRawList(rec, 25, func(func(string, string) error, func(map[string]interface{}, *string) error) (bool, int64, error) {
		return false, 0, nil
	}, func(http.ResponseWriter, error) { t.Fatal("no failure expected") })
	got = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, rec.Body.String())
	}
	if got["kind"] != "List" || got["apiVersion"] != "v1" || len(got["items"].([]interface{})) != 0 || got["truncated"] != false {
		t.Fatalf("answer %v", got)
	}
}
