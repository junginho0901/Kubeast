package controller

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/junginho0901/kubeast/model-config-controller-go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

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
	CACert       string
	Options      map[string]string
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

	// 생성 옵션: ollama.options 를 DB 로 동기화 (kagent parity).
	var options map[string]string
	if provider == "ollama" && spec.Ollama != nil && len(spec.Ollama.Options) > 0 {
		options = spec.Ollama.Options
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
		CACert:       strings.TrimSpace(spec.CACert),
		Options:      options,
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

func providerLabel(mc *v1alpha1.ModelConfig) string {
	value := strings.TrimSpace(mc.Spec.Provider)
	if value == "" {
		return "unknown"
	}
	return strings.ToLower(value)
}
