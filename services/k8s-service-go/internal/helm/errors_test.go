package helm

import (
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
