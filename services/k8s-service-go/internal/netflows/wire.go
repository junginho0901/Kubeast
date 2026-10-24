package netflows

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// The Hubble observer API (cilium api/v1/observer and api/v1/flow, v1.20.4)
// read and written field by field: only what Kubeast asks and shows. Field
// numbers are the proto's; the API keeps them stable across 1.x.

// Workload is a pod's owner as Hubble reports it (kind Deployment, name web).
type Workload struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// filter is one whitelist entry of GetFlows: its fields combine with AND,
// entries with OR. Pods are "namespace/name" prefixes.
type filter struct {
	sourcePod, destinationPod           []string
	sourceWorkload, destinationWorkload []Workload
	verdicts                            []int32
}

func appendString(b []byte, num protowire.Number, s string) []byte {
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendString(b, s)
}

func appendMessage(b []byte, num protowire.Number, m []byte) []byte {
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendBytes(b, m)
}

func (w Workload) encode() []byte {
	var b []byte
	if w.Name != "" {
		b = appendString(b, 1, w.Name)
	}
	if w.Kind != "" {
		b = appendString(b, 2, w.Kind)
	}
	return b
}

func (f filter) encode() []byte {
	var b []byte
	for _, s := range f.sourcePod {
		b = appendString(b, 2, s)
	}
	for _, s := range f.destinationPod {
		b = appendString(b, 4, s)
	}
	if len(f.verdicts) > 0 {
		var packed []byte
		for _, v := range f.verdicts {
			packed = protowire.AppendVarint(packed, uint64(v))
		}
		b = appendMessage(b, 5, packed)
	}
	for _, w := range f.sourceWorkload {
		b = appendMessage(b, 26, w.encode())
	}
	for _, w := range f.destinationWorkload {
		b = appendMessage(b, 27, w.encode())
	}
	return b
}

// encodeRequest is GetFlowsRequest{number, whitelist}: the last number flows
// that match one of the filters.
func encodeRequest(number uint64, whitelist []filter) []byte {
	var b []byte
	b = protowire.AppendTag(b, 1, protowire.VarintType)
	b = protowire.AppendVarint(b, number)
	for _, f := range whitelist {
		b = appendMessage(b, 6, f.encode())
	}
	return b
}

// frame is a gRPC length-prefixed message, uncompressed.
func frame(msg []byte) []byte {
	out := make([]byte, 5, 5+len(msg))
	binary.BigEndian.PutUint32(out[1:], uint32(len(msg)))
	return append(out, msg...)
}

// maxMessage caps one response message (a flow is a few hundred bytes).
const maxMessage = 4 << 20

var errCompressed = errors.New("relay sent a compressed message")

// readMessages calls fn for each gRPC message of r until it ends.
func readMessages(r io.Reader, fn func([]byte) error) error {
	var head [5]byte
	for {
		if _, err := io.ReadFull(r, head[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("reading a relay message: %w", err)
		}
		if head[0] != 0 {
			return errCompressed
		}
		n := binary.BigEndian.Uint32(head[1:])
		if n > maxMessage {
			return fmt.Errorf("relay message of %d bytes is over the %d limit", n, maxMessage)
		}
		msg := make([]byte, n)
		if _, err := io.ReadFull(r, msg); err != nil {
			return fmt.Errorf("reading a relay message: %w", err)
		}
		if err := fn(msg); err != nil {
			return err
		}
	}
}

// fields walks the fields of one message.
func fields(b []byte, fn func(num protowire.Number, typ protowire.Type, v []byte) error) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return protowire.ParseError(n)
		}
		b = b[n:]
		m := protowire.ConsumeFieldValue(num, typ, b)
		if m < 0 {
			return protowire.ParseError(m)
		}
		if err := fn(num, typ, b[:m]); err != nil {
			return err
		}
		b = b[m:]
	}
	return nil
}

func varint(typ protowire.Type, v []byte) uint64 {
	if typ != protowire.VarintType {
		return 0
	}
	x, _ := protowire.ConsumeVarint(v)
	return x
}

func bytesOf(typ protowire.Type, v []byte) []byte {
	if typ != protowire.BytesType {
		return nil
	}
	x, _ := protowire.ConsumeBytes(v)
	return x
}

// response is one GetFlowsResponse: a flow, or a count of lost events.
type response struct {
	flow *Flow
	lost uint64
}

