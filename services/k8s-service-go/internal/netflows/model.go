package netflows

import "time"

// Flow is one network flow as Kubeast shows it, whatever the source.
type Flow struct {
	Time       time.Time `json:"time"`
	Verdict    string    `json:"verdict"`
	DropReason string    `json:"drop_reason,omitempty"`
	// Direction is ingress or egress, as the observing endpoint saw it.
	Direction   string    `json:"direction,omitempty"`
	IsReply     bool      `json:"is_reply,omitempty"`
	Protocol    string    `json:"protocol,omitempty"`
	Source      End       `json:"source"`
	Destination End       `json:"destination"`
	TCPFlags    string    `json:"tcp_flags,omitempty"`
	Policies    *Policies `json:"policies,omitempty"`
	L7          *L7       `json:"l7,omitempty"`
	Node        string    `json:"node,omitempty"`
}

// End is one side of a flow: a pod (namespace, name, owner) or an address.
type End struct {
	Namespace string    `json:"namespace,omitempty"`
	Pod       string    `json:"pod,omitempty"`
	Workload  *Workload `json:"workload,omitempty"`
	IP        string    `json:"ip,omitempty"`
	Port      uint32    `json:"port,omitempty"`
	// Names are DNS names Hubble saw for an address.
	Names    []string `json:"names,omitempty"`
	Service  string   `json:"service,omitempty"`
	Identity uint32   `json:"identity,omitempty"`
	// ServiceAddress: IP is a Service's own cluster IP — the packet was seen before it was sent on to one of
	// the Service's pods (or, on a reply, before the pod's address was put back).
	ServiceAddress bool `json:"service_address,omitempty"`
}

// Policies are the policies that allowed or denied the flow, when the
// network plugin reports them.
type Policies struct {
	EgressAllowedBy  []PolicyRef `json:"egress_allowed_by,omitempty"`
	IngressAllowedBy []PolicyRef `json:"ingress_allowed_by,omitempty"`
	EgressDeniedBy   []PolicyRef `json:"egress_denied_by,omitempty"`
	IngressDeniedBy  []PolicyRef `json:"ingress_denied_by,omitempty"`
}

// PolicyRef names a policy (kind NetworkPolicy, CiliumNetworkPolicy …).
type PolicyRef struct {
	Kind      string `json:"kind,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name"`
}

// L7 is the application part of a flow when the plugin sees it (HTTP, DNS).
type L7 struct {
	Type      string  `json:"type,omitempty"`
	LatencyMs float64 `json:"latency_ms,omitempty"`
	HTTP      *HTTP   `json:"http,omitempty"`
	DNS       *DNS    `json:"dns,omitempty"`
}

// HTTP is a request or response; the URL has no query string or fragment.
type HTTP struct {
	Method   string `json:"method,omitempty"`
	URL      string `json:"url,omitempty"`
	Code     uint32 `json:"code,omitempty"`
	Protocol string `json:"protocol,omitempty"`
}

// DNS is a query or answer.
type DNS struct {
	Query string `json:"query,omitempty"`
	RCode uint32 `json:"rcode,omitempty"`
}
