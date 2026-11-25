// From when a failing object's state is known, in the answers of issues and anomaly_rank with AI_FAULT_ONSET (chart
// ai.faultOnset, off by default): k8s-service works it out of the lists it reads anyway. Off, neither is asked for it and
// the answers are as they were.

package main

import (
	"net/url"

	"github.com/junginho0901/kubeast/services/pkg/config"
)

// faultOnset is AI_FAULT_ONSET by the one switch rule (config.SwitchOn), read at each call.
func faultOnset() bool { return config.EnvSwitch("AI_FAULT_ONSET") }

// askSince asks k8s-service for it when the switch is on.
func askSince(q url.Values) {
	if faultOnset() {
		q.Set("with_since", "true")
	}
}
