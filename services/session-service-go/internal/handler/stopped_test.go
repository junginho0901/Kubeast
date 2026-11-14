package handler

import (
	"testing"

	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

func TestMarkerUsageMarksOnlyAStoppedOrCutAnswer(t *testing.T) {
	for _, c := range []struct {
		msg  model.MessageRequest
		want string
	}{
		{model.MessageRequest{Role: "assistant", Content: "part", Stopped: true}, `{"stopped":true}`},
		{model.MessageRequest{Role: "assistant", Content: "part", Failed: true}, `{"failed":true}`},
	} {
		if got := MarkerUsage(c.msg); got == nil || string(*got) != c.want {
			t.Fatalf("%+v: got %v, want %s", c.msg, got, c.want)
		}
	}
	for _, msg := range []model.MessageRequest{
		{Role: "assistant", Content: "whole answer"},
		{Role: "user", Content: "question", Stopped: true},
		{Role: "user", Content: "question", Failed: true},
	} {
		if got := MarkerUsage(msg); got != nil {
			t.Fatalf("%+v: want no usage, got %s", msg, *got)
		}
	}
}
