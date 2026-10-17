package handler

import (
	"testing"

	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

func TestStoppedUsageMarksOnlyAStoppedAnswer(t *testing.T) {
	got := StoppedUsage(model.MessageRequest{Role: "assistant", Content: "part", Stopped: true})
	if got == nil || string(*got) != `{"stopped":true}` {
		t.Fatalf("stopped answer: got %v", got)
	}
	for _, msg := range []model.MessageRequest{
		{Role: "assistant", Content: "whole answer"},
		{Role: "user", Content: "question", Stopped: true},
	} {
		if got := StoppedUsage(msg); got != nil {
			t.Fatalf("%+v: want no usage, got %s", msg, *got)
		}
	}
}
