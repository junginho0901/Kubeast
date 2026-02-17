package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"k8s.io/apimachinery/pkg/util/sets"
	"k8s.io/apimachinery/pkg/apis/meta/v1"
)

var (
	GroupVersion = schema.GroupVersion{Group: "ai.kube-assistant.io", Version: "v1alpha1"}
	SchemeBuilder = runtime.NewSchemeBuilder(addKnownTypes)
	AddToScheme = SchemeBuilder.AddToScheme
	Codecs = serializer.NewCodecFactory(runtime.NewScheme())
	ProviderSet = sets.NewString(
		"openai",
		"anthropic",
		"azureopenai",
		"gemini",
		"geminivertexai",
		"anthropicvertexai",
		"ollama",
		"bedrock",
	)
)

type ModelConfigSpec struct {
	Provider           string            `json:"provider,omitempty"`
	Model              string            `json:"model,omitempty"`
	BaseURL            string            `json:"baseURL,omitempty"`
	APIKeySecretRef    *SecretKeyRef     `json:"apiKeySecretRef,omitempty"`
	APIKeyEnv          string            `json:"apiKeyEnv,omitempty"`
	ExtraHeaders       map[string]string `json:"extraHeaders,omitempty"`
	TLSVerify          *bool             `json:"tlsVerify,omitempty"`
	Enabled            *bool             `json:"enabled,omitempty"`
	IsDefault          *bool             `json:"isDefault,omitempty"`
	ModelInfo          *ModelInfo        `json:"modelInfo,omitempty"`
	OpenAI             *OpenAIConfig     `json:"openAI,omitempty"`
	Anthropic          *AnthropicConfig  `json:"anthropic,omitempty"`
	AzureOpenAI        *AzureOpenAIConfig `json:"azureOpenAI,omitempty"`
	Gemini             *GeminiConfig     `json:"gemini,omitempty"`
	GeminiVertexAI     *GeminiVertexAIConfig `json:"geminiVertexAI,omitempty"`
	AnthropicVertexAI  *AnthropicVertexAIConfig `json:"anthropicVertexAI,omitempty"`
	Ollama             *OllamaConfig     `json:"ollama,omitempty"`
	Bedrock            *BedrockConfig    `json:"bedrock,omitempty"`
}

type SecretKeyRef struct {
	Name string `json:"name,omitempty"`
	Key  string `json:"key,omitempty"`
}

type ModelInfo struct {
	Family                string `json:"family,omitempty"`
	FunctionCalling       *bool  `json:"functionCalling,omitempty"`
	JSONOutput            *bool  `json:"jsonOutput,omitempty"`
	MultipleSystemMessages *bool `json:"multipleSystemMessages,omitempty"`
	StructuredOutput      *bool  `json:"structuredOutput,omitempty"`
	Vision                *bool  `json:"vision,omitempty"`
}

type OpenAIConfig struct {
	BaseURL          string `json:"baseUrl,omitempty"`
	Organization     string `json:"organization,omitempty"`
	MaxTokens        *int64 `json:"maxTokens,omitempty"`
	Temperature      string `json:"temperature,omitempty"`
	TopP             string `json:"topP,omitempty"`
	PresencePenalty  string `json:"presencePenalty,omitempty"`
	FrequencyPenalty string `json:"frequencyPenalty,omitempty"`
	N                *int64 `json:"n,omitempty"`
	Seed             *int64 `json:"seed,omitempty"`
	Timeout          *int64 `json:"timeout,omitempty"`
}

type AnthropicConfig struct {
	BaseURL     string `json:"baseUrl,omitempty"`
	MaxTokens   *int64 `json:"maxTokens,omitempty"`
	Temperature string `json:"temperature,omitempty"`
	TopP        string `json:"topP,omitempty"`
	TopK        *int64 `json:"topK,omitempty"`
}

type AzureOpenAIConfig struct {
	APIVersion      string `json:"apiVersion,omitempty"`
	AzureEndpoint   string `json:"azureEndpoint,omitempty"`
	AzureDeployment string `json:"azureDeployment,omitempty"`
	AzureADToken    string `json:"azureAdToken,omitempty"`
	MaxTokens       *int64 `json:"maxTokens,omitempty"`
	Temperature     string `json:"temperature,omitempty"`
	TopP            string `json:"topP,omitempty"`
}

type GeminiConfig struct {
	MaxOutputTokens *int64  `json:"maxOutputTokens,omitempty"`
	Temperature     string  `json:"temperature,omitempty"`
	TopP            string  `json:"topP,omitempty"`
	TopK            string  `json:"topK,omitempty"`
	StopSequences   []string `json:"stopSequences,omitempty"`
	ResponseMimeType string `json:"responseMimeType,omitempty"`
}

type GeminiVertexAIConfig struct {
	ProjectID        string   `json:"projectID,omitempty"`
	Location         string   `json:"location,omitempty"`
	MaxOutputTokens  *int64   `json:"maxOutputTokens,omitempty"`
	Temperature      string   `json:"temperature,omitempty"`
	TopP             string   `json:"topP,omitempty"`
	TopK             string   `json:"topK,omitempty"`
	StopSequences    []string `json:"stopSequences,omitempty"`
	ResponseMimeType string   `json:"responseMimeType,omitempty"`
	CandidateCount   *int64   `json:"candidateCount,omitempty"`
}

type AnthropicVertexAIConfig struct {
	ProjectID      string   `json:"projectID,omitempty"`
	Location       string   `json:"location,omitempty"`
	MaxTokens      *int64   `json:"maxTokens,omitempty"`
	Temperature    string   `json:"temperature,omitempty"`
	TopP           string   `json:"topP,omitempty"`
	TopK           string   `json:"topK,omitempty"`
	StopSequences  []string `json:"stopSequences,omitempty"`
}

type OllamaConfig struct {
	Host    string            `json:"host,omitempty"`
	Options map[string]string `json:"options,omitempty"`
}

type BedrockConfig struct {
	Region string `json:"region,omitempty"`
}

type ModelConfigStatus struct {
	Synced             *bool             `json:"synced,omitempty"`
	DBID               *int64            `json:"dbId,omitempty"`
	LastSyncTime       *v1.Time          `json:"lastSyncTime,omitempty"`
	Message            string            `json:"message,omitempty"`
	ObservedGeneration *int64            `json:"observedGeneration,omitempty"`
	SecretHash         string            `json:"secretHash,omitempty"`
	Conditions         []v1.Condition    `json:"conditions,omitempty"`
}

type ModelConfig struct {
	v1.TypeMeta   `json:",inline"`
	v1.ObjectMeta `json:"metadata,omitempty"`
	Spec          ModelConfigSpec   `json:"spec,omitempty"`
	Status        ModelConfigStatus `json:"status,omitempty"`
}

type ModelConfigList struct {
	v1.TypeMeta `json:",inline"`
	v1.ListMeta `json:"metadata,omitempty"`
	Items       []ModelConfig `json:"items"`
}

func addKnownTypes(scheme *runtime.Scheme) error {
	scheme.AddKnownTypes(GroupVersion, &ModelConfig{}, &ModelConfigList{})
	v1.AddToGroupVersion(scheme, GroupVersion)
	return nil
}

func (in *ModelConfig) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(ModelConfig)
	*out = *in
	out.ObjectMeta = *in.ObjectMeta.DeepCopy()
	return out
}

func (in *ModelConfigList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := new(ModelConfigList)
	*out = *in
	if in.Items != nil {
		out.Items = make([]ModelConfig, len(in.Items))
		copy(out.Items, in.Items)
	}
	return out
}
