package handler

import (
	"encoding/json"

	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

var (
	stoppedMarker = json.RawMessage(`{"stopped":true}`)
	failedMarker  = json.RawMessage(`{"failed":true}`)
)

// MarkerUsage is the usage stored with a saved message: for an assistant answer, the stopped marker when the user
// stopped it part way and the failed marker when its stream was cut; nothing otherwise. Token counts come only from
// ai-service, which writes the turns it ends.
func MarkerUsage(msg model.MessageRequest) *json.RawMessage {
	if msg.Role != "assistant" {
		return nil
	}
	var marker json.RawMessage
	switch {
	case msg.Stopped:
		marker = stoppedMarker
	case msg.Failed:
		marker = failedMarker
	default:
		return nil
	}
	return &marker
}