func decodeResponse(b []byte) (response, error) {
	var r response
	var node string
	err := fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch num {
		case 1:
			f, err := decodeFlow(bytesOf(typ, v))
			if err != nil {
				return err
			}
			r.flow = &f
		case 3:
			return fields(bytesOf(typ, v), func(num protowire.Number, typ protowire.Type, v []byte) error {
				if num == 2 {
					r.lost = varint(typ, v)
				}
				return nil
			})
		case 1000:
			node = string(bytesOf(typ, v))
		}
		return nil
	})
	if r.flow != nil && r.flow.Node == "" {
		r.flow.Node = node
	}
	return r, err
}

var verdicts = map[uint64]string{1: "FORWARDED", 2: "DROPPED", 3: "ERROR", 4: "AUDIT", 5: "REDIRECTED", 6: "TRACED", 7: "TRANSLATED"}

// Verdicts maps the names Kubeast accepts to Hubble's enum values.
var Verdicts = map[string]int32{"FORWARDED": 1, "DROPPED": 2, "ERROR": 3, "AUDIT": 4, "REDIRECTED": 5, "TRACED": 6, "TRANSLATED": 7}

func decodeFlow(b []byte) (Flow, error) {
	f := Flow{Verdict: "UNKNOWN"}
	err := fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch num {
		case 1:
			f.Time = decodeTimestamp(bytesOf(typ, v))
		case 2:
			if name, ok := verdicts[varint(typ, v)]; ok {
				f.Verdict = name
			}
		case 5:
			return fields(bytesOf(typ, v), func(num protowire.Number, typ protowire.Type, v []byte) error {
				switch num {
				case 1:
					f.Source.IP = string(bytesOf(typ, v))
				case 2:
					f.Destination.IP = string(bytesOf(typ, v))
				}
				return nil
			})
		case 6:
			return decodeL4(bytesOf(typ, v), &f)
		case 8:
			return decodeEndpoint(bytesOf(typ, v), &f.Source)
		case 9:
			return decodeEndpoint(bytesOf(typ, v), &f.Destination)
		case 11:
			f.Node = string(bytesOf(typ, v))
		case 13:
			f.Source.Names = append(f.Source.Names, string(bytesOf(typ, v)))
		case 14:
			f.Destination.Names = append(f.Destination.Names, string(bytesOf(typ, v)))
		case 15:
			l7, err := decodeL7(bytesOf(typ, v))
			if err != nil {
				return err
			}
			f.L7 = l7
		case 20:
			f.Source.Service = decodeService(bytesOf(typ, v))
		case 21:
			f.Destination.Service = decodeService(bytesOf(typ, v))
		case 22:
			switch varint(typ, v) {
			case 1:
				f.Direction = "ingress"
			case 2:
				f.Direction = "egress"
			}
		case 25:
			if reason := int32(varint(typ, v)); reason != 0 {
				f.DropReason = dropReasons[reason]
				if f.DropReason == "" {
					f.DropReason = fmt.Sprintf("DROP_REASON_%d", reason)
				}
			}
		case 26:
			_ = fields(bytesOf(typ, v), func(num protowire.Number, typ protowire.Type, v []byte) error {
				if num == 1 {
					f.IsReply = varint(typ, v) != 0
				}
				return nil
			})
		case 21001, 21002, 21004, 21005:
			p := decodePolicy(bytesOf(typ, v))
			if f.Policies == nil {
				f.Policies = &Policies{}
			}
			switch num {
			case 21001:
				f.Policies.EgressAllowedBy = append(f.Policies.EgressAllowedBy, p)
			case 21002:
				f.Policies.IngressAllowedBy = append(f.Policies.IngressAllowedBy, p)
			case 21004:
				f.Policies.EgressDeniedBy = append(f.Policies.EgressDeniedBy, p)
			case 21005:
				f.Policies.IngressDeniedBy = append(f.Policies.IngressDeniedBy, p)
			}
		}
		return nil
	})
	return f, err
}

func decodeTimestamp(b []byte) time.Time {
	var sec, nsec uint64
	_ = fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch num {
		case 1:
			sec = varint(typ, v)
		case 2:
			nsec = varint(typ, v)
		}
		return nil
	})
	return time.Unix(int64(sec), int64(nsec)).UTC()
}

