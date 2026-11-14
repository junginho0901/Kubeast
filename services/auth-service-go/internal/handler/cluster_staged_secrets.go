package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// putBackTimeout bounds putting back the Secrets of a change that did not commit, which goes on after its request.
const putBackTimeout = 10 * time.Second

// stagedSecret is one Secret write run inside a clusters row change (cluster.PostgresRegistry ReplaceKubeconfig,
// UpdateMetaStoring), which commits only when every write went through. It reads the value it replaces first, so when
// the row change does not commit after it wrote, putBackAll restores that value and the Secret again matches the
// config_version k8s-service compares.
type stagedSecret struct {
	what  string // "kubeconfig", "prometheus auth", "log search auth"
	value string
	// read is nil when the store cannot read.
	read  func(ctx context.Context) (string, error)
	write func(ctx context.Context, value string) error

	before    string
	hasBefore bool
	written   bool
	// err is the write's own failure.
	err error
}

// stageKubeconfig stages cluster id's kubeconfig Secret.
func (h *ClustersHandler) stageKubeconfig(id cluster.ID, blob string) *stagedSecret {
	s := &stagedSecret{what: "kubeconfig", value: blob, write: func(ctx context.Context, v string) error {
		_, err := h.secrets.WriteKubeconfig(ctx, id, v)
		return err
	}}
	if rd, ok := h.secrets.(cluster.SecretReader); ok {
		s.read = func(ctx context.Context) (string, error) { return rd.ReadKubeconfig(ctx, cluster.SecretName(id)) }
	}
	return s
}

// stageValue stages one key of a named Secret (a Prometheus or log store Authorization header).
func (h *ClustersHandler) stageValue(what, name, key, value string) *stagedSecret {
	s := &stagedSecret{what: what, value: value, write: func(ctx context.Context, v string) error {
		return h.secrets.WriteValue(ctx, name, key, v)
	}}
	if rd, ok := h.secrets.(cluster.SecretReader); ok {
		s.read = func(ctx context.Context) (string, error) { return rd.ReadValue(ctx, name, key) }
	}
	return s
}

// storeAll is the store of a row change: it writes each staged Secret in order and stops at the first that fails.
func storeAll(staged []*stagedSecret) func(context.Context) error {
	if len(staged) == 0 {
		return nil
	}
	return func(ctx context.Context) error {
		for _, s := range staged {
			if s.read != nil {
				if v, err := s.read(ctx); err == nil {
					s.before, s.hasBefore = v, true
				}
			}
			if err := s.write(ctx, s.value); err != nil {
				s.err = err
				return fmt.Errorf("store %s: %w", s.what, err)
			}
			s.written = true
		}
		return nil
	}
}

// putBackAll writes back what each written staged Secret replaced, once their row change did not commit, and says what
// stays as written ("" when nothing does).
func putBackAll(ctx context.Context, staged []*stagedSecret) string {
	var left []string
	for _, s := range staged {
		if !s.written {
			continue
		}
		if !s.hasBefore {
			left = append(left, s.what+" (the value before was not read)")
			continue
		}
		if err := s.write(ctx, s.before); err != nil {
			left = append(left, fmt.Sprintf("%s (%v)", s.what, err))
			continue
		}
		s.written = false
	}
	return strings.Join(left, ", ")
}

// failClusterChange answers a clusters row change that did not commit: the Secrets it wrote are put back, the audit
// row records the failure, and the answer is 404 for a row gone, 500 with the store's reason for a Secret not written
// and 500 for the database.
func (h *ClustersHandler) failClusterChange(w http.ResponseWriter, r *http.Request, payload auth.TokenPayload, id cluster.ID, before, after interface{}, staged []*stagedSecret, err error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), putBackTimeout)
	defer cancel()
	opErr := err
	if left := putBackAll(ctx, staged); left != "" {
		opErr = fmt.Errorf("%w; left as written: %s", err, left)
		slog.Error("cluster: secrets written for a change that did not commit were not put back", "id", id, "left", left)
	}
	h.audit(r, "admin.cluster.update", payload, string(id), before, after, opErr)
	var storeFailed bool
	for _, s := range staged {
		if s.err != nil {
			storeFailed = true
		}
	}
	switch {
	case storeFailed:
		response.Error(w, http.StatusInternalServerError, err.Error())
	case errors.Is(err, cluster.ErrNotFound):
		response.Error(w, http.StatusNotFound, "Cluster not found")
	default:
		response.InternalError(w, r, err)
	}
}
