package cluster

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const kubeconfigSecretKey = "kubeconfig"

// PrometheusAuthKey is the key of the cluster-prometheus-<id> Secret that holds
// the full Authorization header value for the cluster's external Prometheus.
const PrometheusAuthKey = "authorization"

// LogSearchAuthKey is the key of the cluster-logsearch-<id> Secret that holds
// the full Authorization header value for the cluster's own log store.
const LogSearchAuthKey = "authorization"

// SecretReader loads a cluster's kubeconfig from a backing secret store.
type SecretReader interface {
	ReadKubeconfig(ctx context.Context, secretName string) (string, error)
	// ReadValue returns one key of a named secret ("" and an error when absent).
	ReadValue(ctx context.Context, secretName, key string) (string, error)
}

// SecretWriter stores and removes per-cluster kubeconfigs.
type SecretWriter interface {
	WriteKubeconfig(ctx context.Context, id ID, content string) (secretName string, err error)
	DeleteKubeconfig(ctx context.Context, secretName string) error
	// WriteValue stores one key of a named secret (created or replaced).
	WriteValue(ctx context.Context, secretName, key, value string) error
	// DeleteSecret removes a named secret; absent is not an error.
	DeleteSecret(ctx context.Context, secretName string) error
}

// SecretStore is a combined reader/writer.
type SecretStore interface {
	SecretReader
	SecretWriter
}

// SecretName returns the Secret name holding cluster id's kubeconfig.
func SecretName(id ID) string { return "cluster-kubeconfig-" + string(id) }

// PrometheusSecretName returns the Secret name holding cluster id's external
// Prometheus Authorization header (key PrometheusAuthKey).
func PrometheusSecretName(id ID) string { return "cluster-prometheus-" + string(id) }

// LogSearchSecretName returns the Secret name holding cluster id's own log
// store Authorization header (key LogSearchAuthKey).
func LogSearchSecretName(id ID) string { return "cluster-logsearch-" + string(id) }

// --- K8s Secret store (helm mode) ---

// K8sSecretStore keeps per-cluster kubeconfigs as Secrets in the kubeast
// namespace of the cluster kubeast itself runs in. Reading happens at request
// time via the K8s API, so registering a new cluster never requires a rollout.
type K8sSecretStore struct {
	client    kubernetes.Interface
	namespace string
}

// NewK8sSecretStore builds a store backed by Secrets in namespace.
func NewK8sSecretStore(client kubernetes.Interface, namespace string) *K8sSecretStore {
	if namespace == "" {
		namespace = "default"
	}
	return &K8sSecretStore{client: client, namespace: namespace}
}

func (s *K8sSecretStore) ReadKubeconfig(ctx context.Context, secretName string) (string, error) {
	// Failure isolation: a slow host API must not hang the caller.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	sec, err := s.client.CoreV1().Secrets(s.namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("get secret %s/%s: %w", s.namespace, secretName, err)
	}
	blob, ok := sec.Data[kubeconfigSecretKey]
	if !ok {
		return "", fmt.Errorf("secret %s missing key %q", secretName, kubeconfigSecretKey)
	}
	return string(blob), nil
}

func (s *K8sSecretStore) WriteKubeconfig(ctx context.Context, id ID, content string) (string, error) {
	name := SecretName(id)
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "kubeast",
				"kubeast.io/cluster-id":        string(id),
			},
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{kubeconfigSecretKey: []byte(content)},
	}
	_, err := s.client.CoreV1().Secrets(s.namespace).Create(ctx, sec, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		_, err = s.client.CoreV1().Secrets(s.namespace).Update(ctx, sec, metav1.UpdateOptions{})
	}
	if err != nil {
		return "", fmt.Errorf("write secret %s: %w", name, err)
	}
	return name, nil
}

func (s *K8sSecretStore) DeleteKubeconfig(ctx context.Context, secretName string) error {
	err := s.client.CoreV1().Secrets(s.namespace).Delete(ctx, secretName, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func (s *K8sSecretStore) ReadValue(ctx context.Context, secretName, key string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	sec, err := s.client.CoreV1().Secrets(s.namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("get secret %s/%s: %w", s.namespace, secretName, err)
	}
	v, ok := sec.Data[key]
	if !ok {
		return "", fmt.Errorf("secret %s missing key %q", secretName, key)
	}
	return string(v), nil
}

func (s *K8sSecretStore) WriteValue(ctx context.Context, secretName, key, value string) error {
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: s.namespace,
			Labels:    map[string]string{"app.kubernetes.io/managed-by": "kubeast"},
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{key: []byte(value)},
	}
	_, err := s.client.CoreV1().Secrets(s.namespace).Create(ctx, sec, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		_, err = s.client.CoreV1().Secrets(s.namespace).Update(ctx, sec, metav1.UpdateOptions{})
	}
	if err != nil {
		return fmt.Errorf("write secret %s: %w", secretName, err)
	}
	return nil
}

func (s *K8sSecretStore) DeleteSecret(ctx context.Context, secretName string) error {
	return s.DeleteKubeconfig(ctx, secretName)
}

// --- Filesystem store (docker mode) ---

// FilesystemSecretStore keeps per-cluster kubeconfigs as files (docker-compose
// mode, where there is no K8s API). The returned secretName is the file path.
type FilesystemSecretStore struct {
	dir string
}

// NewFilesystemSecretStore builds a store writing under dir.
func NewFilesystemSecretStore(dir string) *FilesystemSecretStore {
	if dir == "" {
		dir = "/var/kubeast/kubeconfigs"
	}
	return &FilesystemSecretStore{dir: dir}
}

func (s *FilesystemSecretStore) ReadKubeconfig(_ context.Context, secretName string) (string, error) {
	b, err := os.ReadFile(secretName)
	if err != nil {
		return "", fmt.Errorf("read kubeconfig %s: %w", secretName, err)
	}
	return string(b), nil
}

func (s *FilesystemSecretStore) WriteKubeconfig(_ context.Context, id ID, content string) (string, error) {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(s.dir, string(id)+".yaml")
	tmp, err := os.CreateTemp(s.dir, ".kubeconfig-*.tmp")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	cleanup := func() { tmp.Close(); os.Remove(tmpName) }
	if _, err := tmp.WriteString(content); err != nil {
		cleanup()
		return "", err
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	return path, nil
}

func (s *FilesystemSecretStore) DeleteKubeconfig(_ context.Context, secretName string) error {
	err := os.Remove(secretName)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Named values live next to the kubeconfigs as <dir>/<secretName>.<key>.
func (s *FilesystemSecretStore) valuePath(secretName, key string) string {
	return filepath.Join(s.dir, secretName+"."+key)
}

func (s *FilesystemSecretStore) ReadValue(_ context.Context, secretName, key string) (string, error) {
	b, err := os.ReadFile(s.valuePath(secretName, key))
	if err != nil {
		return "", fmt.Errorf("read secret %s/%s: %w", secretName, key, err)
	}
	return string(b), nil
}

func (s *FilesystemSecretStore) WriteValue(_ context.Context, secretName, key, value string) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(s.valuePath(secretName, key), []byte(value), 0o600)
}

func (s *FilesystemSecretStore) DeleteSecret(_ context.Context, secretName string) error {
	matches, err := filepath.Glob(filepath.Join(s.dir, secretName+".*"))
	if err != nil {
		return err
	}
	for _, m := range matches {
		if err := os.Remove(m); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
