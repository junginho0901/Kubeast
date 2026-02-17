package controller

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v4/stdlib"
	"github.com/junginho0901/kube-assistant/model-config-controller-go/api/v1alpha1"
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
			Namespace: "kube_assistant",
			Subsystem: "model_config_controller",
			Name:      "sync_total",
			Help:      "Total number of model config sync attempts",
		},
		[]string{"status", "provider"},
	)
	secretHashChangeTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "kube_assistant",
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

type modelConfigData struct {
	Name         string
	Provider     string
	Model        string
	BaseURL      string
	SecretName   string
	SecretKey    string
	APIKeyEnv    string
	ExtraHeaders map[string]string
	TLSVerify    bool
	Enabled      bool
	IsDefault    bool
}

func (r *ModelConfigReconciler) parseSpec(mc *v1alpha1.ModelConfig) (modelConfigData, error) {
	spec := mc.Spec
	provider := strings.ToLower(spec.Provider)
	if provider == "" {
		provider = "openai"
	}
	if !v1alpha1.ProviderSet.Has(provider) {
		return modelConfigData{}, fmt.Errorf("unsupported provider: %s", provider)
	}
	if strings.TrimSpace(spec.Model) == "" {
		return modelConfigData{}, fmt.Errorf("spec.model is required")
	}

	baseURL := strings.TrimSpace(spec.BaseURL)
	if baseURL == "" {
		switch provider {
		case "openai":
			if spec.OpenAI != nil {
				baseURL = strings.TrimSpace(spec.OpenAI.BaseURL)
			}
		case "anthropic":
			if spec.Anthropic != nil {
				baseURL = strings.TrimSpace(spec.Anthropic.BaseURL)
			}
		case "azureopenai":
			if spec.AzureOpenAI != nil {
				baseURL = strings.TrimSpace(spec.AzureOpenAI.AzureEndpoint)
			}
		case "ollama":
			if spec.Ollama != nil {
				baseURL = strings.TrimSpace(spec.Ollama.Host)
			}
		}
	}

	secretName := ""
	secretKey := ""
	if spec.APIKeySecretRef != nil {
		secretName = strings.TrimSpace(spec.APIKeySecretRef.Name)
		secretKey = strings.TrimSpace(spec.APIKeySecretRef.Key)
	}

	extraHeaders := spec.ExtraHeaders
	if extraHeaders == nil {
		extraHeaders = map[string]string{}
	}

	return modelConfigData{
		Name:         mc.Name,
		Provider:     provider,
		Model:        spec.Model,
		BaseURL:      baseURL,
		SecretName:   secretName,
		SecretKey:    secretKey,
		APIKeyEnv:    spec.APIKeyEnv,
		ExtraHeaders: extraHeaders,
		TLSVerify:    boolOrDefault(spec.TLSVerify, true),
		Enabled:      boolOrDefault(spec.Enabled, true),
		IsDefault:    boolOrDefault(spec.IsDefault, false),
	}, nil
}

func boolOrDefault(value *bool, def bool) bool {
	if value == nil {
		return def
	}
	return *value
}

func (r *ModelConfigReconciler) resolveSecret(ctx context.Context, mc *v1alpha1.ModelConfig) (string, metav1.ConditionStatus, string, error) {
	if mc.Spec.APIKeyEnv != "" {
		return "", metav1.ConditionTrue, "Secret not required", nil
	}
	if mc.Spec.APIKeySecretRef == nil {
		return "", metav1.ConditionTrue, "Secret not required", nil
	}
	name := strings.TrimSpace(mc.Spec.APIKeySecretRef.Name)
	key := strings.TrimSpace(mc.Spec.APIKeySecretRef.Key)
	if name == "" || key == "" {
		return "", metav1.ConditionFalse, "Secret ref missing name/key", nil
	}

	var secret corev1.Secret
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: mc.Namespace}, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			return "", metav1.ConditionFalse, "Secret not found", nil
		}
		return "", metav1.ConditionUnknown, "Secret read error", err
	}
	raw, ok := secret.Data[key]
	if !ok {
		return "", metav1.ConditionFalse, "Secret key not found", nil
	}
	hash := sha256.Sum256(raw)
	return fmt.Sprintf("%x", hash[:]), metav1.ConditionTrue, "Secret resolved", nil
}

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

