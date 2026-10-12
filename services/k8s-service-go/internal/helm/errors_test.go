package helm

import (
	"context"
	"errors"
	"testing"

	"helm.sh/helm/v3/pkg/storage/driver"
)

func TestTranslateSDKError(t *testing.T) {
	t.Run("nil passes through", func(t *testing.T) {
		if translateSDKError(nil) != nil {
			t.Error("nil should translate to nil")
		}
	})

	t.Run("driver.ErrReleaseNotFound maps to ErrNotFound", func(t *testing.T) {
		got := translateSDKError(driver.ErrReleaseNotFound)
		if !errors.Is(got, ErrNotFound) {
			t.Errorf("got %v, want ErrNotFound", got)
		}
	})

	t.Run("string-wrapped not found also maps to ErrNotFound", func(t *testing.T) {
		got := translateSDKError(errors.New("release: not found"))
		if !errors.Is(got, ErrNotFound) {
			t.Errorf("got %v, want ErrNotFound", got)
		}
	})

	t.Run("unrelated errors pass through verbatim", func(t *testing.T) {
		src := errors.New("some kube error")
		if translateSDKError(src) != src {
			t.Error("unrelated error should pass through unchanged")
		}
	})
}

// A diff of a non-positive revision is refused before any lookup, with the
// sentinel the handler maps to 400.
func TestDiffRevisionsRejectsNonPositive(t *testing.T) {
	s := &Service{}
	for _, req := range []DiffRequest{{From: 0, To: 1, Section: SectionManifest}, {From: 1, To: -1, Section: SectionManifest}} {
		if _, err := s.DiffRevisions(context.Background(), "ns", "rel", req); !errors.Is(err, ErrInvalidRevision) {
			t.Fatalf("%+v: err = %v, want ErrInvalidRevision", req, err)
		}
	}
}
