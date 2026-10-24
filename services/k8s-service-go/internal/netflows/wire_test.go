package netflows

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"reflect"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// The testdata files are GetFlows answers of a real Hubble Relay (Cilium
// 1.20.4, kind) read through the API server service proxy: the demo app's
// client reaching web, and stranger dropped by the NetworkPolicy web-only-client.
func readFixture(t *testing.T, name string) []Flow {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var flows []Flow
	if err := readMessages(bytes.NewReader(raw), func(msg []byte) error {
		r, err := decodeResponse(msg)
		if r.flow != nil {
			flows = append(flows, *r.flow)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return flows
}

func TestDecodeRealFlows(t *testing.T) {
	flows := readFixture(t, "getflows-web.bin")
	if len(flows) != 20 {
		t.Fatalf("20 flows asked for, got %d", len(flows))
	}
	var forwarded, dropped *Flow
	for i := range flows {
		f := &flows[i]
		if f.Destination.Pod == "" || f.Destination.Namespace != "demo" {
			t.Fatalf("every flow goes to demo/web*: %+v", f.Destination)
		}
		if f.Time.IsZero() || f.Time.Year() < 2026 || f.Node == "" || f.Protocol != "TCP" {
			t.Fatalf("time, node and protocol: %+v", f)
		}
		switch {
		case f.Verdict == "FORWARDED" && f.Source.Pod != "" && forwarded == nil && !f.IsReply:
			forwarded = f
		case f.Verdict == "DROPPED" && dropped == nil:
			dropped = f
		}
	}
	if forwarded == nil || dropped == nil {
		t.Fatalf("the fixture has both: forwarded %v dropped %v", forwarded != nil, dropped != nil)
	}
	if forwarded.Source.Workload == nil || forwarded.Source.Workload.Kind != "Deployment" || forwarded.Source.Workload.Name != "client" || forwarded.Destination.Port != 80 {
		t.Fatalf("client -> web:80 forwarded: %+v", forwarded)
	}
	if dropped.DropReason != "POLICY_DENIED" || dropped.Source.Workload == nil || dropped.Source.Workload.Name != "stranger" || dropped.Direction != "ingress" {
		t.Fatalf("stranger -> web dropped by policy on ingress: %+v", dropped)
	}
}

func TestDecodeVerdictFilteredFixture(t *testing.T) {
	flows := readFixture(t, "getflows-web-dropped.bin")
	if len(flows) != 10 {
		t.Fatalf("10 asked for, got %d", len(flows))
	}
	for _, f := range flows {
		if f.Verdict != "DROPPED" || f.DropReason != "POLICY_DENIED" {
			t.Fatalf("only drops: %+v", f)
		}
	}
}

func TestEncodeRequest(t *testing.T) {
	// The request the fixtures were captured with: number 10, one filter with
	// destination_pod "demo/web" and verdict DROPPED.
	got := encodeRequest(10, []filter{{destinationPod: []string{"demo/web"}, verdicts: []int32{2}}})
	want := append([]byte{0x08, 0x0a, 0x32, 0x0d, 0x22, 0x08}, append([]byte("demo/web"), 0x2a, 0x01, 0x02)...)
	if !bytes.Equal(got, want) {
		t.Fatalf("encoding\n got %x\nwant %x", got, want)
	}
	w := encodeRequest(5, []filter{{sourcePod: []string{"shop/"}, sourceWorkload: []Workload{{Kind: "Deployment", Name: "web"}}}})
	var seen []protowire.Number
	_ = fields(w, func(num protowire.Number, typ protowire.Type, v []byte) error {
		seen = append(seen, num)
		if num == 6 {
			return fields(bytesOf(typ, v), func(n protowire.Number, _ protowire.Type, _ []byte) error {
				seen = append(seen, 600+n)
				return nil
			})
		}
		return nil
	})
	if !reflect.DeepEqual(seen, []protowire.Number{1, 6, 602, 626}) {
		t.Fatalf("fields: %v", seen)
	}
}

func TestReadMessagesErrors(t *testing.T) {
	ok := append(frame([]byte{1, 2}), frame(nil)...)
	n := 0
	if err := readMessages(bytes.NewReader(ok), func([]byte) error { n++; return nil }); err != nil || n != 2 {
		t.Fatalf("two frames: %d %v", n, err)
	}
	cut := frame([]byte{1, 2, 3})[:6]
	if err := readMessages(bytes.NewReader(cut), func([]byte) error { return nil }); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("a cut message: %v", err)
	}
	compressed := frame([]byte{1})
	compressed[0] = 1
	if err := readMessages(bytes.NewReader(compressed), func([]byte) error { return nil }); !errors.Is(err, errCompressed) {
		t.Fatalf("compressed: %v", err)
	}
	huge := make([]byte, 5)
	binary.BigEndian.PutUint32(huge[1:], maxMessage+1)
	if err := readMessages(bytes.NewReader(huge), func([]byte) error { return nil }); err == nil {
		t.Fatal("an oversized message is refused")
	}
}

func TestWithoutQuery(t *testing.T) {
	for in, want := range map[string]string{
		"http://web.demo/login?token=abc#x":      "http://web.demo/login",
		"https://user:pw@api.example/v1/items?q": "https://api.example/v1/items",
		"/path?secret=1":                         "/path",
		"http://web.demo/":                       "http://web.demo/",
	} {
		if got := withoutQuery(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestDecodeTimestampAndL7(t *testing.T) {
	var ts []byte
	ts = protowire.AppendTag(ts, 1, protowire.VarintType)
	ts = protowire.AppendVarint(ts, 1_800_000_000)
	ts = protowire.AppendTag(ts, 2, protowire.VarintType)
	ts = protowire.AppendVarint(ts, 5)
	if got := decodeTimestamp(ts); !got.Equal(time.Unix(1_800_000_000, 5)) {
		t.Fatalf("timestamp: %v", got)
	}
	var http []byte
	http = protowire.AppendTag(http, 1, protowire.VarintType)
	http = protowire.AppendVarint(http, 403)
	http = appendString(http, 2, "GET")
	http = appendString(http, 3, "http://web/admin?key=1")
	var l7 []byte
	l7 = protowire.AppendTag(l7, 1, protowire.VarintType)
	l7 = protowire.AppendVarint(l7, 2)
	l7 = appendMessage(l7, 101, http)
	got, err := decodeL7(l7)
	if err != nil || got.Type != "RESPONSE" || got.HTTP == nil || got.HTTP.Code != 403 || got.HTTP.Method != "GET" || got.HTTP.URL != "http://web/admin" {
		t.Fatalf("l7: %+v %v", got, err)
	}
}
