package jobspec

import (
	"errors"
	"fmt"
	"regexp"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ExpiresAnnotation on a build's git Secret is when its token stops
// working, so a controller can remove a Secret a crash left without owner.
const ExpiresAnnotation = "kubeast.io/ci-token-expires"

// tokenRe: printable ASCII without spaces. The checkout's credential
// helper prints the file's contents after "password=", so a line break
// would let a token add lines of its own.
var tokenRe = regexp.MustCompile(`^[!-~]+$`)

// GitSecretName is the Secret a build's checkout reads its clone token
// from; pass it as Input.GitSecret.
func GitSecretName(buildID string) string { return "ci-" + buildID + "-git" }

// GitSecret is that Secret for in's build: the token under key "token",
// immutable, with the build Job's labels and the token's expiry.
//
// The order that leaves nothing behind and never makes the pod wait: make
// this Secret, then the Job, then add the Job as its owner (WithOwner; an
// immutable Secret's data is frozen, not its metadata), so it is deleted
// with the Job. A Secret left ownerless by a crash is found by its labels
// and removed once ExpiresAnnotation has passed.
func GitSecret(in Input, token string, expires time.Time) (*corev1.Secret, error) {
	var errs []error
	if len(in.Build.ID) > 40 || !idRe.MatchString(in.Build.ID) {
		errs = append(errs, fmt.Errorf("build id %q is not a DNS label of at most 40 characters", in.Build.ID))
	}
	if len(in.Namespace) > 63 || !nsRe.MatchString(in.Namespace) {
		errs = append(errs, fmt.Errorf("namespace %q is not a DNS label", in.Namespace))
	}
	if in.GitSecret != GitSecretName(in.Build.ID) {
		errs = append(errs, fmt.Errorf("the Job mounts Secret %q, not %q", in.GitSecret, GitSecretName(in.Build.ID)))
	}
	if len(token) > 1024 || !tokenRe.MatchString(token) {
		errs = append(errs, errors.New("the token is empty, too long or has spaces, line breaks or other characters a token does not have"))
	}
	if expires.IsZero() {
		errs = append(errs, errors.New("the token's expiry is not set"))
	}
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return &corev1.Secret{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"},
		ObjectMeta: metav1.ObjectMeta{
			Name:        in.GitSecret,
			Namespace:   in.Namespace,
			Labels:      buildLabels(in),
			Annotations: map[string]string{ExpiresAnnotation: expires.UTC().Format(time.RFC3339)},
		},
		Immutable: ptr(true),
		Type:      corev1.SecretTypeOpaque,
		Data:      map[string][]byte{"token": []byte(token)},
	}, nil
}

// WithOwner makes job, as the API server returned it, the owner of a
// build's git Secret, so the Secret goes when the Job's TTL deletes it.
func WithOwner(secret *corev1.Secret, job *batchv1.Job) error {
	switch {
	case job.UID == "":
		return errors.New("the Job has no UID; use the Job the API server returned")
	case job.Namespace != secret.Namespace:
		return fmt.Errorf("the Job is in %q, the Secret in %q", job.Namespace, secret.Namespace)
	case job.Labels[LabelBuild] == "" || job.Labels[LabelBuild] != secret.Labels[LabelBuild]:
		return errors.New("the Job and the Secret belong to different builds")
	}
	secret.OwnerReferences = []metav1.OwnerReference{{
		APIVersion: "batch/v1",
		Kind:       "Job",
		Name:       job.Name,
		UID:        job.UID,
	}}
	return nil
}
