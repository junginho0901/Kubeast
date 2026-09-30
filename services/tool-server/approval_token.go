// Approval tokens bind a write-tool call to the approval the user gave.
//
// ai-service's approve endpoint signs approval_id|user|cluster|tool|
// sha256(canonical args)|exp with the secret both services share
// (AI_APPROVAL_SECRET) and sends it as X-Kubeast-Approval-Token next to the
// approval id. tool-server refuses the call unless every field matches the
// request it is about to run: the JWT's user, the routed cluster, the tool,
// and the arguments as approved.

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	approvalTokenHeader = "X-Kubeast-Approval-Token"
	approvalSecretEnv   = "AI_APPROVAL_SECRET"
)

var errApprovalToken = errors.New("approval token")

// verifyApprovalToken checks token against the call it accompanies. now is
// injectable for tests.
func verifyApprovalToken(secret, token, approvalID, userID, cluster, tool string, args map[string]interface{}, now time.Time) error {
	if secret == "" {
		return fmt.Errorf("%w: verification is not configured (%s)", errApprovalToken, approvalSecretEnv)
	}
	dot := strings.LastIndexByte(token, '.')
	if dot <= 0 || dot == len(token)-1 {
		return fmt.Errorf("%w: malformed", errApprovalToken)
	}
	payloadB64, sig := token[:dot], token[dot+1:]
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payloadB64))
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return fmt.Errorf("%w: bad signature", errApprovalToken)
	}
	raw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return fmt.Errorf("%w: malformed payload", errApprovalToken)
	}
	fields := strings.Split(string(raw), "|")
	if len(fields) != 6 {
		return fmt.Errorf("%w: malformed payload", errApprovalToken)
	}
	exp, err := strconv.ParseInt(fields[5], 10, 64)
	if err != nil || now.Unix() > exp {
		return fmt.Errorf("%w: expired", errApprovalToken)
	}
	if fields[0] != approvalID {
		return fmt.Errorf("%w: approval id mismatch", errApprovalToken)
	}
	if fields[1] != userID {
		return fmt.Errorf("%w: user mismatch", errApprovalToken)
	}
	if fields[2] != cluster {
		return fmt.Errorf("%w: cluster mismatch", errApprovalToken)
	}
	if fields[3] != tool {
		return fmt.Errorf("%w: tool mismatch", errApprovalToken)
	}
	sum := sha256.Sum256([]byte(canonicalArgs(args)))
	if fields[4] != hex.EncodeToString(sum[:]) {
		return fmt.Errorf("%w: arguments differ from the approved ones", errApprovalToken)
	}
	return nil
}

// canonicalArgs renders args the way ai-service hashes them:
// json.dumps(args, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
// with the routing key "cluster" removed. args come from json.Decoder with
// UseNumber, so numbers keep the literal ai-service sent.
func canonicalArgs(args map[string]interface{}) string {
	filtered := make(map[string]interface{}, len(args))
	for k, v := range args {
		if k != "cluster" {
			filtered[k] = v
		}
	}
	var b strings.Builder
	writeCanonical(&b, filtered)
	return b.String()
}

func writeCanonical(b *strings.Builder, v interface{}) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		b.WriteString(t.String())
	case float64:
		b.WriteString(strconv.FormatFloat(t, 'g', -1, 64))
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case string:
		writeCanonicalString(b, t)
	case []interface{}:
		b.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			writeCanonical(b, item)
		}
		b.WriteByte(']')
	case map[string]interface{}:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeCanonicalString(b, k)
			b.WriteByte(':')
			writeCanonical(b, t[k])
		}
		b.WriteByte('}')
	default:
		// Anything else (map[string]string from tests, etc.) goes through the
		// generic decoder so it lands in the cases above.
		raw, err := json.Marshal(t)
		if err != nil {
			b.WriteString("null")
			return
		}
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.UseNumber()
		var generic interface{}
		if err := dec.Decode(&generic); err != nil {
			b.WriteString("null")
			return
		}
		writeCanonical(b, generic)
	}
}

// writeCanonicalString escapes like Python's json with ensure_ascii=True:
// '"' and '\' with a backslash, \b \f \n \r \t by name, every other
// character outside printable ASCII as \uXXXX (surrogate pairs above U+FFFF).
func writeCanonicalString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r >= 0x20 && r <= 0x7e {
				b.WriteRune(r)
			} else if r > 0xffff {
				hi, lo := utf16.EncodeRune(r)
				fmt.Fprintf(b, `\u%04x\u%04x`, hi, lo)
			} else {
				fmt.Fprintf(b, `\u%04x`, r)
			}
		}
	}
	b.WriteByte('"')
}
