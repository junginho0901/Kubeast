package helm

import (
	"context"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The cached release list is scoped by the identity it was read as, so a
// viewer is never served an admin's list (or the other way round); the key
// carries a hash, not the user.
func TestListCacheKey_ScopedByIdentity(t *testing.T) {
	admin := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u-admin", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {"*"}}})
	reader := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u-reader", Email: "reader@example.com", Roles: map[string]string{"c1": "Read"}})
	readerAgain := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u-reader", Email: "reader@example.com", Roles: map[string]string{"c1": "Read"}})

	kAdmin := listCacheKey(admin, "c1", "", "")
	kReader := listCacheKey(reader, "c1", "", "")
	kReaderAgain := listCacheKey(readerAgain, "c1", "", "")
	kNone := listCacheKey(context.Background(), "c1", "", "")

	if kAdmin == kReader {
		t.Fatalf("admin and reader share a cache key: %s", kAdmin)
	}
	if kReader != kReaderAgain {
		t.Fatalf("same identity produced different keys: %s vs %s", kReader, kReaderAgain)
	}
	if kNone == kReader || kNone == kAdmin {
		t.Fatalf("no-identity key collides with a user key: %s", kNone)
	}
	for _, k := range []string{kAdmin, kReader, kNone} {
		if !strings.HasPrefix(k, "helm|releases|c1|") {
			t.Fatalf("key %q must keep the helm|releases|<cluster> prefix used by Invalidate", k)
		}
		if strings.Contains(k, "example.com") || strings.Contains(k, "u-") {
			t.Fatalf("key %q carries user data", k)
		}
	}
	// Namespace and status still separate entries for the same identity.
	if listCacheKey(reader, "c1", "team-a", "") == kReader || listCacheKey(reader, "c1", "", "failed") == kReader {
		t.Fatal("namespace/status no longer distinguish cache entries")
	}
}
