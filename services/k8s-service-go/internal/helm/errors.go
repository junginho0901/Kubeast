package helm

import (
	"errors"
	"strings"

	"helm.sh/helm/v3/pkg/storage/driver"
)

// ErrNotFound is returned when a release or a revision does not exist.
// The handler layer maps it to HTTP 404.
var ErrNotFound = errors.New("release not found")

// ErrInvalidSection is returned for unknown section kinds in URLs.
// Mapped to HTTP 400 in the handler layer.
var ErrInvalidSection = errors.New("invalid section")

// ErrInvalidRevision is returned when a diff names a revision that is not
// positive. Mapped to HTTP 400 in the handler layer.
var ErrInvalidRevision = errors.New("from/to revisions must be positive")

// translateSDKError converts a low-level Helm SDK error to one of our
// sentinel errors where possible, preserving the original message.
// Used so callers can errors.Is(err, helm.ErrNotFound) without importing
// the Helm driver package.
func translateSDKError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, driver.ErrReleaseNotFound) {
		return ErrNotFound
	}
	// Helm wraps some not-found cases as plain strings — be tolerant.
	msg := err.Error()
	if strings.Contains(msg, "not found") || strings.Contains(msg, "release: not found") {
		return ErrNotFound
	}
	return err
}
