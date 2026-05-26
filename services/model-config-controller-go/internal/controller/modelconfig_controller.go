package controller

import (
	"context"
	"database/sql"
	"sync"
	"time"

	"github.com/junginho0901/kubeast/model-config-controller-go/api/v1alpha1"
	"github.com/prometheus/client_golang/prometheus"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

var (
	syncTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "kubeast",
			Subsystem: "model_config_controller",
			Name:      "sync_total",
			Help:      "Total number of model config sync attempts",
		},
		[]string{"status", "provider"},
	)
	secretHashChangeTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "kubeast",
			Subsystem: "model_config_controller",
			Name:      "secret_hash_change_total",
			Help:      "Total number of model config secret hash changes",
		},
		[]string{"provider"},
	)
)

func init() {
	metrics.Registry.MustRegister(syncTotal, secretHashChangeTotal)
}

type ModelConfigReconciler struct {
	client.Client
	Scheme *runtime.Scheme

	dbOnce sync.Once
	db     *sql.DB
	dbErr  error
}

func (r *ModelConfigReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var modelConfig v1alpha1.ModelConfig
	if err := r.Get(ctx, req.NamespacedName, &modelConfig); err != nil {
		if apierrors.IsNotFound(err) {
			return r.deleteModelConfig(ctx, req.NamespacedName)
		}
		return ctrl.Result{}, err
	}

	provider := providerLabel(&modelConfig)
	if err := r.ensureDB(); err != nil {
		syncTotal.WithLabelValues("error", provider).Inc()
		return ctrl.Result{RequeueAfter: 10 * time.Second}, err
	}

	data, err := r.parseSpec(&modelConfig)
	if err != nil {
		syncTotal.WithLabelValues("error", provider).Inc()
		return r.patchErrorStatus(ctx, &modelConfig, err)
	}

	dbID, err := r.upsertModelConfig(ctx, data)
	if err != nil {
		syncTotal.WithLabelValues("error", provider).Inc()
		return r.patchErrorStatus(ctx, &modelConfig, err)
	}

	secretHash, secretState, secretMsg, secretErr := r.resolveSecret(ctx, &modelConfig)
	if secretErr != nil {
		secretState = metav1.ConditionUnknown
		secretMsg = secretErr.Error()
	}

	updated, err := r.updateStatus(ctx, &modelConfig, dbID, secretHash, secretState, secretMsg)
	if err != nil {
		syncTotal.WithLabelValues("error", provider).Inc()
		return ctrl.Result{}, err
	}
	syncTotal.WithLabelValues("success", provider).Inc()
	if updated {
		return ctrl.Result{RequeueAfter: 0}, nil
	}
	return ctrl.Result{}, nil
}

func (r *ModelConfigReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.ModelConfig{}).
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(r.mapSecretToModelConfigs)).
		Complete(r)
}

func (r *ModelConfigReconciler) mapSecretToModelConfigs(ctx context.Context, obj client.Object) []reconcile.Request {
	secret, ok := obj.(*corev1.Secret)
	if !ok {
		return nil
	}

	var list v1alpha1.ModelConfigList
	if err := r.List(ctx, &list, client.InNamespace(secret.Namespace)); err != nil {
		return nil
	}

	requests := make([]reconcile.Request, 0, len(list.Items))
	for _, item := range list.Items {
		if item.Spec.APIKeySecretRef == nil {
			continue
		}
		if item.Spec.APIKeySecretRef.Name == secret.Name {
			requests = append(requests, reconcile.Request{NamespacedName: types.NamespacedName{
				Name:      item.Name,
				Namespace: item.Namespace,
			}})
		}
	}
	return requests
}
