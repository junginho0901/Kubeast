package handler

import (
	"encoding/json"

	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

var stoppedMarker = json.RawMessage(`{"stopped":true}`)

// StoppedUsage is the usage stored with a saved message: the stopped marker for an assistant answer the user
// stopped part way, nothing otherwise. Token counts come only from ai-service, which writes the turns it ends.
func StoppedUsage(msg model.MessageRequest) *json.RawMessage {
	if !msg.Stopped || msg.Role != "assistant" {
		return nil
	}
	marker := stoppedMarker
	return &marker
}