var tcpFlagNames = map[protowire.Number]string{1: "FIN", 2: "SYN", 3: "RST", 4: "PSH", 5: "ACK", 6: "URG", 7: "ECE", 8: "CWR", 9: "NS"}

func decodeL4(b []byte, f *Flow) error {
	return fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		proto := map[protowire.Number]string{1: "TCP", 2: "UDP", 3: "ICMPv4", 4: "ICMPv6", 5: "SCTP", 6: "VRRP", 7: "IGMP"}[num]
		if proto == "" {
			return nil
		}
		f.Protocol = proto
		return fields(bytesOf(typ, v), func(n protowire.Number, t protowire.Type, v []byte) error {
			switch {
			case n == 1 && (num == 1 || num == 2 || num == 5):
				f.Source.Port = uint32(varint(t, v))
			case n == 2 && (num == 1 || num == 2 || num == 5):
				f.Destination.Port = uint32(varint(t, v))
			case n == 3 && num == 1:
				var set []string
				_ = fields(bytesOf(t, v), func(fn protowire.Number, ft protowire.Type, fv []byte) error {
					if varint(ft, fv) != 0 && tcpFlagNames[fn] != "" {
						set = append(set, tcpFlagNames[fn])
					}
					return nil
				})
				f.TCPFlags = strings.Join(set, ",")
			}
			return nil
		})
	})
}

func decodeEndpoint(b []byte, e *End) error {
	return fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch num {
		case 2:
			e.Identity = uint32(varint(typ, v))
		case 3:
			e.Namespace = string(bytesOf(typ, v))
		case 5:
			e.Pod = string(bytesOf(typ, v))
		case 6:
			if e.Workload == nil {
				var w Workload
				_ = fields(bytesOf(typ, v), func(n protowire.Number, t protowire.Type, v []byte) error {
					switch n {
					case 1:
						w.Name = string(bytesOf(t, v))
					case 2:
						w.Kind = string(bytesOf(t, v))
					}
					return nil
				})
				e.Workload = &w
			}
		}
		return nil
	})
}

func decodeService(b []byte) string {
	var name, ns string
	_ = fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch num {
		case 1:
			name = string(bytesOf(typ, v))
		case 2:
			ns = string(bytesOf(typ, v))
		}
		return nil
	})
	if name == "" {
		return ""
	}
	return ns + "/" + name
}

func decodePolicy(b []byte) PolicyRef {
	var p PolicyRef
	_ = fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch num {
		case 1:
			p.Name = string(bytesOf(typ, v))
		case 2:
			p.Namespace = string(bytesOf(typ, v))
		case 5:
			p.Kind = string(bytesOf(typ, v))
		}
		return nil
	})
	return p
}

func decodeL7(b []byte) (*L7, error) {
	l := &L7{}
	err := fields(b, func(num protowire.Number, typ protowire.Type, v []byte) error {
		switch num {
		case 1:
			l.Type = map[uint64]string{1: "REQUEST", 2: "RESPONSE", 3: "SAMPLE"}[varint(typ, v)]
		case 2:
			l.LatencyMs = float64(varint(typ, v)) / 1e6
		case 100:
			d := &DNS{}
			_ = fields(bytesOf(typ, v), func(n protowire.Number, t protowire.Type, v []byte) error {
				switch n {
				case 1:
					d.Query = string(bytesOf(t, v))
				case 6:
					d.RCode = uint32(varint(t, v))
				}
				return nil
			})
			l.DNS = d
		case 101:
			h := &HTTP{}
			_ = fields(bytesOf(typ, v), func(n protowire.Number, t protowire.Type, v []byte) error {
				switch n {
				case 1:
					h.Code = uint32(varint(t, v))
				case 2:
					h.Method = string(bytesOf(t, v))
				case 3:
					h.URL = withoutQuery(string(bytesOf(t, v)))
				case 4:
					h.Protocol = string(bytesOf(t, v))
				}
				return nil
			})
			l.HTTP = h
		}
		return nil
	})
	return l, err
}

// withoutQuery drops a URL's query and fragment, which can carry tokens.
func withoutQuery(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		u.RawQuery, u.Fragment, u.User = "", "", nil
		return u.String()
	}
	if i := strings.IndexAny(raw, "?#"); i >= 0 {
		return raw[:i]
	}
	return raw
}
