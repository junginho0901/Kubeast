package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// decodeArgs mirrors handleCall: json.Decoder with UseNumber.
func decodeArgs(t *testing.T, src string) map[string]interface{} {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(src))
	dec.UseNumber()
	var m map[string]interface{}
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("decode %s: %v", src, err)
	}
	return m
}

// The vectors are the output of ai-service's canonical_args (Python
// json.dumps with sort_keys, compact separators and ensure_ascii); the Go
// encoder must produce the same bytes or the hashes never match.
func TestCanonicalArgs_MatchesPython(t *testing.T) {
	cases := []struct{ in, want, sha string }{
		{`{"resource_type":"deployment","resource_name":"web","replicas":2}`,
			`{"replicas":2,"resource_name":"web","resource_type":"deployment"}`,
			"66f259749f66f4d457a0bb1b9a1e650ce524c6d875fd185484f4bd30e70bd666"},
		{`{"b":[1,2.5,true,null,"x"],"a":{"z":"한글 ✓","y":"tab\tnl\n\"q\" \\ / <&>","x":"\u007f\u0001"}}`,
			`{"a":{"x":"\u007f\u0001","y":"tab\tnl\n\"q\" \\ / <&>","z":"\ud55c\uae00 \u2713"},"b":[1,2.5,true,null,"x"]}`,
			"2651207b25ff51dd06da74e632752608090943669cc4e1da7940e7f667e1e692"},
		{`{"emoji":"😀","nested":{"k":[{"n":10000000000000000000},{"f":1000.0}]}}`,
			`{"emoji":"\ud83d\ude00","nested":{"k":[{"n":10000000000000000000},{"f":1000.0}]}}`,
			"300b1be164fd2c1c3adbc826a9342e8dbe209c617384f61c85bd921c29c6e95b"},
		{`{}`, `{}`, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"},
		{`{"cluster":"dropped-by-both-sides","name":"keep"}`, `{"name":"keep"}`,
			"5c4b303fb2e264840b3885c0b5ac6c6cbe97bcb910baa14e64513cef2ad7ecbb"},
	}
	for i, c := range cases {
		got := canonicalArgs(decodeArgs(t, c.in))
		if got != c.want {
			t.Errorf("case %d:\n got  %s\n want %s", i, got, c.want)
		}
		sum := sha256.Sum256([]byte(got))
		if hex.EncodeToString(sum[:]) != c.sha {
			t.Errorf("case %d: sha256 %x != %s", i, sum, c.sha)
		}
	}
}

// signApproval builds a token the way ai-service does (used only by tests).
func signApproval(secret, id, user, cluster, tool string, args map[string]interface{}, exp int64) string {
	sum := sha256.Sum256([]byte(canonicalArgs(args)))
	payload := strings.Join([]string{id, user, cluster, tool, hex.EncodeToString(sum[:]), fmt.Sprint(exp)}, "|")
	b64 := base64.RawURLEncoding.EncodeToString([]byte(payload))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(b64))
	return b64 + "." + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyApprovalToken(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	args := decodeArgs(t, `{"cluster":"prod","resource_type":"deployment","resource_name":"web","replicas":2}`)
	good := signApproval("s3cret", "ap1", "u1", "prod", "k8s_scale", args, now.Unix()+60)

	if err := verifyApprovalToken("s3cret", good, "ap1", "u1", "prod", "k8s_scale", args, now); err != nil {
		t.Fatalf("valid token refused: %v", err)
	}
	tampered := decodeArgs(t, `{"cluster":"prod","resource_type":"deployment","resource_name":"web","replicas":50}`)
	cases := []struct {
		name                                 string
		secret, token, id, user, cluster, tl string
		args                                 map[string]interface{}
		at                                   time.Time
		want                                 string
	}{
		{"no secret", "", good, "ap1", "u1", "prod", "k8s_scale", args, now, "not configured"},
		{"wrong secret", "other", good, "ap1", "u1", "prod", "k8s_scale", args, now, "bad signature"},
		{"malformed", "s3cret", "nodot", "ap1", "u1", "prod", "k8s_scale", args, now, "malformed"},
		{"expired", "s3cret", good, "ap1", "u1", "prod", "k8s_scale", args, now.Add(2 * time.Minute), "expired"},
		{"other approval id", "s3cret", good, "ap2", "u1", "prod", "k8s_scale", args, now, "approval id mismatch"},
		{"other user", "s3cret", good, "ap1", "u2", "prod", "k8s_scale", args, now, "user mismatch"},
		{"other cluster", "s3cret", good, "ap1", "u1", "dev", "k8s_scale", args, now, "cluster mismatch"},
		{"other tool", "s3cret", good, "ap1", "u1", "prod", "k8s_delete_resource", args, now, "tool mismatch"},
		{"tampered args", "s3cret", good, "ap1", "u1", "prod", "k8s_scale", tampered, now, "arguments differ"},
	}
	for _, c := range cases {
		err := verifyApprovalToken(c.secret, c.token, c.id, c.user, c.cluster, c.tl, c.args, c.at)
		if err == nil || !errors.Is(err, errApprovalToken) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want error containing %q", c.name, err, c.want)
		}
	}
}

func TestApprovalGate_BindsTokenToCall(t *testing.T) {
	writeApprovalRequired = true
	orig := approvalSecret
	t.Cleanup(func() { approvalSecret = orig })
	approvalSecret = "s3cret"
	payload := auth.TokenPayload{UserID: "u1"}
	args := decodeArgs(t, `{"resource_type":"deployment","resource_name":"web","replicas":2}`)
	token := signApproval("s3cret", "ap1", "u1", "prod", "k8s_scale", args, time.Now().Unix()+60)

	h := http.Header{}
	if code, err := approvalGate(h, "k8s_get_resources", "prod", payload, args); err != nil || code != 0 {
		t.Fatalf("read tools never need approval: %d %v", code, err)
	}
	if code, _ := approvalGate(h, "k8s_scale", "prod", payload, args); code != http.StatusForbidden {
		t.Fatalf("no headers must be 403, got %d", code)
	}
	h.Set(approvalHeader, "ap1")
	if code, _ := approvalGate(h, "k8s_scale", "prod", payload, args); code != http.StatusForbidden {
		t.Fatalf("id without token must be 403, got %d", code)
	}
	h.Set(approvalTokenHeader, token)
	if code, err := approvalGate(h, "k8s_scale", "prod", payload, args); err != nil || code != 0 {
		t.Fatalf("bound token passes: %d %v", code, err)
	}
	if code, _ := approvalGate(h, "k8s_scale", "prod", auth.TokenPayload{UserID: "u2"}, args); code != http.StatusForbidden {
		t.Fatalf("another user's JWT must be 403, got %d", code)
	}
	if code, _ := approvalGate(h, "k8s_scale", "dev", payload, args); code != http.StatusForbidden {
		t.Fatalf("another cluster must be 403, got %d", code)
	}
	approvalSecret = ""
	if code, _ := approvalGate(h, "k8s_scale", "prod", payload, args); code != http.StatusServiceUnavailable {
		t.Fatalf("no secret must be 503, got %d", code)
	}
	writeApprovalRequired = false
	if code, err := approvalGate(http.Header{}, "k8s_scale", "prod", payload, args); err != nil || code != 0 {
		t.Fatalf("gate off (dev) lets writes through: %d %v", code, err)
	}
	writeApprovalRequired = true
}
