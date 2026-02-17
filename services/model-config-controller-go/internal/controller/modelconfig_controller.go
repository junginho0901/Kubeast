package controller

import (
	"context"

	"github.com/junginho0901/kube-assistant/model-config-controller-go/api/v1alpha1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type ModelConfigReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *ModelConfigReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	return ctrl.Result{}, nil
}

func (r *ModelConfigReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.ModelConfig{}).
		Complete(r)
}
