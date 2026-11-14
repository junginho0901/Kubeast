// Package clusternotice is the cluster change notice on Redis: the channel and the message a k8s-service replica
// publishes when a cluster's registration changes (k8s-service internal/clustersync), which the other replicas and
// tool-server listen to.
//
// A notice names a cluster and the process that sent it, nothing else: no credential, no address, no version. Whoever
// hears one drops what it keeps of that cluster and reads it again from where it always does (k8s-service from the
// registry, tool-server from k8s-service, which checks the person's access again), so a forged notice costs one read.
// Pub/sub delivers a message at most once; each listener also has its own bound on how long it keeps a cluster without
// a notice.
package clusternotice

import (
	"encoding/json"
	"errors"
	"strconv"
	"unicode"
)

// Channel, with the Redis database number after it (ChannelFor), carries one notice per change.
const Channel = "kubeast:clusters:changed"

// ChannelFor is the channel of the install whose keys are in database db. Pub/sub ignores database numbers, so two
// installs sharing one Redis on two databases would otherwise hear each other's notices.
func ChannelFor(db int) string { return Channel + ":" + strconv.Itoa(db) }

// Notice is the message, JSON {"cluster":"<id>","from":"<process>"}.
type Notice struct {
	Cluster string `json:"cluster"`
	// From is the process that published it, which has dropped the cluster already.
	From string `json:"from"`
}

const (
	// MaxPayload is the longest message Decode reads.
	MaxPayload = 1024
	// maxClusterID is the longest cluster id a notice may name (a Kubernetes name's 253).
	maxClusterID = 253
)

// ErrNotANotice is a message Decode does not take: too long, not the JSON above, or a cluster that is empty, longer
// than 253 bytes or holding a control character. (encoding/json gives valid UTF-8 whatever the bytes.)
var ErrNotANotice = errors.New("not a cluster change notice")

// Decode reads a notice.
func Decode(payload string) (Notice, error) {
	if len(payload) > MaxPayload {
		return Notice{}, ErrNotANotice
	}
	var n Notice
	if err := json.Unmarshal([]byte(payload), &n); err != nil {
		return Notice{}, ErrNotANotice
	}
	if !validClusterID(n.Cluster) {
		return Notice{}, ErrNotANotice
	}
	return n, nil
}

func validClusterID(id string) bool {
	if id == "" || len(id) > maxClusterID {
		return false
	}
	for _, r := range id {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