func (r *ModelConfigReconciler) ensureDB() error {
	r.dbOnce.Do(func() {
		url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
		if url == "" {
			r.dbErr = fmt.Errorf("DATABASE_URL is required")
			return
		}
		url = normalizeDBURL(url)
		db, err := sql.Open("pgx", url)
		if err != nil {
			r.dbErr = err
			return
		}
		r.db = db
		r.dbErr = r.ensureTable()
	})
	if r.db == nil && r.dbErr == nil {
		r.dbErr = fmt.Errorf("database not initialized")
	}
	return r.dbErr
}

func normalizeDBURL(url string) string {
	if strings.HasPrefix(url, "postgresql+asyncpg://") {
		return strings.Replace(url, "postgresql+asyncpg://", "postgresql://", 1)
	}
	return url
}

func (r *ModelConfigReconciler) ensureTable() error {
	ddl := `
CREATE TABLE IF NOT EXISTS model_configs (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT,
  api_key_secret_name TEXT,
  api_key_secret_key TEXT,
  api_key_env TEXT,
  extra_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  tls_verify BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
	_, err := r.db.Exec(ddl)
	return err
}

func (r *ModelConfigReconciler) upsertModelConfig(ctx context.Context, data modelConfigData) (int64, error) {
	if data.IsDefault {
		if _, err := r.db.ExecContext(ctx, "UPDATE model_configs SET is_default = FALSE WHERE name <> $1", data.Name); err != nil {
			return 0, err
		}
	}

	extraHeaders, err := json.Marshal(data.ExtraHeaders)
	if err != nil {
		return 0, err
	}

	query := `
INSERT INTO model_configs (
  name, provider, model, base_url,
  api_key_secret_name, api_key_secret_key, api_key_env,
  extra_headers, tls_verify, enabled, is_default,
  created_at, updated_at
) VALUES (
  $1, $2, $3, $4,
  $5, $6, $7,
  $8, $9, $10, $11,
  NOW(), NOW()
) ON CONFLICT (name) DO UPDATE SET
  provider = EXCLUDED.provider,
  model = EXCLUDED.model,
  base_url = EXCLUDED.base_url,
  api_key_secret_name = EXCLUDED.api_key_secret_name,
  api_key_secret_key = EXCLUDED.api_key_secret_key,
  api_key_env = EXCLUDED.api_key_env,
  extra_headers = EXCLUDED.extra_headers,
  tls_verify = EXCLUDED.tls_verify,
  enabled = EXCLUDED.enabled,
  is_default = EXCLUDED.is_default,
  updated_at = NOW()
RETURNING id;
`
	var id int64
	if err := r.db.QueryRowContext(ctx, query,
		data.Name,
		data.Provider,
		data.Model,
		data.BaseURL,
		data.SecretName,
		data.SecretKey,
		data.APIKeyEnv,
		extraHeaders,
		data.TLSVerify,
		data.Enabled,
		data.IsDefault,
	).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func (r *ModelConfigReconciler) deleteModelConfig(ctx context.Context, nn types.NamespacedName) (ctrl.Result, error) {
	if err := r.ensureDB(); err != nil {
		return ctrl.Result{RequeueAfter: 10 * time.Second}, err
	}
	_, err := r.db.ExecContext(ctx, "DELETE FROM model_configs WHERE name = $1", nn.Name)
	return ctrl.Result{}, err
}

func int64Ptr(v int64) *int64 {
	return &v
}

func boolPtr(v bool) *bool {
	return &v
}

func providerLabel(mc *v1alpha1.ModelConfig) string {
	value := strings.TrimSpace(mc.Spec.Provider)
	if value == "" {
		return "unknown"
	}
	return strings.ToLower(value)
}
