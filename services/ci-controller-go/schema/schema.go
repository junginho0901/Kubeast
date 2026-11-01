// Package schema publishes the JSON Schema of .kubeast/pipeline.yaml, for
// editors and for tools that write pipelines. Kubeast reads pipelines with
// package pipeline; a test holds the two to the same answers.
package schema

import _ "embed"

// PipelineV1alpha1 is pipeline.v1alpha1.json.
//
//go:embed pipeline.v1alpha1.json
var PipelineV1alpha1 []byte
