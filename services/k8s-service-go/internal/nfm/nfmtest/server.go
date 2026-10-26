// Package nfmtest is a stand-in for the Network Flow Monitor top contributors API, for tests.
package nfmtest

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Server serves the four top contributors operations at the paths and in the JSON of the AWS SDK for Go v2
// (service/networkflowmonitor v1.9.2, restjson1), so tests run the real client against it. It answers for
// one monitor and records what it was asked.
type Server struct {
	Monitor  string
	Rows     map[string][]map[string]any // by destination category
	Unit     string
	PageSize int      // rows per results page (0: all)
	Statuses []string // the answers of successive status calls (default SUCCEEDED)
	ErrCode  string   // StartQuery refuses with this code
	// StatusDelay holds each status answer back (a slow service).
	StatusDelay time.Duration

	mu sync.Mutex
	// What it was asked: StartQuery bodies, status calls per query ID, stopped query IDs, the maxResults of
	// each results call and every Authorization header.
	Started  []map[string]any
	Polls    map[string]int
	Stopped  []string
	MaxAsked []string
	Auth     []string
	queries  map[string]string // query ID → category
	limits   map[string]int
}

// NewServer answers for the monitor shop-monitor, in Bytes.
func NewServer() *Server {
	return &Server{Monitor: "shop-monitor", Rows: map[string][]map[string]any{}, Unit: "Bytes",
		queries: map[string]string{}, limits: map[string]int{}, Polls: map[string]int{}}
}

func (f *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f.StatusDelay > 0 && strings.HasSuffix(r.URL.Path, "/status") {
		time.Sleep(f.StatusDelay)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Auth = append(f.Auth, r.Header.Get("Authorization"))
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || parts[0] != "monitors" || parts[2] != "topContributorsQueries" {
		http.NotFound(w, r)
		return
	}
	if parts[1] != f.Monitor {
		f.refuse(w, http.StatusNotFound, "ResourceNotFoundException", "monitor "+parts[1]+" not found")
		return
	}
	switch {
	case r.Method == http.MethodPost && len(parts) == 3:
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.Started = append(f.Started, body)
		if f.ErrCode != "" {
			f.refuse(w, http.StatusForbidden, f.ErrCode, "not allowed")
			return
		}
		id := "q" + strconv.Itoa(len(f.Started))
		f.queries[id] = body["destinationCategory"].(string)
		f.limits[id] = int(body["limit"].(float64))
		writeJSON(w, map[string]any{"queryId": id})
	case r.Method == http.MethodGet && len(parts) == 5 && parts[4] == "status":
		n := f.Polls[parts[3]]
		f.Polls[parts[3]] = n + 1
		st := "SUCCEEDED"
		if len(f.Statuses) > 0 {
			st = f.Statuses[min(n, len(f.Statuses)-1)]
		}
		writeJSON(w, map[string]any{"status": st})
	case r.Method == http.MethodGet && len(parts) == 5 && parts[4] == "results":
		f.MaxAsked = append(f.MaxAsked, r.URL.Query().Get("maxResults"))
		rows := f.Rows[f.queries[parts[3]]]
		if l := f.limits[parts[3]]; len(rows) > l {
			rows = rows[:l]
		}
		from, _ := strconv.Atoi(r.URL.Query().Get("nextToken"))
		to := len(rows)
		if f.PageSize > 0 && from+f.PageSize < to {
			to = from + f.PageSize
		}
		out := map[string]any{"topContributors": rows[from:to], "unit": f.Unit}
		if to < len(rows) {
			out["nextToken"] = strconv.Itoa(to)
		}
		writeJSON(w, out)
	case r.Method == http.MethodDelete && len(parts) == 4:
		f.Stopped = append(f.Stopped, parts[3])
		writeJSON(w, map[string]any{})
	default:
		http.NotFound(w, r)
	}
}

func (f *Server) refuse(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("X-Amzn-ErrorType", code)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"message": msg})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// Seen is what was stopped and how often each query's status was asked, read under the server's lock (for a
// test that looks while a slow answer is still on its way).
func (f *Server) Seen() (stopped []string, polls map[string]int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	polls = map[string]int{}
	for k, v := range f.Polls {
		polls[k] = v
	}
	return append([]string(nil), f.Stopped...), polls
}

// Categories are the destination categories of the queries started, in order.
func (f *Server) Categories() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, b := range f.Started {
		out = append(out, b["destinationCategory"].(string))
	}
	return out
}

// Row is one top contributor as NFM writes it; an empty pod leaves kubernetesMetadata's pod fields out.
func Row(cat, localNS, localPod, localIP, localAZ, remoteNS, remotePod, remoteIP, remoteAZ string, port, value int) map[string]any {
	k := map[string]any{}
	if localPod != "" {
		k["localPodNamespace"], k["localPodName"] = localNS, localPod
	}
	if remotePod != "" {
		k["remotePodNamespace"], k["remotePodName"] = remoteNS, remotePod
	}
	r := map[string]any{"destinationCategory": cat, "localIp": localIP, "localAz": localAZ, "localVpcId": "vpc-0a1", "localInstanceId": "i-0local",
		"remoteIp": remoteIP, "remoteAz": remoteAZ, "remoteVpcId": "vpc-0a1", "targetPort": port, "value": value}
	if len(k) > 0 {
		r["kubernetesMetadata"] = k
	}
	return r
}
