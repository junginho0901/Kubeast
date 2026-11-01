package jobspec

// The labels and annotations a build's Job carries, which the controller
// reads back (internal/buildstatus) after a restart.
const (
	LabelBuild          = "kubeast.io/ci-build"
	AnnotationRepo      = "kubeast.io/ci-repo"
	AnnotationCommit    = "kubeast.io/ci-commit"
	AnnotationRef       = "kubeast.io/ci-ref"
	AnnotationEvent     = "kubeast.io/ci-event"
	AnnotationUntrusted = "kubeast.io/ci-untrusted"
	// CancelAnnotation is set by the controller on a Job it cancels, before
	// deleting it, so whoever reads the Job meanwhile sees why it stops.
	CancelAnnotation = "kubeast.io/ci-cancelled"
)
