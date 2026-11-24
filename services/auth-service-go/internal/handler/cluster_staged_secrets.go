package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// stagedSecret is one Secret write run inside a clusters row change (cluster.PostgresRegistry ReplaceKubeconfig,
// UpdateMetaStoring), which commits only when every write went through. It reads the value it replaces first, so when
// the row change does not commit after it wrote, putBackAll restores that value (the registry runs it while the row is
// still locked) and the Secret again matches the config_version k8s-service compares.
type stagedSecret struct {
	what  string // "kubeconfig", "prometheus auth", "log search auth"
	value string
	// read is nil when the store cannot read.
	read  func(ctx context.Context) (string, error)
	write func(ctx context.Context, value string) error

	before    string
	hasBefore bool
	written   bool
	// err is the write's own failure; unsure, that it failed with its context ended (the store's deadline), when the
	// API server may have applied it anyway.
	err    error
	unsure bool
}

// stageKubeconfig stages cluster id's kubeconfig Secret (a file in docker-compose mode), read where the write goes.
func (h *ClustersHandler) stageKubeconfig(id cluster.ID, blob string) *stagedSecret {
	s := &stagedSecret{what: "kubeconfig", value: blob, write: func(ctx context.Context, v string) error {
		_, err := h.secrets.WriteKubeconfig(ctx, id, v)
		return err
	}}
	if rd, ok := h.secrets.(cluster.SecretReader); ok {
		name := cluster.KubeconfigName(h.secrets, id)
		s.read = func(ctx context.Context) (string, error) { return rd.ReadKubeconfig(ctx, name) }
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

// secretWrites is the cluster.SecretWrites of a row change: storeAll, and putBackAll when it does not commit.
func secretWrites(staged []*stagedSecret) cluster.SecretWrites {
	if len(staged) == 0 {
		return cluster.SecretWrites{}
	}
	return cluster.SecretWrites{
		Store:   func(ctx context.Context) error { return storeAll(ctx, staged) },
		PutBack: func(ctx context.Context) (bool, string) { return putBackAll(ctx, staged) },
	}
}

// storeAll writes each staged Secret in order and stops at the first that fails.
func storeAll(ctx context.Context, staged []*stagedSecret) error {
	for _, s := range staged {
		if s.read != nil {
			if v, err := s.read(ctx); err == nil {
				s.before, s.hasBefore = v, true
			}
		}
		if err := s.write(ctx, s.value); err != nil {
			s.err, s.unsure = err, ctx.Err() != nil
			return fmt.Errorf("store %s: %w", s.what, err)
		}
		s.written = true
	}
	return nil
}

// putBackAll writes back what each staged Secret written, or whose write ran out of time, replaced, once their row
// change did not commit. changed is whether any of them had changed; left says what may stay as written ("" when
// nothing does).
func putBackAll(ctx context.Context, staged []*stagedSecret) (changed bool, left string) {
	var stays []string
	for _, s := range staged {
		if !s.written && !s.unsure {
			continue
		}
		changed = true
		if !s.hasBefore {
			stays = append(stays, s.what+" (the value before was not read)")
			continue
		}
		if err := s.write(ctx, s.before); err != nil {
			stays = append(stays, fmt.Sprintf("%s (%v)", s.what, err))
			continue
		}
		s.written, s.unsure = false, false
	}
	return changed, strings.Join(stays, ", ")
}

// failClusterChange answers a clusters row change that did not commit. The registry has put back the Secrets it wrote;
// what it could not undo (cluster.PutBackError) is named in the audit row and in the answer. The answer is 404 for a
// row gone, 500 with the store's reason for a Secret not written and 500 for the database.
func (h *ClustersHandler) failClusterChange(w http.ResponseWriter, r *http.Request, payload auth.TokenPayload, id cluster.ID, before, after interface{}, staged []*stagedSecret, err error) {
	var notUndone *cluster.PutBackError
	if errors.As(err, &notUndone) {
		slog.Error("cluster: secrets written for a change that did not commit were not all put back", "id", id, "left", notUndone.Left)
	}
	h.audit(r, "admin.cluster.update", payload, string(id), before, after, err)
	var storeFailed bool
	for _, s := range staged {
		if s.err != nil {
			storeFailed = true
		}
	}
	switch {
	case storeFailed:
		response.Error(w, http.StatusInternalServerError, response.Public(err))
	case errors.Is(err, cluster.ErrNotFound):
		response.Error(w, http.StatusNotFound, "Cluster not found")
	case notUndone != nil:
		slog.Error("internal error", "method", r.Method, "path", r.URL.Path, "err", err)
		response.Error(w, http.StatusInternalServerError, "internal server error; "+response.Public(errors.New(notUndone.Left)))
	default:
		response.InternalError(w, r, err)
	}
}
