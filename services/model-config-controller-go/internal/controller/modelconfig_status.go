package controller

import (
	"context"
	"time"

	"github.com/junginho0901/kubeast/model-config-controller-go/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
)

func (r *ModelConfigReconciler) updateStatus(ctx context.Context, mc *v1alpha1.ModelConfig, dbID int64, secretHash string, secretState metav1.ConditionStatus, secretMsg string) (bool, error) {
	status := mc.Status
	updated := false
	specChanged := status.ObservedGeneration == nil || *status.ObservedGeneration != mc.Generation
	secretChanged := status.SecretHash != secretHash

	if specChanged {
		updated = true
	}
	if status.SecretHash != secretHash {
		updated = true
	}
	if status.DBID == nil || *status.DBID != dbID {
		updated = true
	}

	syncedCondition := metav1.Condition{
		Type:               "Synced",
		Status:             metav1.ConditionTrue,
		Reason:             "Synced",
		Message:            "Synced to DB",
		ObservedGeneration: mc.Generation,
	}
	secretCondition := metav1.Condition{
		Type:               "SecretReady",
		Status:             secretState,
		Reason:             conditionReason(secretState),
		Message:            secretMsg,
		ObservedGeneration: mc.Generation,
	}

	conditions := mergeConditions(status.Conditions, syncedCondition, secretCondition)
	if !conditionsEqual(status.Conditions, conditions) {
		updated = true
	}

	if !updated {
		return false, nil
	}

	if secretChanged {
		secretHashChangeTotal.WithLabelValues(providerLabel(mc)).Inc()
	}

	now := metav1.Now()
	status.Synced = boolPtr(true)
	status.DBID = &dbID
	status.SecretHash = secretHash
	status.Message = "Synced to DB"
	status.ObservedGeneration = int64Ptr(mc.Generation)
	status.Conditions = conditions
	if specChanged {
		status.LastSyncTime = &now
	}

	mc.Status = status
	if err := r.Status().Update(ctx, mc); err != nil {
		return false, err
	}
	return true, nil
}

func (r *ModelConfigReconciler) patchErrorStatus(ctx context.Context, mc *v1alpha1.ModelConfig, err error) (ctrl.Result, error) {
	status := mc.Status
	now := metav1.Now()
	status.Synced = boolPtr(false)
	status.Message = err.Error()
	status.ObservedGeneration = int64Ptr(mc.Generation)
	status.LastSyncTime = &now
	errorCondition := metav1.Condition{
		Type:               "Synced",
		Status:             metav1.ConditionFalse,
		Reason:             "SyncError",
		Message:            err.Error(),
		ObservedGeneration: mc.Generation,
	}
	status.Conditions = mergeConditions(status.Conditions, errorCondition)
	mc.Status = status
	if updateErr := r.Status().Update(ctx, mc); updateErr != nil {
		return ctrl.Result{}, updateErr
	}
	return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

func mergeConditions(existing []metav1.Condition, updates ...metav1.Condition) []metav1.Condition {
	byType := map[string]metav1.Condition{}
	for _, cond := range existing {
		byType[cond.Type] = cond
	}
	for _, cond := range updates {
		prev, ok := byType[cond.Type]
		if ok && prev.Status == cond.Status {
			cond.LastTransitionTime = prev.LastTransitionTime
		} else {
			cond.LastTransitionTime = metav1.Now()
		}
		byType[cond.Type] = cond
	}
	result := make([]metav1.Condition, 0, len(byType))
	for _, cond := range byType {
		result = append(result, cond)
	}
	return result
}

func conditionsEqual(a, b []metav1.Condition) bool {
	if len(a) != len(b) {
		return false
	}
	byType := map[string]metav1.Condition{}
	for _, cond := range a {
		byType[cond.Type] = cond
	}
	for _, cond := range b {
		prev, ok := byType[cond.Type]
		if !ok {
			return false
		}
		if prev.Status != cond.Status || prev.Message != cond.Message || prev.Reason != cond.Reason {
			return false
		}
	}
	return true
}

func conditionReason(status metav1.ConditionStatus) string {
	switch status {
	case metav1.ConditionTrue:
		return "SecretResolved"
	case metav1.ConditionFalse:
		return "SecretMissing"
	default:
		return "Unknown"
	}
}

func int64Ptr(v int64) *int64 {
	return &v
}

func boolPtr(v bool) *bool {
	return &v
}
